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
- **Constraint validator (LLM-backend-ready): `backend/validation.py`** — pure, solver-independent hard-constraint checker; see section 6.5.
- Solver live stats: `src/lib/solverStats.ts`
- E2E tests + diagnostics: `e2e/fixtures.ts`, `e2e/app.spec.ts`, `e2e/colband-explosion.spec.ts`; mocked-API specs run in CI: `e2e/agent-apply.spec.ts`, `agent-activity`, `fixed-assignments`, `model-settings`, `my-plan`, `team-page`
- My plan (v1.64): `src/components/myPlan/MyPlanView.tsx`, pure model `src/lib/myPlan/`, preferences `src/lib/userPreferences.ts` + `backend/preferences.py`
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
- Open slots badge lives in the schedule card header (always yellow; clicking it jumps to the next open slot; on a phone it first switches the day view to that slot's day). Counting lives in `src/lib/openSlots.ts` (`computeOpenSlots`).
- Responsive: stacks on small screens; avatar row moves below the main controls.

Schedule card
- Since v1.64 the card header has an extra first row (`TeamPlanHeader`, classic grid and clinic sheet): "Team | My plan" switch, "Times" and "Color by" (both classic grid only, "Times" since v1.65), start-page star and Views menu. In scope "My plan" the card shows `MyPlanView` and the planning panels below the calendar are hidden (kept mounted). See the v1.64 section at the end.
- Since v1.65 the classic grid has two time layouts ("Times: Side by side | Stacked", per-user preference `teamTimeLayout`, default Stacked): Side by side gives every col band of a day its own column (the pre-v1.65 look); Stacked shows one column per day and the day's times as rows below each other, with the row band name and the time in the label column, so the whole week fits on screen. Since v1.66 stacked cells hold only the people (no section block or name; labels and cells carry the section color) and the PDF export offers this compact week on A4 portrait. See the v1.65 and v1.66 sections at the end.
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
- Drag and drop is same-day only. A drop on another day, on an inactive cell or on a slot whose time clashes with another shift of the person REMOVES the assignment (no snap-back; known limitation), a drop on its own cell is a no-op, and a malformed drag payload (e.g. a cross-tab drop) is ignored (`readDragPayload` in `src/lib/clinicianSlotOptions.ts`, shared by both grids).
- Drag/drop does not block rule-violating placements (same-day location mix, multiple shifts); solver enforces rules but manual overrides are allowed and shown in red. Overlap within the same day is blocked by drag/drop (uses time intervals).
- Drag-to-remove: dragging a clinician pill outside the grid removes the assignment.
- Dragging into or out of Vacation updates the clinician vacation ranges.
- Clinician Picker: clicking an open slot shows a popover listing everyone (search field; people without any warning first, then by name); warnings: "Already in slot", "Not qualified", "On vacation", "Rest day", "Time conflict", "Different location" (`ClinicianPickerPopover.tsx`).
- While dragging, the other days are greyed out and same-day cells the clinician is qualified for and free for get an outline (`showQualified` in `ScheduleGrid.tsx`). Moving a person out of a slot that has no valid time (e.g. 20:00–08:00 without +1 day) to another slot on the same day is no longer blocked by that slot itself (v1.64).
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
- Smoke test (API): `API_BASE=http://127.0.0.1:8000 ADMIN_USERNAME=admin ADMIN_PASSWORD=<pass> node scripts/smoke-api.mjs` — read-only since v1.64 (health, login, state, run inbox); it no longer calls the removed `POST /v1/solve/week` and never starts a solver run.

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
- Location color (v1.64, optional): a swatch next to the location name in the template builder (`LOCATION_COLOR_OPTIONS` in `src/lib/colorPalette.ts`: slate, sand, sage, lilac, or none). Stored as `Location.color` (`#RRGGBB`); presentation only — tints the location's rows in the team grid and the days in My plan, and is excluded from the planning fingerprint.

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
- ColBand explosion safeguard: max 20 colBands per day type (`MAX_COLBANDS_PER_DAY`, duplicated in the two files below and in `backend/state_routes.py`, which only uses it for the health check — keep them in sync). Extra colBands are dropped (truncated) and logged. Safeguard is enforced in:
  - `src/lib/shiftRows.ts` (normalizeTemplateColBands)
  - `src/pages/WeeklySchedulePage.tsx` (the setWeeklyTemplate wrapper truncates per day; every builder change goes through it — the builder's own copy of the sanitizer was removed in v1.64)
- Total limit: above `MAX_TOTAL_COLBANDS` = 300 colBands summed over all locations (`src/lib/templateLimits.ts`), `buildCurrentStatePayload` refuses to save (console.error). Since v1.64 the page shows an amber banner instead of failing silently; sign-out asks before discarding unsaved changes, importing a schedule snapshot is refused, and restoring a calendar snapshot stays possible (it backs up the last saved calendar, not the screen).
- **Slot collision detection**: Multiple sections sharing the same `rowBandId + dayType + colBandOrder` causes only one section to be visible in the calendar UI while others are hidden but still exist in the database. This is a critical configuration error.
  - Detection: `slotCollisions` useMemo in `WeeklySchedulePage.tsx` identifies collisions by grouping classShiftRows by `locationId__rowBandId__dayType__colBandOrder` and flagging groups with multiple different `sectionId` values.
  - Warning banner: A prominent red banner appears below the top bar when collisions are detected, showing:
    - Error title: "Template Configuration Error: Hidden Sections Detected"
    - Explanation of the issue (only one section visible, others hidden)
    - Expandable list of collision details (day type, row band, affected section names)
    - "Open Settings" button to navigate to template builder for fixing
  - Fix: Ensure each section has its own row band in the Weekly Template Builder.

Clinicians
- List with Add Clinician, Edit and Remove buttons (Add uses a dashed, full-width button below the list). Remove asks for confirmation since v1.64: it deletes the person's assignments in all weeks, vacations and preferences, without undo.
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
- Add holidays manually; list shows DD.MM.YYYY dates (the add panel uses the DD.MM.YYYY date picker; `parseHolidayDate` accepts only that form).
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
  - Coverage (1000), Slack (1000), Total Assignments (100), Slot Priority (10), Time Window (20), Section Preference (10), Working Hours (3), Minimum Daily Hours (5), YTD Balance (5). Defaults: `backend/models.py::SolverSettings`, which backend normalization applies (the CP-SAT objective reads `solverSettings` directly, no second default table); mirrored in `src/components/schedule/SolverInfoModal.tsx` (`DEFAULT_WEIGHTS`) and, since v1.64, in the frontend fallback `src/data/mockData.ts::defaultSolverSettings`.
  - Only the CP-SAT path (`solver_mode="cpsat"`, API/benchmarks) reads these weights (`scoring.score_plan` was removed in v1.64); AI planning ranks plans by its lexicographic quality tuple and ignores them. The weights section in the modal says so.
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
  - `test:e2e` script includes `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=mac15-arm64`, which only works on Apple Silicon. On Linux, Intel Macs and Windows run `npx playwright test` directly (CI does).
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
  - Events are all-day (`DTSTART;VALUE=DATE` / `DTEND;VALUE=DATE`, DTEND exclusive). Since v1.64 DTEND is start + 1 + the slot's `endDayOffset` days (capped at +3), so an overnight duty also blocks the next day, as in the subscribed feed (`backend/ical.py`); before, the download always used start + 1.
  - Range parsing accepts `DD.MM.YYYY` (and also `YYYY-MM-DD`), swaps Start/End if reversed, and disables download on invalid input.
- Files: `src/lib/ical.ts`, `src/components/schedule/IcalExportModal.tsx`, wiring in `src/pages/WeeklySchedulePage.tsx`.

Subscribable iCal feed (cryptic URL)
- Publication scope is controlled by `publishedWeekStartISOs` in user state:
  - Array of Monday ISO strings (YYYY-MM-DD) for weeks that are released.
  - If empty, the feed is valid but has **zero** events.
- Backend stores tokens in SQLite:
  - `ical_publications` (one token per user, all clinicians).
  - `ical_clinician_publications` (one token per clinician per user).
- Public endpoint (no JWT): `GET /v1/ical/{token}.ics` (`HEAD` also answered since v1.64, with the same validators)
  - `Content-Disposition: inline; filename="shift-planner-<owner>.ics"; filename*=UTF-8''…` — the plain `filename` falls back to `shift-planner.ics` when the account name is not printable ASCII (non-Latin-1 names used to cause a 500)
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
  - `POST /v1/ical/publish` (enable links; keeps existing tokens; idempotent since v1.64 — it no longer touches `updated_at`, so opening the Export modal does not reset subscribers' cache validators)
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
  - `POST /v1/web/publish` (enable; idempotent since v1.64 — republishing keeps the token and the week ETag/Last-Modified)
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
  color?: string | null; // v1.64: "#RRGGBB" tint, presentation only; omitted from dumps when unset
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
  weightTimeWindow?: number;         // default 20
  weightSectionPreference?: number;  // default 10
  weightWorkingHours?: number;       // default 3
  weightMinimumDailyHours?: number;  // default 5
  weightYtdBalance?: number;         // default 5
  // further fields (scheduleLayout, agent*) — see src/api/client.ts
};
```

Per-user UI preferences (v1.64) — NOT part of AppState
```ts
// GET/PUT /v1/me/preferences; table user_preferences(username, data, updated_at)
// backend/models.py::UserPreferences, mirrored in src/api/client.ts
type PlanScope = "team" | "me";
type PlanRange = "day" | "week" | "month";
type Orientation = "top" | "left";          // "top" = dates on top (days are columns)
type ColorBy = "section" | "person";
type ViewConfig = { scope: PlanScope; range: PlanRange; orientation: Orientation; colorBy: ColorBy };
type ViewStartAt = "today" | "nextShift" | "weekStart";  // relative anchor, never a date
type SavedView = ViewConfig & { id: string /* 1-64 */; name: string /* 1-60 */; startAt: ViewStartAt /* default "today" */ };
type UserPreferences = {
  version: number;                          // 1
  clinicianId: string | null;               // "I am …" link (max 200 chars, blank = null)
  orientationByRange: Record<PlanRange, Orientation>;        // computers; default all "top"
  orientationByRangeMobile: Record<PlanRange, Orientation>;  // phones; default week "left" (agenda)
  myPlanRange: PlanRange;                   // computers; default "week"
  myPlanRangeMobile: PlanRange;             // phones; default "week"
  teamColorBy: ColorBy;                     // default "section"
  savedViews: SavedView[];                  // max 12, unique ids
  startViewDesktop: ViewConfig | null;      // start page on computers (no startAt)
  startViewMobile: ViewConfig | null;       // start page on phones (no startAt)
};
```
- Saving preferences never changes the calendar revision or a planning fingerprint; the row is deleted together with the account. An unreadable stored row is ignored (defaults returned) instead of locking the user out.

Slot IDs
- Section assignments use TemplateSlot ids (Assignment.rowId = TemplateSlot.id); pool rows continue using their plain pool IDs.
- Default template generation uses legacy shiftRowId values (`classId::subShiftId`, e.g. `mri::s1`) for slot ids so existing assignments survive.
- UI uses “section”, but internal ids and RowKind still use `class` for compatibility.

---

## 5) Scheduling Logic (Frontend)
- Vacation override: for each date, if clinician is on vacation, they appear in Vacation pool and their section assignment is suppressed.
- Multiple shifts per day are always allowed; time overlap detection prevents assigning the same clinician to overlapping shift intervals.
- Rest Day Pool (pool-rest-day): if on-call rest days are enabled, clinicians assigned to the on-call section are placed into Rest Day on the configured days before/after (the Rest Day pool is always present after normalization; there is no fallback).
- Assignments stored in a map (rowId + dateISO -> list of assignments); section rows use template slot ids.
- Drag and drop only within the same day; manual overrides are allowed even if they violate solver rules.
- Clicking a section slot cell increments the per-day slot override for that slot id (adds an "Open Slot"); remove via the minus badge.
- Day type is `holiday` if the date is in holidays; otherwise it is the weekday. Holiday settings always override weekday settings.
- Overlap checks use time intervals (start/end + endDayOffset); shift order is not used for overlap decisions. These checks feed solver constraints and UI violation detection.
- Drag/drop also prevents placing a clinician into overlapping time slots on the same day.
- Clinician picker popover: viewport-aware positioning opens above anchor when insufficient space below (flips direction automatically).

---

## 6) Solver (Backend)

Three solver modes exist, selected by `solver_mode` in the request: `cpsat` (API default), `heuristic`, `agent`. The UI always sends `agent`; cpsat/heuristic remain API-only (benchmarks, arena, fallback). `use_heuristic` is legacy.

### CP-SAT Solver (default) — `backend/solver.py`
Endpoint:
- `POST /v1/solve/range` (range solver; accepts `startISO` and optional `endISO`)
Payload:
```json
{ "startISO": "YYYY-MM-DD", "endISO": "YYYY-MM-DD", "only_fill_required": true,
  "solver_mode": "cpsat" | "heuristic" | "agent", "agent_strategy": "day_by_day" | "repair",
  "timeout_seconds": 60 }
```
`endISO` is optional: cpsat/heuristic default to 7 days (resolved and stored on the run); agent solves only `startISO`; `solver_mode` defaults to `cpsat` when omitted (`use_heuristic` is legacy); `agent_strategy` only applies to `agent` (default `day_by_day`).

Behavior
- Considers all clinicians not on vacation; protected (manual or locked/fixed) assignments are kept, unlocked in-range solver assignments are replaced.
- Includes a context window of max(3, onCallRestDaysBefore, onCallRestDaysAfter) days on both ends (`_context_pad`; the rest days count only when on-call rest is enabled, otherwise it is a fixed 3). A new on-call slot is forbidden when its rest window would hit manual work on a context day; a warning note is emitted if boundary days are already assigned.
- Hard constraints:
  - Qualification required.
  - Vacation overrides assignment.
  - Manual assignments remain in place; solver adds additional assignments as needed.
  - Overlap checks use time intervals (start/end + endDayOffset), not shift order.
  - Multiple shifts per day are allowed as long as they don't overlap in time and remain continuous.
  - "Enforce same location per day" blocks mixing locations on the same day.
  - On-call rest days: if enabled, clinicians assigned to the selected on-call section must be unassigned on the configured days before/after.
  - Enforce continuous shifts: each clinician/day has at most one continuous block (or existing manual blocks).
  - Mandatory preferred working-time windows.
  - ISO-week hours cap (`_add_weekly_hours_caps`): contract hours + tolerance per ISO week, counting fixed work outside the range; an existing overload must not grow.
- Targets template slot ids; order weights follow location order + row band order + column band order.
- Qualification + preference checks use slot.sectionId (the parent section).
- Objective (weighted minimization):
  - **Coverage** (w=1000): Maximize filled required slots, prioritized by section order.
  - **Slack** (w=1000): Minimize unfilled required slots.
  - **Total Assignments** (w=100, Distribute All only): Maximize total assignments.
  - **Slot Priority** (w=10, Distribute All only): Prefer earlier slots in template order.
  - **Time Window** (w=20): Respect clinician preferred working hours.
  - **Section Preference** (w=10): Assign clinicians to their preferred sections.
  - **Working Hours** (w=3): Balance hours to target ± tolerance.
  - **Minimum Daily Hours** (w=5): Penalize daily assignments shorter than the derived minimum.
  - **YTD Balance** (w=5): Bias toward clinicians behind on year-to-date hours.
  - Defaults live in `backend/models.py::SolverSettings`.
- Sub-scores are computed after solving and returned in `debugInfo.sub_scores` (slots_filled, slots_unfilled, total_assignments, preference_score, time_window_score, hours_penalty, ytd_balance_bonus).
- Gap-based early stopping: once optimality gap drops below 5%, allows 20s grace period then stops.

### Heuristic Solver v2 — `backend/heuristic/solver_v2.py`
- Alternative fast solver activated by `"solver_mode": "heuristic"` (legacy `use_heuristic: true` still works; `solver_mode` wins).
- Uses a greedy multi-phase approach instead of constraint programming.
- Phases: bottleneck pre-assignment → day-by-day filling with retries and consecutive filling → optional capacity only in Distribute all mode (after mandatory staffing). There is no local-improvement phase.
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
- The remaining time budget is split across the remaining weeks (`week_timeout = remaining / weeks_left`).
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
  - Default: Sets the run's abort event, solver stops at next solution callback (graceful).
  - `force=true`: Immediately terminates the subprocess via `Process.terminate()` then `Process.kill()` if needed.
- Abort is OWNER-SCOPED: without `run_id` it targets the caller's own active run; with `run_id` only the run's owner (or an admin) may abort it. Foreign/unknown ids uniformly report `no_solver_running`.
- This enables instant abort even when the solver is stuck without finding new solutions.
- Run tracking: `_active_runs` (username → `_RunHandle` with process, per-run mp cancel event, per-run `abort_requested`) under `_registry_lock`. At most ONE run per user; different users' AGENT runs execute concurrently (global cap `MAX_CONCURRENT_SOLVES`, env, default 4 — set to 1 to restore single-slot admission). Legacy cpsat/heuristic modes stay machine-exclusive (require empty registry, block all other starts).
- Subprocess cleanup: `atexit` handler and aggressive cleanup function (`_cleanup_solver_processes`) ensure subprocesses are killed on backend restart/crash. Uses `terminate()` first, then `kill()` after 2s timeout. There is no startup sweep (the pgrep-based `_cleanup_orphaned_solver_processes` was removed in v1.64; an orphaned worker exits on its own once the parent's heartbeat stops).
- Overshoot watchdog (only when the request sets `timeout_seconds`): the soft stop sets the cancel event `RUN_OVERSHOOT_SOFT_SECONDS` (60 s) past the budget; the hard stop `RUN_OVERSHOOT_HARD_SECONDS` (120 s) past it now SIGKILLs the worker once (`terminate()` was a no-op because the worker's SIGTERM handler only sets the cancel event), waits up to 5 s for it and reads its queue with a bounded drain (`_drain_dead_worker_queue`, `RUN_QUEUE_DRAIN_TIMEOUT_SECONDS` = 10 s), so a torn queue message cannot leave a run `running`. A killed agent run reports no usage, so its LLM spend up to the kill is not charged (known trade-off).

SSE live updates (real-time progress):
- Endpoint: `GET /v1/solve/progress` (SSE format over an authenticated fetch stream; `Authorization: Bearer <jwt>` header — bearer credentials never go into URLs, there is no `?token=`).
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
    - "Run in background" - hides the overlay; the run continues server-side and a badge stays in the corner.
    - "Stop run" (rose/red) - always visible; the calendar stays untouched, a partial result lands in the run inbox.
    - "Apply best plan" (indigo/blue) - only shown after solutions found; stops the run and applies the best plan so far.
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

Agent activity display (v1.57):
- The current day/phase and running check stay above the scrollable history. Tool start/end receipts are emitted by `PlanToolExecutor.execute`, including nested proposal follow-ups and final checks, without extra validation or model calls.
- Every agent event carries its stage and current planning context, so the bounded client buffer and reconnects cannot reset the stage. Stable sequence ids preserve feed row identity.
- Search receipts distinguish partial/cached searches from checked results; zero options is never presented as proven infeasibility. Draft changes indicate when an earlier best snapshot is retained. Coverage is labelled as the best saved draft.
- Model text is optional, with complete text in a keyboard-accessible dialog. The chronological history only scrolls on an explicit “Jump to latest” click.
- The fetch stream (`src/api/client.ts`) reconnects with exponential backoff (max 30 s) and stops after 6 consecutive failures or on 401/403/404; the overlay marks the view as potentially stale while disconnected. The stream does not replay missed history.
- Browser replays: `e2e/agent-activity.spec.ts` checks long streams, run isolation, reconnects, mobile layout and model text; no real model calls or calendar writes.
- Stats include both solver-generated and existing manual assignments in the solve range for accurate filled slots display.
- Accepts optional `solverSettings` parameter (passed from WeeklySchedulePage) for on-call rest violation tracking.
- Stats tracked: filledSlots, totalRequiredSlots, openSlots, nonConsecutiveShifts, peopleWeeksWithinHours, totalPeopleWeeksWithTarget, locationChanges, totalAssignments, sectionPreferenceMatches, totalClassAssignments, timeWindowFits, totalAssignmentsWithTimeWindows, onCallRestViolations.

Automated Shift Planning panel (frontend):
- Timeframe: "Current week" and "Today" quick buttons; custom date pickers (DD.MM.YYYY) for start/end displayed inline with dash separator.
- No strategy toggle any more (removed on admin request, 2026-07): every run fills required slots only (`only_fill_required=true`); Distribute-all stays available through the API.
- Run button starts an AI planning run (`solver_mode: "agent"`); the result waits in the run inbox (Solver info modal) until it is applied or discarded.
- Reset button opens a dropdown panel with two options (rules in `src/pages/resetSolverAssignments.ts`, unit-tested):
  - "Reset Solver Only" (`resetSolverAssignments`): in the timeframe, removes every unlocked solver entry of a section row, including entries on the clinician's vacation days (hidden in the grid) — the same rule as applying a stored draft (`backend/assignment_policy.py::is_replaced_by_draft`). Keeps manual/legacy and locked (fixed) entries, pool entries and everything outside the timeframe. Before v1.64 it also kept unlocked solver entries on vacation days.
  - "Reset Unfixed" (`resetUnfixedAssignments`): in the timeframe, removes every entry (pool rows included) except locked ones and manual/legacy ones on the clinician's vacation days. Unlocked solver entries on vacation days go too (before v1.64 every entry on a vacation day was kept), so it always removes at least what "Reset Solver Only" removes. Vacation ranges themselves live on the clinician and are untouched.
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
  and M days after each on-call slot (any other assignment in that window is a violation, including a second on-call slot; the heuristic blocks it too)
- `validate_mandatory_windows` — slots must fit inside `preferredWorkingTimes`
  entries whose requirement is `mandatory` (`preference` entries are soft)
- `validate_weekly_hours` — per ISO week, assigned hours ≤ contract + tolerance
  (hard, matching heuristic v2 and, since v1.61, the CP-SAT ISO-week cap
  `_add_weekly_hours_caps`, which also counts fixed work outside the range)
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
daily hours. Plan statistics (`plan_stats`, `open_slots`) live in `backend/scoring.py`; the agent's quality tuple is built on them (see §6.6). The weighted objective exists only inside the CP-SAT model.

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
- Calendar safety: `backend/tests/test_agent_workflow_safety.py`,
  `src/lib/stateSaveQueue.test.ts`, and `e2e/agent-apply.spec.ts` cover stale saves,
  apply validation/confirmation/rollback, empty aborts, and premature day completion.
`backend/tests/test_validation.py` — run with
`pytest backend/tests/test_validation.py`. Tests use the conftest factories
EXCEPT for multi-location scenarios, which build `AppState` manually (because
`make_app_state` creates a single `WeeklyTemplateLocation`).

### Things to watch out for
- **`qualified_class_ids=[]` in `make_clinician()` is ignored** — the factory
  does `qualified_class_ids or ["section-a"]`, so empty-list falls back to the
  default. Use `["section-nonexistent"]` to force a qualification violation.
- **`_slot_interval()` returns `None` only when the end is not after the
  start** (e.g. 20:00–08:00 saved without "+1 day"). Missing times get the same
  defaults as `solver._build_slot_interval` (08:00, +8 h). The validator then
  reports such a slot as `VIOLATION_UNKNOWN_SLOT` via `validate_references`.
  Since v1.64 heuristic v2 skips these slots too (`_expand_slots_to_instances`,
  one "Slot … skipped … (missing +1d?)" warning per slot), so its output keeps
  passing the validator; CP-SAT still clamps them to zero duration and may
  fill them (open follow-up: auto "+1 day" or a UI warning). The UI does not
  prevent the input. If this rule changes, update the validator,
  `_build_slot_interval` and the heuristic together.
- **New constraints must land in three places.** Any constraint added to the
  CP-SAT solver or heuristic v2 must also be added to `validation.py` — the
  agent solver's guardrails are only as complete as the validator. A new
  quality metric goes into `scoring.plan_stats` (and the agent's quality tuple
  if it should gate plans); there is no weighted scorer to keep in sync any
  more. The seed-parity test in `backend/tests/test_scoring.py` catches drift:
  heuristic output must pass `validate_assignments` and fill more slots than
  the empty plan (`plan_stats(...).filled_slots`).

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
the full result JSON, and removes the run from the per-user registry
(runs of different users execute concurrently; a user never has two
overlapping runs). A plan salvaged from the last streamed solution (user
abort, watchdog kill, or — since v1.64 — a worker that died without a
result, note "Solver process ended unexpectedly (exit code N)") is stored
as `aborted`, never `finished`, so applying it asks for confirmation
(`409 partial_result`). Before the run starts, `solve_range` rejects an
unparseable, non-canonical (not `YYYY-MM-DD`) or reversed range with 422,
before any run row or process exists (v1.64). Nothing is applied to the
schedule automatically: the result waits in the RUN INBOX until the admin
applies it (`POST /v1/solve/runs/{id}/apply` — atomic server-side apply:
unlocked in-range solver assignments of section rows are replaced,
including rows hidden by a clinician's vacation; manual/legacy, locked and
pool entries and everything outside the range survive —
`assignment_policy.is_replaced_by_draft`, also used by the CP-SAT/heuristic
pre-solve filter and matching the agent harness and "Reset Solver Only")
or discards it. Discard is a conditional update (`solver_runs.discard_run`):
only `finished`, `aborted` or already `discarded` runs can be discarded,
anything else (e.g. applied from another tab, failed) returns
`409 "Run is <status> and cannot be discarded."`; a running run still gets
`409 "Abort the run first."`. `GET /v1/solve/runs` lists the inbox; a run interrupted by a
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
   runs out, or an explicit `timeout_seconds` expires (none by default —
   interactive runs end on the iteration budget or an abort).
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
(floor 10), computed per solve; `AGENT_MAX_ITERATIONS` is no longer read at
all since v1.64 (`AgentConfig.max_iterations` is a placeholder that every
solve overwrites; the arena's `--max-iterations` flag has no effect either). Any LLM failure (missing key, API error,
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
nothing. The agent never sees or optimizes a weighted score
(`scoring.score_plan`/`PlanScore` had no production caller and were removed
in v1.64).

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
Deterministic plan statistics over a precomputed `ScoringContext`:
`plan_stats` (filled/open slots, split shifts, short days, preference and
time-window fits, …) and `open_slots`. No weighted score: the CP-SAT
objective is built in `solver.py` only (v1.64 removed the unused Python
replica). Reuses the pure helpers from `solver.py` (slot contexts,
intervals, YTD) so slot expansion cannot drift. Soft `SolverRule` violations
are reported by the validator and surfaced to the agent, but do not gate
acceptance.

### Pluggable LLM backend (`backend/agent/provider.py`)
The harness talks through a minimal protocol (`ChatMessage`/`ToolCall`/
`ProviderResponse` + `LLMProvider.complete`). Implementations:
- `AnthropicProvider` — official `anthropic` SDK; prompt-caching breakpoint on
  the system block, adaptive thinking, no sampling params. Since v1.64 it
  sends `thinking.display: "summarized"` to models whose default is
  `"omitted"` (Opus 4.7+, Sonnet 5+, Haiku 5.x, Fable/Mythos; Opus/Sonnet 4.6
  already summarize, Haiku 4.5 gets no thinking parameter), so the reasoning
  feed is no longer empty; an empty reply is replayed as a non-empty text
  block (the API rejects empty assistant content), and any other
  `AnthropicError` becomes a non-retryable error response instead of
  crashing the run. An unexpected exception from any adapter is turned into
  an error response by the harness (type name in the note, traceback in the
  server log), so the best plan so far is kept. Key resolution:
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
`AGENT_MAX_TOKENS`; `AGENT_MAX_ITERATIONS` is ignored, the budget is the
slot-instances × 10 rule) — the spawn subprocess inherits it.
The model is an ADMIN-ONLY global setting (default `claude-sonnet-5`) stored
in the `agent_settings` table and managed via `GET/PUT /v1/agent/settings`
(`backend/agent_budget.py`); the solve endpoint injects it into the payload
(`SolveRangeRequest.agent_model`, server-overwritten so clients can't spoof
it) where it overrides `AGENT_MODEL`. The old per-user
`solverSettings.agentModel` is ignored. Every account also has a cumulative
AI budget (default $5, admin-settable): each run's cost is computed from its
token counts (`agent_budget.MODEL_PRICES`, mirrored from
`src/lib/llmPricing.ts` — update both together;
`test_backend_prices_match_the_frontend_table` fails on drift; Sonnet 5 is
$2/$10 per MTok since v1.64) and recorded in `agent_spend`; once over budget the harness
returns the heuristic draft with an explanatory note
(`payload.agent_budget_exhausted`, also server-injected). The frontend planning panel always
sends `solver_mode: "agent"` — the CP-SAT solver remains available through
the API (`solver_mode: "cpsat"`) and is still used by tests, but the UI no
longer offers the choice. YTD fairness: `PlanToolExecutor.ytd_completion_pct`
gives the percent of a clinician's year-to-date target hours worked up to a
given day (working copy included, vacations credited); candidates are sorted
most-behind first and the `get_ytd_progress` tool exposes the roster.
Candidates can be fetched for up to 8 slots per call (`slot_keys`), old tool
results are compacted to a stub once the history exceeds ~60K chars (`TOOL_HISTORY_BUDGET_CHARS`; chunked,
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
- `backend/tests/test_agent_anthropic_provider.py`, `test_agent_retry.py` —
  Anthropic adapter (empty replies, thinking display per model, SDK errors)
  and provider exceptions inside a run (v1.64)
- `backend/tests/test_solver_monitor.py` — monitor end states (watchdog kill,
  salvage as `aborted`, torn queue message, spend recorded once);
  `backend/tests/test_solver_run_endpoints.py` — 422 ranges, discard 409s,
  vacation-hidden solver rows replaced on apply (v1.64)

---

## 7) Backend State + Persistence
State reads and saves return a content-based `revision`. `POST /v1/state` must echo
the revision of the state being edited; stale or missing revisions fail with 409.
The frontend serializes saves in `StateSaveQueue`, pauses editing/autosave during
apply and restore, and displays persistent save failures. Do not retry conflicts
by attaching a newly fetched revision to old local data. `_load_state` saves the
normalized blob whenever normalization changes anything, flagged or not (v1.64),
so the revision a GET returns always equals the stored one; before, a silent
normalization (e.g. `7:30` → `07:30`) made every later save of that calendar
fail with 409.

Agent runs capture an immutable input snapshot plus a fingerprint of all planning
inputs, including roster, vacations, template, rules, holidays and boundary/history
assignments. `run_apply.py` checks the draft against current inputs and commits
backup, calendar and run status in one SQLite transaction. Unchanged manual
violations are retained; new violations block apply even with `force=true`.
Incomplete drafts need `allow_partial=true`; confirmations use `expected_revision`
to detect further changes. Empty aborted runs are never applicable. Recovery of
interrupted runs is registered in FastAPI's lifespan.

The day loop verifies remaining legal placements before accepting an `end_turn`,
allows two completion nudges, reports `daysIncomplete`, and reserves iteration
budget for the final review. A progress guard nudges after six repeated plan
states and ends the conversation after twelve; equal-quality best-plan changes
are streamed too, so abort recovery keeps the latest best plan.

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
- `locationsEnabled` is legacy; if false in older data, normalization keeps it false and maps slots to the default location.
- Generates/normalizes `weeklyTemplate` v4; if missing, builds a default template from sections + sub-shifts (slot ids use legacy shiftRowIds).
- Filters assignments + slot overrides to existing template slot ids (and pool rows).
- Template slot assignment ids (e.g. `slot-1`) are preserved during normalization in both frontend and backend. Migrated day-type slot ids (`<section>::s2__mon`) are kept as they are (not remapped to `s1`, v1.64) and follow their date's day type when a holiday is added or removed (`_follow_date_day_type` / `followDateDayType`; dropped when the new day type has no such slot). A slot whose column already fits the date keeps its assignment even if its id suffix names another day (e.g. after it was dragged into another day's column). Slot-override keys with a stale sub-shift fall back to the class's fallback sub-shift deterministically.
- Ensures `solverSettings` defaults, clamps on-call rest day values, and fixes invalid on-call class ids.
- Ensures the Rest Day pool exists (pool-rest-day); it is appended if missing.

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
- `POST /v1/solve/range` (`solver_mode`: cpsat | heuristic | agent; legacy `use_heuristic`)
- `POST /v1/solve/abort` (abort solver; `?force=true` kills subprocess immediately)
- `GET /v1/solve/progress` (SSE stream for live solver updates; `Authorization: Bearer` header, no query token)
- `GET /v1/state/health` (database health check)
- `GET /v1/state/inspect/week` (database inspector)
- `GET|POST /v1/state/snapshots`, `POST /v1/state/snapshots/{id}/restore`, `PATCH|DELETE /v1/state/snapshots/{id}` (calendar snapshots)
- `GET /v1/me/preferences`, `PUT /v1/me/preferences` (per-user UI preferences for My plan; outside AppState, 32 KB body cap → 413)
- `GET /v1/solve/runs`, `GET /v1/solve/runs/{id}`, `POST /v1/solve/runs/{id}/apply|discard|feedback` (run inbox)
- `GET|PUT /v1/agent/settings`, `POST /v1/agent/chat-test`, `POST /v1/agent/model-check` (AI planning settings; `PUT /v1/agent/settings`, `chat-test` and `model-check` are admin only)
- `GET /v1/admin/solver-runs[/{id}]`, `GET /v1/admin/run-feedback`, `DELETE /v1/admin/run-feedback/{id}`, `GET /v1/admin/schedule-changes` (admin only)
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
- Creating a user in the admin panel seeds the new user with the default state from `backend/default_state.json` (not the admin's state), or with the imported state; since v1.64 account and start state are written in one transaction (`_create_user(..., initial_state=...)`).
- An admin cannot disable or demote their own account (`PATCH /auth/users/{username}` → 400 "Cannot disable or demote yourself."; v1.64); self-deletion was already blocked.
- Usernames are case-insensitive: login strips and lowercases them (`admin` is stored lowercase).
- Login screen includes show/hide password toggle.

---

## 9) Running Locally (Step-by-step)
Prereqs
- Python 3.10–3.12 (CI 3.11; production image Ubuntu 22.04 Python 3.10). Not 3.13: the pinned `ortools==9.11.4210` has no wheels for it. 3.9 fails at import (PEP 604 unions).
- Node 20+ (22 used in CI and the frontend image)

**Quick start (Claude Code agent)**
To start fresh with a clean database:
```bash
# Kill any existing processes
lsof -ti:8000 | xargs kill -9 2>/dev/null
lsof -ti:5173 | xargs kill -9 2>/dev/null

# Delete database for fresh start (optional; run from the repo root)
rm schedule.db

# Start backend (env vars inline - IMPORTANT: must be on same line or exported first).
# Bound to 127.0.0.1 because the placeholder JWT_SECRET is public; for LAN access
# use --host 0.0.0.0 only with a generated secret (openssl rand -base64 48).
ADMIN_USERNAME=admin ADMIN_PASSWORD=<ADMIN_PASSWORD> JWT_SECRET=change-me-too python3 -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 &

# Start frontend
npm run dev -- --host 0.0.0.0 --port 5173 &
```
- Default admin credentials: `admin` / `<ADMIN_PASSWORD>`
- Database location: `schedule.db` in the directory you start uvicorn from (repo root in these steps; override with `SCHEDULE_DB_PATH`)

**Common pitfalls**
1. **Admin password mismatch**: The admin user is created on first backend startup with the password from `ADMIN_PASSWORD`. If you delete the database and restart with a different password, or if the database already exists with a different password, login will fail.
   - Fix: Delete the database file and restart the backend with the correct password.
   - The password is hashed on user creation; changing `ADMIN_PASSWORD` after the user exists does NOT update the password.
   - Use `ADMIN_PASSWORD_RESET=true` to force-reset an existing admin password.

2. **Env vars not passed to backend**: If you start the backend without the env vars on the same command line (or without exporting them first), the admin user won't be created or will use wrong defaults.
   - Wrong: `python3 -m uvicorn backend.main:app ...` (no env vars)
   - Right: `ADMIN_USERNAME=admin ADMIN_PASSWORD=<ADMIN_PASSWORD> python3 -m uvicorn backend.main:app ...`

3. **Database location**: `SCHEDULE_DB_PATH` (default `schedule.db`, relative to the working directory), not `backend/schedule.db`.

Auth env (required for login):
```bash
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD=<ADMIN_PASSWORD>   # local dev password
export JWT_SECRET=change-me-too   # public placeholder: localhost only, generate one for any LAN/remote host
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
ADMIN_USERNAME=admin ADMIN_PASSWORD=<ADMIN_PASSWORD> JWT_SECRET=change-me-too python3 -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Step 4: start frontend (Terminal 2)
```bash
npm run dev -- --host 0.0.0.0 --port 5173
```

Step 5: open the app
- http://localhost:5173
- Login: `admin` / `<ADMIN_PASSWORD>`

If a port is already in use
- The backend has a startup check that errors if the port it is started with (`--port`, else `BACKEND_PORT`, else 8000) is already in use.
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
- If using a non-localhost host (LAN or remote), set CORS explicitly (and use a generated `JWT_SECRET`, not the placeholder):
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
- `src/components/schedule/AutomatedPlanningPanel.tsx` (planning panel: date range, Run, Reset Solver Only / Reset Unfixed)
- `src/components/schedule/AgentSettingsPanel.tsx` (v1.64, extracted from SettingsView: AI provider/model, endpoint, API keys, model check, chat test, budget)
- `src/components/schedule/TeamPlanHeader.tsx` (v1.64: header row of the team calendars — Team | My plan, Color by, start-page star, Views)
- `src/components/schedule/teamColors.ts` (v1.64: "Color by: Person" pill styles and location row tints for the classic grid)
- `src/lib/stackedTeamLayout.ts` (v1.65: "Times: Stacked" — time lanes per class row, one grid column per day, label meta)
- `src/components/schedule/LocationColorPicker.tsx` (v1.64: location color swatch in the template builder)
- `src/components/schedule/ToggleSwitch.tsx`, `CalendarPlaceholder.tsx` (v1.64: shared settings toggle; placeholder while the start view is resolved)
- `src/components/ui/ConfirmDialog.tsx` (confirm dialog; Enter acts on the focused button)
- `src/api/client.ts`
- `src/lib/shiftRows.ts` (weeklyTemplate normalization, colBand safeguards, legacy shiftRowId helpers)
- `src/lib/schedule.ts` (rendered assignment map, time intervals, Rest Day pool logic)
- `src/lib/solverStats.ts` (live solver stats calculation: coverage, preferences, time windows, on-call rest, working hours)
- `src/lib/myPlan/` (v1.64, pure and tested: one person's plan — shifts split at midnight, previous-day nights, start-day hours, overlap lanes, rest/vacation bands, location tint, coworkers, next shift, rest before, month sheet, colors, labels; public API in `index.ts`)
- `src/components/myPlan/` (v1.64 My plan UI: `MyPlanView.tsx`, week/day/month views for both orientations, `ShiftDetail`, `PlanScopeSwitch`, `RangeSwitch`, `OrientationSwitch`, `PeriodNavigator`, `PersonPicker`, `LinkClinicianCard`, `SavedViewsMenu`, `StartPageStar`, `NextUpChip`)
- `src/lib/userPreferences.ts` (`useUserPreferences`: loads `/v1/me/preferences`, optimistic updates, debounced save, never PUTs before a successful GET, flushes on pagehide)
- `src/lib/colorPalette.ts` (section block colors, `LOCATION_COLOR_OPTIONS`, person palette `PERSON_COLORS`)
- `src/pages/usePlanScope.ts` (v1.64: page scope Team | My plan, start view applied once, `scopeReady`)
- `src/pages/scrollToTeamAssignment.ts` (v1.64: "Show in team plan" — scroll to and pulse the person's pill)
- `src/pages/resetSolverAssignments.ts` (v1.64: Reset Solver Only / Reset Unfixed rules)
- `src/lib/openSlots.ts` (v1.64: open-slot count and jump targets for the badge)
- `src/lib/templateLimits.ts` (v1.64: `MAX_TOTAL_COLBANDS` = 300, `countTemplateColBands`)
- `src/lib/time.ts` (v1.64: the one strict `parseTimeToMinutes`)
- `src/lib/download.ts` (v1.64: `downloadTextFile`; `runLog.ts` re-exports it)
- `src/lib/clipboard.ts` (v1.64: `copyTextToClipboard`, reports success)
- `src/lib/assignmentPolicy.ts` (`isProtectedAssignment`, mirrors `backend/assignment_policy.py`)

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
- `backend/state_routes.py` (health + state endpoints + database inspection)
- `backend/preferences.py` (v1.64: `GET/PUT /v1/me/preferences`, 32 KB cap)
- `backend/assignment_policy.py` (`is_protected_assignment`, `is_replaced_by_draft` — what a stored draft replaces)
- `backend/run_apply.py` (stored-run apply, planning fingerprint), `backend/solver_runs.py` (run table, statuses, `discard_run`)
- `backend/scoring.py` (`plan_stats`, `open_slots`), `backend/validation.py` (hard-constraint validator)
- `backend/snapshots.py` (calendar snapshots)
- `backend/agent_budget.py` (agent settings, chat test, model check, spend)
- `backend/schedule_changes.py` (schedule change log, admin endpoint)
- `backend/account_lifecycle.py` (account generation/identity checks)
- `backend/request_logging.py` (redacted access logging)
- `backend/ical.py` (ICS generation for subscription feeds)
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
- **Versioning (mandatory):** `src/version.ts` holds `APP_VERSION` (string, starts at `"1.00"`) and `APP_BUILD` (integer, starts at `0`), rendered as a subtle `v1.00 (0)` badge at the bottom-right of the app (`App.tsx::VersionBadge`; hidden on phones since v1.64, where it covered plan content). Bump BOTH on every delivered iteration — version `+0.01`, build `+1` — so the owner can verify which build a deployment runs.

---

## 13) Deployment
See [DEPLOY.md](DEPLOY.md) (full) and [NOTES.md](NOTES.md) (runbook). Summary:
- **Production** is the Proxmox LXC behind `https://shiftplanner.truhn.ai`: job `deploy-truhn`, repo `/opt/app`, stack `docker-compose.proxied.yml` (frontend on `127.0.0.1:5000`, host nginx terminates TLS), data volume `app_backend_data`. Access: `ssh -J dtruhn@49.13.89.75:4444 root@10.10.10.6`.
- The old Hetzner server (`46.224.114.183`, `/opt/shiftschedule`, `docker-compose.yml` + Caddy, `shiftplanner.wunderwerk.ai`) is a **redirect host** since 2026-07: Caddy answers with a 301 to `https://shiftplanner.truhn.ai{uri}`. The `deploy` job still rebuilds it; expect 301, not 200, from that domain.
- CI (`.github/workflows/ci-cd.yml`): backend pytest on Python 3.11 (benchmark excluded); frontend on Node 22 with typecheck, Vitest, `npm run build` and the critical Playwright specs. Deploys fetch the tested commit by SHA (`git reset --hard` on the LXC, `git checkout --detach` on Hetzner) and run `scripts/deploy-compose.sh <compose file>` (build → close planning admission → wait up to 90 min for running plans → replace containers or stop without replacing). The Hetzner job then force-recreates `caddy`. Markdown-only pushes do not deploy.
- Manual fallback: use `scripts/deploy-compose.sh`, never a bare `docker compose up -d --build` (skips the drain and kills running plans).
- Never use the `.env.example` placeholders (`JWT_SECRET=change-me-too`): production accepts any non-empty secret. Generate with `openssl rand -base64 48`. Keep `JWT_EXPIRE_MINUTES` non-empty (`docker-compose.yml` and `docker-compose.ip.yml` have no default; `int("")` crashes the backend).
- `PUBLIC_BASE_URL` is set by the domain/proxied compose files to `https://${DOMAIN}/api`. iCal endpoints rely on the frontend nginx proxying `/api` (see `nginx.conf`).
- `docker-compose.ip.yml` (IP-only, ports 80/8000) is legacy and not used in production; it conflicts with Caddy on port 80.

## v1.55 — planning workflow and optional quality experiments

- Suggestions now provide revision-bound proposal IDs. `apply_proposal` revalidates
  an atomic batch and returns fresh suggestions; repeated applications are harmless.
  Any plan change invalidates prior search results, including changes on other days.
- Rank all eligible day blocks before limiting the response. Repeated searches on an
  unchanged plan reuse results. Tool reports identify bounded search scope; a failed
  shallow search does not claim infeasibility.
- The harness checks rescue/balance opportunities before accepting a completed day
  and verifies completion labels against the final returned snapshot. It reserves
  range-review rounds and starts that review from the best verified plan.
- `agentQualityProfile=classic` and `agentNeighborhoodSearch=false` remain defaults.
  Balanced (preview) prioritizes hard violations, required coverage, section priority,
  short/long-day discomfort, soft rules, structured wishes, hours deviation, recent
  duty concentration, disruption and preferences, in that order. These priorities
  are explicit, not an assertion that this is the only correct operational policy.
- Personal `workPattern` fields: average days/week, target daily hours, preferred
  weekdays off. All are soft preferences. Days/week derives day length from contract
  hours; it is not an exact quota. Explicit daily hours override that derivation.
  Legacy optimization objectives are unchanged; agent/statistics use the new pattern.
- Duty distribution uses known recent night/weekend/on-call minutes, scaled by
  contracted hours and eligible days. It is a proxy, not a legal or comprehensive
  fairness certification. Free-text wishes remain model-interpreted and are reported
  as not mechanically verified.
- The optional neighborhood tool explores at most three dates, 120 slots, 1,800
  decision variables, 12 changed assignments and 10 seconds per request. Its model
  is a relaxation; every proposed result must pass the normal full-plan validator
  and improve the active quality tuple. Failure proves neither infeasibility nor
  optimality. Manual assignments and context beyond the requested dates stay fixed.
- The arena can run checkout code from a temporary directory with read-only provider
  settings, allowing real-model experiments before deployment. A deterministic
  first-offer controller supplies a separate reference without any model calls.

## v1.56 — complete repair searches and bounded final review

- Rescue results carry revision/date-bound continuation cursors after 16 blocked
  slots. Required day checks follow all pages; checked improvements on partial
  pages remain actionable. Stale cursors restart the search.
- Direct candidate checks share a bounded per-revision cache; any plan change
  clears it. The atomic apply gate always revalidates the full calendar.
- Pure date/time parsing is memoized with bounded caches. Holiday and personal
  window lookups are shared only inside one validation call; changes to state
  are read afresh for every validation. Rules and violation payloads are unchanged.
- Final review permits 4–12 consecutive tool rounds without a new retained best
  plan, scaling with range length. It warns before the last round and reports
  the bounded stop. Useful custom changes, including equal-score wish changes,
  reset progress; repeated inspections alone do not. Cross-day review remains.
- Arena reporting separates model time and top-level tool time (nested calls
  are not double-counted), records candidate cache hits/misses and fails on
  new hard violations or changed fixed context.

## v1.58 — fixed inputs and verified planning tasks

- Assignment `locked` is independent of provenance. Legacy/manual entries remain
  protected during replanning; explicitly fixed solver entries also survive draft
  replacement, reset, save/import and forced stored-run apply. Changing fixation
  invalidates the input fingerprint. Classic and monthly calendars expose an
  accessible fix/unfix control on solver assignments. Reset Unfixed explicitly
  clears manual entries too; direct user edits remain possible.
- Balanced quality version 2 also scores actual workdays. Full ISO weeks use
  integer target bounds; multiple full weeks additionally check fractional
  averages. Partial weeks count known excess including all fixed week context,
  but do not invent deficits for dates outside the planning range. Overnight
  duties count on their starting date. Vacation/holiday target scaling is a soft
  convention over Mon–Fri (all seven days when the target exceeds five), with
  overlapping absences counted once. This is not a legal workday definition.
- Optional `dailyHoursTolerance` expresses a soft ± range, including zero.
  Leaving it blank preserves existing daily thresholds. A soft clock-time window
  does not shorten an explicitly configured workday; mandatory windows still
  cap it. Fixed duty burden is
  reported separately from incremental burden; no fixed service is redistributed.
  Classic remains the default; explicit work-pattern preferences are opt-in.
- `get_plan_tasks` reports current coverage, day shape, weekly patterns and required
  checks. All checks expire after every plan change; old proposals cannot authorize
  an edit. Live progress counts checks for the current revision only.
- Final verification starts from the retained best and may apply freshly revalidated strict improvements within 60 seconds and the run
  deadline. The repair limit scales with the range: two per day, at least four,
  at most 24; a fixed four-repair cap left verified coverage fixes unused in a
  real Qwen week. Days with required coverage gaps are inspected before
  polishing already staffed days.
  Ten percent of an explicit time budget (at most 60 seconds) is reserved
  for the final audit. Every repair restarts the complete audit. Abort disables repair. Remaining
  opportunities/budget limits stay explicit. Failed model days are retained as
  `modelDaysSkipped`, even if deterministic final repair recovers them.
- Completion separates finished execution, completed bounded checks, required
  coverage and measured wishes. Free-text wishes and partial-week deficits remain
  unverified. Durable restart checkpoints and SSE event replay remain future work.
- Arena scenario `fixed-patterns` keeps saved duties, marks them as locked solver
  entries and adds synthetic personal work patterns to the isolated test fixture.
  It never changes user calendars or saved preferences.

## v1.59 — complete model text

- The live feed and saved run log retain every received model response in full.
  Removed the 24,000-character truncation and the first-80-text log limit.
  The recent browser event buffer remains bounded; an open text dialog retains
  its selected response as newer events arrive. The unused duplicate event
  archive in the calendar page is removed.
- Short previews explicitly show the received character count and open the full
  response in a scrollable, copyable dialog. Long lines, mobile controls and
  reaching the final character are covered by browser tests.
- Provider output limits are independent metadata, including OpenAI-compatible
  responses that contain tool calls. The feed, full-text dialog and saved log
  identify an incomplete generation without shortening the received text or
  changing tool execution. Existing already-truncated historical logs cannot
  recover text that was never stored.

## v1.60 — reviewed planning and persistence boundaries

- Background draft application uses the current browser state. Snapshot restore
  checks the supplied current state's revision and writes backup + restore in
  one transaction. A stale browser snapshot returns `409 state_changed`.
- CP-SAT/heuristic stored drafts replace only unlocked solver entries in range;
  protected, pool, vacation and boundary context remain fixed. A missing legacy
  end date is stored as the actual seven-day range. CP-SAT sees multi-day duties
  before the range and carries successful fallback weeks into later weeks.
- Hard checks cover active template references and complete boundary-week hours.
  Existing manual conflicts cannot justify additional conflicts. Vacation dates
  count once in scoring/YTD even when ranges overlap. Clinician aliases stay
  unique when duplicate names already contain numeric suffixes.
- Cancellation is checked after model responses, retry waits and between final
  review tools. Provider connection diagnostics include cause types only.
- Public weeks expose only rendering fields and week-clipped absences. Web/iCal
  ETags include state/publication content and take precedence over date validators.
- Production Compose stacks explicitly disable the development test login;
  startup revokes an existing unchanged development credential. Deployment uses
  the CI-verified commit. These protections take effect after rollout/restart.
- The Flash preset and arena default use `nvidia/Qwen3.8-Flash-Next-NVFP4`, listed
  by the endpoint on 2026-09-22. Saved model choices are not silently migrated.
  The old W4A16 identifier returned HTTP 400. The first new-ID smoke run ended
  with exit code 137 (SIGKILL): a concurrent deploy replaced the backend
  container while the run executed inside it; this was not an endpoint
  connection failure. Follow-up 1-day and 3-day runs verified NVFP4 stable
  (full coverage, zero rejected moves, no errors; see `backend/arena/README.md`,
  round 7 "Flash re-rolled again (NVFP4)"). Historical W4A16 timings are not
  NVFP4 guarantees.

## v1.61 — account boundaries and verified workflow fixes

- Existing accounts receive a durable random generation and token version.
  Legacy sessions must sign in again once after this upgrade. Calendars are
  preserved; deletion atomically clears owned data and detaches the worker.
  Old tokens/results cannot attach to a recreated username. State, snapshots,
  draft application and publication management recheck identity in the same
  database snapshot as their reads/writes. Public tokens and published state
  are resolved together. The deployment remains a single API worker.
- Solver progress uses Authorization-header fetch streaming, with bounded
  reconnects and cancellation. Cross-thread events wake the owning event
  loop; streams recheck token expiry/revocation. Request logs redact capability
  paths and queries. App proxy raw URL logs are disabled, with checked host
  nginx configuration and rollback on unsafe include overrides.
- PDF export awaits persistence and pins each batch to one revision; rendering
  uses its captured server snapshot. A changed revision stops remaining exports.
  Settings checks await saves and ignore superseded model/endpoint responses.
- CP-SAT now honors the same ISO-week upper limit as the apply gate, including
  fixed work outside the requested range. Agent proposals and stored drafts
  share conflict identity/magnitude comparison, permitting safe partial repairs.
  Heuristic "Distribute all" now adds only the permitted optional capacity
  after mandatory staffing, preserving fixed and already planned duties.
  Heuristic/fallback work respects an explicit remaining time budget; incomplete
  exits retain their interrupted status instead of reporting successful completion.
- Invalid tool JSON/types receive correlated repairable errors. Internally
  verified large proposals use their proposal IDs in final review. Fallbacks
  retain model attempts, usage and provenance, and report the returned plan's
  actual quality. OpenAI cache tokens are not counted twice.
- Arena fixture `synthetic-v2` replaces exported personal records with generated
  profiles, absences and duty history. Version/hash are part of each report;
  historical results from the legacy fixture are not a new-fixture baseline.
  Removing legacy Git history or published artifacts is a separate operation.
- Build/test dependencies move to repaired Vite 6.4.3 and Vitest 4.1.11 on
  Node 22 for container/CI. CI includes the production build and critical browser
  workflows. Deployment builds first, closes planning admission, waits for app
  workers and arena processes (including stdin checkout jobs), and refuses to
  replace busy/uninspectable containers. Failure restores admission and is
  reported; it does not silently kill a running plan after the wait limit.

## v1.62 — Qwen model availability fallback

- The configured Qwen priority is `nvidia/Qwen3.8-Flash-Next-NVFP4`, then
  `Qwen/Qwen3.5-35B-A3B-GPTQ-Int4`, then `Qwen/Qwen3.5-122B-A10B-GPTQ-Int4-cliniva`
  (chain since v1.63; v1.62 shipped with `Qwen/Qwen3.8-27B` in second place,
  which the endpoint stopped serving by 2026-10-06). All three current IDs
  were listed and returned valid synthetic tool calls on the configured
  server on 2026-10-06. This policy selects only these known planners, never
  arbitrary embedding/OCR/reranking models from `/models`.
- On an explicit missing-model / unavailable-deployment response, the same
  endpoint is retried with the next model and the remaining request budget.
  Existing plan, conversation and tool results stay intact. The successful
  replacement remains selected for that provider/run; the global preference
  is unchanged, so new runs try the preferred model again. Selecting a later
  chain member (for example 35B) explicitly starts there; unrelated model
  selections are left alone.
- Authentication, context, malformed-tool, generic transport/timeout and
  rate-limit errors do not trigger model switching. Existing bounded retries
  remain in force. Cancellation is checked between model requests; exhausting
  all known models does not restart the chain.
- Run details and chat tests expose `model_selection` separately from the
  heuristic `fallback`. Run token counts are also grouped by actual model.
  Individual-model responsiveness checks and arena quality benchmarks keep
  their exact requested model; they never silently measure a replacement.
- Model prompts, day construction, proposal ranking and quality objectives
  are unchanged. The 122B reserve is a suitability choice, not a measured
  claim of optimal planner quality; the upstream model card reports stronger
  BFCL-V4/DeepPlanning scores than 35B, and the deployed quantization passed
  the server tool check: https://huggingface.co/Qwen/Qwen3.5-122B-A10B.

## v1.63 — endpoint lineup, audit budget and deploy hygiene (2026-10-06)

- `Qwen/Qwen3.8-27B` is no longer listed by the self-hosted endpoint (LLM
  endpoint diagnostic run from production on 2026-10-06). It is removed from
  the self-hosted presets and from the availability fallback chain, which is
  now `nvidia/Qwen3.8-Flash-Next-NVFP4` → `Qwen/Qwen3.5-35B-A3B-GPTQ-Int4` →
  `Qwen/Qwen3.5-122B-A10B-GPTQ-Int4-cliniva`. All three answered synthetic
  tool calls; Flash NVFP4 remains the production default (65–103 tok/s).
  A saved 27B selection is not migrated automatically: it has no fallback
  chain and fails like any other unlisted model until a served model is
  selected in Settings. The `llm-diag` workflow probes only the three
  current candidates.
- Arena fixture `synthetic-v3` replaces `synthetic-v2`, which left 8 of 24
  clinicians without any qualification. Reports carry the fixture
  version/hash; v2 results are not a v3 baseline.
- The code-side final audit (`PlanningWorkflow.final_audit`) scales with the
  planned range: budget `max(60 s, 10 s × days)` (`audit_time_budget`, also
  the cap of the 10 % reserve carved out of timed runs), repair ceiling two
  per day up to 48, and a repair now re-checks only the days it can
  influence (its ISO week plus the adjacent days — widened to the on-call
  rest window when that rule is on since v1.64; the balanced profile
  still re-checks everything because it scores range-wide averages) while
  completed checks elsewhere are carried to the new revision. Measured on
  the arena fixture, 28 days: before 55 s and 0 of 28 days verified (every
  check "budget exhausted"), after 93 s and 25 of 28 verified with only
  genuine findings left open. A check that ran out of time or was cancelled
  at the final revision is now reported as `unverified` (task status,
  `completion.required_checks_unverified`, `daysUnverified`) instead of
  `pending`: it does not make the run `partial`, does not count as an
  incomplete day, and the apply gate ignores it (coverage gaps are still
  computed by the gate itself). Run notes say "Final verification ran out
  of time for N day(s)".
- Backend startup clears the deploy drain marker, so a deploy that closed
  planning admission and then failed cannot leave a restarted backend
  refusing new plans. The proxy logging setup script is non-fatal: a failure
  there is reported and does not abort the deploy.
- Documentation: Node 20+ (22 in CI and containers) replaces the stale
  "Node 18+" requirement; the arena README names `PROMPT_EVAL_REPORT` as the
  workflow's report line, lists all workflow inputs and the 7-day cap, and
  corrects the account of the 2026-09-22 NVFP4 smoke run (exit 137 from a
  concurrent deploy, verified stable afterwards).

## v1.64 — My plan (individual view) and code review fixes

### My plan

- **Team | My plan.** The calendar card has a new first header row
  (`src/components/schedule/TeamPlanHeader.tsx`, classic grid and clinic
  sheet): `PlanScopeSwitch` on the left; "Color by" (classic grid only),
  start-page star and Views menu on the right, in the same places as in the
  My plan header. The anchor date is shared by both scopes. Scope is page
  state (`src/pages/usePlanScope.ts`): it starts as Team, and the stored start
  view of the current device class (`startViewDesktop` / `startViewMobile`) is
  applied once after the preferences load; later preference changes and late
  loads never switch the view under the user. Until the start view is known
  (at most `START_VIEW_WAIT_MS` = 1 s) the card shows `CalendarPlaceholder`
  instead of painting the team grid and swapping it. Without a start view the
  team grid looks as before apart from the new header row. In scope "My plan"
  the planning panels below the calendar are hidden but stay mounted. The My
  plan bundle is lazy-loaded, so team-only sessions never download it.
- **My plan view** (`src/components/myPlan/MyPlanView.tsx`, pure model in
  `src/lib/myPlan/`, public API in `index.ts`): day, week or month
  (`RangeSwitch`), each with the date on top or on the left
  (`OrientationSwitch`; month: calendar / list, day: time runs down / right).
  Range and orientation per range are remembered per device class
  (`myPlanRange` + `orientationByRange` on computers, `myPlanRangeMobile` +
  `orientationByRangeMobile` on phones, where the week defaults to the agenda,
  date on the left). Shifts are the person's section assignments with slot
  times; hours are the gross slot duration (8 h when a time is missing,
  `getSlotDurationMinutes`, also used by the working-hours overview) counted on
  the start day, and overlapping own shifts count once. Overnight shifts
  belong to their start day and are split at midnight (both parts share one
  shift id); a night that started the day before the range is loaded too.
  Vacation and rest days (exactly as the team grid shows them, including
  on-call rest) render as bands; days without work show "free" in published
  weeks, unpublished weeks show "Draft – not published". The day ground is
  tinted by the location where a shift starts (split when two locations).
- **Header and detail.** Period navigator, "Next up" chip (running or next own
  shift within 14 days, countdown, click opens that day), person picker
  (chevron next to the switch; "You are viewing the plan of X" banner, the
  browser title names the person), Views menu and start-page star. Clicking a
  shift opens the detail (desktop popover, phone bottom sheet, inline card in
  day views): time, hours, location/section, coworkers ("Working with you":
  same duty / same time at location / others at location), rest before, next
  entry, published/draft status and "Show in team plan" (switches to Team at
  that date, scrolls to the person's pill and pulses it,
  `src/pages/scrollToTeamAssignment.ts`). Keyboard (outside inputs, no
  modifier, no open modal): T / W / M day, week, month · H today · O
  orientation · P team plan · N / Shift+N next / previous shift · ? help toast.
- **"I am" link.** Without a linked clinician (or if it no longer exists) My
  plan shows "Who are you in the plan?" with an "I am" select and "That's
  me"; the choice is stored as `clinicianId` in the preferences. Viewing
  someone else's plan is page state only.
- **Saved views and start pages.** A saved view stores scope, range,
  orientation, colorBy and an "Open at" anchor `startAt` (today, next shift,
  week start) — never a fixed date; max 12, unique ids. Applying a view from
  either header moves the anchor accordingly. The star makes the current view
  the start page of this device class; start pages carry no `startAt` and keep
  the current anchor.
- **Team additions (opt-in).** "Color by: Section | Person" (`teamColorBy`,
  classic grid only): Person gives every clinician a color from
  `PERSON_COLORS` (by list order, 16 colors, repeating), section blocks turn
  neutral, and the linked person's own pills get an outline. Section is the
  default and looks as before. Locations with a color tint their row labels
  and their location separator row in the classic grid
  (`src/components/schedule/teamColors.ts`); uncolored locations and the
  clinic sheet keep their look.
- **Per-user preferences** (`backend/preferences.py`, model
  `backend/models.py::UserPreferences`, hook `src/lib/userPreferences.ts`):
  `GET/PUT /v1/me/preferences`, one JSON row per login in the new table
  `user_preferences` (created by `CREATE TABLE IF NOT EXISTS` at startup).
  Outside AppState, so saving never changes the calendar revision or a
  planning fingerprint. PUT bodies over 32 KB get 413 (after authentication,
  so anonymous requests get 401). A PUT stores only the top-level keys it
  names (null or `[]` clears one, an object such as `orientationByRange` is
  replaced whole) and returns the merged document, so the hook sends only the
  keys changed since its last successful save and a tab cannot undo another
  device's changes to other keys. Deleted with the account. An unreadable
  stored row returns defaults instead of locking the user out. The hook
  updates optimistically, saves debounced (600 ms) and serialized, never PUTs
  before a successful GET (a failed load cannot overwrite stored views),
  skips no-op updates, and flushes on pagehide, when the tab is hidden and on
  unmount; opening the app writes nothing unless the start view differs from
  the stored range/orientation.
- **`Location.color`** (`#RRGGBB`, presets slate/sand/sage/lilac in
  `LOCATION_COLOR_OPTIONS`, set with `LocationColorPicker` in the template
  builder): part of the shared calendar but presentation only. Normalized
  (uppercased; anything else means no tint) in `backend/state.py` and
  `normalizeAppState`; a non-string value never blocks a save with 422;
  omitted from the dump when unset (existing calendars keep their revision)
  and excluded from the planning fingerprint (`backend/run_apply.py`).
- Tests: `backend/tests/test_user_preferences.py`,
  `backend/tests/test_state_preferences.py`, `src/lib/myPlan/*.test.ts`,
  `src/lib/userPreferences.test.ts`, `src/pages/usePlanScope.test.ts`,
  `src/components/myPlan/*.test.tsx`, `TeamPlanHeader.test.tsx`,
  `LocationColorPicker.test.tsx`, `e2e/my-plan.spec.ts`.

### Behaviour changes (users and admins can notice these)

- **Applying a stored draft and the CP-SAT/heuristic pre-solve filter now
  replace unlocked solver entries on a clinician's vacation days** (one rule,
  `backend/assignment_policy.py::is_replaced_by_draft`, matching the agent
  harness). Such entries are hidden in the grid; before, they survived apply
  and blocked agent drafts or left invisible gaps. Manual/legacy, locked and
  pool entries still survive.
- **Reset Solver Only** also removes unlocked solver entries on vacation days
  (same rule). **Reset Unfixed** removes them too; on vacation days it now
  keeps only locked and manual/legacy entries (before: every entry on a
  vacation day). Rules in `src/pages/resetSolverAssignments.ts`.
- `POST /v1/solve/runs/{id}/discard` only discards `finished`/`aborted` runs
  (idempotent for `discarded`); anything else returns 409 ("Run is applied and
  cannot be discarded."), so a discard can no longer overwrite an apply from
  another tab.
- `POST /v1/solve/range` returns 422 "Invalid date range." for unparseable,
  non-`YYYY-MM-DD` or reversed ranges (before: HTTP 500 or a run that failed
  at once). No upper limit on the range length.
- A plan salvaged from a worker that died without a result is stored as
  `aborted` with "Solver process ended unexpectedly (exit code N)", so apply
  asks for confirmation; before it was `finished`. The overshoot watchdog's
  hard stop now really ends the worker (SIGKILL).
- Heuristic v2 no longer abandons a day attempt at the first slot that became
  unfillable through earlier choices: it marks it blocked, keeps filling and
  reports failure at the end, so retries still run and the best attempt keeps
  more slots filled. Slots whose end is not after their start (e.g.
  20:00–08:00 without "+1 day") are skipped with a warning instead of
  producing an `UNKNOWN_SLOT` violation and blocking the next day; CP-SAT
  still fills them.
- **Sonnet 5 is priced at $2 / $10 per MTok** (`agent_budget.MODEL_PRICES`,
  `src/lib/llmPricing.ts`; was $3 / $15). Earlier runs were charged about
  50 % too much against the per-user AI budget; stored `agent_spend` is not
  corrected, so admins may raise budgets. The run history recomputes costs
  from tokens, so past runs now show the lower price there.
- On Sonnet 5, Opus 4.7+, Haiku 5.x and Fable/Mythos, Claude's reasoning now
  appears in the live feed and run log (`thinking.display: "summarized"`;
  their API default is `"omitted"`, which left the feed empty), see §6.6.
- Assignments on migrated sub-shift slot ids (`<section>::s2__mon`) are no
  longer moved to `s1` on load (backend and frontend in lockstep), and
  overrides fall back deterministically. Such an assignment now follows its
  date's day type when a holiday is added or removed (to `…::s2__holiday`
  when that slot exists, otherwise it is dropped as before). Assignments that
  were already moved to `s1` by earlier versions are not moved back.
- Confirm dialogs: Enter on a focused "Cancel" cancels (before: Enter always
  confirmed). Removing a person in Settings asks for confirmation (all
  weeks' assignments, vacations and preferences are deleted); the template's
  slot "x" always asks, and the block/row/column/location dialogs say that
  shifts planned in them, including past weeks, are deleted.
- The local `.ics` download blocks the following day(s) for overnight shifts
  (DTEND = start + 1 + `endDayOffset`, capped at +3), like the subscribed feed.
- The month picker navigates to the clicked row's first day in the displayed
  month (before: the row's Monday, which jumped to the previous month).
- AI budget field saves on blur/Enter only; an empty or invalid value restores
  the stored budget (before: clearing the field saved $0 for everyone at
  once) and budget edits no longer reset the model check or chat test.
  "Custom model name…" opens the text field even while a preset is active.
- A 502 or network error while checking the session keeps the user signed in
  and offers Retry / Go to sign in (before: any failure cleared the token, so
  a 502 during a deploy restart signed everyone out); only 401/403 clear it. The login page distinguishes wrong
  credentials (401) from an unreachable server, and the public week link
  shows "Could not load the schedule" instead of "invalid or expired" on
  network/5xx errors.
- A weekly template with more than 300 column bands shows a banner (saves
  stay refused); sign-out asks first, snapshot import is refused, snapshot
  restore works.
- Admins get 400 "Cannot disable or demote yourself." for their own account;
  creating a user saves account and start state in one transaction.
- Re-publishing iCal or web links no longer touches `updated_at`, so opening
  the Export modal does not reset subscribers' cache validators; the public
  feed answers `HEAD`; usernames outside Latin-1 no longer cause a 500 on the
  feed (download filename falls back to `shift-planner.ics`).
- Smaller UI fixes: rule-violation and split-shift popover items are
  clickable; on a phone the open-slots badge and those popovers switch the
  day view to the target day; dragging a person out of the Rest Day row
  removes the stored entry; a same-day move out of a slot without a valid
  time is allowed; preferred working times keep the picked time and opening
  the editor no longer autosaves; Escape while renaming a snapshot only
  cancels the rename; "Copied ✓" only after a successful copy; an empty PDF
  start date disables "Export PDF"; run-inbox errors (feedback, details, log
  download) show inside the affected run card; the version badge is hidden
  on phones.
- `AGENT_MAX_ITERATIONS` is no longer read (the compose files still pass it;
  harmless). `scripts/smoke-api.mjs` is read-only (no solver run).

### Code review fixes (by area)

- **Backend solver/runs** (`solver.py`, `solver_runs.py`, `run_apply.py`,
  `assignment_policy.py`): shared `is_replaced_by_draft`; watchdog SIGKILL
  once + 5 s reap + bounded queue drain (`_drain_dead_worker_queue`);
  removed the import-time pgrep/SIGKILL sweep `_cleanup_orphaned_solver_processes`
  (it never matched spawn children but could kill unrelated processes);
  salvaged plans stored `aborted`; 422 date validation; `abort_solver` is a
  plain `def` (thread pool, no event-loop blocking); weights read straight
  from `SolverSettings` (`DEFAULT_WEIGHT_*`/`get_weight` removed);
  `_add_on_call_rest_constraints` returns early when off and reports the
  boundary conflict (45-line post-solve loop removed, output unchanged);
  conditional `discard_run`; dead code removed (`SolverTimer.summary`,
  `MockUser`, `_solve_range_impl_subprocess`, the worker's `_load_state`
  fallback, `_RunHandle.mode`, `_range_fingerprint`, unused parameters).
  Tests: `test_solver_monitor.py`, `test_solver_run_endpoints.py`, on-call
  rest boundary tests in `test_solver.py`.
- **Heuristic and scoring** (`heuristic/solver_v2.py`, `scoring.py`): blocked
  slots no longer end the attempt (`blocked_count`); zero-duration slots
  skipped with one warning per slot, implicit-overnight checks use `<`;
  `is_on_vacation` compares ISO strings (a malformed vacation date no longer
  crashes); dead code and stale docstrings removed (weekly reset without
  effect, `preferred_sections`, unused `config`/`source` parameters, the
  `_assign_doctor_to_slot` wrapper; eligibility is 8 criteria incl.
  continuity); `score_plan`/`PlanScore` and unused context fields removed,
  their tests ported to `plan_stats`.
- **Agent** (`agent/*.py`, `agent_budget.py`): Anthropic adapter (empty
  replies, summarized thinking for Opus 4.7+/Sonnet 5+/Haiku 5.x/Fable,
  other `AnthropicError`s non-retryable, `(empty)` placeholder); harness turns
  adapter exceptions into error responses and keeps the best plan;
  final-audit repairs start no follow-up search (the audit re-checks itself);
  re-check window widened to the on-call rest window (up to 7 days); the
  final range review handles truncated replies (tool results + up to two
  nudges) and names error/refusal details; replaced-assignment filter is one
  pass (was quadratic); the unsolved overview reuses the quality metrics;
  shared helpers (`restore_best`, `_fmt_span`, `ABORT_NOTE`, `_roster_lines`,
  `_range_error`, tolerance/week-cap helpers); the LLM sees S-codes and
  section names instead of raw slot/section ids in violations and
  `get_clinician_summary`; `suggest_day_blocks`/`suggest_balance_moves`
  descriptions and both system prompts describe the `apply_proposal` flow and
  candidates without a proposal id correctly; `get_ytd_progress` rejects
  invalid dates and normalizes compact ISO dates; `AGENT_MAX_ITERATIONS`
  dropped from `from_env`; default model/provider defined once
  (`agent/config.py`); Sonnet 5 price plus a backend/frontend price-table
  parity test. The model-visible text changed (tool descriptions, prompts,
  violation messages): the prompt cache misses once after deploy, and arena
  results before and after are not strictly comparable.
- **Core, auth, publication** (`state.py`, `state_routes.py`, `auth.py`,
  `account_lifecycle.py`, `publication.py`, `web.py`, `ical*.py`, `pdf.py`,
  `models.py`): `_load_state` persists any normalization difference so the
  revision it returns always equals the stored one (before, a silent
  normalization made every save fail with 409); `connection` is required in
  the publication lookups and the dead write branch that could recreate a
  deleted account's state is gone; deterministic sub-shift fallback for
  overrides, migrated day-type slot ids kept (`_is_day_type_slot_id`) and
  following the date's day type (`_follow_date_day_type`); the default
  sub-shift gets `endDayOffset: 0` (normalization is idempotent);
  `state_routes` uses `state._get_day_type`; `_get_current_user` reuses
  `_extract_bearer_token`; atomic `create_user`; self-disable/demote guard;
  `user_preferences` cleared on account deletion and a schema-introspection
  test checks every per-user table; iCal `Content-Disposition` with
  `filename*`, `HEAD` route, idempotent `publish_ical`/`publish_web`, fast
  path in `_fold_ical_line`, early return without published weeks; shared
  `_new_token`, `_compute_etag`/`_public_cache_headers`/`_not_modified`
  (ETags bit-identical, pinned by a test) and `_render_pdf`; PDF timeouts and
  render failures are logged; dead helpers/models removed
  (`get_account_generation`, `_load_raw_state_blob`, `_resolve_shift_row`,
  `SolverDebugCheckpoint`, `IcalPublishRequest`).
- **Frontend page** (`WeeklySchedulePage.tsx`): one `buildStatePayload` for
  every save path (autosave, snapshot import, run start — the run start now
  also passes the colBand guard); autosave normalizes only when the debounce
  fires; ~330 lines of dead handlers removed; popover clicks no longer count
  as "outside"; the 100 ms run ticker pauses while the overlay is minimized;
  a stable rendered-assignment list for the overview modals and no duplicate
  map on desktop; `computeOpenSlots` (`src/lib/openSlots.ts`); one
  `revealDate` jump helper (phones switch to the target day);
  vacation updates moved out of the assignment state updater; local `.ics`
  `endDayOffset`; reset rules in `resetSolverAssignments.ts`; template-limit
  banner and guarded sign-out/restore; My plan integration.
- **Frontend grid** (`ScheduleGrid.tsx`, `ClinicSheetGrid.tsx`,
  `AssignmentPill.tsx`, `clinicianSlotOptions.ts`, `schedule.ts`):
  `ConfirmDialog` Enter fix; month picker; `ClinicianPickerPopover` no
  longer pulls focus back into its search field on parent re-renders;
  `SnapshotPopover` Escape and `restoreDisabled`; unknown-interval counts
  per clinician (`canDropAssignment`); shared
  `DRAG_MIME`/`readDragPayload` (malformed payloads ignored) and
  `sortAssignmentsBySurname`; the dragover state shim, dead props and
  always-false branches removed; Rest Day entries keep their stored ids in
  `buildRenderedAssignmentMap` (dead pool bookkeeping removed); drag/drop and
  picker tests.
- **Frontend settings** (`SettingsView.tsx`, `AgentSettingsPanel.tsx`,
  `ClinicianEditor.tsx`, `WeeklyTemplateBuilder.tsx`, `AdminUsersPanel.tsx`):
  remove-person confirmation; AI settings extracted into
  `AgentSettingsPanel` (its chat timer no longer re-renders the whole
  settings page), budget field and custom model name fixed;
  preferred-working-times editor rewritten without the timer/suppress-ref
  mechanism (no emit on mount, own times shown again after switching
  clinicians); slot removal confirmation and honest delete dialogs; the
  builder's duplicate colBand sanitizer and console logging removed;
  unreachable month-name parser in `parseHolidayDate` removed; hook order fix
  in `AdminUsersPanel`; shared `ToggleSwitch`.
- **Frontend planning UI** (`SolverOverlay.tsx`, `SolverInfoModal.tsx`,
  `IcalExportModal.tsx`, `WorkingHoursOverviewModal.tsx`,
  `VacationOverviewModal.tsx`, `AgentActivityPanel.tsx`): live stats cache
  keyed by solution object (a second run over the same range no longer shows
  old numbers); the overlay re-finds a remounted calendar container (falls
  back to a fixed overlay); `liveStats` is the last history entry; run-card
  errors; weights section says it only affects CP-SAT; PDF start validation;
  hours aggregation skipped while closed and done in one pass with the
  shared hours rule; dead `visibleYear` scroll listener and `DashboardCard`
  removed; `copyTextToClipboard` reports failure.
- **Frontend lib/pages/app**: `App.tsx` session check (401/403 vs transient);
  `login()` no longer triggers the session-expired handler on wrong
  credentials; `LoginPage`/`PublicWeekPage` error messages; `mockData.ts`
  re-exports the API types and uses the backend weight defaults; one strict
  `parseTimeToMinutes` (`src/lib/time.ts`); `buildTimeMeta` shared by both
  column-time builders; print pages without dead code and with stable week
  arrays; DB inspector ignores stale week responses; animated numbers
  continue from the shown value; `downloadTextFile` in `src/lib/download.ts`;
  section block colors derived from `BLOCK_COLOR_SWATCH_OPTIONS` (a backend
  test checks them against `backend/state.py`).
- **Infra/tests**: CI runs `e2e/my-plan.spec.ts` and `e2e/team-page.spec.ts`
  in addition to the four earlier specs; `scripts/smoke-api.mjs` no longer
  calls the removed `POST /v1/solve/week`.

### Deploy and data notes

- Schema change is additive only (`user_preferences`); no existing table or
  calendar is migrated. Uncolored locations serialize exactly as before.
- A calendar whose stored JSON differs from its normalized form is re-saved
  once on its first load after the deploy (same content the app already
  showed; its revision then matches what clients get). This replaces the
  earlier behaviour where such a calendar failed every save with 409.
- Not addressed in this release (known): an invalid drop still removes the
  assignment instead of snapping back; the LLM spend of stopped, killed or
  crashed agent runs is still not charged; no login throttling; a discard
  that gets 409 shows the generic "try again" notice instead of the server's
  reason; CP-SAT still fills zero-duration slots; the legacy v<4 template
  migration in `_normalize_state` still carries dead code.
- After deploy, run the admin "Model connection test" (Settings → Solver)
  once on Sonnet 5: the new `thinking.display` request field has only been
  checked against the installed SDK, not the live API.

### Documentation

- DEPLOY.md, NOTES.md and §13 name the LXC (`shiftplanner.truhn.ai`) as
  production and the Hetzner server as redirect host; CI/deploy steps match
  `ci-cd.yml` (Node 22, build + Playwright incl. `my-plan`/`team-page`, SHA
  checkout + `deploy-compose.sh`). Corrected stale statements on optimizer
  weights (20/10/3 plus Minimum Daily Hours and YTD Balance), the SSE
  progress stream (Authorization header, no `?token=`), the agent wall clock
  (none by default), the tool-history budget (~60K chars), colBand limits
  (20 per day type, save refused above 300), case-insensitive usernames, the
  local Python range (3.10–3.12), apply/reset semantics, the planning panel
  (no strategy toggle), overlay buttons, drop behaviour, the validator's
  zero-duration rule, scoring (`plan_stats` only) and the heuristic's
  blocked-slot handling (`human-heuristic-solver.md`,
  `HEURISTIC_SOLVER_V2_README.md`).

## v1.65 — Compact team week ("Times: Stacked")

- **Two time layouts in the classic grid.** The team header gets a "Times:
  Side by side | Stacked" switch next to "Color by" (classic grid only; the
  clinic sheet keeps its look). The choice is the per-user preference
  `teamTimeLayout` (`"columns"` | `"stacked"`, default `"stacked"`; declared
  in `backend/models.py::UserPreferences`, mirrored in `src/api/client.ts` and
  `normalizePreferences`). It is not part of saved views or start pages.
  Side by side is the unchanged pre-v1.65 grid (one column per col band of a
  day). Stacked has one column per day: each class row (location × row band)
  splits into one sub-row per time lane, the label column shows the row band
  name (on its first lane), the lane's section when it is not the row band
  name (e.g. a second column with another section) and the lane's time
  right-aligned; the location separator names the location (neutral band when
  uncolored) and the per-column time headings disappear. Cells are compact
  section blocks (open slots 24 px high, "nobody needed" blocks faint); a cell
  shows its own section or time only where it differs from its lane's.
- **Time lanes** (`src/lib/stackedTeamLayout.ts::buildTimeLanes`, pure):
  at most one slot per day type per lane. The day type with the most slots
  opens the lanes in column order; the other days join them by the same time
  and section, then the same time, then the nearest start on the clock
  (00:00 is next to 22:00). Matching on time,
  not on the col band order, matters because the template numbers each day's
  columns on its own (a weekend with "Day | Night" puts its night shift into
  the weekday night lane). Lanes without a slot on the visible days are left
  out; a row without any keeps one inactive lane.
- **Nothing else changes.** `ScheduleGrid` gets `timeLayout` (default
  `"columns"`, so print/public pages and tests keep the old grid) and builds
  the stacked rows/columns with `buildStackedTeamLayout`; slot ids, cell
  `data-row-id`/`data-date-iso`, assignment keys, drag & drop, the picker,
  open-slot/violation highlights and "Show in team plan" work unchanged.
  Slot lookups (intervals, row kinds, picker options) still use the source
  rows. A stacked lane's slots are copies with `colBandOrder: 1`; the source
  rows are never changed. Two sections on the same row band / day / column
  (the "slot collision" configuration error) get separate lanes, so Stacked
  shows both while Side by side shows one; the warning text says so.
- **Pills (both layouts):** a manually placed pill in the section look
  reserves room on the right for its small lock badge (`pr-4`), so a long name
  is abbreviated ("Julia M.") instead of running under the badge.
- Tests: `src/lib/stackedTeamLayout.test.ts`, `ScheduleGrid.test.tsx`
  ("stacked times"), `TeamPlanHeader.test.tsx`, `userPreferences.test.ts`,
  `backend/tests/test_user_preferences.py`, `e2e/team-page.spec.ts` ("Times
  switches between side-by-side and stacked columns").
- Deploy notes: no schema or calendar change; stored preferences without
  `teamTimeLayout` read as Stacked, so every user sees the compact week after
  the deploy until they pick Side by side.

## v1.66 — Compact team cells ("plan for all" look) and portrait PDF

- **Stacked cells without blocks.** In "Times: Stacked" a cell is the slot
  itself: no section block around the pills and no section name inside.
  The section look tints each active cell with its own section color
  (`.stacked-section-cell`, `--section-color`, `color-mix()` in
  `src/index.css`, inside `@supports`; browsers without `color-mix()` show
  the plain section color); the person
  look keeps cells white; a day without the lane's slot is hatched
  (`.stacked-off-cell`, so it never reads as an empty slot, also in print); a
  qualified drop target gets an inset ring. A cell writes only a time other
  than its lane's (compact "08:00–20:00", wrapping after the dash in narrow
  columns); a cell of another section than the
  lane's gets a small corner mark (no text); its section and time are in its
  tooltip.
- **Lane labels like shift colors.** The label cell is tinted with the lane's
  section color (`.stacked-label-tint`; it replaces the location tint there,
  the location band above the rows keeps it). It shows the row band name
  (first lane; long names wrap to two lines), the lane's section when it is
  not the row band name and the compact time. When some visible days belong to another section, a "+N"
  badge lists them in its tooltip and for screen readers ("Other days: Tue: X
  · Wed: Y"); `StackedRowMeta` gains `sectionColor` and `otherSections`
  (`src/lib/stackedTeamLayout.ts`).
- **Narrower columns.** Stacked day columns may shrink to 64 px, so seven
  days fit next to even the widest label (about 290 px) on A4 portrait; names
  abbreviate (down to initials). `AssignmentPill` `compact`: an unfixed solver
  pill shows its fix button only on hover or keyboard focus (always on touch
  screens) and keeps no room for it; a fixed pill keeps the button. Compact
  pills measure again when their width changes (resize, fixing a pill), so a
  name never stays cut off. The full name of a shortened pill is now in the
  pill's own tooltip (before, it sat on content that ignores the pointer and
  never showed). Compact open slots read "Open".
- **Portrait PDF.** `GET /v1/pdf/week` and `/v1/pdf/weeks` take
  `layout=landscape|portrait` (default landscape). Portrait renders the print
  route with `&layout=portrait` in an A4 portrait viewport (794 × 1122) and
  writes an A4 portrait PDF. `PrintWeekPage` / `PrintWeeksPage` read the
  layout (`src/pages/printPage.ts`), restate `@page { size: A4 portrait }`
  (index.css says landscape for every print, and Chromium follows the CSS
  page size over its landscape flag), lay the classic grid out as
  `timeLayout="stacked"` at the page width (`portraitContentWidth`: names
  abbreviate instead of the week shrinking) and start portrait pages at the
  top. Multi-week pages now keep a left and top margin like the single-week
  page. The Export dialog
  offers "Landscape · times side by side | Portrait · compact week" for the
  standard week grid (preselected from the user's Times choice); the monthly
  clinic sheet always exports landscape. Open slots are not printed, as before.
- Tests: `ScheduleGrid.test.tsx`, `AssignmentPill.test.tsx`,
  `IcalExportModal.test.tsx`, `src/pages/printPage.test.ts`,
  `PrintWeekPage.test.tsx`, `PrintWeeksPage.test.tsx`,
  `src/api/client.pdf.test.ts`, `backend/tests/test_pdf_revision.py`.
- Deploy notes: no schema or data change. The PDF renderer loads the deployed
  frontend, so backend and frontend must ship together (one deploy does).

