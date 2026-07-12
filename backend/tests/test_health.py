import os

os.environ["SCHEDULE_DB_PATH"] = ":memory:"

from fastapi.testclient import TestClient

from backend.main import app


def test_health() -> None:
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    # solver_running is what the deploy script polls so it never replaces
    # the container while a run is in flight.
    assert response.json() == {"status": "ok", "solver_running": False}
