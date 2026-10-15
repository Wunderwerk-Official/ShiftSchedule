import json
import logging
import os
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

from .auth import _extract_bearer_token, _get_current_user
from .account_lifecycle import authenticated_account_connection
from .models import UserPublic
from .state import _load_state, _parse_date_input

logger = logging.getLogger(__name__)

router = APIRouter()

FRONTEND_BASE_URL = (
    os.environ.get("FRONTEND_BASE_URL")
    or os.environ.get("APP_ORIGIN")
    or "http://localhost:5173"
).strip()

# Optional override for environments where Playwright's own pinned Chromium
# build is not installed but a system/pre-provisioned Chromium exists.
PDF_CHROMIUM_EXECUTABLE = os.environ.get("PDF_CHROMIUM_EXECUTABLE", "").strip()


def _launch_chromium(playwright):
    if PDF_CHROMIUM_EXECUTABLE:
        return playwright.chromium.launch(executable_path=PDF_CHROMIUM_EXECUTABLE)
    return playwright.chromium.launch()


def _export_snapshot(current_user: UserPublic, expected_revision: Optional[str]):
    with authenticated_account_connection(current_user) as conn:
        state = _load_state(current_user.username, connection=conn)
    if expected_revision is not None and state.revision != expected_revision:
        raise HTTPException(status_code=409, detail=(
            "The calendar changed during export. Already downloaded files use the previous "
            "revision; reload and start a new export for the updated calendar."
        ))
    return state.model_dump_json(), state.revision


def _bind_print_snapshot(page, snapshot: str):
    # The print page must never read a newer calendar while Chromium starts
    # or renders subsequent weeks. This snapshot belongs to this request only.
    page.route("**/v1/state", lambda route: route.fulfill(
        status=200, content_type="application/json", body=snapshot,
    ))


def _render_pdf(
    print_path: str,
    filename: str,
    current_user: UserPublic,
    authorization: Optional[str],
    expected_revision: Optional[str],
) -> Response:
    # _get_current_user already rejected requests without a bearer token.
    token = _extract_bearer_token(authorization)
    snapshot, revision = _export_snapshot(current_user, expected_revision)
    print_url = f"{FRONTEND_BASE_URL.rstrip('/')}{print_path}"

    try:
        with sync_playwright() as playwright:
            browser = _launch_chromium(playwright)
            try:
                # Set viewport to A4 landscape dimensions at 96 DPI
                # 297mm x 210mm = 1122 x 794 px at 96 DPI
                page = browser.new_page(viewport={"width": 1122, "height": 794})
                _bind_print_snapshot(page, snapshot)
                page.add_init_script(
                    "localStorage.setItem('authToken', %s);" % json.dumps(token)
                )
                page.emulate_media(media="print")
                page.goto(print_url, wait_until="networkidle", timeout=20000)
                page.wait_for_function("window.__PDF_READY__ === true", timeout=20000)
                # Frontend already scales content to fit A4 printable area with margins,
                # so we use scale=1.0 and no additional PDF margins
                pdf_bytes = page.pdf(
                    format="A4",
                    landscape=True,
                    print_background=True,
                    scale=1.0,
                    margin={"top": "0mm", "right": "0mm", "bottom": "0mm", "left": "0mm"},
                )
            finally:
                browser.close()
    except PlaywrightTimeoutError as exc:
        logger.warning("PDF render timed out for %s", print_url)
        raise HTTPException(status_code=504, detail="PDF render timed out.") from exc
    except Exception as exc:
        # HTTPException causes are not logged by FastAPI; keep the diagnosis.
        logger.exception("PDF render failed for %s", print_url)
        raise HTTPException(status_code=500, detail="PDF render failed.") from exc

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"',
                 "X-Calendar-Revision": revision or ""},
    )


@router.get("/v1/pdf/week")
def export_week_pdf(
    start: str = Query(..., min_length=8),
    expected_revision: Optional[str] = Query(default=None),
    authorization: Optional[str] = Header(default=None),
    current_user: UserPublic = Depends(_get_current_user),
):
    start_iso = _parse_date_input(start)
    if not start_iso:
        raise HTTPException(status_code=400, detail="Start date required.")
    return _render_pdf(
        f"/print/week?start={start_iso}", f"shift-planner-{start_iso}.pdf",
        current_user, authorization, expected_revision,
    )


@router.get("/v1/pdf/weeks")
def export_weeks_pdf(
    start: str = Query(..., min_length=8),
    weeks: int = Query(..., ge=1, le=55),
    expected_revision: Optional[str] = Query(default=None),
    authorization: Optional[str] = Header(default=None),
    current_user: UserPublic = Depends(_get_current_user),
):
    start_iso = _parse_date_input(start)
    if not start_iso:
        raise HTTPException(status_code=400, detail="Start date required.")
    return _render_pdf(
        f"/print/weeks?start={start_iso}&weeks={weeks}", f"shift-planner-{start_iso}-{weeks}w.pdf",
        current_user, authorization, expected_revision,
    )
