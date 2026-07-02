import json
import os
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

from .auth import _extract_bearer_token, _get_current_user
from .models import UserPublic
from .state import _parse_date_input

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


@router.get("/v1/pdf/week")
def export_week_pdf(
    start: str = Query(..., min_length=8),
    authorization: Optional[str] = Header(default=None),
    current_user: UserPublic = Depends(_get_current_user),
):
    _ = current_user
    start_iso = _parse_date_input(start)
    if not start_iso:
        raise HTTPException(status_code=400, detail="Start date required.")
    token = _extract_bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token.")
    base_url = FRONTEND_BASE_URL.rstrip("/")
    print_url = f"{base_url}/print/week?start={start_iso}"

    try:
        with sync_playwright() as playwright:
            browser = _launch_chromium(playwright)
            try:
                # Set viewport to A4 landscape dimensions at 96 DPI
                # 297mm x 210mm = 1122 x 794 px at 96 DPI
                page = browser.new_page(viewport={"width": 1122, "height": 794})
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
        raise HTTPException(status_code=504, detail="PDF render timed out.") from exc
    except Exception as exc:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail="PDF render failed.") from exc

    filename = f"shift-planner-{start_iso}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/v1/pdf/weeks")
def export_weeks_pdf(
    start: str = Query(..., min_length=8),
    weeks: int = Query(..., ge=1, le=55),
    authorization: Optional[str] = Header(default=None),
    current_user: UserPublic = Depends(_get_current_user),
):
    _ = current_user
    start_iso = _parse_date_input(start)
    if not start_iso:
        raise HTTPException(status_code=400, detail="Start date required.")
    token = _extract_bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token.")
    base_url = FRONTEND_BASE_URL.rstrip("/")
    print_url = f"{base_url}/print/weeks?start={start_iso}&weeks={weeks}"

    try:
        with sync_playwright() as playwright:
            browser = _launch_chromium(playwright)
            try:
                # Set viewport to A4 landscape dimensions at 96 DPI
                # 297mm x 210mm = 1122 x 794 px at 96 DPI
                page = browser.new_page(viewport={"width": 1122, "height": 794})
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
                    margin={
                        "top": "0mm",
                        "right": "0mm",
                        "bottom": "0mm",
                        "left": "0mm",
                    },
                )
            finally:
                browser.close()
    except PlaywrightTimeoutError as exc:
        raise HTTPException(status_code=504, detail="PDF render timed out.") from exc
    except Exception as exc:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail="PDF render failed.") from exc

    filename = f"shift-planner-{start_iso}-{weeks}w.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
