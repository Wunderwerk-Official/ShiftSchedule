# ShiftSchedule

ShiftSchedule is a weekly clinician scheduling app with a React + Vite frontend and a FastAPI backend. It supports drag-and-drop scheduling, class qualification rules, vacations, and per-day slot overrides. Required slots can be auto-filled by a CP-SAT optimizer (OR-Tools), a heuristic solver, or an LLM agent.

## Features
- Weekly schedule view with drag-and-drop within the same day
- Rest-day and vacation pools
- Per-class minimum slots (weekday vs weekend) and per-day overrides
- Clinician qualifications and preferences
- Vacation tracking
- Auto-allocate day/week with a solver — Optimizer (CP-SAT/heuristic) or AI Agent (Claude), selectable in the planning panel
- PDF export (A4 landscape) and public iCal subscription feeds (published weeks only)

## Tech Stack
- Frontend: React 18, TypeScript, Vite, Tailwind CSS
- Backend: FastAPI, OR-Tools, SQLite (single JSON state row)

## Local Development (Step-by-step)
Prereqs:
- Python 3.11 (matches CI and the production image)
- Node 18+

Auth setup (required for login):
```bash
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD=<choose-a-strong-password>
export JWT_SECRET=<long-random-string>
```
On first startup, the admin user is created if it doesn't already exist.
If the admin already exists, the password is not overwritten unless you set
`ADMIN_PASSWORD_RESET=true` to force a reset for local dev.

1) Install backend deps
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
Production deploys are automated: every green push to `main` runs CI
(pytest + typecheck/Vitest) and then deploys to the server via SSH.
See [DEPLOY.md](DEPLOY.md) for the pipeline, server setup, `.env`
reference, and operations/troubleshooting.

## Repository Notes
- `node_modules/`, `dist/`, and local databases are ignored via `.gitignore`.
