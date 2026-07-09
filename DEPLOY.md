# Deployment

Production runs on a single Hetzner Cloud server with Docker Compose
(`docker-compose.yml`):

- `backend` — FastAPI (internal port 8000)
- `frontend` — static Vite build served by Nginx (internal port 80)
- `caddy` — reverse proxy + automatic HTTPS (Let's Encrypt), the only
  container with published ports (80/443)

Routing: `https://<DOMAIN>/` → frontend, `https://<DOMAIN>/api/*` → backend
(`/api` prefix is stripped by Caddy). App data lives in the `backend_data`
Docker volume (`/data/schedule.db`), not in the repo directory.

## Automated deployment (CI/CD)

Deploys are automated via GitHub Actions
([.github/workflows/ci-cd.yml](.github/workflows/ci-cd.yml)):

1. **CI** on every push to `main` and every PR — two parallel jobs:
   - Backend: Python 3.11, `pytest` (slow solver benchmark excluded)
   - Frontend: Node 20, `tsc` typecheck + Vitest
2. **Deploy** only on push to `main` and only if both CI jobs pass.
   A `concurrency` group prevents overlapping deploys. The job SSHes into
   the server and runs:
   ```
   cd $DEPLOY_PATH
   git pull --ff-only
   docker compose -f docker-compose.yml up -d --build
   ```
   followed by an in-container health check (`GET /health` inside the
   backend container, retried up to 150 s).

So: **merging/pushing to `main` deploys to production.** No PR is deployed.

### GitHub secrets & variables

Configured under *Settings → Secrets and variables → Actions*:

| Kind | Name | Content |
|------|------|---------|
| Secret | `SSH_PRIVATE_KEY` | Dedicated ed25519 deploy key (private part) |
| Secret | `SSH_HOST` | Server IP/hostname |
| Secret | `SSH_USER` | SSH user |
| Secret | `SSH_KNOWN_HOSTS` | Pinned `ssh-keyscan` output for the server |
| Variable | `DEPLOY_PATH` | Repo path on the server |
| Variable | `COMPOSE_FILE` | Optional; defaults to `docker-compose.yml` |
| Variable | `SSH_PORT` | Optional; defaults to `22` |

Application secrets (admin credentials, `JWT_SECRET`, `ANTHROPIC_API_KEY`, …)
live **only** in the server's `.env` — never in GitHub.

### Rotating the deploy key

```bash
ssh-keygen -t ed25519 -C "gh-actions-deploy shiftschedule" -f deploykey -N ""
# public part → server:
ssh <user>@<server> 'cat >> ~/.ssh/authorized_keys' < deploykey.pub
# private part → GitHub:
gh secret set SSH_PRIVATE_KEY -R <owner>/<repo> < deploykey
rm deploykey deploykey.pub
```

## Manual deploy (fallback)

```bash
ssh <user>@<server>
cd /opt/shiftschedule
git pull --ff-only
docker compose -f docker-compose.yml up -d --build
# health:
docker compose -f docker-compose.yml exec -T backend \
  python -c "import urllib.request as u; print(u.urlopen('http://localhost:8000/health', timeout=5).read())"
```

## First-time server setup

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
LETSENCRYPT_EMAIL=admin@example.com
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<choose-a-strong-password>
JWT_SECRET=<long-random-string, e.g. `openssl rand -base64 48`>
JWT_EXPIRE_MINUTES=720
PUBLIC_BASE_URL=https://schedule.example.com/api
FRONTEND_BASE_URL=https://schedule.example.com

# Optional — AI agent solver (solver_mode="agent"); without a key, agent
# runs fall back to the heuristic seed plan:
ANTHROPIC_API_KEY=
```

Notes:
- `PUBLIC_BASE_URL` is used to build public iCal subscription URLs.
- `FRONTEND_BASE_URL` is used by the backend's PDF export (Playwright loads
  the frontend through this URL — it must be reachable *from inside* the
  backend container, i.e. normally the public domain).
- To change the admin password of an **existing** installation: set the new
  `ADMIN_PASSWORD`, additionally set `ADMIN_PASSWORD_RESET=true`, run
  `docker compose up -d backend`, then remove the flag again.
- Changing `JWT_SECRET` invalidates all active sessions (users must log in
  again).

## Operations

Logs:
```bash
docker compose -f docker-compose.yml logs -f --tail 100 backend
docker logs shiftschedule-caddy-1 --since 1h
```

Backup of the app data (without stopping anything):
```bash
docker run --rm -v shiftschedule_backend_data:/data:ro -v /root:/backup alpine \
  sh -c "cd /data && tar czf /backup/backend_data_backup_$(date +%Y%m%d_%H%M%S).tar.gz ."
```

## Troubleshooting

- **Site unreachable, certificate expired**: check that the DNS `A` record
  for `$DOMAIN` still points to the server (`dig +short $DOMAIN`). Without
  it, Let's Encrypt renewals fail. After fixing DNS,
  `docker restart shiftschedule-caddy-1` forces an immediate renewal.
- **Bare-IP access does not work by design**: Caddy only serves the
  configured `$DOMAIN` host; `https://<server-ip>` is rejected.
- **iCal feeds are empty**: feeds only contain weeks that were explicitly
  published in the app (`publishedWeekStartISOs`). Publish weeks in the UI
  for events to appear in subscribed calendars.
- **PDF export times out**: the backend container must be able to resolve
  and reach `FRONTEND_BASE_URL` (public DNS + valid certificate).

## Legacy: IP-only variant

`docker-compose.ip.yml` serves the frontend on port 80 and the backend on
port 8000 without a domain/HTTPS (`APP_ORIGIN`/`VITE_API_URL` in `.env`).
Not used in production — kept for local/experimental setups.

## Second target: Proxmox LXC (shiftplanner.truhn.ai)

The `deploy-truhn` job in the same workflow deploys to a Proxmox LXC
container (VMID 105, internal IP `10.10.10.6`) at the institute. Details:

- **Network path**: public DNS for `shiftplanner.truhn.ai` points at the
  Hetzner bastion (`49.13.89.75`), which tunnels the domain to the
  container. SSH reaches the container only THROUGH the bastion
  (`proxy_*` options of `appleboy/ssh-action`); the bastion's ForceCommand
  permits pure TCP forwarding, never command execution.
- **Auth**: one key pair (`secrets.DEPLOY_SSH_KEY`) is authorized for
  `dtruhn` on the bastion and for `root` inside the container.
- **Stack**: `docker-compose.proxied.yml` — backend + frontend only, the
  frontend published on `127.0.0.1:5000` (never `0.0.0.0`: the app would
  otherwise be reachable unauthenticated from the internal `10.10.10.0/24`
  subnet). The container's own nginx terminates TLS for the domain and
  proxies to that port.
- **Bootstrap**: the job clones the public repo to `/opt/app` on first run,
  generates `.env` (random admin password + JWT secret, never echoed to
  logs — read them via `ssh -J dtruhn@49.13.89.75:4444 dtruhn@10.10.10.6`,
  then `sudo cat /opt/app/.env`), and installs `/opt/app/run.sh` for the
  provisioned `app.service` autostart convention (compose up + sleep).
- **LLM config**: no API keys ship with the deploy. An admin sets the
  Anthropic key OR the self-hosted OpenAI-compatible endpoint (base URL,
  model, key, TLS verification) in Settings → Solver after first login.
