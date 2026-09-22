import logging

import pytest

from backend.request_logging import SafeAccessFilter, safe_request_target


@pytest.mark.parametrize("url,expected", [
    ("/v1/solve/progress?token=secret&extra=x", "/v1/solve/progress"),
    ("/api/v1/ical/secret.ics?clinician=x", "/api/v1/ical/[redacted].ics"),
    ("/v1/web/secret/week?startISO=2026-01-05", "/v1/web/[redacted]/week"),
    ("/public/secret", "/public/[redacted]"),
    ("/v1/ical/s%65cret.ics", "/v1/ical/[redacted].ics"),
    ("/v1/web/secret/wek", "/v1/web/[redacted]/wek"),
    ("/v1/ical/secret.icsx", "/v1/ical/[redacted]"),
    ("/api/v1/web/secret", "/api/v1/web/[redacted]"),
    ("/v1/web/publish/rotate", "/v1/web/publish/rotate"),
    ("/v1/ical/publish", "/v1/ical/publish"),
    ("//[", "//["),
    ("/v1/state", "/v1/state"),
])
def test_sensitive_request_targets_are_redacted(url, expected):
    assert safe_request_target(url) == expected


def test_uvicorn_access_record_does_not_retain_bearer_url():
    record = logging.LogRecord("uvicorn.access", logging.INFO, "", 0,
                               '%s - "%s %s HTTP/%s" %s',
                               ("client", "GET", "/v1/solve/progress?token=secret", "1.1", 200), None)
    assert SafeAccessFilter().filter(record)
    assert "secret" not in record.getMessage()
    assert "200" in record.getMessage()
