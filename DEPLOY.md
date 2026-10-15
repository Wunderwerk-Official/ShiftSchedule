# Deployment

**Production is the Proxmox LXC behind `https://shiftplanner.truhn.ai`**
(job `deploy-truhn`, repo at `/opt/app`, stack `docker-compose.proxied.yml`).

The old Hetzner server (`shiftplanner.wunderwerk.ai`, `/opt/shiftschedule`,
stack `docker-compose.yml`) is a **legacy redirect host** since 2026-07: its
Caddy answers every request with a permanent redirect to
`https://shiftplanner.truhn.ai{uri}` (see [Caddyfile](Caddyfile)), so old
bookmarks, iCal subscription URLs and published web links keep working. The
`deploy` job still rebuilds that stack on every push, so its backend and the
pre-migration copy of all user data in its `shiftschedule_backend_data`
volume are still there, but no user traffic reaches them. Whether to keep or
delete that copy is an open owner decision.

## Stacks

| | Production (LXC) | Legacy redirect host (Hetzner) |
|---|---|---|
| Compose file | `docker-compose.proxied.yml` | `docker-compose.yml` |
| Services | `backend`, `frontend` | `backend`, `frontend`, `caddy` |
| Entry | host nginx (TLS) → `127.0.0.1:5000` → frontend nginx; `/api/*` → backend (see [nginx.conf](nginx.conf)) | Caddy on 80/443, redirect only |
| Repo path | `/opt/app` | `/opt/shiftschedule` (`DEPLOY_PATH` variable) |
| Data volume | `app_backend_data` (`/data/schedule.db`) | `shiftschedule_backend_data` (stale since the migration) |

App data lives in the Docker volume, not in the repo directory. The volume
name is `<compose project>_backend_data`; the project name defaults to the
directory name (`app`, `shiftschedule`). Check with `docker volume ls` before
running a backup or restore.

## Automated deployment (CI/CD)

Deploys are automated via GitHub Actions
([.github/workflows/ci-cd.yml](.github/workflows/ci-cd.yml)):

1. **CI** on every push to `main` and every PR targeting `main` — two
   parallel jobs:
   - Backend: Python 3.11, `pip install -r backend/requirements.txt -r
     backend/requirements-dev.txt`, then
     `python -m pytest tests -q --ignore=tests/test_solver_benchmark.py`
     (run from `backend/`; the ~7 min solver benchmark is excluded).
   - Frontend: Node 22, `npm ci`, `npm run typecheck`, `npm test` (Vitest),
     `npm run build` (production build), then the critical Playwright specs
     (`e2e/agent-apply.spec.ts`, `e2e/agent-activity.spec.ts`,
     `e2e/fixed-assignments.spec.ts`, `e2e/model-settings.spec.ts`,
     `e2e/my-plan.spec.ts`, `e2e/team-page.spec.ts`) against a local Vite dev
     server with mocked API.
2. **Deploy** only on push to `main` and only if both CI jobs pass. Two jobs
   run in parallel:
   - `deploy-truhn` (production): SSH to `root@10.10.10.6` through the
     bastion, `git fetch origin <sha>` + `git reset --hard <sha>` in
     `/opt/app` (clones the public repo and bootstraps `.env` on the first
     run), rewrites `/opt/app/run.sh`, installs the host-nginx proxy drop-in,
     runs `scripts/configure_proxy_logging.py`, then
     `bash scripts/deploy-compose.sh docker-compose.proxied.yml`, and finally
     checks `http://127.0.0.1:5000/api/health`.
   - `deploy` (legacy Hetzner): SSH to `SSH_USER@SSH_HOST`,
     `git fetch origin <sha>` + `git checkout --detach <sha>` in
     `$DEPLOY_PATH`, `bash scripts/deploy-compose.sh "$COMPOSE_FILE"`, then
     `docker compose up -d --force-recreate caddy` (the single-file Caddyfile
     bind mount only picks up a changed file after a recreate), and an
     in-container `GET http://localhost:8000/health` check.

   Both deploy the exact commit that passed CI, even if `main` has moved on.

`scripts/deploy-compose.sh` builds the images first, then closes planning
admission (a drain marker next to the DB plus a frontend-nginx `503` on
`/api/v1/solve/range`) and waits until no planning process is running
(`DEPLOY_DRAIN_POLLS` × `DEPLOY_DRAIN_INTERVAL`, default 540 × 10 s = 90 min).
If planning does not drain, or the solver status cannot be read, it stops
**without replacing the containers**. Otherwise it runs `up -d --no-build`
and waits for `/health`; admission reopens on exit in every case.

Pushes that change only `*.md` files or the diagnostic workflows listed in
`paths-ignore` do not trigger CI/deploy on `main`. A workflow-level
`concurrency` group (`production-deploy`, no cancellation) serializes runs.

So: **merging/pushing to `main` deploys to production.** No PR is deployed.

### GitHub secrets & variables

Configured under *Settings → Secrets and variables → Actions*:

| Kind | Name | Used by | Content |
|------|------|---------|---------|
| Secret | `SSH_KEY_FUER_SHIFTSCHEDULE_SERVER` | `deploy-truhn`, `migrate-db`, diagnostic/arena workflows | Key authorized for `dtruhn` on the bastion and `root` in the LXC |
| Secret | `SSH_PRIVATE_KEY` | `deploy`, `migrate-db` | Dedicated ed25519 deploy key (private part) for the Hetzner host |
| Secret | `SSH_HOST` | `deploy`, `migrate-db` | Hetzner server IP/hostname |
| Secret | `SSH_USER` | `deploy`, `migrate-db` | SSH user |
| Secret | `SSH_KNOWN_HOSTS` | `deploy`, `migrate-db` | Pinned `ssh-keyscan` output for the Hetzner server |
| Variable | `DEPLOY_PATH` | `deploy`, `migrate-db` | Repo path on the Hetzner server |
| Variable | `COMPOSE_FILE` | `deploy` | Optional; defaults to `docker-compose.yml` |
| Variable | `SSH_PORT` | `deploy`, `migrate-db` | Optional; defaults to `22` |

Application secrets (admin credentials, `JWT_SECRET`, `ANTHROPIC_API_KEY`, …)
live **only** in each server's `.env` — never in GitHub.

### Rotating the Hetzner deploy key

```bash
ssh-keygen -t ed25519 -C "gh-actions-deploy shiftschedule" -f deploykey -N ""
# public part → server:
ssh <user>@<server> 'cat >> ~/.ssh/authorized_keys' < deploykey.pub
# private part → GitHub:
gh secret set SSH_PRIVATE_KEY -R <owner>/<repo> < deploykey
rm deploykey deploykey.pub
```

## Production: Proxmox LXC (shiftplanner.truhn.ai)

The `deploy-truhn` job deploys to a Proxmox LXC container (VMID 105,
internal IP `10.10.10.6`) at the institute. Details:

- **Network path**: public DNS for `shiftplanner.truhn.ai` points at the
  bastion (`49.13.89.75`), which tunnels the domain to the container. SSH
  reaches the container only THROUGH the bastion (port 4444; `proxy_*`
  options of `appleboy/ssh-action`); the bastion's ForceCommand permits pure
  TCP forwarding, never command execution.
- **Auth**: one key pair (`secrets.SSH_KEY_FUER_SHIFTSCHEDULE_SERVER`) is
  authorized for `dtruhn` on the bastion and for `root` inside the container.
  Interactive access: `ssh -J dtruhn@49.13.89.75:4444 root@10.10.10.6` (or
  `dtruhn@10.10.10.6` plus `sudo`).
- **Stack**: `docker-compose.proxied.yml` — backend + frontend only, the
  frontend published on `127.0.0.1:5000` (never `0.0.0.0`: the app would
  otherwise be reachable unauthenticated from the internal `10.10.10.0/24`
  subnet). The container's own nginx terminates TLS for the domain and
  proxies to that port. The deploy drops
  `/etc/nginx/conf.d/zz-shiftschedule-proxy.conf` onto that host nginx
  (read/send timeout 3600s, `proxy_buffering off`) — solver POSTs answer
  only after minutes and progress streams as SSE, which the nginx defaults
  (60s timeout, buffering) would cut off or freeze. It also runs
  `scripts/configure_proxy_logging.py --domain shiftplanner.truhn.ai`, which
  disables raw URL access/error logs in the app's host-nginx virtual servers
  (non-fatal on failure).
- **PDF export**: `FRONTEND_BASE_URL` defaults to the internal
  `http://frontend` service (`FRONTEND_INTERNAL_URL` overrides it), because
  the public domain may not be reachable from inside the container network.
- **Bootstrap**: the job clones the public repo to `/opt/app` on first run,
  generates `.env` (random admin password + JWT secret, never echoed to
  logs — read them with `sudo cat /opt/app/.env` on the container), and
  installs `/opt/app/run.sh` for the provisioned `app.service` autostart
  convention (compose up + sleep).
- **LLM config**: no API keys ship with the deploy. An admin sets the
  Anthropic key OR the self-hosted OpenAI-compatible endpoint (base URL,
  model, key, TLS verification) in Settings → Solver after first login.

### Operations (production)

Run on the container (`ssh -J dtruhn@49.13.89.75:4444 root@10.10.10.6`):

```bash
cd /opt/app
# logs
docker compose -f docker-compose.proxied.yml logs -f --tail 100 backend
# health through the path the host nginx uses
curl -fsS http://127.0.0.1:5000/api/health
# backup of the app data (hot, read-only; check the name with `docker volume ls`)
docker run --rm -v app_backend_data:/data:ro -v /root:/backup alpine \
  sh -c "cd /data && tar czf /backup/backend_data_backup_$(date +%Y%m%d_%H%M%S).tar.gz ."
```

Without SSH access, the `backend-logs` and `inspect-history` workflows read
production logs and history through the same bastion path.

### Manual deploy (fallback, production)

Use the deploy script, never a bare `docker compose up -d --build`: that
would skip the planning drain and kill running plans.

```bash
cd /opt/app
git fetch origin main
git reset --hard origin/main
bash scripts/deploy-compose.sh docker-compose.proxied.yml
curl -fsS http://127.0.0.1:5000/api/health
```

## Legacy redirect host (Hetzner, shiftplanner.wunderwerk.ai)

Its DNS `A` record must keep pointing at the server so Caddy can renew the
certificate for the redirect. The `deploy` job leaves the checkout on a
detached HEAD, so `git pull` does not work there.

Manual deploy (fallback):
```bash
ssh <user>@<server>
cd /opt/shiftschedule
git fetch origin main
git checkout --detach origin/main
bash scripts/deploy-compose.sh docker-compose.yml
docker compose -f docker-compose.yml up -d --force-recreate caddy
```

Logs / certificate:
```bash
docker compose -f docker-compose.yml logs -f --tail 100 caddy
docker restart shiftschedule-caddy-1   # forces an immediate renewal after fixing DNS
```

## First-time setup of a self-contained Caddy server

This is how the Hetzner host was set up; use it for a new standalone server
with `docker-compose.yml`. Note that the checked-in [Caddyfile](Caddyfile)
now only redirects to `shiftplanner.truhn.ai`; a new standalone server needs
a Caddyfile that proxies `/api/*` to `backend:8000` (prefix stripped) and
everything else to `frontend:80`, for example:

```
{$DOMAIN} {
  handle_path /api/* {
    reverse_proxy backend:8000
  }
  handle {
    reverse_proxy frontend:80
  }
  tls {$LETSENCRYPT_EMAIL}
}
```

1. Server: Ubuntu 22.04 LTS, your SSH key added.
2. Install Docker: `curl -fsSL https://get.docker.com | sh`
3. Clone the repo:
   ```bash
   git clone https://github.com/Wunderwerk-Official/ShiftSchedule.git /opt/shiftschedule
   cd /opt/shiftschedule
   ```
4. **DNS**: create an `A` record for your domain pointing to the server IP.
   This must exist *before* the first start — Caddy needs it to obtain the
   TLS certificate, and certificate renewals fail without it.
5. Configure `.env` (see below), then:
   ```bash
   docker compose up -d --build
   ```
6. Verify: `https://<DOMAIN>` and `https://<DOMAIN>/api/health`.

## Server `.env` reference

```
DOMAIN=schedule.example.com
LETSENCRYPT_EMAIL=admin@example.com       # Caddy stack only
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<choose-a-strong-password>
JWT_SECRET=<long-random-string, e.g. `openssl rand -base64 48`>
JWT_EXPIRE_MINUTES=720

# Optional — AI agent solver (solver_mode="agent"); without a key, agent
# runs fall back to the heuristic seed plan. Admins can also set provider,
# model and keys at runtime in Settings → Solver.
ANTHROPIC_API_KEY=
```

Notes:
- Never use the placeholder values from `.env.example`: the backend accepts
  any non-empty `JWT_SECRET` in production, and the repository is public.
- `JWT_EXPIRE_MINUTES` must not be empty: `docker-compose.yml` and
  `docker-compose.ip.yml` pass it through without a default and the backend
  crashes on `int("")` (`docker-compose.proxied.yml` defaults it to 720).
- `PUBLIC_BASE_URL` (public iCal subscription URLs) is set by both compose
  files to `https://${DOMAIN}/api`; a value in `.env` is not used by them.
- `FRONTEND_BASE_URL` (Playwright PDF export) is `https://${DOMAIN}` in
  `docker-compose.yml` and the internal `http://frontend` in
  `docker-compose.proxied.yml`; it must be reachable *from inside* the
  backend container.
- To change the admin password of an **existing** installation: set the new
  `ADMIN_PASSWORD`, additionally set `ADMIN_PASSWORD_RESET=true`, recreate
  the backend, then remove the flag again. On production, recreate it with
  `bash scripts/deploy-compose.sh <compose file>`, which replaces containers
  only after the planning drain. A bare
  `docker compose -f <compose file> up -d backend` skips the drain: use it
  only after checking that no plan is running (an interrupted run is
  restarted once for the newest run per user; other interrupted runs are
  marked crashed).
- Changing `JWT_SECRET` invalidates all active sessions (users must log in
  again).

## Troubleshooting

- **Planning returns 503 after a failed deploy**: the drain marker or the
  frontend nginx gate was left behind. The next run of
  `scripts/deploy-compose.sh` self-heals both, and backend startup removes
  the marker.
- **Deploy stopped with "Planning has not drained"**: a plan was still
  running after the drain window; nothing was replaced. Re-run the deploy
  once the run has finished.
- **iCal feeds are empty**: feeds only contain weeks that were explicitly
  published in the app (`publishedWeekStartISOs`). Publish weeks in the UI
  for events to appear in subscribed calendars.
- **PDF export times out**: the backend container must be able to resolve
  and reach `FRONTEND_BASE_URL`.
- **Redirect host certificate expired**: check that the DNS `A` record for
  `shiftplanner.wunderwerk.ai` still points to the Hetzner server
  (`dig +short shiftplanner.wunderwerk.ai`), then
  `docker restart shiftschedule-caddy-1`.
- **Bare-IP access to a Caddy host does not work by design**: Caddy only
  serves the configured `$DOMAIN` host.

## Legacy: IP-only variant

`docker-compose.ip.yml` serves the frontend on port 80 and the backend on
port 8000 without a domain/HTTPS (`APP_ORIGIN`/`VITE_API_URL` in `.env`).
Not used in production — kept for local/experimental setups.
