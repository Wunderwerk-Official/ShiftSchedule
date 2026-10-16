"""Each PDF renders one saved revision, even while the live calendar changes."""
import json
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


def test_filenames_stay_per_endpoint(export_case, request):
    _, _, call = export_case
    disposition = call().headers["Content-Disposition"]
    expected = ("shift-planner-2026-01-05-2w.pdf" if request.node.callspec.params["export_case"] == "weeks"
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


@pytest.mark.parametrize("endpoint", ["week", "weeks"])
@pytest.mark.parametrize("layout", ["landscape", "portrait"])
def test_layout_sets_page_orientation_and_print_route(monkeypatch, endpoint, layout):
    """Portrait renders the compact week (print page `layout=portrait`) on A4 portrait."""
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
            return b"%PDF-fake-render"

    def new_page(**kwargs):
        seen["viewport"] = kwargs["viewport"]
        return Page()

    browser = SimpleNamespace(new_page=new_page, close=lambda: None)
    monkeypatch.setattr(pdf, "sync_playwright", lambda: nullcontext(None))
    monkeypatch.setattr(pdf, "_launch_chromium", lambda _: browser)
    monkeypatch.setattr(pdf, "authenticated_account_connection", lambda _: nullcontext(None))
    monkeypatch.setattr(pdf, "_load_state", lambda _, **kwargs: state)
    kwargs = dict(start="2026-01-05", expected_revision=None, layout=layout,
                  authorization="Bearer test", current_user=SimpleNamespace(username="owner"))
    if endpoint == "weeks":
        pdf.export_weeks_pdf(weeks=2, **kwargs)
    else:
        pdf.export_week_pdf(**kwargs)

    portrait = layout == "portrait"
    assert seen["pdf"]["landscape"] is (not portrait)
    assert seen["viewport"] == ({"width": 794, "height": 1122} if portrait else {"width": 1122, "height": 794})
    assert seen["url"].endswith("&layout=portrait") is portrait
