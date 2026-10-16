# ShiftSchedule

ShiftSchedule is a weekly clinician scheduling app with a React + Vite frontend and a FastAPI backend. It supports drag-and-drop scheduling, class qualification rules, vacations, and per-day slot overrides. Required slots can be auto-filled by a CP-SAT optimizer (OR-Tools), a heuristic solver, or an LLM agent.

## Features
- Weekly schedule view with drag-and-drop within the same day
- "My plan" individual view next to the team plan (Team | My plan switch): one person's shifts as day, week or month, with the date on top or on the left, overnight shifts split at midnight, absences, coworkers per shift, and location tints
- Per-user preferences ("I am" link, saved views, start page per device class) stored per login via `GET/PUT /v1/me/preferences`, outside the shared calendar state; a PUT stores only the top-level keys it sends and keeps the rest, so a device cannot undo another device's changes to other keys (a key such as `savedViews` is replaced whole)
- Compact team week: a day's times stacked as rows ("Times: Stacked", default) or side by side as columns
- Optional location colors and a team "Color by: Person" mode (presentation only; planning is unaffected)
- Rest-day and vacation pools
- Required staffing per weekly-template slot (set per weekday and for holidays) and per-day overrides
- Clinician qualifications and preferences
- Vacation tracking
- AI planning drafts with explicit review and apply; CP-SAT and heuristic solvers also remain available through the API
- Rule checks and an automatic backup before applying; incomplete drafts need confirmation
- Revision-checked saving prevents older browser edits from overwriting newer calendar changes
- PDF export (A4 landscape) and public iCal subscription feeds (published weeks only)

## Tech Stack
- Frontend: React 18, TypeScript, Vite, Tailwind CSS
- Backend: FastAPI, OR-Tools, SQLite (calendar state as one JSON row per account in `app_state`; users, publications, solver runs, run feedback, snapshots, change log, per-user preferences and agent settings/spend in their own tables)

## Local Development (Step-by-step)
Prereqs:
- Python 3.10–3.12 (CI uses 3.11; the production image
  `mcr.microsoft.com/playwright/python:v1.49.0-jammy` runs Ubuntu 22.04's
  Python 3.10). Python 3.13 does not work: the pinned `ortools==9.11.4210`
  has no wheels for it.
- Node 20+ (22 recommended; CI and the frontend image use Node 22)

Auth setup (required for login):
```bash
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD=<choose-a-strong-password>
export JWT_SECRET=<long-random-string>   # e.g. openssl rand -base64 48
```
On first startup, the admin user is created if it doesn't already exist.
If the admin already exists, the password is not overwritten unless you set
`ADMIN_PASSWORD_RESET=true` to force a reset for local dev.

1) Install backend deps (add `-r backend/requirements-dev.txt` for pytest)
```bash
python3 -m pip install -r backend/requirements.txt
```

2) Install frontend deps
```bash
npm install
```

3) Start backend (Terminal 1)
```bash
python3 -m uvicorn backend.main:app --host localhost --port 8000
```

4) Start frontend (Terminal 2)
```bash
npm run dev -- --host localhost --port 5173
```

5) Open the app
- http://localhost:5173

### If a port is already in use
Backend:
```bash
python3 -m uvicorn backend.main:app --host localhost --port 8001
VITE_API_URL=http://localhost:8001 npm run dev -- --host localhost --port 5173
```

Frontend:
```bash
npm run dev -- --host localhost --port 5175
```

### Troubleshooting
- Solver not responding:
  - Check backend health: `curl http://localhost:8000/health`
  - Ensure `VITE_API_URL` matches the backend host/port.
  - For non-localhost hosts (LAN/remote), set CORS explicitly:
```bash
CORS_ALLOW_ORIGINS=http://my-host:5173 python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

## Deployment
Production runs at https://shiftplanner.truhn.ai (Proxmox LXC). Every push
to `main` runs CI (backend pytest; frontend typecheck, Vitest, production
build and critical Playwright specs) and, when green, deploys via SSH with
`scripts/deploy-compose.sh`, which waits for running plans before replacing
containers. Pushes that touch only Markdown files or the paths-ignored
workflows (`agent-arena`, `backend-logs`, `set-agent-model`) skip CI and
deploy. See [DEPLOY.md](DEPLOY.md) for the pipeline, both targets,
`.env` reference, and operations/troubleshooting.

## Repository Notes
- `node_modules/`, `dist/`, and local databases are ignored via `.gitignore`.
- State API clients must read `GET /v1/state` and echo its `revision` in `POST /v1/state`.
  Use the revision returned by each successful save for the next write. A stale or missing
  revision returns `409 state_changed`; reload and reconcile edits before retrying.
- Draft application can return `409 calendar_changed` or `409 partial_result` with a review
  message and `revision`. After user confirmation, retry with `force=true` and/or
  `allow_partial=true`, plus `expected_revision` from that response. Rule violations and
  empty aborted drafts cannot be overridden. Successful application saves a restorable backup.
