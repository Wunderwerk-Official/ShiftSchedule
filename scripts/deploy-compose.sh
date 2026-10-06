#!/usr/bin/env bash
# Build first, drain admissions, then replace only an idle healthy stack.
set -euo pipefail
compose_file=${1:?Usage: deploy-compose.sh COMPOSE_FILE}
poll_limit=${DEPLOY_DRAIN_POLLS:-540}
poll_seconds=${DEPLOY_DRAIN_INTERVAL:-10}
compose=(docker compose -f "$compose_file")
draining=0

# Both halves of the drain, shared by the EXIT cleanup and the self-heal of a
# previous run that never reached its cleanup (SIGKILL, host reboot, exec into
# a restarting container). The backend also clears its own marker on startup.
remove_marker='import os,pathlib; pathlib.Path(os.environ.get("SCHEDULE_DB_PATH","schedule.db")).with_name(".planning-drain").unlink(missing_ok=True)'
restore_frontend='if [ -f /tmp/nginx-before-planning-drain.conf ]; then cp /tmp/nginx-before-planning-drain.conf /etc/nginx/conf.d/default.conf; nginx -t; nginx -s reload; rm /tmp/nginx-before-planning-drain.conf; fi'

cleanup() {
  if [ "$draining" -eq 0 ]; then return 0; fi
  local failed=0
  "${compose[@]}" exec -T backend python -c "$remove_marker" >/dev/null 2>&1 || failed=1
  "${compose[@]}" exec -T frontend sh -ec "$restore_frontend" >/dev/null 2>&1 || failed=1
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

# Self-heal: a previous deployment killed before its EXIT trap leaves planning
# closed (503) until the drain marker and the nginx gate are removed. Best
# effort; the EXIT cleanup of this run retries whatever fails here.
running_services=$("${compose[@]}" ps --status running --services 2>/dev/null || true)
if printf '%s\n' "$running_services" | grep -qx frontend; then
  "${compose[@]}" exec -T frontend sh -ec "$restore_frontend" >/dev/null 2>&1 \
    || echo 'Warning: could not restore the frontend configuration left by a previous deployment.' >&2
fi
if printf '%s\n' "$running_services" | grep -qx backend; then
  "${compose[@]}" exec -T backend python -c "$remove_marker" >/dev/null 2>&1 \
    || echo 'Warning: could not remove a drain marker left by a previous deployment.' >&2
fi

"${compose[@]}" build

# The marker protects new backends and direct API access. The frontend gate
# also protects the first rollout, whose old backend cannot read the marker.
running_services=$("${compose[@]}" ps --status running --services)
backend_running=$(printf '%s\n' "$running_services" | sed -n '/^backend$/p')
frontend_running=$(printf '%s\n' "$running_services" | sed -n '/^frontend$/p')
if [ -n "$backend_running" ]; then
  draining=1
  "${compose[@]}" exec -T backend python -c 'import os,pathlib; pathlib.Path(os.environ.get("SCHEDULE_DB_PATH","schedule.db")).with_name(".planning-drain").touch()'
  if [ -n "$frontend_running" ]; then
    # -e: a failing nginx -t must abort before nginx -s reload, so the EXIT
    # cleanup restores the backup instead of leaving a broken gate behind.
    "${compose[@]}" exec -T frontend sh -ec '
      cp /etc/nginx/conf.d/default.conf /tmp/nginx-before-planning-drain.conf
      sed "/server {/a\\  location = /api/v1/solve/range { return 503; }" /tmp/nginx-before-planning-drain.conf > /etc/nginx/conf.d/default.conf
      nginx -t
      nginx -s reload
    '
  else
    echo 'Warning: frontend is not running; skipping the nginx planning gate (the backend drain marker still protects).' >&2
  fi
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
