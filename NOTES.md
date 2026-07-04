# Hetzner Deployment Notes (Runbook)

## Server
- IP: 46.224.114.183 (Hetzner Cloud, Ubuntu 22.04)
- SSH: `ssh root@46.224.114.183`
- Project path: `/opt/shiftschedule` — a **git clone** of `main`
  (deploys run `git pull --ff-only`; never commit on the server)
- Domain: `https://shiftplanner.wunderwerk.ai`
  (DNS `A` record at the registrar must point to the server IP — required
  for Let's Encrypt renewals)

## Stack in use
Domain/HTTPS variant via `docker-compose.yml` (backend + frontend + caddy).
`docker-compose.ip.yml` (IP-only) is legacy and not used.

- Frontend: https://shiftplanner.wunderwerk.ai
- Backend/API: https://shiftplanner.wunderwerk.ai/api
- Health: https://shiftplanner.wunderwerk.ai/api/health
- App data: Docker volume `shiftschedule_backend_data` (`/data/schedule.db`)
- Secrets: only in `/opt/shiftschedule/.env` (never in git/GitHub)

## Deploys
Automatic: push to `main` → GitHub Actions CI → deploy job (SSH, pull,
`docker compose up -d --build`, health check). See
[.github/workflows/ci-cd.yml](.github/workflows/ci-cd.yml) and
[DEPLOY.md](DEPLOY.md).

Manual fallback:
```
cd /opt/shiftschedule
git pull --ff-only
docker compose -f docker-compose.yml up -d --build
```

## Common commands
```
# status / logs
docker ps
docker compose -f docker-compose.yml logs -f --tail 100 backend
docker logs shiftschedule-caddy-1 --since 1h

# health from inside the backend container (works regardless of DNS/TLS)
docker compose -f docker-compose.yml exec -T backend \
  python -c "import urllib.request as u; print(u.urlopen('http://localhost:8000/health', timeout=5).read())"

# backup app data (hot, read-only)
docker run --rm -v shiftschedule_backend_data:/data:ro -v /root:/backup alpine \
  sh -c "cd /data && tar czf /backup/backend_data_backup_$(date +%Y%m%d_%H%M%S).tar.gz ."

# force TLS certificate renewal (after fixing DNS)
docker restart shiftschedule-caddy-1
```

## Gotchas
- `https://<IP>` is rejected by design — Caddy only serves the domain host.
- iCal subscription feeds only contain weeks published in the app.
- PDF export renders the frontend through the public domain from inside the
  backend container — broken DNS/TLS breaks PDF export too.
