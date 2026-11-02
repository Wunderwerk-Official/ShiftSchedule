"""Each PDF renders one saved revision, even while the live calendar changes."""
import json
import signal
import threading
from contextlib import nullcontext
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend import pdf
from .conftest import make_app_state


@pytest.fixture(params=["week", "weeks"])
def export_case(request, monkeypatch):
    state = make_app_state()
    state.revision = "saved-revision"
    rendered = []
    routes = {}
    class Page:
        def route(self, pattern, handler): routes[pattern] = handler
        def add_init_script(self, script): pass
        def emulate_media(self, **kwargs): pass
        def goto(self, *args, **kwargs):
            # Simulate another browser changing the calendar during startup.
            state.clinicians[0].name = "Newer live name"
            state.revision = "new-revision"
        def wait_for_function(self, *args, **kwargs): pass
        def pdf(self, **kwargs):
            routes["**/v1/state"](SimpleNamespace(fulfill=lambda **response: rendered.append(json.loads(response["body"]))))
            return b"%PDF-fake-render"
    browser = SimpleNamespace(new_page=lambda **kwargs: Page(), close=lambda: None)
    monkeypatch.setattr(pdf, "sync_playwright", lambda: nullcontext(None))
    monkeypatch.setattr(pdf, "_launch_chromium", lambda _: browser)
    monkeypatch.setattr(pdf, "_browser_pid", lambda _: 4242)
    monkeypatch.setattr(pdf, "authenticated_account_connection", lambda _: nullcontext(None))
    monkeypatch.setattr(pdf, "_load_state", lambda _, **kwargs: state)
    def call(revision="saved-revision"):
        kwargs = dict(start="2026-01-05", expected_revision=revision,
                      authorization="Bearer test", current_user=SimpleNamespace(username="owner"))
        if request.param == "weeks":
            return pdf.export_weeks_pdf(weeks=2, **kwargs)
        return pdf.export_week_pdf(**kwargs)
    return state, rendered, call


def test_print_uses_snapshot_loaded_before_browser_start(export_case):
    state, rendered, call = export_case
    old_name = state.clinicians[0].name
    response = call()
    assert response.headers["X-Calendar-Revision"] == "saved-revision"
    assert state.revision == "new-revision"
    assert rendered[0]["revision"] == "saved-revision"
    assert rendered[0]["clinicians"][0]["name"] == old_name


def test_later_batch_request_refuses_a_different_revision(export_case):
    _, rendered, call = export_case
    call()
    with pytest.raises(HTTPException) as failure:
        call()
    assert failure.value.status_code == 409
    assert "changed during export" in failure.value.detail
    assert len(rendered) == 1


def test_filenames_name_the_printed_days(export_case, request):
    _, _, call = export_case
    disposition = call().headers["Content-Disposition"]
    expected = ("shift-planner-2026-01-05-to-2026-01-18.pdf"
                if request.node.callspec.params["export_case"] == "weeks"
                else "shift-planner-2026-01-05.pdf")
    assert disposition == f'attachment; filename="{expected}"'


def test_render_failure_is_logged_with_print_path(export_case, monkeypatch, caplog):
    _, _, call = export_case

    def broken_launch(_):
        raise RuntimeError("chromium missing")

    monkeypatch.setattr(pdf, "_launch_chromium", broken_launch)
    with caplog.at_level("ERROR", logger="backend.pdf"), pytest.raises(HTTPException) as failure:
        call()
    assert failure.value.status_code == 500
    records = [r for r in caplog.records if r.name == "backend.pdf" and r.levelname == "ERROR"]
    assert records and "/print/week" in records[0].getMessage()


def test_render_timeout_is_logged_as_warning(export_case, monkeypatch, caplog):
    _, _, call = export_case

    def slow_launch(_):
        raise pdf.PlaywrightTimeoutError("timeout")

    monkeypatch.setattr(pdf, "_launch_chromium", slow_launch)
    with caplog.at_level("WARNING", logger="backend.pdf"), pytest.raises(HTTPException) as failure:
        call()
    assert failure.value.status_code == 504
    assert any(r.name == "backend.pdf" and r.levelname == "WARNING" for r in caplog.records)


def _record_render(monkeypatch, page_pdf=None):
    """Fake browser that records the print URL, viewport and PDF options."""
    state = make_app_state()
    state.revision = "saved-revision"
    seen = {}

    class Page:
        def route(self, pattern, handler): pass
        def add_init_script(self, script): pass
        def emulate_media(self, **kwargs): pass
        def goto(self, url, **kwargs): seen["url"] = url
        def wait_for_function(self, *args, **kwargs): pass
        def pdf(self, **kwargs):
            seen["pdf"] = kwargs
            return page_pdf() if page_pdf else b"%PDF-fake-render"

    def new_page(**kwargs):
        seen["viewport"] = kwargs["viewport"]
        return Page()

    browser = SimpleNamespace(new_page=new_page, close=lambda: None)
    monkeypatch.setattr(pdf, "sync_playwright", lambda: nullcontext(None))
    monkeypatch.setattr(pdf, "_launch_chromium", lambda _: browser)
    monkeypatch.setattr(pdf, "_browser_pid", lambda _: 4242)
    monkeypatch.setattr(pdf, "authenticated_account_connection", lambda _: nullcontext(None))
    monkeypatch.setattr(pdf, "_load_state", lambda _, **kwargs: state)
    return seen


def _export(endpoint, start, **extra):
    kwargs = dict(start=start, expected_revision=None, layout="landscape",
                  authorization="Bearer test", current_user=SimpleNamespace(username="owner"))
    kwargs.update(extra)
    weeks = kwargs.pop("weeks", 3)
    if endpoint == "weeks":
        return pdf.export_weeks_pdf(weeks=weeks, **kwargs)
    return pdf.export_week_pdf(**kwargs)


@pytest.mark.parametrize("start", ["2026-11-04", "04.11.2026", "2026-11-08"])
def test_start_inside_a_week_prints_and_names_its_whole_weeks(monkeypatch, start):
    """The print pages show Monday to Sunday: request and file name start on that Monday."""
    seen = _record_render(monkeypatch)
    week = _export("week", start)
    assert "/print/week?start=2026-11-02" in seen["url"]
    assert week.headers["Content-Disposition"] == 'attachment; filename="shift-planner-2026-11-02.pdf"'
    weeks = _export("weeks", start, weeks=3)
    assert "/print/weeks?start=2026-11-02&weeks=3" in seen["url"]
    assert weeks.headers["Content-Disposition"] == (
        'attachment; filename="shift-planner-2026-11-02-to-2026-11-22.pdf"'
    )


@pytest.mark.parametrize("endpoint", ["week", "weeks"])
def test_render_past_the_time_limit_stops_the_browser_and_answers_504(monkeypatch, caplog, endpoint):
    """page.pdf() has no timeout of its own: the deadline kills the browser instead."""
    killed = threading.Event()
    kills = []

    def fake_kill(pid, sig):
        kills.append((pid, sig))
        killed.set()

    def hanging_pdf():
        # Stands in for a print that never finishes; the browser's death ends it.
        assert killed.wait(5), "the deadline never stopped the browser"
        raise RuntimeError("Target page, context or browser has been closed")

    _record_render(monkeypatch, page_pdf=hanging_pdf)
    monkeypatch.setattr(pdf, "PDF_RENDER_TIMEOUT_SECONDS", 0.2)
    monkeypatch.setattr(pdf.os, "kill", fake_kill)
    with caplog.at_level("WARNING", logger="backend.pdf"), pytest.raises(HTTPException) as failure:
        _export(endpoint, "2026-01-05")
    assert failure.value.status_code == 504
    assert failure.value.detail == "PDF render timed out."
    assert kills == [(4242, signal.SIGKILL)]
    assert not any(r.levelname == "ERROR" for r in caplog.records if r.name == "backend.pdf")


def test_page_steps_never_wait_past_the_render_deadline(monkeypatch):
    deadline = pdf._RenderDeadline(5)
    assert 4000 < deadline.step_timeout_ms() <= 5000
    assert pdf._RenderDeadline(60).step_timeout_ms() == 20000
    # Playwright reads 0 as "no limit": an expired deadline still gives a limit.
    assert pdf._RenderDeadline(-1).step_timeout_ms() == 1


def test_a_finished_render_cancels_the_deadline(monkeypatch):
    kills = []
    _record_render(monkeypatch)
    monkeypatch.setattr(pdf, "PDF_RENDER_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(pdf.os, "kill", lambda pid, sig: kills.append(pid))
    assert _export("week", "2026-01-05").body == b"%PDF-fake-render"
    threading.Event().wait(0.15)
    assert kills == []


@pytest.mark.parametrize("endpoint", ["week", "weeks"])
@pytest.mark.parametrize("layout", ["landscape", "portrait"])
def test_layout_sets_page_orientation_and_print_route(monkeypatch, endpoint, layout):
    """Portrait renders the compact week (print page `layout=portrait`) on A4 portrait."""
    seen = _record_render(monkeypatch)
    _export(endpoint, "2026-01-05", layout=layout, weeks=2)

    portrait = layout == "portrait"
    assert seen["pdf"]["landscape"] is (not portrait)
    assert seen["viewport"] == ({"width": 794, "height": 1122} if portrait else {"width": 1122, "height": 794})
    assert seen["url"].endswith("&layout=portrait") is portrait
