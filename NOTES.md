# Deployment Notes (Runbook)

Full details: [DEPLOY.md](DEPLOY.md). This page is the short version.

## Production: Proxmox LXC — https://shiftplanner.truhn.ai
- Container: VMID 105, `10.10.10.6`, reachable only through the bastion:
  `ssh -J dtruhn@49.13.89.75:4444 root@10.10.10.6`
- Project path: `/opt/app` — a git checkout reset to the deployed commit
  (never commit on the server)
- Stack: `docker-compose.proxied.yml` (backend + frontend, frontend on
  `127.0.0.1:5000`; the container's host nginx terminates TLS)
- App data: Docker volume `app_backend_data` (`/data/schedule.db`)
- Secrets: only in `/opt/app/.env` (never in git/GitHub)
- Health: https://shiftplanner.truhn.ai/api/health

## Legacy redirect host: Hetzner — shiftplanner.wunderwerk.ai
- IP `46.224.114.183`, path `/opt/shiftschedule`, stack `docker-compose.yml`
- Since 2026-07 its Caddy only redirects (301) to `https://shiftplanner.truhn.ai{uri}`.
  The volume `shiftschedule_backend_data` still holds the pre-migration data copy.
- The DNS `A` record must keep pointing at the server so the redirect
  certificate renews.

## Deploys
Automatic: push to `main` → GitHub Actions CI (backend pytest; frontend
typecheck, Vitest, production build, critical Playwright specs) → jobs
`deploy-truhn` (production) and `deploy` (Hetzner). Each fetches the tested
commit by SHA and runs `scripts/deploy-compose.sh <compose file>`, which
builds first, drains running plans (up to 90 min) and only then replaces the
containers. See [.github/workflows/ci-cd.yml](.github/workflows/ci-cd.yml).

Manual fallback (production):
```
cd /opt/app
git fetch origin main
git reset --hard origin/main
bash scripts/deploy-compose.sh docker-compose.proxied.yml
```
Do not run a bare `docker compose up -d --build`: it skips the drain and
kills running plans.

## Common commands (production, on the container)
```
cd /opt/app
# status / logs
docker compose -f docker-compose.proxied.yml ps
docker compose -f docker-compose.proxied.yml logs -f --tail 100 backend

# health through the host-nginx path
curl -fsS http://127.0.0.1:5000/api/health

# backup app data (hot, read-only)
docker run --rm -v app_backend_data:/data:ro -v /root:/backup alpine \
  sh -c "cd /data && tar czf /backup/backend_data_backup_$(date +%Y%m%d_%H%M%S).tar.gz ."
```

## Gotchas
- iCal subscription feeds only contain weeks published in the app.
- PDF export renders the frontend from inside the backend container via
  `FRONTEND_BASE_URL` (internal `http://frontend` on the LXC stack).
- The `backend-logs` and `inspect-history` workflows reach
  production through the bastion when SSH is not at hand.
- Since v1.64 each login's "My plan" preferences live in the
  `user_preferences` table of the same `schedule.db` (so the volume backup
  above includes them; account deletion removes them). The table is created
  automatically at backend start.
- `AGENT_MAX_ITERATIONS` in `.env`/compose is ignored since v1.64.
- After the v1.64 deploy, run the admin model connection test once on
  Sonnet 5 (Settings → Solver), see agent.md "v1.64 › Deploy and data notes".
