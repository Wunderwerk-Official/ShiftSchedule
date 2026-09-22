#!/usr/bin/env bash
# Build first, drain admissions, then replace only an idle healthy stack.
set -euo pipefail
compose_file=${1:?Usage: deploy-compose.sh COMPOSE_FILE}
poll_limit=${DEPLOY_DRAIN_POLLS:-540}
poll_seconds=${DEPLOY_DRAIN_INTERVAL:-10}
compose=(docker compose -f "$compose_file")
draining=0

cleanup() {
  if [ "$draining" -eq 0 ]; then return 0; fi
  local failed=0
  "${compose[@]}" exec -T backend python -c 'import os,pathlib; pathlib.Path(os.environ.get("SCHEDULE_DB_PATH","schedule.db")).with_name(".planning-drain").unlink(missing_ok=True)' >/dev/null 2>&1 || failed=1
  "${compose[@]}" exec -T frontend sh -ec 'if [ -f /tmp/nginx-before-planning-drain.conf ]; then cp /tmp/nginx-before-planning-drain.conf /etc/nginx/conf.d/default.conf; nginx -t; nginx -s reload; rm /tmp/nginx-before-planning-drain.conf; fi' >/dev/null 2>&1 || failed=1
  return "$failed"
}
on_exit() {
  local result=$?
  if ! cleanup; then
    echo 'Could not reopen planning admissions; check the deployment drain marker and frontend configuration.' >&2
    result=1
  fi
  exit "$result"
}
trap on_exit EXIT
trap 'exit 1' INT TERM HUP

"${compose[@]}" build

# The marker protects new backends and direct API access. The frontend gate
# also protects the first rollout, whose old backend cannot read the marker.
backend_running=$("${compose[@]}" ps --status running --services | sed -n '/^backend$/p')
if [ -n "$backend_running" ]; then
  draining=1
  "${compose[@]}" exec -T backend python -c 'import os,pathlib; pathlib.Path(os.environ.get("SCHEDULE_DB_PATH","schedule.db")).with_name(".planning-drain").touch()'
  "${compose[@]}" exec -T frontend sh -c '
    cp /etc/nginx/conf.d/default.conf /tmp/nginx-before-planning-drain.conf
    sed "/server {/a\\  location = /api/v1/solve/range { return 503; }" /tmp/nginx-before-planning-drain.conf > /etc/nginx/conf.d/default.conf
    nginx -t
    nginx -s reload
  '
  idle_polls=0
  for ((i=1; i<=poll_limit; i++)); do
    # Failure to inspect is NOT evidence of an idle worker. Fail closed.
    active=$("${compose[@]}" exec -T backend python - < "$(dirname "$0")/count_planning_processes.py")
    if [[ ! "$active" =~ ^[0-9]+$ ]]; then
      echo 'Could not establish solver status; keeping the current containers.' >&2
      exit 1
    fi
    if [ "$active" -eq 0 ]; then
      idle_polls=$((idle_polls + 1))
      # Let requests already admitted by the previous frontend drain too.
      if [ "$idle_polls" -ge 2 ]; then break; fi
    else
      idle_polls=0
      echo "Planning still active; deployment waiting ($i/$poll_limit)."
    fi
    sleep "$poll_seconds"
  done
  if [ "$idle_polls" -lt 2 ]; then
    echo 'Planning has not drained; deployment stopped without replacing containers.' >&2
    exit 1
  fi
fi

"${compose[@]}" up -d --no-build
for ((i=1; i<=30; i++)); do
  if "${compose[@]}" exec -T backend python -c "import urllib.request; assert b'ok' in urllib.request.urlopen('http://localhost:8000/health', timeout=5).read()" >/dev/null 2>&1; then
    echo 'Backend healthy; planning admissions reopen.'
    exit 0
  fi
  sleep 5
done
echo 'Backend health check failed after deployment.' >&2
exit 1
