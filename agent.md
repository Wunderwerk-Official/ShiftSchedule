# agent.md — Weekly Schedule System (Current State)

This repo is a doctors/clinicians scheduling system with a React frontend and a FastAPI backend + OR-Tools solver. It is local-first and stores state in SQLite via the API.

---

## Quick Start for New Agents
Where to look first
- UI logic + state: `src/pages/WeeklySchedulePage.tsx`
- Grid rendering + drag/drop: `src/components/schedule/ScheduleGrid.tsx`
- Template builder (Settings → Weekly Calendar Template): `src/components/schedule/WeeklyTemplateBuilder.tsx`
- Shared calendar layout helpers (main/public/print): `src/lib/calendarView.ts`
- Slot/template normalization + row building: `src/lib/shiftRows.ts`
- Rendered assignment map + pool logic + overlaps: `src/lib/schedule.ts`
- Backend normalization + persistence: `backend/state.py`, `backend/db.py`
- CP-SAT Solver: `backend/solver.py`
- Heuristic Solver v2: `backend/heuristic/solver_v2.py` (alternative fast solver)
- **Constraint validator (LLM-backend-ready): `backend/validation.py`** — pure, solver-independent hard-constraint checker; see section 12.
- Solver live stats: `src/lib/solverStats.ts`
- E2E tests + diagnostics: `e2e/fixtures.ts`, `e2e/app.spec.ts`, `e2e/colband-explosion.spec.ts`
- API client: `src/api/client.ts`
- Settings UI: `src/components/schedule/SettingsView.tsx`

Where to verify behavior
- UI rules, drag/drop, overlaps: `src/components/schedule/ScheduleGrid.tsx`, `src/lib/schedule.ts`
- Template/slot migration: `src/lib/shiftRows.ts` and `backend/state.py`
- Solver constraints: `backend/solver.py`, `backend/heuristic/solver_v2.py`
- Public/published views: `src/pages/PublicWeekPage.tsx`, `backend/web.py`
  - Public + print routes use the same calendar layout helpers as the main view (`src/lib/calendarView.ts`).

---

## 1) Tech Stack
Frontend
- React 18 + TypeScript
- Vite
- Tailwind CSS

Backend
- FastAPI + Uvicorn
- OR-Tools CP-SAT
- SQLite persistence (per-user JSON state rows)
- Auth: python-jose (JWT), passlib (password hashing)

---

## 2) Core UI
Top bar
- Title is clickable and returns to calendar view.
- Button order (left → right): Settings, Help, Theme toggle, User avatar.
- Settings/Help buttons turn into a highlighted **Back** state when active.
- Open slots badge lives in the schedule card header (green when all slots filled).
- Responsive: stacks on small screens; avatar row moves below the main controls.

Schedule card
- Week navigator lives inside the card header; range label uses DD.MM.YYYY (or DD.MM.YYYY – DD.MM.YYYY); Today button sits next to the arrows.
- **Week picker**: clicking on the date range label opens a custom calendar popover (not the native browser picker). The calendar displays weeks as selectable rows—hovering highlights the entire week, and clicking any day navigates to the Monday of that week. A small calendar icon appears next to the date label. "Select a week" hint text and a "This week" button are included. Click-outside detection closes the picker.
- On mobile, the schedule renders a single day with a day navigator (label between arrows, Today next to them).
- Today is shown by circling the day number in the header.
- Week starts Monday; weekend/holiday styling is header-only: weekend header light gray, holiday header light lavender; holiday name is a tiny purple label under the day.
- Mobile: grid uses touch scrolling and slightly tighter paddings.
- Calendar grid should not scroll vertically; it expands and the page scrolls. Horizontal scrolling remains.
- Automated shift planning and Export are separate panels in the schedule view; Export panel opens the same modal as before.
- Vacation Planner panel sits between Automated Shift Planning and Export; it opens the full-screen Vacation Overview.
- Control row between section rows and pool rows with icon buttons:
  - Only necessary, Distribute all, Reset to free (week and per day), with tooltips.
- Week publication uses a **Publish** toggle pill in the header, placed to the right of the Open Slots badge.
- Rule violations badge sits next to Open Slots only when violations exist; click to see details and highlight the related pills (red).
- Split shifts badge: shows count of non-consecutive shifts (gaps between assignments for the same clinician on the same day). Hover badge to highlight all split shift pills; hover/click individual items in the popover to highlight specific pills with connection lines (same red styling as rule violations).

Rows
- Sections are stored as class rows (MRI, CT, Sonography, On Call, etc.) and are selected inside template blocks (no separate section/shift panel).
- Calendar view groups template slots by location + row band (one row per row band with at least one placed slot); row labels show the row label centered with the location name directly beneath it.
- Per day, additional sub-columns appear for day columns that have slots; header shows `Col N` for extra columns, and pool rows render only in the first column per day.
- Pool rows (editable names, not deletable): Rest Day (id: pool-rest-day), Vacation (id: pool-vacation).
- **Deprecated pools (removed)**: Distribution Pool (pool-not-allocated) and Reserve Pool (pool-manual) were removed. State normalization automatically removes these rows and any assignments to them on load.
- Pool rows appear below a separator line.
- Row labels are uppercase, no colored dots, truncate around 20 characters (tighter on mobile).
- Vacation row background stays the same gray even on weekends/holidays.

Cells
- Each active class cell shows a small panel with the section name and time at the top; open slots and assignments render inside that panel.
- Multiple clinician pills per cell, sorted by surname.
- Empty slots shown as gray dashed pills based on the template required count per day type (fallback to legacy min slots); plus/minus badges are gray; label is not bold.
- Drag and drop is same-day only; invalid drops (wrong day or outside the grid) snap back instantly.
- Drag/drop does not block rule-violating placements (same-day location mix, multiple shifts); solver enforces rules but manual overrides are allowed and shown in red. Overlap within the same day is blocked by drag/drop (uses time intervals).
- Drag-to-remove: dragging a clinician pill outside the grid removes the assignment.
- Dragging into or out of Vacation updates the clinician vacation ranges.
- Clinician Picker: clicking an open slot shows a popover with eligible clinicians; warnings show "Already in slot" (priority) or "Not qualified".
- Eligible target cells for a dragged clinician use a pale green background (consistent with the green "Open Slots" badge when count is 0).
- Ineligible manual assignment is allowed, with a yellow warning icon.
- No eligible sections shows a red warning icon.
- Warning tooltips show only when hovering the icon itself.
- Hovering a section cell highlights eligible clinicians for that section on the same date (desktop only); highlight stays when hovering a pill and is cleared while dragging.

Clinic sheet layout (Klinik-Monatslayout)
- Second calendar layout selectable in Settings → Calendar Layout (`solverSettings.scheduleLayout`: `"classic"` default | `"clinicSheet"`); per-user, persisted in the state blob, no backend change. Sanitized in `normalizeAppState` (frontend) — unknown values fall back to classic.
- Faithful clone of a clinic's Excel "Arbeitsplan": the whole month as horizontal day blocks, Arial plain-text surnames (no pills), gray weekday headers (#C0C0C0), fully cyan weekend/holiday day blocks (#00CCFF), tinted row labels, medium/hair borders with spacer rows between location sections, absence pools at the bottom.
- Each day block is 6 name columns: one colBand spans all 6; two colBands split 4+2 (assistants left, senior/OA area right, tinted with the slot's section color — Excel pink #FF99CC fallback); >2 colBands split evenly. Structure comes from the template (rowBands/colBands), not code — see `src/lib/clinicSheet.ts` (`buildMonthDays`, `buildClinicSheetModel`).
- Renderer: `src/components/schedule/ClinicSheetGrid.tsx` + `MonthNavigator`; fully editable (click cell → clinician picker, same-day drag, drop-outside removes) via the shared logic in `src/lib/clinicianSlotOptions.ts` and the page's `handleAddAssignment`/`handleRemoveAssignment`/`handleMoveWithinDay`.
- Month-scoped `buildRenderedAssignmentMap` (do NOT reuse the week-scoped map — pool synthesis is day-bound). Desktop only (mobile keeps the daily view); week-scoped badges and the Publish toggle are hidden in sheet mode; print/PDF/public pages always use the classic grid. The sheet stays paper-light in dark mode by design.

Pills
- Compact blue pill, normal font weight; eligible hover highlight uses green background + green border (no extra thickness).
- Name abbreviation: if a clinician's name doesn't fit, it is progressively abbreviated ("First Last" → "F. Last" → "F. L." → "FL"); full name shown on hover. Disambiguates when siblings would collide (e.g., "Da. Truhn" vs "D. Turner").
- Warning icons are small circular badges at top-right of the pill.
- Drag preview uses the normal pill style (highlight removed).
- Assignment pills show only the name; time is shown in the section block header or the column header (when consistent).
- Distribution Pool pills show only the remaining free time segments.
- Rule-violation pills render in red automatically.
- While dragging a clinician, all other pills for the same clinician on the same day turn darker blue with a black outline; the dragged pill uses the same style.
- Smoke test (API): `API_BASE=http://127.0.0.1:8000 ADMIN_USERNAME=admin ADMIN_PASSWORD=<pass> node scripts/smoke-api.mjs`

---

## 3) Settings
Section Blocks (Weekly Calendar Template)
- Section blocks are just section names; time, end-day offset, and required slots are set per placed slot in the grid.
- Add block by name; delete via the small x in the block list (no clone/gear).
- Drag blocks into the grid or click an empty cell to add; placed blocks can be dragged to move.
- Empty grid cells show "Drop a block or click to add a block."
- Multiple shifts are represented by multiple blocks (no sub-shift editor).

Weekly Calendar Template
- Single calendar with locations stacked; day-type columns are shared across locations (Mon..Sun + Holiday).
- Per-day columns: add columns for a specific day; delete via a hover-only "Delete Column" button at the top of the first row (confirm only if the column has slots).
- Delete button highlighting: hovering Delete Location/Row/Column buttons shows a thick red outline around the entire group (not per-cell rings). The outline uses edge borders only—top/left/right/bottom borders on the outer cells of the highlighted region.
- Row bands are simple rows with an editable row label in the left header cell; Add row is a full-width dashed button below each location; row delete confirms only if the row has slots.
- Section blocks sidebar stays visible while scrolling the template grid (sticky at all sizes; scrolls with the template grid container).
- Blocks live in `weeklyTemplate.blocks` and slots reference `blockId`.
- Slots define time range, end-day offset, and required slots (single value); blocks carry only the section reference.
- Holiday day type always overrides weekdays at runtime (no fallback).
- Settings views that use section dropdowns (solver on-call rest, clinician eligible sections) are filtered to sections that exist as current template blocks.
- Copy Day: button in template builder copies all columns and slots from one day type to another; requires confirmation checkbox if target has existing content.

Locations
- Manage locations inside the calendar template (top-left "+ Location" button).
- Location order uses a dropdown; names are edited inline.
- Delete location (confirm) is allowed even for the default location; the next location becomes the new default (`loc-default`) and slot locationIds are updated.

Pools
- Rename pool rows (Rest Day, Vacation). No deletion.
- **Deprecated pools (removed)**: Distribution Pool (`pool-not-allocated`) and Reserve Pool (`pool-manual`) were removed from the UI. State normalization automatically removes these rows and any assignments to them on load.
- Rest Day pool is used to park clinicians before/after on-call duty when the setting is enabled.
- Pool visibility is a UI filter only: class assignments are never hidden by rest-day/vacation logic.
- If a clinician is marked off on a date, any pool assignment for that date is re-routed to the Rest Day pool in the UI (so they stay visible).

Slots / Template integrity
- Invalid slot assignments are repaired on load:
  - If a slot references a block/section that no longer exists or the slot dayType does not match the assignment date's dayType, the assignment is removed (since Distribution Pool was deprecated).
  - This is enforced in both frontend normalization (`src/lib/shiftRows.ts`) and backend normalization (`backend/state.py`).
- ColBand explosion safeguard: max 50 colBands per day type (MAX_COLBANDS_PER_DAY). If exceeded, extra colBands are blocked and logged. Safeguard is enforced in:
  - `src/lib/shiftRows.ts` (normalizeTemplateColBands)
  - `src/components/schedule/WeeklyTemplateBuilder.tsx` (sanitizeLocations)
  - `src/pages/WeeklySchedulePage.tsx` (setWeeklyTemplate wrapper blocks saves over 500 total colBands)
- **Slot collision detection**: Multiple sections sharing the same `rowBandId + dayType + colBandOrder` causes only one section to be visible in the calendar UI while others are hidden but still exist in the database. This is a critical configuration error.
  - Detection: `slotCollisions` useMemo in `WeeklySchedulePage.tsx` identifies collisions by grouping classShiftRows by `locationId__rowBandId__dayType__colBandOrder` and flagging groups with multiple different `sectionId` values.
  - Warning banner: A prominent red banner appears below the top bar when collisions are detected, showing:
    - Error title: "Template Configuration Error: Hidden Sections Detected"
    - Explanation of the issue (only one section visible, others hidden)
    - Expandable list of collision details (day type, row band, affected section names)
    - "Open Settings" button to navigate to template builder for fixing
  - Fix: Ensure each section has its own row band in the Weekly Template Builder.

Clinicians
- List with Add Clinician and Edit buttons (Add uses a dashed, full-width button below the list).
- Editing uses the same modal as clicking a pill in the calendar.
- Optional working hours per week field (contract hours).

Clinician Editor (modal)
- Panel order: Eligible Sections → Vacations → Preferred Working Times.
- Eligible sections list is ordered. Drag to set priority (this order is also the preference list).
- Add eligible sections via dropdown + Add button; remove via per-row Remove button.
- Vacation management uses custom date pickers (DD.MM.YYYY format) with calendar dropdown; setting a start date after the current end date auto-adjusts end to start + 1 day.
- Invalid date ranges (end before start) show red styling with "End must be after start" warning but are allowed for editing flexibility.
- Past vacations collapsed in a <details>.
- Modal body is scrollable for long vacation lists.
- Preferred working times persist per clinician as `preferredWorkingTimes` (mon..sun with startTime/endTime + requirement none/preference/mandatory).
- Mandatory windows are hard solver constraints; preference windows add a small solver reward.
- Week solver nudges total assigned minutes toward `workingHoursPerWeek` within the tolerance (manual assignments count toward totals).
- Per-clinician working hours tolerance: stored as `clinician.workingHoursToleranceHours` (default 5 hours). Each clinician can have a different tolerance for how much their assigned hours can deviate from their contract hours.

Working Hours Overview
- Dashboard panel opens a full-screen modal showing yearly working hours for all clinicians.
- Year selector with navigation buttons; "Today" button jumps to current year/week.
- Each clinician shows: name, contract hours (e.g., "40h/w"), weekly hours worked, yearly total.
- If contract hours are set, also shows: Expected (fractional for partial weeks), Difference, Cumulative.
- Weeks span Jan 1 to Dec 31 with partial weeks at year boundaries (e.g., if Jan 1 is Thursday, first week has 4 days).
- Expected hours for partial weeks are calculated as `expectedWeeklyHours * (daysInWeek / 7)`.
- Color coding: emerald (within ±2h of expected), amber (under by >2h), rose (over by >2h).
- Pool assignments (rest day, vacation) do not count toward working hours.
- Slot duration comes from the weekly template; defaults to 8 hours if not set.
- Current week is highlighted with sky-blue background; sticky header + Total column.

Holidays
- Year selector with stepper buttons.
- Country picker with flag emoji (top EU countries + CH, LU), alphabetical.
- "Load Holidays" fetches from https://date.nager.at/api/v3/PublicHolidays.
- Add holidays manually; list shows DD.MM.YYYY dates (input accepts DD.MM.YYYY or ISO).
- Add Holiday button is a dashed, full-width button below the list and opens an inline add panel.
- Holidays behave like weekends in solver + min slot logic and show in the calendar header.

Database Health Check
- Located at the bottom of the Settings page.
- "Run Check" button performs integrity checks on the database:
  - Orphaned assignments (assignments referencing non-existent slots)
  - Slot collisions (multiple sections at same position causing hidden sections)
  - Duplicate assignments (same clinician assigned multiple times to same slot/date)
  - ColBand explosion (excessive colBands per day type, limit 20)
  - Pool assignments info (count of persisted pool assignments)
- Stats are clickable with explanations for each metric.
- "Open Database Inspector" link opens a separate full-page view.

Database Inspector
- Route: `/db-inspector` (requires authentication).
- Full-page view showing all slots and assignments directly from the database.
- Week selector with navigation arrows and "Today" button.
- Stats overview: Total Slots, Assigned, Open, Pool Assignments.
- Filter toggle: "Show only open slots".
- Expandable day sections with tables showing:
  - Time, Row, Column, Status (open/assigned), Assigned To, Source (manual/solver).
- Pool assignments table at the bottom showing persisted pool entries.
- Data comes directly from the database, not from the UI view.
- Backend endpoint: `GET /v1/state/inspect/week?week_start=YYYY-MM-DD`.

Solver Settings
- Toggle: Enforce same location per day (default: enabled).
- Toggle: Enforce continuous shifts (default: enabled). When enabled, the solver enforces at most one continuous work block per clinician/day (or the number of manual blocks already present), using same-location time adjacency (end == start).
- Multiple shifts per day are always allowed (removed setting); only actual time overlaps are blocked.
- On-call rest days: toggle + section selector + days before/after. When enabled, solver enforces rest days and the UI places clinicians into the Rest Day pool.
- On-call rest days dropdown only shows sections that exist as current template section blocks.
- Working hours tolerance is now per-clinician (see Clinician Editor); removed from global solver settings.
- Rule violations are evaluated for the current week and surfaced in the header badge; affected pills are shown in red.
- Violations include: rest-day conflicts, same-day location mismatches (when enforced), and overlapping shift times.
- **Click-to-scroll for violations**: Clicking a rule violation in the popover scrolls the schedule grid to show the responsible assignment pill (smooth scroll to center).
- **Click-to-scroll for split shifts**: Clicking a split shift item in the popover scrolls to and highlights the relevant pills with connection lines.
- Automated planning runs the week solver over the selected date range in one call and shows an ETA based on the last run's per-day duration.
- **Optimization weights**: Collapsible section in the Solver Info modal (gear icon) allows configuring objective weights:
  - Coverage (1000), Slack (1000), Total Assignments (100), Slot Priority (10), Time Window (5), Section Preference (1), Working Hours (1).
  - "Total Assignments" and "Slot Priority" are only active in "Distribute All" mode (visually dimmed with amber description).
  - Each weight has an info tooltip explaining its effect in layman's terms.
  - "Reset to defaults" button restores all weights to their default values.

Testing
- Frontend unit/component tests: Vitest + Testing Library (`npm run test` runs `src/**/*.test.{ts,tsx}` only).
- Backend tests: pytest (dev deps in `backend/requirements-dev.txt`), run `python3 -m pytest backend/tests`.
- E2E tests: Playwright specs in `e2e/` (`npm run test:e2e`).
  - Uses API login and seeds `localStorage.authToken`.
  - Resets state before each test and restores original state after the suite.
  - Env: `E2E_USERNAME`, `E2E_PASSWORD`, `PLAYWRIGHT_API_URL`, `PLAYWRIGHT_BASE_URL`.
  - Defaults to `testuser` / `sdjhfl34-wfsdfwsd2` when `E2E_USERNAME`/`E2E_PASSWORD` are unset.
  - `test:e2e` script includes `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=mac15-arm64` for Apple Silicon.
  - Default non-admin test user for local E2E: `testuser` / `sdjhfl34-wfsdfwsd2` (set `ENABLE_E2E_TEST_USER=0` to disable creation, do not use in production).
  - In sandboxed runs, Playwright may need escalated permissions to access `localhost:8000` and launch Chromium (otherwise EPERM/permission-denied errors).
  - Diagnostics on failure: console, page errors, failed requests, >=400 responses, screenshot, HTML snapshot, and trace (see `e2e/fixtures.ts`).
  - PDF export test calls `/v1/pdf/week` and asserts the generated PDF has exactly one page.
  - Print layout test opens `/print/week` in print media and asserts the scaled schedule fits within one A4 page (portrait or landscape) and fills at least 70% of one dimension.
  - ColBand explosion tests (`e2e/colband-explosion.spec.ts`): verify colBand counts stay stable through settings, Copy Day, column operations, and solver runs; checks for console explosion errors.
  - Pool removal tests (`e2e/pool-removal.spec.ts`): verify deprecated pools (Distribution Pool, Reserve Pool) are not rendered while Rest Day and Vacation pools remain visible.
  - Full workflow test (`e2e/full-workflow.spec.ts`): UI-only comprehensive test that simulates a user setting up a schedule from scratch:
    - **Step 1**: Login as admin (`admin` / `<ADMIN_PASSWORD>`)
    - **Step 2**: Create test user `test` with password `test` via User Management UI
    - **Step 3**: Logout from admin
    - **Step 4**: Login as test user
    - **Step 5**: Create section blocks via Settings → Weekly Calendar Template:
      - 6 sections: MRI, CT, Sonography, X-Ray, On-Call, Emergency
    - **Step 6**: Create 3 locations: Berlin, Aachen, Munich
    - **Step 7**: Create 7 clinicians with unique names (includes test run ID to avoid duplicates)
    - **Step 8**: Return to calendar view
    - **Step 9**: Run automated solver ("Apply Solution" when found)
    - **Step 10**: Verify assignments exist in calendar
    - **Step 11**: Navigate weeks forward
    - **Step 12**: Final verification and logout
    - Takes screenshots at each step (saved to `test-results/` directory)
    - Uses unique clinician names per test run to avoid selector issues with duplicates
    - Timeout: 3 minutes
    - Run with: `ADMIN_USERNAME=admin ADMIN_PASSWORD=<ADMIN_PASSWORD> PLAYWRIGHT_BASE_URL=http://localhost:5173 npx playwright test e2e/full-workflow.spec.ts`
    - View results: `npx playwright show-report`
    - **Note**: Eligibility assignment step is currently skipped - clinicians inherit eligibilities from the template. For full eligibility testing, see the eligibility helpers in the test file.

Dev server restart
- Kill existing servers via `lsof -nP -iTCP:8000 -sTCP:LISTEN` and `lsof -nP -iTCP:5173 -sTCP:LISTEN`, then `kill <pid>`.
- Start backend: `python3 -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000 > logs/dev-backend.log 2>&1 &`
- Start frontend: `npm run dev -- --host 127.0.0.1 --port 5173 > logs/dev-frontend.log 2>&1 &`
- In this sandbox, use `setopt NO_BG_NICE` when starting background jobs to avoid `nice(5) failed` errors.
- Health checks from within the sandbox can fail with “Operation not permitted”; verify from the browser instead.
- Reason: background jobs may be auto-niced; the sandbox blocks `nice(5)`, so disable background niceness before launching servers.

Vacation Overview
- Open via the Vacation Planner panel in the main schedule view.
- Full-screen year grid: clinicians as rows, day numbers across the year, month headers span their days.
- Grey bar per clinician; green segments for vacation ranges (clipped to the selected year).
- A thin vertical Today marker appears only when viewing the current year.
- Multi-year timeline: year row stays visible and updates as you scroll; there is a "Today" jump button.
- Clicking a clinician row opens the Clinician Editor modal scrolled to vacations.

Admin user management
- User export: admin can download a user state JSON (export includes metadata + AppState).
- User import: create user form accepts an export JSON to seed the new user's state.

iCal (download + subscription feed)
- The Export panel button opens a modal:
  - Primary tabs: **PDF**, **iCal**, **Web**.
  - iCal has a secondary toggle for **Subscription** (default) vs **Download**.
  - Subscriptions include **only weeks marked Published** in the schedule view (week toggle above the grid).

PDF export (server-side, Playwright)
- Print-only routes:
  - `/print/week?start=YYYY-MM-DD`
  - `/print/weeks?start=YYYY-MM-DD&weeks=N` (multiple pages in one PDF)
- Print pages (`src/pages/PrintWeekPage.tsx`, `src/pages/PrintWeeksPage.tsx`) scale the full schedule table to fit one A4 landscape page using a fixed 6mm margin + safety factor; multi-week export waits for each page layout before `__PDF_READY__`.
- Backend endpoints:
  - `GET /v1/pdf/week?start=YYYY-MM-DD` (single week)
  - `GET /v1/pdf/weeks?start=YYYY-MM-DD&weeks=N` (combined PDF)
- PDF render specifics:
  - Always A4 landscape with background colors.
  - Content is top-aligned and horizontally centered within the printable area.
  - Auto-scale to fit the full table on the page (never scales up above 1x).
  - Margins are 6mm on all sides.
  - Multi-week export uses the max width/height across all `.print-page` grids.
  - Open Slots badge, Publish toggle, and Open Slot pills are hidden in PDF.
- The print route sets `window.__PDF_READY__ = true` after data loads + two rAFs; backend waits for that signal.
- Export UI:
  - PDF tab accepts start week + number of weeks (max 55).
  - User can choose **one combined PDF** or **individual files**.
- Env var `FRONTEND_BASE_URL` is used by the backend to reach the frontend for PDF rendering:
  - Domain setup: `https://$DOMAIN`
  - IP-only setup: `http://SERVER_IP`
- Print CSS lives in `src/index.css` (`print-color-adjust`, overflow visible, no-print elements hidden).

iCal download (frontend-only)
- Supports:
  - "All clinicians" (one `.ics` file containing many events across many dates)
  - Individual clinician `.ics` files
  - A date range filter (Start/End) shown/entered as `DD.MM.YYYY` (empty = all dates)
- Implementation details:
  - Only section assignments are exported (pool rows are ignored).
  - Events are all-day (`DTSTART;VALUE=DATE` / `DTEND;VALUE=DATE` with end = +1 day).
  - Range parsing accepts `DD.MM.YYYY` (and also `YYYY-MM-DD`), swaps Start/End if reversed, and disables download on invalid input.
- Files: `src/lib/ical.ts`, `src/components/schedule/IcalExportModal.tsx`, wiring in `src/pages/WeeklySchedulePage.tsx`.

Subscribable iCal feed (cryptic URL)
- Publication scope is controlled by `publishedWeekStartISOs` in user state:
  - Array of Monday ISO strings (YYYY-MM-DD) for weeks that are released.
  - If empty, the feed is valid but has **zero** events.
- Backend stores tokens in SQLite:
  - `ical_publications` (one token per user, all clinicians).
  - `ical_clinician_publications` (one token per clinician per user).
- Public endpoint (no JWT): `GET /v1/ical/{token}.ics`
  - Returns `text/calendar; charset=utf-8`
  - Only section assignments are included (pool rows ignored)
  - Only weeks listed in `publishedWeekStartISOs` are included
  - Clinician tokens return only that clinician’s assignments
  - Vacation override is applied: assignments are skipped on days where the clinician is on vacation (the UI hides these too, but raw assignments can remain in persisted state).
  - Bug fix: clinician-specific feeds must not reuse/overwrite the `clinician_id` filter variable in `backend/ical.py`; otherwise every link returns the last clinician’s events.

Known issues / fixes
- ICS clinician filter bug: avoid shadowing `clinician_id` in `backend/ical.py` (use a different loop variable for clinicians). Symptom was that every clinician link returned the same clinician’s events.
  - All-day events; UID is stable (`assignment.id@shiftschedule`) so clients update instead of duplicating
  - HTTP caching: sets `ETag` + `Last-Modified` and supports conditional GET (returns 304 when unchanged)
- Authenticated endpoints (JWT required):
  - `GET /v1/ical/publish` (status, includes all + per-clinician URLs when published)
  - `POST /v1/ical/publish` (enable links; keeps existing tokens)
  - `POST /v1/ical/publish/rotate` (new tokens for all + clinicians; old URLs become 404)
  - `DELETE /v1/ical/publish` (unpublish; URL becomes 404)
- Subscription UI behavior:
  - Status is a **Links active** toggle; turning it off unpublishes.
  - **Refresh links** rotates tokens after confirmation.
  - All clinicians link is shown in the same list as individual clinicians.
  - Links are auto-refreshed when the Export modal opens (no separate “Update links” button).
- Subscribe URL base:
  - Backend uses env var `PUBLIC_BASE_URL` if set (recommended for production behind HTTPS). For the domain+Caddy setup in this repo (backend behind `/api`), set `PUBLIC_BASE_URL=https://$DOMAIN/api`.
  - Otherwise it falls back to `request.base_url` (works for local dev).
- Local verification:
  - Publish via UI, then `curl -i "<subscribeUrl>"` should return 200 + calendar data.
  - Re-run with `If-None-Match` or `If-Modified-Since` should return 304 if unchanged.
  - Note: Many real calendar clients (especially Apple Calendar on devices) strongly prefer HTTPS for subscriptions.

Public web view (share link)
- Public route: `/public/:token?start=YYYY-MM-DD` (no login).
- Backend table: `web_publications` (one token per user; rotation invalidates old link).
- Auth endpoints:
  - `GET /v1/web/publish` (status)
  - `POST /v1/web/publish` (enable)
  - `POST /v1/web/publish/rotate` (new token)
  - `DELETE /v1/web/publish` (disable)
- Public data endpoint: `GET /v1/web/{token}/week?start=YYYY-MM-DD`
  - Returns `published:false` if the week is not in `publishedWeekStartISOs`.
  - When published: returns rows, clinicians, assignments (section rows only, within week), min slots, slot overrides, holidays.
  - Vacation override is applied (assignments hidden on vacation days).
  - HTTP caching: `ETag` + `Last-Modified` with conditional 304.
- Export modal → **Web** tab:
  - Links active toggle, refresh link (confirm), copyable public URL.
  - URL uses `${window.location.origin}/public/<token>`.
  - If a week is unpublished, the public page shows “This week is not published yet.” but keeps navigation visible.

Hover highlight issue (remote)
- Root cause: pills had both blue and emerald classes at once; Tailwind CSS order kept the blue background even when `isHighlighted` was true.
- Fix: use mutually exclusive class sets in `AssignmentPill` so emerald styles fully replace blue.
- Symptom: cell hover worked but pills did not turn green; fixed after frontend rebuild.

Hover stuck after drag (local/remote)
- Root cause: CSS `:hover` (group-hover) sometimes stays active after a drag cancel, leaving ghost slots or cell backgrounds stuck.
- Fix: drive ghost slot visibility and cell hover background from `hoveredClassCell` state instead of CSS hover.

Drag preview styling
- Drag image uses a cloned pill; if it was highlighted, the clone kept emerald classes.
- Fix: strip all emerald classes on clone and re-apply the normal blue classes during drag start.

Slot override key parsing
- `slotOverridesByKey` keys are `slotId__dateISO` (e.g., `slot-1__2026-01-05`).
- Backend validates date portion; malformed keys with day types instead of dates (e.g., `slot-1__mon`) are skipped.

ColBand explosion on fresh start (fixed)
- Root cause: In `backend/state.py` `_normalize_weekly_template()`, the legacy migration check used `not getattr(template, "blocks", None)` which evaluates to `True` for an empty list `[]` because empty lists are falsy in Python.
- Symptom: Fresh databases started with 50 colBands per day (hitting the safeguard limit) instead of 8 (one per dayType).
- Mechanism: The faulty check triggered legacy migration for v4 templates with empty blocks. Legacy migration treats each existing colBand as a "legacy" colBand and creates 8 new colBands (one per dayType) for each, resulting in 8×8=64 colBands.
- Fix: Changed the condition from `not getattr(template, "blocks", None)` to `not hasattr(template, "blocks")` which correctly checks for property existence rather than truthiness.
- Note: The frontend (`src/lib/shiftRows.ts`) was already correct, using `!("blocks" in template)` which checks property existence.

Safari drag-and-drop (partially fixed, open issue)
- Symptom: In Safari, dragging filled physician pills is unreliable — often only works from the lower padding area, not over the text.
- Root cause: Safari's WebKit engine has multiple interacting drag-and-drop quirks: `<button>` parents suppress child `draggable`; native text drag competes with HTML5 `draggable` even when `user-select: none` is set; transparent overlay divs are not reliably hit-tested.
- Partial fixes applied:
  - Removed the transparent drag overlay div from `AssignmentPill.tsx`; root div now handles drag directly.
  - Added `-webkit-user-drag: element` on `[data-assignment-pill][draggable="true"]` and `-webkit-user-drag: none` on children in `src/index.css`.
  - Added `pointer-events-none` on the pill content wrapper so events pass through to the root.
- Status: Works in Chrome; Safari still unreliable. The CSS workarounds are the standard recommendation but don't fully resolve Safari's engine-level issues.
- Future fix: Replace HTML5 drag-and-drop with a pointer-event-based library like `@dnd-kit/core` which doesn't depend on Safari's native drag implementation. This is a significant refactor affecting `ScheduleGrid.tsx` and `AssignmentPill.tsx`.

Code patterns to avoid
- **Double `.get()` calls**: Avoid calling `.get()` twice on the same key; cache the result instead.
  - Bad: `d.get(k).attr if d.get(k) else None`
  - Good: `v = d.get(k); v.attr if v else None`
- **setTimeout without cleanup**: Always store timeout IDs and clear them in useEffect cleanup to prevent memory leaks.
  - Bad: `setTimeout(() => ref.current?.focus(), 0);`
  - Good: `const id = setTimeout(...); return () => clearTimeout(id);`
- **Duplicate functions**: Avoid creating multiple functions with identical implementations; consolidate them.
- **Test assumptions**: Tests should not assume default state has data; always create required test fixtures explicitly.

---

## 4) Data Model (Shared Concept)
```ts
type RowKind = "class" | "pool";

type Location = {
  id: string;
  name: string;
};

type SubShift = {
  id: string;
  name: string;
  order: 1 | 2 | 3;
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  endDayOffset?: number; // 0-3
  hours?: number;
};

type WorkplaceRow = {
  id: string;
  name: string;
  kind: RowKind;
  dotColorClass: string;
  blockColor?: string;
  locationId?: string;
  subShifts?: SubShift[];
};

type VacationRange = { id: string; startISO: string; endISO: string };

type PreferredWorkingTimeRequirement = "none" | "preference" | "mandatory";

type PreferredWorkingTime = {
  startTime?: string;
  endTime?: string;
  requirement?: PreferredWorkingTimeRequirement;
};

type PreferredWorkingTimes = Record<
  "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun",
  PreferredWorkingTime
>;

type Clinician = {
  id: string;
  name: string;
  qualifiedClassIds: string[];
  preferredClassIds: string[];
  vacations: VacationRange[];
  preferredWorkingTimes?: PreferredWorkingTimes;
  workingHoursPerWeek?: number;
  workingHoursToleranceHours?: number; // default 5
};

type Assignment = {
  id: string;
  rowId: string;
  dateISO: string;
  clinicianId: string;
  source?: "manual" | "solver"; // Tracks assignment origin; undefined/missing treated as manual
};

type MinSlotsByRowId = Record<string, { weekday: number; weekend: number }>;

type DayType = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun" | "holiday";

type TemplateRowBand = {
  id: string;
  order: number;
  label?: string;
};

type TemplateColBand = { id: string; label?: string; order: number; dayType: DayType };

type TemplateBlock = {
  id: string;
  sectionId: string;
  label?: string;
  color?: string;
  requiredSlots: number; // legacy; slots carry requiredSlots
};

type TemplateSlot = {
  id: string; // used as Assignment.rowId
  locationId: string;
  rowBandId: string;
  colBandId: string;
  blockId: string;
  requiredSlots?: number;
  startTime?: string;
  endTime?: string;
  endDayOffset?: number;
};

type WeeklyTemplateLocation = {
  locationId: string;
  rowBands: TemplateRowBand[];
  colBands: TemplateColBand[];
  slots: TemplateSlot[];
};

type WeeklyCalendarTemplate = {
  version: 4;
  blocks: TemplateBlock[];
  locations: WeeklyTemplateLocation[];
};

type Holiday = { dateISO: string; name: string };

type SolverSettings = {
  enforceSameLocationPerDay: boolean; // default true
  onCallRestEnabled: boolean;
  onCallRestClassId?: string;
  onCallRestDaysBefore: number;
  onCallRestDaysAfter: number;
  preferContinuousShifts: boolean; // default true
  // Configurable optimization weights (optional, defaults in solver)
  weightCoverage?: number;           // default 1000
  weightSlack?: number;              // default 1000
  weightTotalAssignments?: number;   // default 100 (Distribute All only)
  weightSlotPriority?: number;       // default 10 (Distribute All only)
  weightTimeWindow?: number;         // default 5
  weightSectionPreference?: number;  // default 1
  weightWorkingHours?: number;       // default 1
};
```

Slot IDs
- Section assignments use TemplateSlot ids (Assignment.rowId = TemplateSlot.id); pool rows continue using their plain pool IDs.
- Default template generation uses legacy shiftRowId values (`classId::subShiftId`, e.g. `mri::s1`) for slot ids so existing assignments survive.
- UI uses “section”, but internal ids and RowKind still use `class` for compatibility.

---

## 5) Scheduling Logic (Frontend)
- Vacation override: for each date, if clinician is on vacation, they appear in Vacation pool and their section assignment is suppressed.
- Multiple shifts per day are always allowed; time overlap detection prevents assigning the same clinician to overlapping shift intervals.
- Rest Day Pool (pool-rest-day): if on-call rest days are enabled, clinicians assigned to the on-call section are placed into Rest Day on the configured days before/after (fallback to Reserve if Rest Day is missing).
- Assignments stored in a map (rowId + dateISO -> list of assignments); section rows use template slot ids.
- Drag and drop only within the same day; manual overrides are allowed even if they violate solver rules.
- Clicking a section slot cell increments the per-day slot override for that slot id (adds an "Open Slot"); remove via the minus badge.
- Day type is `holiday` if the date is in holidays; otherwise it is the weekday. Holiday settings always override weekday settings.
- Overlap checks use time intervals (start/end + endDayOffset); shift order is not used for overlap decisions. These checks feed solver constraints and UI violation detection.
- Drag/drop also prevents placing a clinician into overlapping time slots on the same day.
- Clinician picker popover: viewport-aware positioning opens above anchor when insufficient space below (flips direction automatically).

---

## 6) Solver (Backend)

Two solver implementations exist. The frontend can select which to use via `useHeuristic` toggle.

### CP-SAT Solver (default) — `backend/solver.py`
Endpoint:
- `POST /v1/solve/range` (range solver; accepts `startISO` and optional `endISO`)
Payload:
```json
{ "startISO": "YYYY-MM-DD", "only_fill_required": true|false, "use_heuristic": false }
```

Behavior
- Considers all clinicians not on vacation; manual assignments are treated as fixed.
- Includes a 1-day context window on both ends for rest-day constraints; rest rules only enforce inside the selected range and emit a warning note if boundary days are already assigned.
- Hard constraints:
  - Qualification required.
  - Vacation overrides assignment.
  - Manual assignments remain in place; solver adds additional assignments as needed.
  - Overlap checks use time intervals (start/end + endDayOffset), not shift order.
  - Multiple shifts per day are allowed as long as they don't overlap in time and remain continuous.
  - "Enforce same location per day" blocks mixing locations on the same day.
  - On-call rest days: if enabled, clinicians assigned to the selected on-call section must be unassigned on the configured days before/after.
  - Enforce continuous shifts: each clinician/day has at most one continuous block (or existing manual blocks).
- Targets template slot ids; order weights follow location order + row band order + column band order.
- Qualification + preference checks use slot.sectionId (the parent section).
- Objective (weighted minimization):
  - **Coverage** (w=1000): Maximize filled required slots, prioritized by section order.
  - **Slack** (w=1000): Minimize unfilled required slots.
  - **Total Assignments** (w=100, Distribute All only): Maximize total assignments.
  - **Slot Priority** (w=10, Distribute All only): Prefer earlier slots in template order.
  - **Time Window** (w=5): Respect clinician preferred working hours.
  - **Section Preference** (w=1): Assign clinicians to their preferred sections.
  - **Working Hours** (w=1): Balance hours to target ± tolerance.
- Sub-scores are computed after solving and returned in `debugInfo.sub_scores` (slots_filled, slots_unfilled, total_assignments, preference_score, time_window_score, hours_penalty).
- Gap-based early stopping: once optimality gap drops below 5%, allows 20s grace period then stops.

### Heuristic Solver v2 — `backend/heuristic/solver_v2.py`
- Alternative fast solver activated by `"solver_mode": "heuristic"` (legacy `use_heuristic: true` still works; `solver_mode` wins).
- Uses a greedy multi-phase approach instead of constraint programming.
- Phases: bottleneck pre-assignment → greedy slot filling → local improvement.
- Respects the same constraints as CP-SAT (qualification, vacation, overlap, same-location, on-call rest, continuity).
- Produces solutions faster but may not be as optimal as CP-SAT.
- Documentation: `HEURISTIC_SOLVER_V2_README.md`, `human-heuristic-solver.md`.

Performance optimizations:
- Constraint building uses O(n) date-based grouping instead of O(n²) pairwise comparisons.
- Lookup tables: `vars_by_clinician_date`, `vars_by_date_slot`, `manual_count_by_date_slot`.
- Model build time ~25s for 100+ day ranges (down from ~100s before optimization).

Debug mode (development only):
- Set `DEBUG_SOLVER=true` environment variable to enable detailed timing instrumentation.
- When enabled, each solve writes a JSON file to `backend/logs/solver_debug/` with:
- Checkpoint timings for each major step (load_state, date_setup, slot_contexts, create_variables, overlap_constraints, coverage_constraints, on_call_rest_days, working_hours_constraints, continuity_constraints, objective_setup, solve, result_extraction).
  - State summary (clinician count, location count, assignments, etc.).
  - Model statistics (num_variables, solver status, objective value).
  - Result info (assignments created, slack remaining).
- **Production warning**: Do NOT deploy with `DEBUG_SOLVER=true`. Remove or unset the environment variable for production builds. The debug logs consume disk space and may impact performance.
- Files are named `solve_YYYYMMDD_HHMMSS_microseconds.json` for easy identification.
- Frontend debug panel: When DEBUG_SOLVER is enabled, the solver response includes `debugInfo` which the frontend displays in the solver notice modal:
  - Summary stats: solver status, variable count, days, slots, solutions found, improvement percentage.
  - Objective value chart: SVG line chart showing objective value (Y-axis) vs. time in seconds (X-axis) for each solution found during the solve.
  - Timing breakdown table: shows each phase name, time (ms/s), percentage of total, and a visual bar chart.
  - Component: `SolverDebugPanel.tsx` renders the debug visualization.

Timeouts:
- All ranges: 60s (flat timeout regardless of range size)

Week-by-week fallback:
- If full-range solver fails for >14 day ranges, automatically retries solving each week individually.
- Each week uses 60s timeout.
- Returns partial results if some weeks succeed and others fail.
- Notes include timing info for each week solved.

Solver notice panel (frontend):
- Displays timing info (build + solve time) on success and failure.
- Stays open until user clicks to dismiss (click backdrop or X button).
- Centered modal with scrollable content for long diagnostics.

Subprocess architecture (force abort):
- Solver runs in a separate subprocess using `multiprocessing.get_context("spawn")`.
- Main process spawns `_solver_subprocess_worker` which runs the actual CP-SAT solving.
- Progress is relayed via `multiprocessing.Queue` from subprocess to main process, then broadcast to SSE subscribers.
- Abort endpoint (`POST /v1/solve/abort`) supports two modes:
  - Default: Sets cancel event flag, solver stops at next solution callback (graceful).
  - `force=true`: Immediately terminates the subprocess via `Process.terminate()` then `Process.kill()` if needed.
- This enables instant abort even when the solver is stuck without finding new solutions.
- Global tracking: `_solver_process` holds the subprocess reference, `_solver_cancel_event` for graceful abort.
- Subprocess cleanup: `atexit` handler and aggressive cleanup function (`_cleanup_solver_process`) ensure subprocesses are killed on backend restart/crash. Uses `terminate()` first, then `kill()` after 2s timeout.

SSE live updates (real-time progress):
- Endpoint: `GET /v1/solve/progress?token=<jwt>` (Server-Sent Events stream).
- Events:
  - `connected`: Initial connection confirmation.
  - `start`: Solver started with `{startISO, endISO, timeout_seconds}`.
  - `solution`: New solution found with `{solution_num, time_ms, objective, assignments}`.
  - `complete`: Solver finished with `{startISO, endISO, status, error?}`.
- Solution events include full assignments array, allowing the frontend to apply intermediate solutions.
- Frontend subscribes via `subscribeSolverProgress()` in `src/api/client.ts`.
- When aborted, the last solution's assignments can be applied immediately.

Solver overlay (SolverOverlay.tsx):
- Renders inside the calendar container via `createPortal(content, calendarContainer)` where `calendarContainer` is the parent of `.calendar-scroll`.
- Uses absolute positioning (`absolute inset-0 z-30`) so it only covers the calendar area.
- Only shows when the displayed week overlaps with the solve range.
- Compact panel width (`w-auto max-w-lg`) that fits content.
- Components:
  - Animated spinner with indigo accent.
  - Date range label (DD.MM.YYYY format).
  - Preparation phase indicator: shows current solver phase before first solution (e.g., "Loading schedule data...", "Solving constraints...").
  - Live solution chart: SVG line chart showing objective value over time (log scale, inverted so better scores appear higher).
  - Elapsed/total time counter (X:XX / Y:XX format, e.g., "0:45 / 1:00").
  - Action buttons:
    - "Abort" (rose/red) - always visible, discards any solutions found.
    - "Apply Solution" (indigo/blue) - only shown after solutions found, applies current best solution.
    - "Details" button - opens full-screen dashboard with all graphs.
- Full-screen dashboard (SolverDashboard):
  - Opens via "Details" button, renders as full-viewport overlay via portal to `document.body` (z-[1100]).
  - Organized into logical sections with section headers:
    - **Coverage**: Optimization Score (full width), Filled Slots, Total Assignments.
    - **Constraints**: Non-consecutive Shifts, Location Changes, Working Hours Compliance, On-Call Rest Violations.
    - **Preferences**: Section Preference Match, Time Window Compliance.
  - Cards are conditionally shown only when relevant (e.g., Time Window only if clinicians have time preferences set).
  - Live updates continue while dashboard is open.
  - "← Back" button to close and return to compact overlay.
- Solver stats calculation: modular function in `src/lib/solverStats.ts` (`calculateSolverLiveStats`).
- Stats include both solver-generated and existing manual assignments in the solve range for accurate filled slots display.
- Accepts optional `solverSettings` parameter (passed from WeeklySchedulePage) for on-call rest violation tracking.
- Stats tracked: filledSlots, totalRequiredSlots, openSlots, nonConsecutiveShifts, peopleWeeksWithinHours, totalPeopleWeeksWithTarget, locationChanges, totalAssignments, sectionPreferenceMatches, totalClassAssignments, timeWindowFits, totalAssignmentsWithTimeWindows, onCallRestViolations.

Automated Shift Planning panel (frontend):
- Timeframe: "Current week" and "Today" quick buttons; custom date pickers (DD.MM.YYYY) for start/end displayed inline with dash separator.
- Strategy: "Fill open slots" (only fills required slots) or "Distribute all" (assigns all available clinicians).
- Run button triggers solver.
- Reset button opens a dropdown panel with two options:
  - "Reset Solver Only": Removes only assignments created by the automated planner (source === "solver"); keeps manual assignments.
  - "Reset All": Removes all assignments in the selected timeframe, including both manual and solver-generated ones.
- Reset panel auto-positions: opens above the button when there's insufficient space below (viewport-aware).

Custom date picker component (`CustomDatePicker.tsx`):
- European format (DD.MM.YYYY) with calendar dropdown.
- Calendar shows month navigation, weekday headers (Mo-Su), today highlight, selected date highlight.
- Dropdown opens above if not enough space below (auto-detects).
- Fixed width 252px for consistent dropdown size; z-index 100 for proper layering.

---

## 6.5) Constraint Validator (`backend/validation.py`)

A solver-independent module that encodes the **hard** constraints of the CP-SAT
solver as pure functions. Use it anywhere a proposed set of assignments needs a
pass/fail check — LLM-generated schedules, external imports, UI conflict
badges, debug tooling.

### What it checks
All return `list[Violation]`; `validate_assignments()` aggregates them into a
`ValidationReport`:
- `validate_qualifications` — section must be in clinician's `qualifiedClassIds`
- `validate_vacations` — no slot assignments during vacations (pool rows exempt)
- `validate_overlaps` — same-clinician time overlap, handles overnight slots
  (`endDayOffset > 0`) by placing intervals on an absolute minute axis
- `validate_same_location_per_day` — only when `enforceSameLocationPerDay`
- `validate_on_call_rest` — only when `onCallRestEnabled`; checks N days before
  and M days after each on-call slot (back-to-back on-call is allowed)
- `validate_mandatory_windows` — slots must fit inside `preferredWorkingTimes`
  entries whose requirement is `mandatory` (`preference` entries are soft)
- `validate_weekly_hours` — per ISO week, assigned hours ≤ contract + tolerance
  (hard, matching heuristic v2; CP-SAT treats hours as a soft penalty, so a
  CP-SAT plan may legitimately flag here)
- `validate_split_shifts` — one contiguous work block per clinician/day when
  `preferContinuousShifts` is on (adjacent slots merge)
- `validate_capacity` — per slot instance, count ≤ `requiredSlots` + override
  (+ distribute-all headroom when `only_fill_required=False`)
- `validate_references` — unknown clinician IDs or slot IDs

Checked separately (NOT part of `validate_assignments` pass/fail):
- `validate_solver_rules` — the if/then `SolverRule` entries. No solver has
  ever enforced these, so existing plans may violate them; callers treat the
  result as soft feedback (the agent solver scores them as soft violations).

**Baseline-diff pattern:** pre-existing manual data may legitimately violate
e.g. weekly hours or capacity. Callers comparing a candidate plan against a
baseline (the agent repair loop) diff the two violation lists — the invariant
is "no NEW violations", not "zero violations".

### What it does NOT check
Soft objectives: coverage counts, section preferences, time-window
*preferences*, working-hours balance below the hard cap, YTD balance, minimum
daily hours. Scoring lives in `backend/scoring.py` (see §6.6).

### Design rules
- **No imports from `solver.py`** — the small helpers (time parsing, slot
  interval construction) are duplicated intentionally to avoid a circular
  dependency with the subprocess-spawning code.
- **Pure, side-effect-free.** No I/O, no global state. Safe to call from any
  request path.
- **Pool rows (`pool-*`) are skipped** for qualification, overlap, vacation,
  and on-call-rest — they represent virtual rows (Rest Day, Vacation), not
  schedulable slots. Reference integrity also skips them.
- **Stable violation codes** (`VIOLATION_QUALIFICATION`, …) so LLM feedback
  loops and UI badges can pattern-match without parsing the `message` string.
- **Multi-location awareness**: uses `WeeklyTemplateLocation.locationId` (not
  the per-slot `locationId` field) because that's what the solver does.
  Single-template-location states won't produce same-location violations
  regardless of per-slot values.

### Typical LLM-backend flow
```python
from backend.validation import validate_assignments

# Claude or any other model proposes assignments as JSON
proposed: list[Assignment] = parse_llm_response(raw)

report = validate_assignments(state, proposed)
if not report.is_valid:
    # Feed violations back as tool-result so the model can correct
    feedback = [v.message for v in report.violations]
    ...
else:
    apply_assignments(state, proposed)
```

### Tests
`backend/tests/test_validation.py` — 41 cases, run with
`pytest backend/tests/test_validation.py`. Tests use the conftest factories
EXCEPT for multi-location scenarios, which build `AppState` manually (because
`make_app_state` creates a single `WeeklyTemplateLocation`).

### Things to watch out for
- **`qualified_class_ids=[]` in `make_clinician()` is ignored** — the factory
  does `qualified_class_ids or ["section-a"]`, so empty-list falls back to the
  default. Use `["section-nonexistent"]` to force a qualification violation.
- **`_slot_interval()` returns `None` for missing start/end** or zero-duration
  slots. This is intentional — the solver would silently clamp to 0 duration,
  but the validator surfaces it via `VIOLATION_UNKNOWN_SLOT` through
  `validate_references`. If future behaviour change is needed (e.g. tolerate
  missing start time), update both the validator and `_build_slot_interval` in
  `solver.py` together.
- **New constraints must land in three places.** Any constraint added to the
  CP-SAT solver or heuristic v2 must also be added to `validation.py` (and, if
  it affects the objective, `scoring.py`) — the agent solver's guardrails are
  only as complete as the validator. The seed-parity tests in
  `backend/tests/test_scoring.py` catch drift: heuristic output must always
  pass `validate_assignments`.

---

## 6.6) Agent Solver (`backend/agent/`, `backend/scoring.py`)

A third solver mode: an LLM improves a heuristic seed plan through tools
(propose → verify → repair). Selected per request via
`SolveRangeRequest.solver_mode: "cpsat" | "heuristic" | "agent"` (the legacy
`use_heuristic` flag still works; `solver_mode` wins when both are set). The
dispatch lives in `_solver_subprocess_worker` in `solver.py`, so agent runs
inherit the subprocess isolation, abort/heartbeat machinery, and the SSE
progress pipeline unchanged — `SolverOverlay` renders agent runs like any
other solve (`phase` events for loop progress, one `solution` event for the
seed and one per accepted improvement, objective on the same minimized scale).

### Background runs (`backend/solver.py` + `backend/solver_runs.py`, v1.43)
A solve is a SERVER-SIDE JOB, not an HTTP request: `POST /v1/solve/range`
creates a row in the `solver_runs` table, spawns the solver subprocess plus
a monitor thread, and returns the run id immediately. The monitor relays
progress to SSE, persists the outcome (`finished`/`aborted`/`failed`) with
the full result JSON, and frees the solve slot. Nothing is applied to the
schedule automatically: the result waits in the RUN INBOX until the admin
applies it (`POST /v1/solve/runs/{id}/apply` — atomic server-side apply
with the same semantics the frontend used: in-range solver assignments are
replaced, manual entries and vacationing clinicians' rows survive) or
discards it. `GET /v1/solve/runs` lists the inbox; a run interrupted by a
backend restart/deploy is restarted once on startup
(`recover_interrupted_runs`, note in the run) and marked `crashed`
otherwise. There is NO wall-clock limit by default (admin decision):
runs end on the iteration budget (slots x 10) or via
`POST /v1/solve/abort`; a `timeout_seconds` in the request still works and
re-arms the overshoot watchdog. The frontend shows the familiar live
overlay, which can be sent to the background (floating badge, calendar
stays usable); a reload re-attaches to the running job.

### Flow (`backend/agent/harness.py::agent_solve_range`)
Two strategies, selectable per solve via `SolveRangeRequest.agent_strategy`
(**day_by_day is the default since v1.38**; the UI no longer offers repair —
it remains for the arena benchmarks and explicit API calls):

**repair**: the classic improve-the-draft loop.
1. **Seed**: `heuristic_solve_range_v2` produces the initial plan (its
   per-day `solution` events are muted; phases are forwarded).
2. **Loop**: the LLM gets a compact problem digest and the inspection/move
   tools; it improves a working copy until it stops, the iteration budget
   runs out, or the wall clock (`timeout_seconds`, default 300s for agent
   mode) expires.
3. **Finalize**: the best snapshot is returned — never worse than the seed.

**day_by_day**: the LLM builds the range from scratch the way a human
planner works, with four extra tools (`get_day_priorities`,
`suggest_day_blocks`, `suggest_rescue_moves`, `suggest_balance_moves`).
1. **Duty pre-pass**: one conversation staffs every open on-call/duty slot
   of the WHOLE range first — duties bind rest days and weekly-hours
   budgets, so placed last they starve.
2. **One fresh conversation per day**: slots are worked in PROCESSING
   order (single-candidate slots, then on-call, then the template's slot
   priority — never chronologically); `suggest_day_blocks` auto-selects
   the most urgent slot and returns pre-validated contiguous work blocks
   ("Anschlussverwendung") per candidate, with `overloaded=true` marking
   >16h days (a night duty stacked on a day duty is a last resort).
   Chains target the contract workday (contract/5, capped at 10h); a
   mandatory working-time window only bounds WHEN someone may work — its
   span is never treated as the daily workload target (v1.40, after a
   06:30–20:00 presence window produced a 13.5h auto-chain in
   production). When no candidate reaches the daily minimum, the longest
   block sorts first — one person on a 2h stint beats two people on 1h
   stints. Fully staffed days are skipped without a conversation.
3. **Rescue**: when a day's leftovers have `eligible_count 0`,
   `suggest_rescue_moves` searches depth-1 rearrangements of the agent's
   OWN placements (blocker out, substitute in, freed clinician onto the
   stuck slot) as pre-validated net-gain batches before anything is
   declared unfillable.
4. **Final review** (v1.40): once the day is complete,
   `suggest_balance_moves` re-reads it like a human planner — over-long
   days shed edge slots to less-loaded colleagues, mini-stint days
   (below the daily minimum) are handed entirely to an adjacent
   colleague so their holder stays off. Offers are pre-validated
   single-handover batches that keep both days contiguous and never
   create a new over-long or mini-stint day; fixed/manual assignments
   are never touched.
5. **Zero-progress guard**: an empty day-by-day result never reaches the
   client — it falls back to a fresh heuristic draft
   (`AGENT_FALLBACK_SEED`).

The iteration budget follows the admin rule **total slot instances × 10**
(floor 10), computed per solve; it supersedes `AGENT_MAX_ITERATIONS`, which
remains only as config plumbing. Any LLM failure (missing key, API error,
refusal) degrades to the seed/heuristic plan with a note; it never surfaces
as a 500 once a plan exists.

### Quality gate (`PlanToolExecutor._quality`)
The best-plan gate is a **lexicographic tuple**, not the hand-weighted scalar
score: `(hard_violations_in_range, open_required_slots, short_days,
soft_rule_violations, hours_deviation_minutes, -(preference fits
[+ assignments in distribute mode]))`, compared tier by tier — no weight can
trade a required slot against preference wins. Hard violations (in the solve
range) are the top tier so REPAIRING what the seed or manual data breaks
outranks filling slots: unassigning a rest-day-violating draft assignment
counts as an improvement even though it opens a slot. **Ties keep the agent's newest state**, so quality-neutral
swaps (YTD fairness, admin instructions — goals the tuple doesn't measure)
survive into the final plan instead of being overridden by an old snapshot.
`encode_quality` maps the tuple to a saturated scalar ONLY for the live chart
and run history (`seed_score`/`best_score` in `debugInfo.agent`); it gates
nothing. `score_plan` in `scoring.py` still exists for the CP-SAT path and
its tests, but the agent no longer sees or optimizes a score.

### Tools (`backend/agent/tools.py`) — full reference

Guardrails are structural, not prompt-based: fixed assignments (anything
already in app state) are immutable, capacity is enforced on assign, and a
move batch that would create NEW hard violations (relative to the seed
baseline — see the baseline-diff pattern in §6.5) rolls back atomically.
Slot instances are addressed as `"<slotId>__<dateISO>"`; slot ids may
contain `__`, so parsing splits on the LAST separator.

**Graded verdicts (v1.41):** legality stays a hard gate, but wherever a
verdict has a size, the tools report it so the model can weigh near-misses
against hopeless cases: `week_over_cap_hours` (how far over the weekly cap
a blocked move would land), `over_by_hours` on WEEKLY_HOURS violations and
batch rejections, `daily_min_hours` next to `meets_daily_minimum`, and
`receiver_overshoot_hours` on balance offers.

Inspection tools (both strategies):

| Tool | What it measures | Key output fields |
|---|---|---|
| `get_plan_overview` | Whole-plan status: the lexicographic quality tiers, coverage, best snapshot so far | tiers (hard/open/short/soft/hours/bonus), open counts, violation counts by code |
| `get_violations` | Current violations of fixed context + working copy, filterable by severity/code | code, message, clinicianId, dateISO, `new` (blocks acceptance), `repairable`, `over_by_hours` (weekly) |
| `list_open_slots` | Slot instances below required staffing | slot_key, section, date, time, missing (paginated) |
| `list_candidates_for_slot` | Per-clinician legality for 1–8 slots against the CURRENT plan (exact apply gate) | eligible, reasons (violation codes), `week_over_cap_hours`, day_hours, adjacent_to_existing, week_hours, contract_hours, ytd_worked_pct, prefers_section, window_fit |
| `get_clinician_summary` | One clinician's whole situation | contract+tolerance, week_hours per ISO week, ytd_worked_pct, sections, preferred times, in-range assignments (fixed vs own) |
| `list_short_days` | Days below the daily minimum, with pre-validated fix options (repair strategy's short-day pass) | clinician, date, hours, fixable, fix_options with blocked_by |
| `get_ytd_progress` | Year-to-date fairness across the roster | ytd_worked_pct per clinician (100 = on target), sorted most-behind first |
| `get_hours_overview` | Weekly hours vs contract for everyone | per clinician per ISO week: hours, contract, delta |
| `get_day_schedule` | One day as it currently stands | per slot: assignees, missing, times |

Move tool (both strategies):

| Tool | What it does | Key output fields |
|---|---|---|
| `apply_moves` | Atomic batch of assign/unassign against the working copy; the ONLY way to change the plan. `dry_run: true` previews quality without committing | applied, rejected (index+reason), new_hard_violations (code, message, `over_by_hours`), quality tiers after |

Day-by-day-only tools (the day pipeline):

| Tool | What it measures | Key output fields |
|---|---|---|
| `get_day_priorities` | One day's unfilled slots in PROCESSING order (single-candidate first, then on-call, then template priority, scarcest first) | slot_key, section, time, missing, priority, on_call, eligible_count, eligible_preview (≤20 shown + more_open_slots) |
| `suggest_day_blocks` | For one open slot (auto-selected when only dateISO is passed): up to 6 legal candidates, each with their best contiguous work block starting there (chain capped at the contract workday, ≤10h; a mandatory window only bounds it; a PREFERENCE window also steers the chain's position — past its edge only until the daily minimum is met). `single: true` = duty mode, no chaining | block (slot keys), block_hours, day_hours_after, meets_daily_minimum + `daily_min_hours`, overloaded (>16h), `window_fit` + `preferred_window` (wish fit of the whole block; sort tie-break after the daily minimum), week_hours(_max), ytd_worked_pct; `day_complete` + unfillable_slots when nothing fillable remains |
| `suggest_rescue_moves` | Depth-1 rearrangement search for eligible_count-0 slots: free a qualified person by moving ONE own placement, substitute covers the vacated slot | ready-to-apply 3-move batches, truly_unfillable, not_searched (cap/time cut) |
| `suggest_balance_moves` | End-of-day review: over-long days (> preferred span +1h) and mini-stint days (below daily minimum), with pre-validated handovers that keep both days contiguous | offers (batch, donor/receiver hours before→after, `receiver_overshoot_hours` ≤1h tagged trade-offs), overlong_days, mini_stint_days, balanced flag |

Long tool searches (rescue, balance) check the run's wall-clock deadline
(`executor.wall_deadline`, stamped by the harness) and cut short with a
"time budget" note — a single tool call can never push the run past its
budget (v1.41, after a production run overshot until the HTTP connection
was cut).

### Prompts (`backend/agent/prompts.py`) — full reference

| Prompt | Role | Content in one line |
|---|---|---|
| `SYSTEM_PROMPT` | System prompt of the repair strategy | Improve the heuristic draft: fix new hard violations, fill open slots, fix short days, then soft goals; finish criteria and rules of engagement |
| `DAY_SYSTEM_PROMPT` | System prompt of every day-by-day day conversation | Hard-constraint list + the 6-step procedure: (1) get_day_priorities once, (2) suggest_day_blocks auto-select, (3) candidate choice rules (pre-sorted; below-minimum → longest block first; overloaded last), (4) pipeline apply+suggest in one message, (5) repeat until day_complete, rescue once, (6) FINAL REVIEW via suggest_balance_moves with judgment guidance (soft targets, overshoot trade-offs); magnitude-reading rules; finish criteria |
| `DUTY_SYSTEM_PROMPT` | System prompt of the duty pre-pass conversation | Staff ALL on-call/duty slots of the range first, single=true (no chaining), never two duties same day/person, spread across people |
| `build_day_digest` | First user message of each day conversation | Roster with as-of-day YTD, the day's slots in processing order, fixed anchors, previous-day summaries, round budget, distribute-all note; may end with ADMIN INSTRUCTIONS |
| `build_duty_digest` | First user message of the duty pre-pass | Roster, all open duty slots of the range in date order, procedure + round budget |
| `build_problem_digest` | First user message of the repair loop | Seed quality tiers, open slots, repairable hard violations by name, iteration budget |

The harness adds smaller steering messages at runtime: a truncation nudge
when a reply is cut off mid-tool-call, and tool results themselves carry
`note` fields that steer the next step (processing order, day_complete
next actions, rescue/balance application rules, time-budget cuts).

### Scoring (`backend/scoring.py`)
Pure-Python replica of the CP-SAT objective (same `SolverSettings` weights,
minimized scale) over a precomputed `ScoringContext`, plus `plan_stats` and
`open_slots`. Reuses the pure helpers from `solver.py` (slot contexts,
intervals, YTD) so slot expansion cannot drift. Soft `SolverRule` violations
are reported by the validator and surfaced to the agent, but do not gate
acceptance.

### Pluggable LLM backend (`backend/agent/provider.py`)
The harness talks through a minimal protocol (`ChatMessage`/`ToolCall`/
`ProviderResponse` + `LLMProvider.complete`). Implementations:
- `AnthropicProvider` — official `anthropic` SDK; prompt-caching breakpoint on
  the system block, adaptive thinking, no sampling params. Key resolution:
  admin-stored key (Settings → Solver) wins over `ANTHROPIC_API_KEY` env.
- `OpenAICompatibleProvider` — official `openai` SDK against any
  OpenAI-compatible endpoint (self-hosted vLLM, llama.cpp, TGI, or OpenAI
  itself) via `openai_base_url`. Differences handled inside the adapter:
  tool arguments arrive as JSON strings (parsed defensively — broken JSON
  from weaker open models degrades to `{}` and the tool executor's own
  validation answers with a readable error), tool results are one
  `role="tool"` message per result, `finish_reason` mapping treats
  `stop`-with-tool-calls as `tool_use`, no `cache_control`/`thinking`
  params, no raw-content replay. vLLM must run with
  `--enable-auto-tool-choice` and a tool-call parser.
- `MockProvider` — deterministic scripted turns for tests; inject in-process
  or across the subprocess boundary via `AGENT_PROVIDER=mock` +
  `AGENT_MOCK_SCRIPT=<json path>`.
Provider selection and credentials are admin-configurable at runtime
(Settings → Solver → `agent_settings` table): provider, Anthropic key,
endpoint base URL + key + model name for the OpenAI-compatible path. The
solver WORKER overlays these onto the env config in-process
(`agent_budget.resolve_agent_runtime_config`) so secrets never travel through
the solve payload, its debug dumps, or any API response (the settings API
returns set/unset booleans only). The per-user AI budget applies to the
Anthropic provider only — self-hosted runs are free and never blocked by it.
Config is read from env at solve time (`AGENT_PROVIDER`, `AGENT_MODEL`,
`AGENT_MAX_TOKENS`; `AGENT_MAX_ITERATIONS` is superseded by the
slot-instances × 10 budget rule) — the spawn subprocess inherits it.
The model is an ADMIN-ONLY global setting (default `claude-sonnet-5`) stored
in the `agent_settings` table and managed via `GET/PUT /v1/agent/settings`
(`backend/agent_budget.py`); the solve endpoint injects it into the payload
(`SolveRangeRequest.agent_model`, server-overwritten so clients can't spoof
it) where it overrides `AGENT_MODEL`. The old per-user
`solverSettings.agentModel` is ignored. Every account also has a cumulative
AI budget (default $5, admin-settable): each run's cost is computed from its
token counts (pricing table mirrored from `src/lib/llmPricing.ts` — update
both together) and recorded in `agent_spend`; once over budget the harness
returns the heuristic draft with an explanatory note
(`payload.agent_budget_exhausted`, also server-injected). The frontend planning panel always
sends `solver_mode: "agent"` — the CP-SAT solver remains available through
the API (`solver_mode: "cpsat"`) and is still used by tests, but the UI no
longer offers the choice. YTD fairness: `PlanToolExecutor.ytd_completion_pct`
gives the percent of a clinician's year-to-date target hours worked up to a
given day (working copy included, vacations credited); candidates are sorted
most-behind first and the `get_ytd_progress` tool exposes the roster.
Candidates can be fetched for up to 8 slots per call (`slot_keys`), old tool
results are compacted to a stub once the history exceeds ~120K chars (chunked,
cache-friendly — see `harness._compact_tool_history`), and every run records
`debugInfo.agent.summary` + `.moves` (real names) for the run review in the
solver history. `plan_stats.short_days` counts clinician-days below the
derived daily minimum; candidates carry `day_hours`/`adjacent_to_existing` so
the agent avoids 1-2h mini-days. Each run's `debugInfo.agent` records
the model plus input/output/cache token counts; the frontend prices them via
`src/lib/llmPricing.ts` (per-run + cumulative cost in the solver history —
update that pricing table when Anthropic prices change).

### SSE progress channel (`/v1/solve/progress`)
Progress events are delivered only to SSE subscribers of the user who owns
the active run, and every event is tagged with the client-generated
`run_token` from the solve request. The frontend drops events whose token
doesn't match its current run — without this, stragglers from an aborted
previous run (or another user's run) get mixed into the live score chart
with a foreign objective scale, which shows up as a full-height "jump".

### Tests
- `backend/tests/test_scoring.py` — scorer/stats + **seed-parity** (heuristic
  output must validate cleanly and beat the empty plan)
- `backend/tests/test_agent_tools.py` — working copy, guardrails, snapshots
- `backend/tests/test_agent_harness.py` — loop behaviour with MockProvider
  (improvement, rejection, provider errors, budgets, abort, determinism)
- `backend/tests/test_agent_integration.py` — through POST `/v1/solve/range`
  with the real subprocess; includes the `use_heuristic` regression guard

---

## 7) Backend State + Persistence
Backend stores one JSON blob per user in SQLite:
```json
{
  "locations": [{ "id": "loc-default", "name": "Default" }],
  "locationsEnabled": true,
  "rows": [...],
  "clinicians": [...],
  "assignments": [...],
  "minSlotsByRowId": {...},
  "solverSettings": {
    "enforceSameLocationPerDay": true,
    "onCallRestEnabled": false,
    "onCallRestClassId": "on-call",
    "onCallRestDaysBefore": 1,
    "onCallRestDaysAfter": 1,
    "preferContinuousShifts": true
  },
  "solverRules": [],
  "publishedWeekStartISOs": ["2025-12-22"],
  "holidayCountry": "DE",
  "holidayYear": 2025,
  "holidays": [{ "dateISO": "2025-12-25", "name": "Christmas Day" }]
}
```
Note: `solverRules` is legacy and not used by the current UI/solver, but remains in state for compatibility.
`weeklyTemplate` (v4) is stored alongside the state and is the source of truth for schedule rows; `slotOverridesByKey` keys are `slotId__dateISO`.
State normalization on load
- Ensures `locations` exists (adds loc-default).
- Ensures section rows have `locationId` and `subShifts` (defaults to 08:00–16:00, endDayOffset 0).
- `locationsEnabled` is legacy; if false in older data, normalization forces default location usage and sets it back to true.
- Generates/normalizes `weeklyTemplate` v4; if missing, builds a default template from sections + sub-shifts (slot ids use legacy shiftRowIds).
- Filters assignments + slot overrides to existing template slot ids (and pool rows).
- Template slot assignment ids (e.g. `slot-1`) are preserved during normalization in both frontend and backend.
- Ensures `solverSettings` defaults, clamps on-call rest day values, and fixes invalid on-call class ids.
- Ensures the Rest Day pool exists (pool-rest-day), inserted after Reserve Pool.

Default state (clean database)
- Default state is loaded from `backend/default_state.json` file.
- New users start with a pre-configured radiology department setup:
  - **Location**: Berlin
  - **Sections**: On Call, MRI, CT, Sonography, MRI Neuro, CT Neuro (+ Rest Day, Vacation pools)
  - **Clinicians**: 2 sample clinicians (Galileo Galilei, Leonardo DaVinci) with full qualifications
  - **Weekly Template**: 4 row bands (MRI, CT, Sonography, On call), 3 columns per weekday, 2 columns for weekends/holidays
  - **Slots**: Pre-configured with times (08:00-12:00, 12:00-16:00, 16:00-08:00+1d for on-call)
  - **Holidays**: German holidays for 2026
- To modify the default state, edit `backend/default_state.json` directly.
- Fallback: if the JSON file doesn't exist, an empty state with only Rest Day and Vacation pools is created.
Table: `app_state` (id = username). Legacy row id `"state"` is migrated to `"jk"`. The table now also has an `updated_at` column which is bumped on every `POST /v1/state` save.

Endpoints
- `GET /health`
- `POST /auth/login`
- `GET /auth/me`
- `GET /auth/users` (admin only)
- `GET /auth/users/{username}/export` (admin only)
- `POST /auth/users` (admin only, seeds new user with default state from `default_state.json`)
- `PATCH /auth/users/{username}` (admin only, supports password reset)
- `DELETE /auth/users/{username}` (admin only)
- `GET /v1/state`
- `POST /v1/state`
- `POST /v1/solve/range` (accepts `use_heuristic` to switch solver engine)
- `POST /v1/solve/abort` (abort solver; `?force=true` kills subprocess immediately)
- `GET /v1/solve/progress` (SSE stream for live solver updates; requires `?token=<jwt>`)
- `GET /v1/state/health` (database health check)
- `GET /v1/state/inspect/week` (database inspector)
- `GET /v1/ical/publish`
- `POST /v1/ical/publish`
- `POST /v1/ical/publish/rotate`
- `DELETE /v1/ical/publish`
- `GET /v1/ical/{token}.ics` (public, no JWT)
- `GET /v1/web/publish`
- `POST /v1/web/publish`
- `POST /v1/web/publish/rotate`
- `DELETE /v1/web/publish`
- `GET /v1/web/{token}/week` (public, no JWT)
- `GET /v1/pdf/week`
- `GET /v1/pdf/weeks`

---

## 8) Auth Model (Backend + Frontend)
- JWT auth; frontend stores token in `localStorage` key `authToken`.
- Admin user is created on startup if `ADMIN_USERNAME`/`ADMIN_PASSWORD` are set and the user does not already exist.
- Set `ADMIN_PASSWORD_RESET=true` to force-reset the admin password on startup (useful for local dev DBs).
- Creating a user in the admin panel seeds the new user with the default state from `backend/default_state.json` (not the admin's state).
- Login is case-sensitive (`admin` is lowercase).
- Login screen includes show/hide password toggle.

---

## 9) Running Locally (Step-by-step)
Prereqs
- Python 3.9+
- Node 18+

**Quick start (Claude Code agent)**
To start fresh with a clean database:
```bash
# Kill any existing processes
lsof -ti:8000 | xargs kill -9 2>/dev/null
lsof -ti:5173 | xargs kill -9 2>/dev/null

# Delete database for fresh start (optional)
rm /Users/danieltruhn/Workspace/ShiftSchedule/schedule.db

# Start backend (env vars inline - IMPORTANT: must be on same line or exported first)
ADMIN_USERNAME=admin ADMIN_PASSWORD=<ADMIN_PASSWORD> JWT_SECRET=change-me-too python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 &

# Start frontend
npm run dev -- --host 0.0.0.0 --port 5173 &
```
- Default admin credentials: `admin` / `<ADMIN_PASSWORD>`
- Database location: `/Users/danieltruhn/Workspace/ShiftSchedule/schedule.db` (project root, not `backend/`)

**Common pitfalls**
1. **Admin password mismatch**: The admin user is created on first backend startup with the password from `ADMIN_PASSWORD`. If you delete the database and restart with a different password, or if the database already exists with a different password, login will fail.
   - Fix: Delete the database file and restart the backend with the correct password.
   - The password is hashed on user creation; changing `ADMIN_PASSWORD` after the user exists does NOT update the password.
   - Use `ADMIN_PASSWORD_RESET=true` to force-reset an existing admin password.

2. **Env vars not passed to backend**: If you start the backend without the env vars on the same command line (or without exporting them first), the admin user won't be created or will use wrong defaults.
   - Wrong: `python3 -m uvicorn backend.main:app ...` (no env vars)
   - Right: `ADMIN_USERNAME=admin ADMIN_PASSWORD=<ADMIN_PASSWORD> python3 -m uvicorn backend.main:app ...`

3. **Database location**: The database is at project root (`schedule.db`), not `backend/schedule.db`.

Auth env (required for login):
```bash
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD=<ADMIN_PASSWORD>   # local dev password
export JWT_SECRET=change-me-too
```

Step 1: install backend deps
```bash
python3 -m pip install -r backend/requirements.txt
```

Step 2: install frontend deps
```bash
npm install
```

Step 3: start backend (Terminal 1)
```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=<ADMIN_PASSWORD> JWT_SECRET=change-me-too python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Step 4: start frontend (Terminal 2)
```bash
npm run dev -- --host 0.0.0.0 --port 5173
```

Step 5: open the app
- http://localhost:5173
- Login: `admin` / `<ADMIN_PASSWORD>`

Codex CLI sandbox note (local dev)
- You may see `operation not permitted` when binding to ports (8000/5173) if the sandbox disallows it.
- Fix: rerun the start commands with escalated permissions, or use a Python `subprocess.Popen(..., start_new_session=True)` wrapper to launch in the background.
- Also avoid `nohup` in this environment; it can trigger permission errors.

If a port is already in use
- The backend has a startup check that errors if port 8000 is already in use, with a message like: "Port 8000 is already in use by another process."
- Kill existing processes: `lsof -ti:8000 | xargs kill -9` and `lsof -ti:5173 | xargs kill -9`
- Backend: pick another port, then set `VITE_API_URL` for the frontend:
```bash
python3 -m uvicorn backend.main:app --host localhost --port 8001
VITE_API_URL=http://localhost:8001 npm run dev -- --host localhost --port 5173
```
- Frontend: pick another port with `--port 5175` and open that URL in the browser.

If the UI says "Solver service is not responding"
- Check backend health: `curl http://localhost:8000/health`
- Ensure `VITE_API_URL` matches the backend host/port.
- If backend logs show 401 on `/v1/solve`, the auth token is invalid (often after a JWT secret change). Log out/in.
- If backend logs show a validation error for `solverSettings` fields, restart the backend so the updated models load.
- If using a non-localhost host (LAN or remote), set CORS explicitly:
```bash
CORS_ALLOW_ORIGINS=http://my-host:5173 python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Env note
- `export ...` in a terminal is session-only (not permanent).

Stopping servers
- Press Ctrl+C in each terminal, or `lsof -ti:8000 | xargs kill -9` / `lsof -ti:5173 | xargs kill -9`.

Deployment note
- Build the frontend with `VITE_API_URL=https://your-api.example.com npm run build`, then serve `dist/`.
- Run the backend behind a reverse proxy (or public host) and set `CORS_ALLOW_ORIGINS` to your frontend origin.

---

## 10) UI Styling
Centralized button styles
- All button styles are defined in `src/lib/buttonStyles.ts` for consistency.
- `pillToggle` / `getPillToggleClasses(isActive)`: toggle buttons with sky-blue active state.
- `buttonPrimary`: main action buttons (Save, Close, Run).
- `buttonSecondary`: secondary actions (Cancel, Reset, Today).
- `buttonSmall`: inline action buttons (Edit, Remove in lists).
- `buttonDanger`: destructive actions (Remove with rose color).
- `buttonAdd`: dashed border add buttons (Add Person, Add Holiday).
- `pillLabel`: non-interactive label pills.
- When adding new buttons, use these centralized styles instead of inline classes.

---

## 11) Key Files
Frontend
- `src/pages/WeeklySchedulePage.tsx` (main state + logic)
- `src/components/schedule/ScheduleGrid.tsx`
- `src/components/schedule/ClinicianEditor.tsx`
- `src/components/schedule/ClinicianEditModal.tsx`
- `src/components/schedule/SettingsView.tsx`
- `src/components/schedule/WeeklyTemplateBuilder.tsx` (template grid, Copy Day, colBand safeguards)
- `src/components/schedule/ClinicianPickerPopover.tsx` (open slot click → clinician selection)
- `src/components/schedule/RowLabel.tsx`
- `src/components/schedule/AssignmentPill.tsx`
- `src/components/schedule/VacationOverviewModal.tsx` (vacation planner, scrolls to today on open)
- `src/components/schedule/WorkingHoursOverviewModal.tsx` (yearly working hours overview for all clinicians)
- `src/components/schedule/SolverOverlay.tsx` (live solver progress overlay with chart and abort/apply)
- `src/components/schedule/SolverDebugPanel.tsx` (debug info visualization after solve completes)
- `src/components/schedule/SolverInfoModal.tsx` (solver info modal with history, settings, and configurable weights; auto-resets to info view when opened)
- `src/components/schedule/AutomatedPlanningPanel.tsx` (solver control panel with date range and strategy)
- `src/api/client.ts`
- `src/lib/shiftRows.ts` (weeklyTemplate normalization, colBand safeguards, legacy shiftRowId helpers)
- `src/lib/schedule.ts` (rendered assignment map, time intervals, Rest Day pool logic)
- `src/lib/solverStats.ts` (live solver stats calculation: coverage, preferences, time windows, on-call rest, working hours)

Backend
- `backend/main.py` (app setup + router wiring)
- `backend/models.py` (Pydantic models including SolverSubScores, SolverDebugInfo)
- `backend/constants.py` (shared constants)
- `backend/db.py` (SQLite schema + connection helpers)
- `backend/state.py` (state normalization, defaults, persistence)
- `backend/default_state.json` (default state for new users)
- `backend/auth.py` (JWT auth + admin endpoints)
- `backend/web.py` (public web publish endpoints)
- `backend/pdf.py` (PDF export endpoints)
- `backend/ical_routes.py` (iCal endpoints)
- `backend/publication.py` (tokens + caching helpers)
- `backend/solver.py` (CP-SAT solver endpoint + logic)
- `backend/heuristic/solver_v2.py` (heuristic solver v2 implementation)
- `backend/heuristic/models.py` (heuristic solver data models)
- `backend/state_routes.py` (health + state endpoints + database inspection)
- `backend/requirements.txt`
- `backend/schedule.db`

Database Inspector
- `src/pages/DatabaseInspectorPage.tsx` (full-page database inspection view)

---

## 12) Notes for New Agents
- The calendar is the source of truth for edits; Settings manages section priority + min slots + pool names + clinician list.
- Pool ids: Rest Day = `pool-rest-day`, Vacation = `pool-vacation`. Distribution Pool (`pool-not-allocated`) and Reserve Pool (`pool-manual`) were removed; state normalization auto-cleans them.
- Keep drag restricted to same day; manual overrides are allowed even if they violate solver rules.
- Mobile single-day view uses `useMediaQuery("(max-width: 640px)")` with `displayDays`; week-level calculations still use `fullWeekDays`.
- `ScheduleGrid` supports variable day counts (dynamic `gridTemplateColumns`, last column determined by index).
- Hover highlighting is desktop-only (no hover on mobile) and uses `AssignmentPill` `isHighlighted`.
- HTML5 drag-and-drop does not work on mobile; touch DnD would require a new library or alternate UX.
- If you change the solver API, update `src/api/client.ts` and `WeeklySchedulePage.tsx`.
- Legacy row id `pool-not-working` is filtered out on load.
- **Versioning (mandatory):** `src/version.ts` holds `APP_VERSION` (string, starts at `"1.00"`) and `APP_BUILD` (integer, starts at `0`), rendered as a subtle `v1.00 (0)` badge at the bottom-right of the app (`App.tsx::VersionBadge`). Bump BOTH on every delivered iteration — version `+0.01`, build `+1` — so the owner can verify which build a deployment runs.

---

## 13) Current Hetzner Deployment (Domain, default)
- Server IP: `46.224.114.183`
- SSH user: `root`
- Path: `/opt/shiftschedule`
- Stack: `docker compose up -d --build` (uses `docker-compose.yml` + Caddy).
- Frontend: `https://shiftplanner.wunderwerk.ai`
- Backend: `https://shiftplanner.wunderwerk.ai/api`
- Data lives in the `backend_data` volume; you can update only the frontend without touching the DB.
- Typical frontend update: rsync repo to `/opt/shiftschedule`, then `docker compose build frontend` and `up -d frontend`.

### Remote setup checklist (smooth deploy)
- Ensure `/opt/shiftschedule/.env` exists before running compose. If you use `rsync --delete`, exclude `.env` or recreate it after sync.
- Required `.env` values for domain setup:
  - `DOMAIN=shiftplanner.wunderwerk.ai`
  - `LETSENCRYPT_EMAIL=daniel.truhn@gmail.com`
  - `ADMIN_USERNAME=admin`
  - `ADMIN_PASSWORD=<ADMIN_PASSWORD>`
  - `JWT_SECRET=change-me-too`
  - `JWT_EXPIRE_MINUTES=720` (avoid empty string; backend crashes on startup)
- `PUBLIC_BASE_URL` is set in `docker-compose.yml` as `https://${DOMAIN}/api` (don’t leave it blank).
- If login fails and you need a forced reset, set `ADMIN_PASSWORD_RESET=true` in `.env` and restart backend, then remove/disable it after login works.
- iCal subscription endpoints require `/api` proxying in the frontend nginx config; otherwise `/api/v1/ical/*.ics` returns HTML and Apple Calendar rejects it.
- Domain stack uses Caddy on ports 80/443; stop the IP-only stack first to avoid port conflicts.
- After deploy, always verify:
  - `curl -s -o /dev/null -w "%{http_code}" https://shiftplanner.wunderwerk.ai` (expect 200)
  - `curl -s -o /dev/null -w "%{http_code}" https://shiftplanner.wunderwerk.ai/api/health` (expect 200)
- Before deploy, run `npm run build` locally to catch TypeScript build errors that unit/E2E tests may not cover.

## 14) IP-only Deployment (optional)
- Stack: `docker compose -f docker-compose.ip.yml up -d --build`
- Frontend: `http://46.224.114.183`
- Backend: `http://46.224.114.183:8000`
- IP-only stack binds port 80 directly; it conflicts with Caddy, so only run one stack at a time.
- `.env` required for domain setup:
  - `DOMAIN=shiftplanner.wunderwerk.ai`
  - `LETSENCRYPT_EMAIL=daniel.truhn@gmail.com`
  - `ADMIN_USERNAME=admin`
  - `ADMIN_PASSWORD=<prod password>`
  - `JWT_SECRET=<prod secret>`
  - `JWT_EXPIRE_MINUTES=720` (avoid empty string)
- Caddy handles TLS + `/api` proxying. Frontend uses `VITE_API_URL=/api` so no extra env needed.
- `PUBLIC_BASE_URL` is set in `docker-compose.yml` as `https://${DOMAIN}/api` (don’t leave it blank).
- If admin login fails after switching stacks, the existing DB user may still have the old password. Reset via:
  - `docker compose exec -T backend python - << 'PY' ...` (update `users` table in `/data/schedule.db`).
