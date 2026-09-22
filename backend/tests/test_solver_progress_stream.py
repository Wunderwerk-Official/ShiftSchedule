"""SSE must wake its event loop and continuously validate the owning session."""
import asyncio
from datetime import datetime, timedelta, timezone
import threading
import time

from fastapi import Request
from fastapi.testclient import TestClient
import pytest

from backend import auth, db, solver
from backend.main import app


@pytest.fixture
def subscriber(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "stream.db"))
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    user = auth._create_user("stream-owner", "password", "user")
    token = auth._create_access_token(user)
    # Bearer schemes are case-insensitive for both initial and repeated auth.
    header = "bearer " + token
    request = Request({"type": "http", "headers": [(b"authorization", header.encode())]})
    return request, auth._get_current_user(header), token


def test_progress_requires_authorization_header_even_when_query_has_token(subscriber):
    _, _, token = subscriber
    response = TestClient(app).get("/v1/solve/progress", params={"token": token})
    assert response.status_code == 401


def test_monitor_thread_progress_wakes_idle_stream_without_keepalive(subscriber):
    request, user, _ = subscriber
    errors = []

    async def receive():
        response = await solver.solver_progress_stream(request, user)
        stream = response.body_iterator
        assert '"connected"' in await anext(stream)

        def emit_from_monitor():
            time.sleep(0.025)  # Let the receiver suspend on the empty queue.
            try:
                solver._broadcast_solver_progress(user.username, "thread-run", "phase", {"phase": "fresh"})
            except Exception as exc:
                errors.append(exc)

        worker = threading.Thread(target=emit_from_monitor)
        worker.start()
        started = time.monotonic()
        try:
            event = await asyncio.wait_for(anext(stream), timeout=1)
            assert '"fresh"' in event and '"thread-run"' in event
            assert not errors
            assert time.monotonic() - started < 0.5
        finally:
            await stream.aclose()
            worker.join(timeout=1)

    asyncio.run(receive(), debug=False)
    assert not [entry for entry in solver._solver_progress_subscribers if entry[0] == user.username]


@pytest.mark.parametrize("invalidation", ["expired", "replaced"])
def test_existing_stream_stops_before_next_event_after_session_invalidated(subscriber, monkeypatch, invalidation):
    request, user, _ = subscriber

    async def receive():
        response = await solver.solver_progress_stream(request, user)
        stream = response.body_iterator
        assert '"connected"' in await anext(stream)
        if invalidation == "replaced":
            auth._delete_user(user.username)
            auth._create_user(user.username, "new-password", "user")
        else:
            class FutureDatetime(datetime):
                @classmethod
                def now(cls, tz=None):
                    return datetime.now(tz or timezone.utc) + timedelta(days=2)
            monkeypatch.setattr(auth.jwt, "datetime", FutureDatetime)
        solver._broadcast_solver_progress(user.username, "new-run", "phase", {"secret": "new account"})
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(anext(stream), timeout=1)
        assert not [entry for entry in solver._solver_progress_subscribers if entry[0] == user.username]

    asyncio.run(receive())
