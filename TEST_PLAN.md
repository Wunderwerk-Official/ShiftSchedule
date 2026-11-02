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
- [x] My plan chosen by hand before the calendar has loaded shows "Loading calendar…" instead of calling the link stale, then the plan
- [x] Without a color the first location is blue (Auto); a picked color is saved with the calendar and colors the label shades and the band; Auto clears it (v1.71)
- [x] Phone: the scope switch leads to My plan and hides the planning panels

### 3.10 Team page regressions (v1.64)

**Frontend Tests**: `src/pages/resetSolverAssignments.test.ts` (Reset → Unlocked shifts / Unlocked shifts and rest days), `src/lib/assignmentPolicy.test.ts` (one lock, v1.69), `src/lib/openSlots.test.ts`, `src/components/ui/ConfirmDialog.test.tsx`, `src/App.test.tsx` (502/network keep the session), `src/lib/clinicianSlotOptions.test.ts`, `ScheduleGrid.test.tsx` / `ClinicSheetGrid.test.tsx` (drag and drop).

**E2E Tests** (`e2e/team-page.spec.ts`, mocked API, in CI):
- [x] Rule-violation and split-shift popover items can be clicked
- [x] Dragging into and out of the Vacation row adds and removes the vacation day
- [x] Phone: the open-slots badge switches the day view to the open slot's day
- [x] Template above the column limit: banner and no save, snapshot import refused, snapshot restore backs up the last saved calendar, sign-out asks first
- [x] Calendar snapshots wait until the calendar has loaded: Save and Restore are unavailable while the demo calendar is shown, and the snapshot saved afterwards holds the loaded calendar (v1.79)
- [x] Reset → Unlocked shifts and Unlocked shifts and rest days also remove planner entries on vacation days; both keep locked shifts, hand-placed ones included (v1.69)
- [x] Times switches between side-by-side and stacked columns and stores the choice (v1.65)
- [x] Stacked: a section that takes over a row band's slot on one day gets its own lane, named in the label (row band / section / time cells); the other lane is hatched that day; no in-cell section tag (v1.76)
- [x] Moving a planner shift by hand locks it (v1.69)
- [x] A locked shift moved into the Rest Day row becomes a plain rest day entry that Reset → Unlocked shifts and rest days removes (v1.69)
- [x] A shifts file import saves the calendar as shown as an auto-backup first; when the backup fails nothing is imported (v1.74)
- [x] Loading public holidays keeps the holidays added by hand (v1.74; the state filter is in `holiday-region.spec.ts`)

**Frontend Tests (v1.66 compact cells and portrait PDF)**: `ScheduleGrid.test.tsx` (no section block or name in stacked cells, tooltip, corner mark (replaced by a tag in v1.73, gone since v1.76) and +N badge (gone since v1.76), hatched days without a slot, section tints, hover-only fix button, fixed pill keeps it, "Open"), `AssignmentPill.test.tsx` (full name in the pill's tooltip), `IcalExportModal.test.tsx` (page layout choice), `src/pages/printPage.test.ts` (A4 portrait geometry), `PrintWeekPage.test.tsx` / `PrintWeeksPage.test.tsx` (portrait page rule, seven columns, margins), `src/api/client.pdf.test.ts` (layout reaches the request); backend `test_pdf_revision.py` (layout → orientation, viewport and print route).

**Frontend Tests (v1.73 named sections in stacked cells)**: superseded in v1.76 — lanes never mix sections, so there is no section tag; replaced by the v1.76 tests below.

**Frontend Tests (v1.76 stacked week: one row per section)**: `src/lib/stackedTeamLayout.test.ts` (`buildTimeLanes`: a slot that overlaps no free lane opens its own, however near its start; `buildSectionLanes`: lanes never mix sections — the user's rotating "IRM HK" row; a section's separate time blocks on different days (the user's IRM cardio HK: Mon/Thu 07:30, Wed 13:00 and 16:00) get a lane each with no differing time; sections by earliest start, then first slot in template column order, then name; a section's lanes by start even when a later day opened them; a weekend variant with another time stays in its section's lane; two slots of one section on a day get two lanes; sections by id, by name without one; `buildStackedTeamLayout`: a day of another section gets its own lane and color, a section named like its row band is titled when another section comes first, lane ids and order are the same whatever days are on screen, also when a hidden day or a holiday decides the order, row/section spans and first/last-in-section flags), `ScheduleGrid.test.tsx` (three label columns with spanning row band and section cells, header and pool row labels span them; divider levels lane / section / row on cells and label cells; single day keeps one label cell and names the section on every lane; no section tag in cells, own time as a quiet clock note under the people (no chip) and tooltip kept, no "+N"; section tints per lane label and cell; a later lane's section for screen readers and in its tooltip; location shade on every label cell), `HelpView.test.tsx` (stacked text), e2e `team-page.spec.ts` (see above).

**Frontend Tests (v1.77 team switch while loading)**: `CalendarPlaceholder.test.tsx` (the "Team | My plan" switch is usable while My plan waits for the calendar and reports "team"; busy status "Loading calendar…"; plain "My plan" label without initials; compact switch on phones).

**Frontend Tests (v1.79 snapshots wait for the calendar)**: `SnapshotPopover.test.tsx` (while the calendar loads, Save, Enter and Restore wait, with the hint in the panel and as the tooltip; Rename stays available; saving works once loaded), e2e `team-page.spec.ts` (see above).

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

### 3.14 Working hours overview (v1.78)

**Frontend Tests**:
- [x] `src/lib/workingHours.test.ts` — year weeks (partial ends, ISO labels incl. a year starting on Friday), a week counts from half of the team's target hours (fallback: any shift without contracts), target and tolerance scaled by vacation days, statuses, day details (minutes, shifts, rest days), running balance and totals over counted weeks, a vacation week without status
- [x] `WorkingHoursOverviewModal.test.tsx` — opens on this week; days with Rest / Vac, tooltips, planned, target with vacation note, difference with status, balance, team counts; sort most under first; a week that does not count yet explains why; week navigation across years; year view cells, hatched uncounted weeks, totals, Hours / Difference / Balance; a week header opens the week; Monday and Sunday stay in one week in three time zones; close button and Escape

### 3.15 Planning across days and weekly hours (v1.80)

**Backend Tests** (`backend/tests/test_cross_day_repair.py`; the case: a person with a 32 + 8 h cap and 27.5 h booked Mon–Wed, Thursday's 10 h slot and Friday's two 4 h slots of higher priority, nobody else qualified):
- [x] CP-SAT repair mode moves her hours from Thursday to Friday (one more required place) and keeps the best plan when nothing improves
- [x] The same-day rescue cannot fix it (no own placement of Friday blocks)
- [x] `coverage_repair` applies through the gate (2 → 1 open, 3 changes, fixed context unchanged, note text); a complete plan reports `complete`; an illegal solver answer is `rejected`; too little time is `no_time`
- [x] A day-by-day run (scripted model: Thursday gets the long slot) ends with the repaired plan, `cross_day_repair` applied and the note in the run notes
- [x] Batched `candidates` report `week_over_cap_hours` (1.5 h)
- [x] Direct strategy (arena): reply parsing (placements, removals, unparsed lines), one plan answer through the gate (3 proposed, 2 accepted, 1 dropped), digest with weekly hours (`W45 27.5/40`), the range target (`target 9.1±2.3`) and the legal people per open place; placements and removals in the model's order (scarce hours go where the model listed them first) with retry passes while a pass makes progress; every plan block read, fenced notes ignored; only answer text parsed, never reasoning; abort during the call applies nothing; a cut-off answer gets one more call; days left fillable count as model-incomplete and the arena flags their repair
- [x] Repair model = gate (review): a block across two sites with the same-site rule off and work at a site of a fixed two-site day stay in the repaired plan (both tests fail on the stricter model)
- [x] Section order binds the repair (v1.80): with COR as the top section the solver keeps Thursday's COR instead of trading it for two lower Friday slots, `coverage_repair` reports `no_improvement`, a day-by-day run keeps the top section; a gap moves between days of one section; running totals per tier from the top (`priority_trade_down`); a solver answer that trades down is `rejected` ("higher-ranked section left open", section COR); the three trade-down tests fail without `_add_priority_dominance`
- [x] Second review of the section order (v1.80): the tier is the section's first block, so with the Friday slots on a second COR block (listed after or before Thursday's) the solver and `coverage_repair` still move the gap inside the section (2 → 1 open), and a pre-v4 template normalized by `backend/state.py` (one block per sub-shift and day type) gives every slot of a section one tier above the next section; with as many positions filled either way the repair staffs the top section and leaves the lowest one open, although that takes 5 changes instead of 3 (`equal_coverage_state`); all three fail on the per-block tier or the old objective
- [x] Rest Day row entries (merge with v1.75): the repair never moves hours onto one (no variable that day), a reference placement without a variable is no change (solvable with no change allowed), the gate refuses work on it should a solution propose it (`rejected`, `REST_DAY`); the direct digest's legal people and the open-slot reasons leave the person out ("blocked by rest day 1"); `REST_DAY` ranks right after vacation and both rule tables stay in step (`test_agent_harness.py`)
- [x] Main reason with an absence (`test_agent_harness.py`): a person on vacation or a rest day counts as absent even when also over their weekly hours (main reason vacation / rest day, `blocked_by` still lists weekly hours, ties in the rule order); anyone not absent counts under every rule that blocks them (overlap 3, weekly hours 2 → overlap; fails when a person counts under the first rule only)
- [x] Why a slot stayed open (`test_agent_harness.py`): per open slot the qualified people, those already on it, the directly addable ones and the people each hard rule blocks (vacation 1, weekly hours 1 → main reason weekly hours by the fixed order; nobody qualified → `NO_QUALIFIED`, "nobody is qualified" / "no other qualified person (1 already on it)"), the run-log line, the slot, time and stop bounds
- [x] A finished run with open positions is not called stopped (`test_agent_workflow_safety.py`; also with `stopReason` "completed" and with "partial" for a day the model skipped that the repair completed): `unfinished_dates` empty, apply prompt "The planner finished, but 1 required position(s) remain open; the run log lists each one", `stopped: false`; a skipped day, an open day whose check ran out of time, and a run cut short by its budget keep "incomplete or was stopped" with the day in `unfinished_dates`; a CP-SAT result says "remain open in this draft", a calendar that changed since the run says so; a stored open slot the draft fills applies without the question
- [x] Day digest roster (`test_agent_tools.py`, `test_agent_harness.py`): booked/hard max of the day's ISO week per person (`8/40` with fixed Monday work before a Tuesday range, `4/-` without contract), equal to `_week_hours`; production row shape `…|ytd|0/45|soft work pattern…`; a day's digest includes the earlier days of the run (`0/-` Monday, `8/-` Tuesday); slot list and DAY_SYSTEM_PROMPT name the tools' single-candidate-first order
- [x] A run where the model placed nothing still falls back to the heuristic (`test_prompt_eval.py`); a day the model ended unplanned (`test_agent_workflow_safety.py`) or skipped after a provider failure (`test_agent_retry.py`, `test_agent_integration.py` through the endpoint) is filled by the repair before the final audit and still counts as skipped by the model (arena: invalid for comparison, `test_arena_claude.py`)

**Frontend Tests**: `src/lib/weeklyHours.test.ts` (ISO weeks as Python's `isocalendar`, counting on the start date, pool rows ignored, slot minutes as the gate counts them incl. slots without times = 08:00–16:00, cap contract + tolerance with 5 h default and explicit 0, over only above the cap, label), `src/lib/clinicianSlotOptions.test.ts` (over-limit flag and label, none for people without a contract or already in the slot), `ClinicianPickerPopover.test.tsx` ("Over weekly limit (…)" shown, sorted after people without warnings), `src/lib/solverOutcome.test.ts` (banner reasons most frequent first whatever the input order, ties in the backend rule order incl. `REST_DAY` before overlaps, no top-N cut, "a qualified person is still free", "for 1 of 2 slots", "The run ended early." / "ended before it checked" instead of blaming rules; run card "Finished with open positions" only when nothing is unfinished, the incomplete wording for unfinished, aborted and older runs, nothing for applied or discarded runs; the run-details state "stopped" / "stopped early: …" from the stop reason and the run's status, "finished" for a partial run with no day left, "not started: this account's AI budget is used up" with 0 iterations; `runStoppedEarly` / `runEndedEarly` without the partial stop; the toast "Run stopped early - …" for budget, provider, error and refusal stops; the banner lead "are still open" for an unfinished day or a slot someone could still take), `SolverInfoModal.test.tsx` (the rendered run-card line; the rendered "Run:" line for a repaired skipped day, a Stop during the closing report, a budget stop and an unstarted run), `HelpView.test.tsx` (the repair's promise and the weekly-limit example); `e2e/team-page.spec.ts` stacked labels poll (stable 6 of 6 locally; main's v1.79 has the same fix and also waits for the mocked calendar).

### 3.16 Strict section order for the AI planner (v1.81)

**Backend Tests**:
- [x] `test_cross_day_repair.py`: Pat (8 h a week) on two lower 4 h slots and the top section's 8 h slot open: the repair moves Pat to the top slot (1 -> 2 open, report section TOP, note "staffed TOP first … the section order comes before the count"); freed hours (Sam takes Pat's Monday) go to the top slot although two lower slots would fill one more position (3 -> 2 open, vector [0, 2, 0]); a pure 1:1 upward trade is applied (1 -> 1 open); one vector entry per section (two blocks of COR share one) that sums to the open count; `first_difference`; the v1.80 tests (top section kept, gap within one section and across two blocks of one section, staffing the top at equal coverage) hold with the staged search
- [x] `test_agent_planning_workflow.py`: in both profiles `suggest_day_blocks` lists first the candidate whose block leaves the better section vector (P also fills B; Q fills two C slots); `suggest_rescue_moves` moves Alice from B up to A without a substitute (2 moves, `leaves_open`, vector [0, 1, 0]); the shallow-rescue and paginated fixtures rank the stuck section lowest and still find no rescue
- [x] `test_agent_tools.py`: processing order ranks one section once (`section_rank` 3, 2, 1, 1; the earlier start of section A first)
- [x] `test_agent_quality_profile.py`: classic tuple of 7 fields starting `hard_violations_in_range, open_by_section_order, open_required_slots`; `QUALITY_VERSION` 4 in the overview

**Frontend Tests**: `HelpView.test.tsx` (the strict rule in section 3); the Settings help (`SECTION_PRIORITY_HELP`), the Planning goals text, "How the agent plans" and the basic-plan notice name the strict order; `test_cross_day_repair.py` pins the repair notes with the changed sections ("2 -> 1 open; SENO 1 -> 0, ECHO 1 -> 0, COR 0 -> 1"; "to staff higher sections first (1 -> 2 open; TOP 1 -> 0, LOW 0 -> 2)").

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
| 2026-11-02 | Claude | v1.79: Calendar snapshots wait until the calendar has loaded; team-page e2e waits for the mocked calendar, not the demo grid |
| 2026-11-02 | Claude | v1.80 (merged onto v1.74–v1.79; the branch called it v1.74, later v1.79): cross-day coverage repair with the section order binding, weekly hours in the picker, direct strategy (arena), why a slot stayed open; `REST_DAY` among the blocking reasons; stop texts follow the run's status |
| 2026-11-02 | Claude | v1.81: strict section order for the AI planner (quality tuple `open_by_section_order`, QUALITY_VERSION 4; staged lexicographic cross-day repair; section rank in the day loop) |
