"""Public calendar validators must track changes even within one clock second."""

from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

import pytest
from fastapi.testclient import TestClient

from backend import ical_routes, publication, web
from backend.ical import ICS_FORMAT_SINCE
from backend.main import app
from .conftest import make_app_state, make_assignment

# Last change of the calendar; requests are timed against it.
CHANGED_AT = datetime(2026, 11, 16, 12, 0, 0, tzinfo=timezone.utc)


def http_date(value):
    return format_datetime(value, usegmt=True)


@pytest.fixture(params=["web", "ical", "clinician_ical"])
def public_calendar(request, monkeypatch):
    timestamp = CHANGED_AT
    payload = make_app_state(
        assignments=[make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1")],
        published_week_start_isos=["2026-01-05"],
    ).model_dump()
    publication = {
        "username": "cache-test", "token": "cache-token", "clinician_id": "clin-1",
        "updated_at": timestamp.isoformat(),
    }
    module = web if request.param == "web" else ical_routes
    monkeypatch.setattr(module, "_load_state_blob_and_updated_at", lambda _, **kwargs: (
        payload, timestamp, timestamp.isoformat(),
    ))
    if request.param == "web":
        monkeypatch.setattr(web, "_get_web_publication_by_token", lambda _, **kwargs: publication)
        url = "/v1/web/cache-token/week?start=2026-01-05"
    else:
        monkeypatch.setattr(ical_routes, "_get_publication_by_token", lambda _, **kwargs: (
            publication if request.param == "ical" else None
        ))
        monkeypatch.setattr(ical_routes, "_get_clinician_publication_by_token", lambda _, **kwargs: publication)
        url = "/v1/ical/cache-token.ics"
    return TestClient(app), url, payload


def test_same_second_schedule_edit_invalidates_etag(public_calendar):
    client, url, payload = public_calendar
    first = client.get(url)
    assert first.status_code == 200
    payload["clinicians"][0]["name"] = "Dr. Changed"
    updated = client.get(url, headers={"If-None-Match": first.headers["ETag"]})
    assert updated.status_code == 200
    assert updated.headers["ETag"] != first.headers["ETag"]
    assert "Dr. Changed" in updated.text


def at(monkeypatch, moment):
    monkeypatch.setattr(publication, "_utcnow", lambda: moment)


def test_response_in_the_second_of_the_change_has_no_last_modified(public_calendar, monkeypatch):
    client, url, payload = public_calendar
    at(monkeypatch, CHANGED_AT)
    first = client.get(url)
    assert first.status_code == 200
    # No date that a further change within this second could still match.
    assert "Last-Modified" not in first.headers
    payload["clinicians"][0]["name"] = "Dr. Same Second"
    at(monkeypatch, CHANGED_AT + timedelta(seconds=1))
    updated = client.get(url, headers={"If-None-Match": first.headers["ETag"]})
    assert updated.status_code == 200
    assert "Dr. Same Second" in updated.text


def test_if_modified_since_is_ignored_within_the_second_of_the_change(public_calendar, monkeypatch):
    client, url, _ = public_calendar
    at(monkeypatch, CHANGED_AT)
    response = client.get(url, headers={"If-Modified-Since": http_date(CHANGED_AT)})
    assert response.status_code == 200
    assert "ETag" in response.headers


def test_last_modified_is_sent_and_honoured_once_its_second_is_over(public_calendar, monkeypatch):
    client, url, _ = public_calendar
    at(monkeypatch, CHANGED_AT + timedelta(seconds=1))
    first = client.get(url)
    assert first.headers["Last-Modified"] == http_date(CHANGED_AT)
    assert client.get(url, headers={"If-Modified-Since": first.headers["Last-Modified"]}).status_code == 304
    older = http_date(CHANGED_AT - timedelta(seconds=1))
    assert client.get(url, headers={"If-Modified-Since": older}).status_code == 200


def test_feeds_from_before_timed_events_do_not_revalidate(monkeypatch):
    before_switch = datetime(2026, 1, 5, 12, 0, 0, tzinfo=timezone.utc)
    payload = make_app_state(published_week_start_isos=["2026-01-05"]).model_dump()
    monkeypatch.setattr(ical_routes, "_load_state_blob_and_updated_at", lambda _, **kwargs: (
        payload, before_switch, before_switch.isoformat(),
    ))
    monkeypatch.setattr(ical_routes, "_get_publication_by_token", lambda _, **kwargs: {
        "username": "cache-test", "token": "cache-token", "updated_at": before_switch.isoformat(),
    })
    at(monkeypatch, CHANGED_AT)
    response = TestClient(app).get(
        "/v1/ical/cache-token.ics", headers={"If-Modified-Since": http_date(before_switch)}
    )
    assert response.status_code == 200
    assert response.headers["Last-Modified"] == http_date(ICS_FORMAT_SINCE)


def test_nonmatching_etag_takes_precedence_over_modified_since(public_calendar, monkeypatch):
    client, url, _ = public_calendar
    at(monkeypatch, CHANGED_AT + timedelta(seconds=1))
    first = client.get(url)
    updated = client.get(url, headers={
        "If-None-Match": '"older-representation"',
        "If-Modified-Since": first.headers["Last-Modified"],
    })
    assert updated.status_code == 200


@pytest.mark.parametrize("validator", ["exact", "weak", "list", "wildcard"])
def test_unchanged_etag_still_returns_304(public_calendar, validator):
    client, url, _ = public_calendar
    first = client.get(url)
    etag = first.headers["ETag"]
    header = {"exact": etag, "weak": f"W/{etag}", "list": f'"old", {etag}', "wildcard": "*"}[validator]
    unchanged = client.get(url, headers={"If-None-Match": header})
    assert unchanged.status_code == 304
    assert unchanged.headers["ETag"] == etag


def test_public_etags_stay_bit_identical_after_helper_merge():
    """Subscribers must not refetch because of the shared ETag helper."""
    from backend.publication import _compute_etag

    state = {"clinicians": [{"id": "c1", "name": "Dr. Ä"}], "publishedWeekStartISOs": ["2026-01-05"]}
    publication = {"username": "alice", "token": "tok", "start_date_iso": None, "end_date_iso": None,
                   "cal_name": None, "created_at": "2026-01-01T00:00:00+00:00",
                   "updated_at": "2026-01-02T00:00:00+00:00"}
    state_at, publication_at = "2026-01-03T00:00:00+00:00", "2026-01-02T00:00:00+00:00"
    # Reference values computed with the former _compute_public_etag/_compute_public_week_etag.
    assert _compute_etag("tok", state_at, publication_at, state, publication) == (
        '"292ea7cb496e0e14a74cc2760b54387e789a83bef62979f2ee753dd6304e5763"')
    assert _compute_etag("tok", "", "", state, publication) == (
        '"f96a072e2c6856c17eb2221ae22a472697feb4a3df6a3583b6f111408dd1c04d"')
    assert _compute_etag("tok", "2026-01-05", state_at, publication_at, state, publication) == (
        '"cf7df9e410ff574f7275d34fe473c101146101431c15649b70abd61d81560835"')
