import logging
import os
import socket
import sys
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .agent_budget import router as agent_budget_router
from .auth import _ensure_admin_user, _ensure_test_user, router as auth_router
from .db import _get_connection
from .ical_routes import router as ical_router
from .pdf import router as pdf_router
from .schedule_changes import router as schedule_changes_router
from .solver import router as solver_router
from .state_routes import router as state_router
from .web import router as web_router


def _resolve_expected_port() -> int:
    """Determine the port this server is meant to bind.

    The startup check used to hardcode 8000, which aborted the
    README-documented fallback of running on --port 8001 while another
    instance occupies 8000.
    """
    argv = sys.argv
    for index, arg in enumerate(argv):
        if arg == "--port" and index + 1 < len(argv):
            try:
                return int(argv[index + 1])
            except ValueError:
                pass
        if arg.startswith("--port="):
            try:
                return int(arg.split("=", 1)[1])
            except ValueError:
                pass
    try:
        return int(os.environ.get("BACKEND_PORT", "8000"))
    except ValueError:
        return 8000


def _check_port_available(port: int = 8000) -> None:
    """Check if port is available, raise error if already in use."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(1)
    try:
        result = sock.connect_ex(("127.0.0.1", port))
        if result == 0:
            # Connection succeeded, meaning something is already listening
            raise RuntimeError(
                f"Port {port} is already in use by another process. "
                f"Please stop the other backend instance first (e.g., kill the process using: lsof -ti:{port} | xargs kill -9)"
            )
    finally:
        sock.close()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _check_port_available(_resolve_expected_port())
    conn = _get_connection()
    conn.close()
    _ensure_admin_user()
    _ensure_test_user()
    yield


app = FastAPI(title="Weekly Schedule API", version="0.1.0", lifespan=lifespan)

LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")
os.makedirs(LOG_DIR, exist_ok=True)
LOG_PATH = os.path.join(LOG_DIR, "api.log")
request_logger = logging.getLogger("api_requests")
if not request_logger.handlers:
    handler = logging.FileHandler(LOG_PATH)
    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s %(message)s", datefmt="%Y-%m-%dT%H:%M:%S"
    )
    handler.setFormatter(formatter)
    request_logger.addHandler(handler)
    request_logger.setLevel(logging.INFO)

CORS_ALLOW_ORIGINS = os.environ.get("CORS_ALLOW_ORIGINS", "")
CORS_ALLOW_ORIGIN_REGEX = os.environ.get(
    "CORS_ALLOW_ORIGIN_REGEX", r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"
)
_allowed_origins = [origin.strip() for origin in CORS_ALLOW_ORIGINS.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_origin_regex=None if _allowed_origins else CORS_ALLOW_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def _log_requests(request, call_next):
    start = time.time()
    try:
        response = await call_next(request)
    except Exception as exc:
        duration_ms = int((time.time() - start) * 1000)
        request_logger.error(
            "ERROR %s %s?%s %sms %s",
            request.method,
            request.url.path,
            request.url.query,
            duration_ms,
            exc,
        )
        raise
    duration_ms = int((time.time() - start) * 1000)
    request_logger.info(
        "%s %s?%s %s %sms",
        request.method,
        request.url.path,
        request.url.query,
        response.status_code,
        duration_ms,
    )
    return response

app.include_router(auth_router)
app.include_router(state_router)
app.include_router(web_router)
app.include_router(pdf_router)
app.include_router(ical_router)
app.include_router(solver_router)
app.include_router(agent_budget_router)
app.include_router(schedule_changes_router)


@app.on_event("startup")
def _recover_solver_runs() -> None:
    # A backend restart (deploy, crash) kills any in-flight solve; its run
    # row is still 'running'. Restart it once, mark the rest crashed —
    # results are never auto-applied, so replanning is safe.
    from .solver import recover_interrupted_runs

    recover_interrupted_runs()
