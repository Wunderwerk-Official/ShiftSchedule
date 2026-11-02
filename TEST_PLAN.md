# Test Plan - Shift Schedule Application

This document outlines the test strategy, coverage areas, and execution instructions for the Shift Schedule application.

---

## 1. Test Layers Overview

| Layer | Framework | Location | Purpose |
|-------|-----------|----------|---------|
| Backend Unit | pytest | `backend/tests/` | State normalization, solver logic, utilities |
| Backend Integration | pytest | `backend/tests/` | API endpoints, database operations |
| Frontend Unit | Vitest | `src/**/*.test.ts(x)` | Pure functions, helpers, utilities |
| Frontend Component | Vitest | `src/**/*.test.tsx` | React component behavior |
| End-to-End | Playwright | `e2e/*.spec.ts` | Full user journeys |

---

## 2. Running Tests

### Backend Tests (pytest)

```bash
# Install dev dependencies
pip install -r backend/requirements-dev.txt

# Run all backend tests as CI does (the ~7 min solver benchmark excluded)
(cd backend && python3 -m pytest tests -q --ignore=tests/test_solver_benchmark.py)

# Run specific test file
python3 -m pytest backend/tests/test_state_normalization.py -v

# Coverage needs pytest-cov, which is not in requirements-dev.txt:
#   pip install pytest-cov && python3 -m pytest backend/tests/ --cov=backend --cov-report=html
```

### Frontend Unit Tests (Vitest)

```bash
# Run once
npm test

# Watch mode
npm run test:watch

# With coverage (needs @vitest/coverage-v8, not in package.json)
npm test -- --coverage
```

### End-to-End Tests (Playwright)

```bash
# Ensure backend and frontend are running first
# Backend: python3 -m uvicorn backend.main:app --port 8000
# Frontend: npm run dev

# Run E2E tests (npm run test:e2e is for Apple Silicon only, see CI section)
npx playwright test

# Run specific test file
npx playwright test e2e/app.spec.ts

# Debug mode
npx playwright test --debug

# Show report
npx playwright show-report
```

### Required Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLAYWRIGHT_BASE_URL` | `http://127.0.0.1:5173` | Frontend URL for E2E |
| `PLAYWRIGHT_API_URL` | `http://localhost:8000` | Backend URL for E2E |
| `E2E_USERNAME` | `testuser` | Test user username |
| `E2E_PASSWORD` | `sdjhfl34-wfsdfwsd2` | Test user password |
| `ADMIN_USERNAME` | - | Admin user for backend |
| `ADMIN_PASSWORD` | - | Admin password for backend |
| `JWT_SECRET` | - | JWT signing secret |

---

## 3. Coverage by Feature

### 3.1 State Normalization & Migration

**Backend Tests** (`backend/tests/test_state_normalization.py`):
- [x] Remove deprecated pool rows (`pool-not-allocated`, `pool-manual`)
- [x] Remove assignments to deprecated pools
- [x] Preserve Rest Day pool (`pool-rest-day`)
- [x] Preserve Vacation pool (`pool-vacation`)
- [x] Remove deprecated solver settings (`allowMultipleShiftsPerDay`, `showDistributionPool`, `showReservePool`)
- [x] Normalize solver settings defaults
- [x] Handle legacy state formats gracefully

**Frontend Tests** (`src/lib/shiftRows.test.ts`):
- [x] `normalizeAppState()` removes deprecated pools
- [x] `normalizeAppState()` preserves valid pools
- [x] `parseShiftRowId()` and `buildShiftRowId()` round-trip correctly

### 3.2 Solver Logic

**Backend Tests** (`backend/tests/test_solver.py`):
- [x] Day solver creates assignments only for template slots
- [x] Solver respects clinician qualifications
- [x] Solver blocks vacation days
- [x] Solver blocks dates a person was placed in the Rest Day row by hand (v1.75, `TestSolverRestDayRow`)
- [x] Solver blocks rest days (when on-call rest enabled)
- [x] Solver enforces same-location-per-day (when enabled)
- [x] Solver prevents time overlaps (overlapping intervals forbidden)
- [x] Solver allows touching intervals (end == start)
- [x] Manual assignments remain fixed
- [x] Infeasible configurations return safe responses

### 3.3 Time Interval Logic

**Backend Tests** (`backend/tests/test_solver_time.py`):
- [x] Time parsing (`_parse_time_to_minutes()`)
- [x] Slot interval building (`_build_slot_interval()`)
- [x] Day offset handling

**Frontend Tests** (`src/lib/schedule.test.ts`):
- [x] `intervalsOverlap()` edge cases
- [x] `buildShiftInterval()` with day offsets
- [x] Pool rows return null interval

### 3.4 Assignment Rendering

**Frontend Tests** (`src/lib/schedule.test.ts`):
- [x] `buildRenderedAssignmentMap()` filters vacation days
- [x] `buildRenderedAssignmentMap()` handles on-call rest days
- [x] No Distribution Pool references in output

### 3.5 iCal Export

**Backend Tests** (`backend/tests/test_ical.py`):
- [x] `_escape_text()` escapes special characters
- [x] `_fold_ical_line()` wraps long lines per RFC 5545
- [x] `_format_dtstamp()` produces valid timestamps
- [x] Calendar generation produces valid iCal format
- [x] Only section assignments included (no pool rows)
- [x] Vacation days filter out assignments

**Backend Integration Tests** (`backend/tests/test_ical.py`, `test_publication_caching.py`, `test_publication_lifecycle.py`):
- [x] Invalid token returns 404
- [x] Unpublished weeks return empty calendar
- [x] Published weeks return events
- [x] Token rotation invalidates old tokens
- [x] ETag/Last-Modified headers for caching
- [x] Conditional GET returns 304 when unchanged

### 3.6 Public Web View

**Backend Tests** (`backend/tests/test_web.py`):
- [x] Unpublished week returns `published: false`
- [x] Published week returns schedule data
- [x] Invalid token returns 404
- [x] Token rotation invalidates old tokens
- [x] ETag caching works correctly

### 3.7 PDF Export

**E2E Tests** (`e2e/app.spec.ts`):
- [x] PDF export produces valid PDF
- [x] One page per week
- [x] Print layout fits A4 page

### 3.8 Pool Removal Regression Tests

**Backend Tests**:
- [x] Distribution Pool (`pool-not-allocated`) is removed from state
- [x] Reserve Pool (`pool-manual`) is removed from state
- [x] No assignment rowId equals deprecated pool IDs
- [x] Solver does not reference pools

**Frontend Tests**:
- [x] Normalization removes deprecated pools

**E2E Tests** (`e2e/pool-removal.spec.ts`):
- [x] Distribution Pool not rendered in UI
- [x] Reserve Pool not rendered in UI
- [x] Settings view shows only Rest Day and Vacation pools
- [x] Schedule grid has no deprecated pool rows

### 3.9 My plan and per-user preferences (v1.64)

**Backend Tests** (`backend/tests/test_user_preferences.py` unless noted):
- [x] `GET /v1/me/preferences` returns defaults; PUT/GET round trip; partial input completed, unknown fields ignored
- [x] Invalid input rejected without storing; saved-view cap (12) and name trimming
- [x] Body over 32 KB → 413; the same request without a token → 401
- [x] Isolated per user; deleted with the account; unreadable row → defaults; table added to an older database
- [x] `Location.color` normalization, non-string values dropped, omitted when unset (`test_state_preferences.py`); excluded from the planning fingerprint (`test_fixed_planning_tasks.py`)

**Frontend Tests**:
- [x] `src/lib/myPlan/*.test.ts` — timeline (midnight split, previous-day night), hours, rest/vacation bands, coworkers, layout, colors, labels
- [x] `src/lib/userPreferences.test.ts` — normalization, debounce, no PUT before a successful GET, flush on hide
- [x] `src/pages/usePlanScope.test.ts`, `scrollToTeamAssignment.test.ts`
- [x] `src/components/myPlan/*.test.tsx` — views, header chrome, shift detail, flows, keyboard shortcuts
- [x] `TeamPlanHeader.test.tsx`, `LocationColorPicker.test.tsx` (Auto + presets, v1.71)
- [x] `src/lib/locationColors.test.ts` — automatic location colors in location order, chosen colors never handed out twice (v1.71)
- [x] `src/lib/myPlan/colors.test.ts` — person palette: fills ≥ 15 ΔE00 apart among the first 12, ≥ 9 among all 20, readable text in both themes; location presets: readable label shades, white-text band (v1.71)
- [x] `ScheduleGrid.test.tsx` — label shades alternate per row band and restart per location; stacked lanes share their row band's shade; band in the location's strong color (v1.71)

**E2E Tests** (`e2e/my-plan.spec.ts`, mocked API, in CI):
- [x] Link yourself, change views, jump back into the team plan
- [x] The calendar always opens in Team, even with a stored My-plan start view (v1.74: start-page star and saved views removed; opening sends no preferences PUT); the team pills carry person colors (no "Color by" switch since v1.69)
- [x] "Not <name>? Change who you are" (last entry of the person picker) unlinks the account (PUT `clinicianId: null`) and My plan asks "Who are you in the plan?" again (v1.74)
- [x] Both plans wait for the calendar (v1.78, replaces "My plan waits for the calendar"): no demo calendar in Team, no stale link in My plan, the Settings loading card during a slow load, then the plan
- [x] Without a color the first location is blue (Auto); a picked color is saved with the calendar and colors the label shades and the band; Auto clears it (v1.71)
- [x] Phone: the scope switch leads to My plan and hides the planning panels

### 3.10 Team page regressions (v1.64)

**Frontend Tests**: `src/pages/resetSolverAssignments.test.ts` (Reset → Unlocked shifts / Unlocked shifts and rest days), `src/lib/assignmentPolicy.test.ts` (one lock, v1.69), `src/lib/openSlots.test.ts`, `src/components/ui/ConfirmDialog.test.tsx`, `src/App.test.tsx` (502/network keep the session), `src/lib/clinicianSlotOptions.test.ts`, `ScheduleGrid.test.tsx` / `ClinicSheetGrid.test.tsx` (drag and drop).

**E2E Tests** (`e2e/team-page.spec.ts`, mocked API, in CI):
- [x] Rule-violation and split-shift popover items can be clicked
- [x] Dragging into and out of the Vacation row adds and removes the vacation day
- [x] Phone: the open-slots badge switches the day view to the open slot's day
- [x] Template above the column limit: banner and no save, snapshot import refused, snapshot restore backs up the last saved calendar, sign-out asks first
- [x] Reset → Unlocked shifts and Unlocked shifts and rest days also remove planner entries on vacation days; both keep locked shifts, hand-placed ones included (v1.69)
- [x] Times switches between side-by-side and stacked columns and stores the choice (v1.65)
- [x] Stacked: a section that takes over a row band's slot on one day gets its own lane, named in the label (row band / section / time cells); the other lane is hatched that day; no in-cell section tag (v1.76)
- [x] Moving a planner shift by hand locks it (v1.69)
- [x] A locked shift moved into the Rest Day row becomes a plain rest day entry that Reset → Unlocked shifts and rest days removes (v1.69)
- [x] A shifts file import saves the calendar as shown as an auto-backup first, sending this tab's revision (v1.78); when the backup fails nothing is imported (v1.74)
- [x] Loading public holidays keeps the holidays added by hand (v1.74; the state filter is in `holiday-region.spec.ts`)

**Frontend Tests (v1.66 compact cells and portrait PDF)**: `ScheduleGrid.test.tsx` (no section block or name in stacked cells, tooltip, corner mark (replaced by a tag in v1.73, gone since v1.76) and +N badge (gone since v1.76), hatched days without a slot, section tints, hover-only fix button, fixed pill keeps it, "Open"), `AssignmentPill.test.tsx` (full name in the pill's tooltip), `IcalExportModal.test.tsx` (page layout choice), `src/pages/printPage.test.ts` (A4 portrait geometry), `PrintWeekPage.test.tsx` / `PrintWeeksPage.test.tsx` (portrait page rule, seven columns, margins), `src/api/client.pdf.test.ts` (layout reaches the request); backend `test_pdf_revision.py` (layout → orientation, viewport and print route).

**Frontend Tests (v1.73 named sections in stacked cells)**: superseded in v1.76 — lanes never mix sections, so there is no section tag; replaced by the v1.76 tests below.

**Frontend Tests (v1.76 stacked week: one row per section)**: `src/lib/stackedTeamLayout.test.ts` (`buildTimeLanes`: a slot that overlaps no free lane opens its own, however near its start; `buildSectionLanes`: lanes never mix sections — the user's rotating "IRM HK" row; a section's separate time blocks on different days (the user's IRM cardio HK: Mon/Thu 07:30, Wed 13:00 and 16:00) get a lane each with no differing time; sections by earliest start, then first slot in template column order, then name; a section's lanes by start even when a later day opened them; a weekend variant with another time stays in its section's lane; two slots of one section on a day get two lanes; sections by id, by name without one; `buildStackedTeamLayout`: a day of another section gets its own lane and color, a section named like its row band is titled when another section comes first, lane ids and order are the same whatever days are on screen, also when a hidden day or a holiday decides the order, row/section spans and first/last-in-section flags), `ScheduleGrid.test.tsx` (three label columns with spanning row band and section cells, header and pool row labels span them; divider levels lane / section / row on cells and label cells; single day keeps one label cell and names the section on every lane; no section tag in cells, own time as a quiet clock note under the people (no chip) and tooltip kept, no "+N"; section tints per lane label and cell; a later lane's section for screen readers and in its tooltip; location shade on every label cell), `HelpView.test.tsx` (stacked text), e2e `team-page.spec.ts` (see above).

**Frontend Tests (v1.77 team switch while loading)**: `CalendarPlaceholder.test.tsx` (the "Team | My plan" switch is usable while My plan waits for the calendar and reports "team"; busy status "Loading calendar…"; plain "My plan" label without initials; compact switch on phones).

**Frontend Tests (v1.65 stacked times)**: `src/lib/stackedTeamLayout.test.ts` (time lanes: weekend columns by time, shorter shifts by nearest start, same-time columns by section), `ScheduleGrid.test.tsx` ("stacked times": one column per day, labels, own-time captions, drag between lanes), `TeamPlanHeader.test.tsx` (Times switch).

### 3.11 Background runs (v1.64)

**Backend Tests** (`backend/tests/test_solver_monitor.py`, `test_solver_run_endpoints.py`):
- [x] Watchdog hard stop kills the worker once; salvaged plans end `aborted`; a torn queue message cannot hang the monitor; agent spend recorded once
- [x] Invalid date ranges → 422 with no run row or process
- [x] Discard after apply / of a failed run → 409; discarding an open run twice → 200
- [x] A vacation-hidden unlocked solver row is replaced on apply (`is_replaced_by_draft`)

### 3.12 Holidays by state (v1.72)

**Frontend Tests**: `src/lib/holidays.test.ts` (region filter with date.nager.at's Germany 2026 answer: nationwide entries, matching and other states' counties, no region; region normalizer; region tables), `src/lib/shiftRows.test.ts` (`normalizeAppState` keeps an uppercased code, drops anything else), `SettingsView.test.tsx` (state select, "all states" hint, reload note, load arguments, region of another country, unknown code).

**Backend Tests**: `test_state_normalization.py` (normalizer, non-strings, a pre-v1.72 calendar keeps its bytes and revision through load and save, round trip, clearing restores the old revision), `test_state_routes.py` (GET/POST `/v1/state` round trip, 409 for a stale tab), `test_fixed_planning_tasks.py` (the region is not a planning input).

**E2E Tests** (`e2e/holiday-region.spec.ts`, mocked API and mocked date.nager.at, in CI):
- [x] A chosen state filters the loaded holidays (NRW: Fronleichnam and Allerheiligen, no Buß- und Bettag) and is saved with the calendar; choosing it alone keeps the stored list
- [x] A stored state is shown; another country starts without one

**Holidays added by hand (v1.74)**: `src/lib/holidays.test.ts` (`mergeLoadedHolidays`: state filter, all states without one, hand-added holidays and other years kept, untagged entries the service lists replaced, no duplicates), `SettingsView.test.tsx` (load count, "added by hand"); backend `test_state_normalization.py` (untagged holidays dump without `source`, a pre-v1.74 calendar keeps its bytes and revision, round trip, unknown tags dropped instead of a 422), `test_state_routes.py` (GET/POST `/v1/state`), `test_agent_workflow_safety.py` (`source` is not a planning input); e2e `team-page.spec.ts` (with a stored state, holidays added by hand, in the UI or before v1.74, survive a load; older loaded ones are replaced).

### 3.13 Hand-placed rest days and on-call fairness (v1.75)

**Backend Tests**:
- [x] `REST_DAY` flags a shift on a stored `pool-rest-day` date (manual, solver or untagged entry), read from the calendar and from the checked list; not other dates or people, not pool rows; a night shift starting the evening before stays allowed (as for vacation); stored Vacation row entries stay ignored (`test_validation.py`)
- [x] CP-SAT and heuristic v2 give the shift to someone else, leave it open when only the person on the rest day qualifies (solved, no infeasibility), and keep an existing shift on that day (`test_solver.py`, `test_heuristic_v2.py`); the basic plan (without AI) and the repair seed too (`test_agent_harness.py`)
- [x] Agent: the person is ineligible with `REST_DAY` in candidate lists, day priorities and day blocks, `apply_moves` refuses, a fixed conflict blocks no unrelated move, `get_clinician_summary` lists `rest_days` (`test_agent_tools.py`); `repair_neighborhood` never previews them (`test_agent_planning_workflow.py`)
- [x] A stored draft is refused (also with force) when a rest day was added after the run; a fixed conflict does not block an unrelated draft; fingerprints of stored runs are unchanged (`test_agent_workflow_safety.py`)
- [x] Balanced counts on-call burden only while "Rest days around on-call duty" is on; rest days reduce duty opportunity weights; `QUALITY_VERSION` 3 (`test_agent_quality_profile.py`); the duty-pass follow-up reports `duty_complete` with the rule off (`test_agent_planning_workflow.py`)

**Frontend Tests**: `SettingsView.test.tsx` (Rest Day row helper, Planning goals on-call note), `HelpView.test.tsx` (Rest Day row day off).

### 3.14 v1.78 QA fixes

**Backend Tests**:
- [x] Timed iCal events: UTC from the plan's wall clock, overnight and DST shifts end at their real end (16:00–24:00 ends at midnight, 20:00–08:00 is 13 h in October and 11 h in March), the zone follows the holiday country, gap and repeated hours use the offset before the change, a slot without usable times stays all-day on its day, events ordered by start (`test_ical.py`, including `TestFormatUtc`)
- [x] Calendar names never use the account; file names are transliterated ASCII ("Müller, Jörg; Dr." → `mueller-joerg-dr`), `shift-planner-all.ics` for everyone (`test_ical.py` `TestNames`)
- [x] Frontend and backend zone maps and defaults are identical, every Settings country has a zone, every mapped zone loads, `wall_clock_to_utc` (`test_plan_timezone.py`)
- [x] No Last-Modified in the second of the change, If-Modified-Since ignored in that second, both honoured once it is over; feeds from before timed events do not revalidate; a non-matching ETag wins over If-Modified-Since (`test_publication_caching.py`)
- [x] iCal names never show the account name; a removed person's link is revoked and a reused id gets a new token; a personal feed of a removed person is 404 even with a leftover token; publish status removes leftover tokens; all-day copies never revalidate after the switch to timed events, also after a restart (`ical_formats`, real database) (`test_publication_lifecycle.py`)
- [x] PDF: a start inside a week prints and names its whole weeks; file names name the printed days (`shift-planner-<monday>-to-<last sunday>.pdf`); a render past the time limit stops the browser and answers 504; page steps never wait past the deadline; a finished render cancels it (`test_pdf_revision.py`)
- [x] Impossible dates → 422 naming value and path (shifts, Rest Day entries, holidays, published weeks, slot-override keys, vacations); the formats the app writes are accepted (leap day, override key); shifts of people no longer listed are dropped on save; a calendar stored with impossible dates still loads, is cleaned and saves back (`test_state_routes.py`); normalize drops invalid entries instead of raising, also for an imported export (`test_state_normalization.py`); the public week of such a calendar renders (`test_web.py`)
- [x] Import backup: named after a holiday change or a loaded copy, an unknown reason gives 422, a stale `expectedRevision` gives 409 without touching the backup; restoring a snapshot stored with impossible dates drops them (`test_snapshots.py`)
- [x] Public week: on-call shifts of the neighbouring weeks are sent reduced, the window follows the days before/after, none while the rule is off (`test_web.py::TestWebRestDayContext`); the owner's Times layout (default stacked), the ETag changes with it, an unpublished week sends none (`TestWebTimeLayout`)

**Frontend Tests (v1.78 iCal and real durations)**: `src/lib/ical.test.ts` (timed events and the same instants as the backend, all-day fallback, published weeks only unless included, UID scheme, header and calendar names, file-name transliteration, `foldLine` at 75 octets including umlaut/CJK/emoji boundaries, escaping without bare CR), `src/lib/planTimeZone.test.ts` (Berlin, London and Moscow at DST changes, Moscow's 2014 offset change, gap and repeated hours), `src/lib/myPlan/hours.test.ts` (17:00–08:00 is 16 h / 14 h on the change nights, day and week sums, `getShiftMinutes`), `src/lib/myPlan/rest.test.ts` (13 h rest across the October change; Next up with the browser in Berlin, New York, Tokyo and Auckland), `MyPlanView.test.tsx` (Next up chip with the browser in New York), `WorkingHoursOverviewModal.test.tsx` (17 h / 15 h), `IcalExportModal.test.tsx` ("Include unpublished weeks", zone texts), `HelpView.export.test.tsx` (timed events, published-weeks rule, removed person's link, DST wording).

**Frontend Tests (v1.78 holidays and backups)**: `src/lib/shiftRows.test.ts` (`findAssignmentsDroppedByHolidayChange`: add, remove, state switch, no-op, already misplaced, migrated `__daytype` moves, duplicate ids), `src/lib/holidayChange.test.ts` (message, locked counts, singular/plural, five days then "+N more days", date format), `src/pages/useConfirmHolidayChange.test.tsx` (real confirm dialog; confirm, cancel; the backup before a holiday change, refused after a failed queued save or a failed backup), `src/api/client.backup.test.ts` (request body with and without reason), `src/api/client.importBackup.test.ts` (expected revision, the server's reason for a refusal, the first problem of a rejected request body (422), `savedStateRevision`), `src/lib/stateSaveQueue.test.ts` (`baseRevision`), `SettingsView.test.tsx` (Add form kept on cancel/failure, remove error, cancelled load), `HelpView.test.tsx`.

**Frontend Tests (v1.78 PDF)**: `src/pages/printPage.test.ts` (the page box is monolithic and never reaches the next sheet), `PrintWeekPage.test.tsx` / `PrintWeeksPage.test.tsx` (one sheet per week with `breakAfter` page/auto, draft marker only on unpublished weeks, content-sized landscape columns, mid-week start), `ScheduleGrid.test.tsx` ("ScheduleGrid print pages": columns by their widest word, the compact week keeps 64 px, names wrap instead of shortening, labels wrap, row band and section words stay whole, no today mark), `ClinicSheetGrid.test.tsx` (long names never widen the day column, fixed column an ordinary surname fits, names share their area's columns, open-slot marks keep a track, a full area wraps), `IcalExportModal.test.tsx` (progress texts without "0 of"), `src/api/client.pdf.test.ts` (the abort signal reaches fetch).

**Frontend Tests (v1.78 names and search)**: `src/lib/personName.test.ts` (parser table for comma, title, particle and degree forms; team-unique labels at every level — Yildirim/Yılmaz, Wagner/Weber, Andrea/Andreas Schulz, identical names, a 28-person team; `distinctLength`; `displayName` with nicknames and notes), `src/lib/textSearch.test.ts` (accents, ß, ı, ł, ø, umlaut transliteration, word order, apostrophes), `AssignmentPill.test.tsx` (team-wide label; "S. Wa." / "S. We." when a cut would read "Sophie…"; the cut stays when not even "F. L." fits) and `AssignmentPill.noCanvas.test.tsx` (renamed from `.stepwise`), `ClinicSheetGrid.test.tsx` ("Last, First" and titled names by unique surname), `ClinicianPickerPopover.test.tsx` and `src/components/myPlan/PersonPicker.test.tsx` (accent-insensitive search, initials, the "Not <name>?" footer), `schedule.test.ts` (sort by the parsed family name).

**Frontend Tests (v1.78 public page and shifts file)**: `src/pages/PublicWeekPage.test.tsx` (rest days from on-call shifts in the neighbouring weeks without showing them, also in the clinic sheet; the owner's stacked layout; phone: one day with its name, moving by day into the next week, stacked even for side by side, day view for the clinic sheet), `schedule.test.ts` (`restContextAssignments`, vacation days), `src/lib/shiftsFileImport.test.ts` (validation, refusals of empty, foreign and all-dropped files, dedupe and ids, entry limit, drop reasons, `shiftsFileName`, revision passed, refused backup, failed queued save), `SettingsView.test.tsx` (checked before asking, counts, cancel, the 10 MB limit), `AdminUsersPanel.test.tsx` (backup before the copy, a refused backup loads nothing), `src/App.test.tsx` (no session check on a public link), `SnapshotPopover.test.tsx` (the backup replaces the previous one).

**Frontend Tests (v1.78 calendar UI)**: `src/lib/schedule.test.ts` (automatic rest days around on-call duty: a shift wins over the computed pill, vacation excluded), `ScheduleGrid.test.tsx` (a Rest Day pill moves to another day's Rest Day row, is removed outside or on another day's slot, other days' Rest Day cells stay bright; a Vacation pill only leaves when dragged out; clipped holiday name in the header tooltip and its dark color), `ClinicSheetGrid.test.tsx` (cross-day Rest Day move, the rest-day mark, Vacation drop kept), `CalendarPlaceholder.test.tsx` (team scope, settings scope, failed load with reload), `src/lib/date.test.ts` (`formatWeekdayDate`, English month label), `MonthNavigator.test.tsx` (month and week texts), `MyPlanView.shortcuts.test.tsx` (person picker, listbox/menu/textbox focus, the date picker; N still steps inside the shift detail), `src/pages/weekParam.test.ts` (parsing, rolled-over dates, address rewriting, `replaceState` and no `pushState`, the enabled gate), `HelpView.test.tsx`.

**E2E Tests** (CI specs, mocked API):
- [x] `agent-apply.spec.ts`: a PDF export from a mid-week date starts on its Monday and names the weeks it contains; Cancel stops a combined export at once (no counter that never moves); Cancel stops individual files and reports how many were downloaded
- [x] `holiday-region.spec.ts`: loading another state's holidays asks before it removes the shifts that no longer fit (cancel keeps everything, confirm backs up with reason `holiday_change`); removed shifts stay removed when the holiday comes back; the screen waits while the backup is saved, so no other change is lost; holidays loaded while a removal waits for its answer are refused, not overwritten
- [x] `my-plan.spec.ts`: both plans wait for the calendar; My plan keeps its own day in the address (a reload brings back its month and day); a night across the March clock change counts its real 11 hours; Next up counts down in the plan's time zone with the browser in another zone
- [x] `team-page.spec.ts`: printed short names stand for one person of the team (landscape and portrait); team grid pills never show two people under one visible name (both layouts); a hand-placed rest day moves to another day and leaves when dragged out, an automatic one explains itself; a hand-placed rest day on an automatic one leaves it in place with the notice; a vacation day ends only when its pill leaves the calendar; a shift on a rest day after on-call duty in the week before is still flagged; the clinic sheet marks a shift on an automatic rest day; a hand-placed rest day next to a shift that day is a rule violation; the viewed week is kept in the address (reload, links, Today, invalid values); the team plan shows a loading card instead of the demo calendar and stops waiting when loading fails; shifts file import: nothing imported from a tab whose calendar changed elsewhere, a file without shifts for this calendar is refused before asking, duplicates and invalid entries are kept once / reported

**Manual checks**: download and feed compared event by event on the DST weeks 2026-03-23 and 2026-10-19; PDF of the demo plan in both layouts (every page complete, whole names in landscape, no images in the file); public page at 390 px.

---

## 4. Intentionally Not Covered

The following areas are explicitly excluded from automated testing:

1. **Visual styling** - Covered by manual review; snapshot tests avoided for maintainability
2. **PDF visual accuracy** - Only validates PDF generation, not pixel-perfect layout
3. **Real external API calls** - date.nager.at is never called; `e2e/holiday-region.spec.ts` mocks it and `src/lib/holidays.test.ts` uses its response shape
4. **Browser compatibility** - Playwright runs Chromium only; cross-browser testing is manual
5. **Performance benchmarks** - Not part of functional test suite
6. **Mobile touch interactions** - HTML5 drag-and-drop doesn't support mobile

---

## 5. Test Data & Fixtures

**Re-QA round (v1.78)**: backend `test_publication_lifecycle.py` (a removed person's link is revoked, not deleted; restoring a snapshot revives the links of the people it brings back; public week and iCal feeds drop stored entries with impossible dates without writing back), `test_ical.py` (file names with ø/ł); Vitest `stateSaveQueue.test.ts` (unchanged calendar, newest queued save, cleared on failure/retry), `personName.test.ts` (title kept when the bare name is another person's), `textSearch.test.ts` (ø = oe, å = aa), `AssignmentPill.test.tsx` (section look wraps the last level), `ClinicSheetGrid.test.tsx` (names wrap on screen), `IcalExportModal.test.tsx` (modal dialog, Escape, named per-person buttons, empty-download notice, "1 of 1 week"), `CalendarTransitionOverlay.test.tsx` (inert page, focus on Cancel, Escape), `ical.test.ts` (event counts), `MonthNavigator.test.tsx` (whole month marked), `ScheduleGrid.test.tsx` (no vacation hint when read-only, safe centering), `SettingsView.test.tsx` (valid date not marked), `useConfirmHolidayChange.test.tsx` (pending save failure message), `client.importBackup.test.ts` (422 detail); e2e `team-page.spec.ts` ("a hand-placed rest day is not moved onto a vacation day", vacation pill on header/label keeps its day) and the previously stale `colband-explosion.spec.ts`, `app.spec.ts`, `full-workflow.spec.ts`.

### Backend Fixtures (`backend/tests/conftest.py`)

```python
@pytest.fixture
def default_clinician() -> Clinician:
    """Single clinician with basic qualifications."""

@pytest.fixture
def default_state(default_clinician) -> AppState:
    """Minimal valid AppState with one clinician and one slot."""

@pytest.fixture
def state_with_deprecated_pools() -> AppState:
    """State containing Distribution and Reserve pools for migration testing."""

@pytest.fixture
def test_client() -> TestClient:
    """FastAPI test client with auth token."""
```

### Frontend Fixtures

Test utilities are imported from `@testing-library/react` and custom helpers in test files.

### E2E Fixtures (`e2e/fixtures.ts`)

- Extended Playwright test with diagnostics
- Automatic secret redaction
- Screenshot utilities
- Auth token helpers

---

## 6. CI Integration

Tests are designed to be CI-friendly:

- **Deterministic**: No reliance on real time or external services
- **Isolated**: Each test cleans up after itself
- **Fast**: Unit tests complete in seconds
- **Parallel-safe**: E2E tests use serial execution where needed

### CI Pipeline

The actual pipeline is [.github/workflows/ci-cd.yml](.github/workflows/ci-cd.yml):
backend `python -m pytest tests -q --ignore=tests/test_solver_benchmark.py`
(Python 3.11, from `backend/`); frontend on Node 22 with `npm run typecheck`,
`npm test`, `npm run build`, then the critical Playwright specs
(`e2e/agent-apply.spec.ts`, `e2e/agent-activity.spec.ts`,
`e2e/fixed-assignments.spec.ts`, `e2e/holiday-region.spec.ts`,
`e2e/model-settings.spec.ts`, `e2e/my-plan.spec.ts`, `e2e/team-page.spec.ts`)
against a local Vite dev
server with a mocked API (`page.route`; no backend needed). Run the same set
locally with `npx playwright test e2e/agent-apply.spec.ts
e2e/agent-activity.spec.ts e2e/fixed-assignments.spec.ts
e2e/holiday-region.spec.ts e2e/model-settings.spec.ts e2e/my-plan.spec.ts
e2e/team-page.spec.ts` while
`npm run dev -- --host 127.0.0.1 --port 5173` is running. The full E2E suite is not part of CI. Note that
`npm run test:e2e` forces `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=mac15-arm64` and
only works on Apple Silicon; elsewhere run `npx playwright test`.

---

## 7. Future Work

Areas identified for future test expansion:

1. **Template builder E2E tests** - More comprehensive slot placement scenarios
2. **Solver performance tests** - Benchmark large schedule solving
3. **Accessibility tests** - Verify WCAG compliance
4. **API contract tests** - OpenAPI schema validation

---

## 8. Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2026-01-03 | Claude | Initial test plan created |
| 2026-01-03 | Claude | Added pool removal regression tests |
| 2026-01-03 | Claude | Added iCal and web API tests |
| 2026-10-15 | Claude | v1.64: My plan / preferences, team page and background-run coverage; CI spec list |
| 2026-11-01 | Claude | v1.72 holidays by state (incl. `holiday-region` in the CI spec list); v1.73 named sections in stacked cells |
| 2026-11-01 | Claude | v1.74 (merge of the feature-branch "v1.71" work): My plan always opens in Team and relinks, import backup, holidays added by hand |
| 2026-11-01 | Claude | v1.75: hand-placed rest days block automatic planning (`REST_DAY`); Balanced on-call fairness follows the rest rule |
| 2026-11-02 | Claude | v1.76: stacked team week with one lane per section (no "+N", no in-cell section tag), three-column label with spanning row band / section cells; review round: overlap rule for time lanes, auto label tracks, own time as a note, phone labels name every lane |
| 2026-11-02 | Claude | v1.77: the My-plan loading card keeps the "Team | My plan" switch |
| 2026-11-02 | Claude | v1.78: QA fixes — timed iCal events in the plan's time zone (format switch per database, removed people's links, same-second caching, real DST durations in My plan), holiday changes confirmed with a backup, impossible dates rejected with 422, complete and fast PDFs with draft marker, Monday file names and Cancel, team-unique short names and accent-insensitive search, public page rest days / Times layout / phone day view, checked shifts file import and revision-safe backups (Load copy included), rest days by drag, loading card for all scopes, week in the address (§3.14) |
| 2026-11-02 | Claude | v1.78 re-QA round: soft-revoked personal iCal links revived on restore, public readers clean stored data, unchanged calendars not re-sent, modal Export dialog and progress overlay, rest day not moved onto vacation, vacation kept on header drops, names wrap instead of being cut, stale non-CI e2e specs updated |
