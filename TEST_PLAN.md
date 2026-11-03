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
- [x] Section order binds the repair (v1.80): with COR as the top section the solver keeps Thursday's COR instead of trading it for two lower Friday slots, `coverage_repair` reports `no_improvement`, a day-by-day run keeps the top section; a gap moves between days of one section; running totals per tier from the top (`priority_trade_down`); a solver answer that trades down is `rejected` ("higher-ranked section left open", section COR); the three trade-down tests fail without `_add_priority_dominance` (v1.82: `priority_trade_down` and `_add_priority_dominance` were removed; the gate's section vector and the staged search replace them; the trade-down refusal is `test_coverage_repair_refuses_a_trade_down_from_the_solver`, the running-total test became `test_first_difference_finds_the_deciding_section`; see 3.17)
- [x] Second review of the section order (v1.80): the tier is the section's first block, so with the Friday slots on a second COR block (listed after or before Thursday's) the solver and `coverage_repair` still move the gap inside the section (2 → 1 open), and a pre-v4 template normalized by `backend/state.py` (one block per sub-shift and day type) gives every slot of a section one tier above the next section; with as many positions filled either way the repair staffs the top section and leaves the lowest one open, although that takes 5 changes instead of 3 (`equal_coverage_state`); all three fail on the per-block tier or the old objective
- [x] Rest Day row entries (merge with v1.75): the repair never moves hours onto one (no variable that day), a reference placement without a variable is no change (solvable with no change allowed), the gate refuses work on it should a solution propose it (`rejected`, `REST_DAY`); the direct digest's legal people and the open-slot reasons leave the person out ("blocked by rest day 1"); `REST_DAY` ranks right after vacation and both rule tables stay in step (`test_agent_harness.py`)
- [x] Main reason with an absence (`test_agent_harness.py`): a person on vacation or a rest day counts as absent even when also over their weekly hours (main reason vacation / rest day, `blocked_by` still lists weekly hours, ties in the rule order); anyone not absent counts under every rule that blocks them (overlap 3, weekly hours 2 → overlap; fails when a person counts under the first rule only)
- [x] Why a slot stayed open (`test_agent_harness.py`): per open slot the qualified people, those already on it, the directly addable ones and the people each hard rule blocks (vacation 1, weekly hours 1 → main reason weekly hours by the fixed order; nobody qualified → `NO_QUALIFIED`, "nobody is qualified" / "no other qualified person (1 already on it)"), the run-log line, the slot, time and stop bounds
- [x] A finished run with open positions is not called stopped (`test_agent_workflow_safety.py`; also with `stopReason` "completed" and with "partial" for a day the model skipped that the repair completed): `unfinished_dates` empty, apply prompt "The planner finished, but 1 required position(s) remain open; the run log lists each one", `stopped: false`; a skipped day, an open day whose check ran out of time, and a run cut short by its budget keep "incomplete or was stopped" with the day in `unfinished_dates`; a CP-SAT result says "remain open in this draft", a calendar that changed since the run says so; a stored open slot the draft fills applies without the question
- [x] Day digest roster (`test_agent_tools.py`, `test_agent_harness.py`): booked/hard max of the day's ISO week per person (`8/40` with fixed Monday work before a Tuesday range, `4/-` without contract), equal to `_week_hours`; production row shape `…|ytd|0/45|soft work pattern…`; a day's digest includes the earlier days of the run (`0/-` Monday, `8/-` Tuesday); slot list and DAY_SYSTEM_PROMPT name the tools' single-candidate-first order
- [x] A run where the model placed nothing still falls back to the heuristic (`test_prompt_eval.py`); a day the model ended unplanned (`test_agent_workflow_safety.py`) or skipped after a provider failure (`test_agent_retry.py`, `test_agent_integration.py` through the endpoint) is filled by the repair before the final audit and still counts as skipped by the model (arena: invalid for comparison, `test_arena_claude.py`)

**Frontend Tests**: `src/lib/weeklyHours.test.ts` (ISO weeks as Python's `isocalendar`, counting on the start date, pool rows ignored, slot minutes as the gate counts them incl. slots without times = 08:00–16:00, cap contract + tolerance with 5 h default and explicit 0, over only above the cap, label), `src/lib/clinicianSlotOptions.test.ts` (over-limit flag and label, none for people without a contract or already in the slot), `ClinicianPickerPopover.test.tsx` ("Over weekly limit (…)" shown, sorted after people without warnings), `src/lib/solverOutcome.test.ts` (banner reasons most frequent first whatever the input order, ties in the backend rule order incl. `REST_DAY` before overlaps, no top-N cut, "a qualified person is still free", "for 1 of 2 slots", "The run ended early." / "ended before it checked" instead of blaming rules; run card "Finished with open positions" only when nothing is unfinished, the incomplete wording for unfinished, aborted and older runs, nothing for applied or discarded runs; the run-details state "stopped" / "stopped early: …" from the stop reason and the run's status, "finished" for a partial run with no day left, "not started: this account's AI budget is used up" with 0 iterations; `runStoppedEarly` / `runEndedEarly` without the partial stop; the toast "Run stopped early - …" for budget, provider, error and refusal stops; the banner lead "are still open" for an unfinished day or a slot someone could still take), `SolverInfoModal.test.tsx` (the rendered run-card line; the rendered "Run:" line for a repaired skipped day, a Stop during the closing report, a budget stop and an unstarted run), `HelpView.test.tsx` (the repair's promise and the weekly-limit example; v1.82 replaced the promise by the strict rule, see 3.17); `e2e/team-page.spec.ts` stacked labels poll (stable 6 of 6 locally; main's v1.79 has the same fix and also waits for the mocked calendar).

### 3.16 Swap assistant (v1.81)

**Backend Tests** (`backend/tests/`; fixtures `make_swap_state`, `asg` and `rich_swap_state` in `swap_fixtures.py`):
- [x] `test_validation_context.py` — `validate_assignments` and every single validator give the same violations with a precomputed `ValidationContext` (arena fixture and 50 seeded subsets of a chained plan, with and without `skip_references` / `only_fill_required`); a context built for another state raises
- [x] `test_constraint_policy.py` — `new_violations` equals `run_apply._new_violations`; `classify_violations` splits new and carried violations; `baseline_violations=` skips revalidating the baseline; `resolved_violations` lists what a revert brings back (gone or eased, never worse)
- [x] `test_swap_blocks.py` — work blocks (touching shifts merge, a night with its morning handover, Whole day), items that are no unit (vacation-hidden, pool row, untimed slot), fingerprints, unit kind, the minute axis past 9999-12-31; fixture self-tests (normalization and a save/load round trip keep every slot and assignment)
- [x] `test_swap_worktime.py` — rest under 11 h (only new ones), night without a free day, stretch over 24 h, week hours equal to the weekly-hours rule (vacation-hidden shifts counted), custom rules; the year-to-date deficit counts from the first planned date of the year (unknown under a week of history; pool rows and last year ignored; vacation credited inside the window; clamped) and equals the solver's formula on the arena fixture, which is planned from 1 January
- [x] `test_swap_policy.py` — calendar time zone around DST, started and the 48 h notice boundary, swap settings defaults and fallbacks, open-slot detection (overrides, hidden holders, inactive days)
- [x] `test_swap_matching.py` — prefilter and gate reasons with their exact messages (also an overlap whose two shifts are both received), groups and ranking, caps, totals and closest options, the partner / range / same-type filters, started shifts, every finding, rest-day moves and removals (D7), pre-existing checks (D12), people without contract hours (D13), blocked targets, the baseline cache, `truncated`; `targetFindings`: a contracted giver's handover note per touched week, equal to the giver's hours card in every option on `rich_swap_state`, while the options stay best matches, and empty for swap, cover and blocked targets; year-to-date ranking of a calendar started in November; a handover search in a fresh process never imports `backend.solver` or ortools; a clash with a vacation-hidden shift (on-call, a rest day's shift, an overlap) names it and says to find cover first; readable reasons for unresolved references; on-call rest days reaching into the next ISO week block; the warnings of a stretch longer than the slice window (starting before it, ending after it, with no free day after it, kept) equal the calendar's in id and text; the slice window stays inside the date range
- [x] `test_swap_property.py` — the two-person slice gives the same verdict as the full calendar (and the same warnings by id and text, the kept warnings of its window, pre-existing checks and solver-rule hits) on the arena fixture, a chained plan, `rich_swap_state` and `wide_swap_state`: 200 swap/hand-over cases (seeds 7 and 11) and 60 cover cases per dataset, with non-vacuity counts; `wide_swap_state` must produce an on-call rest conflict two or more days outside the moved weeks (seven rest days after an on-call), an overfilled cover, a valid Whole-day unit, a stretch starting before the window (new and kept) and a night block ending after it, so a margin under 7 days, a cover slice without co-holders or a cut block fails it; the whole file runs in under 20 s
- [x] `test_swap_endpoints.py` — `POST /v1/swaps/candidates`, `/apply`, `/{id}/undo` and `GET /v1/swaps/history`: swap, hand-over with a rest-day move and removal, cover with the hidden removal, `targetFindings` in all three modes; every refusal (`state_changed`, `swap_stale`, `swap_started`, `notice_override_required`, `consent_required`, `swap_invalid`, `plan_invalid`, `warnings_unacknowledged`, `undo_conflict`, `already_reverted`, `swap_not_found`, 422), with a `swap_invalid` reason that names both shifts of an overlap the partner would receive; stored rows, events and change-log kinds; undo may bring back what the swap resolved (a cover's removed vacation-hidden shift, an eased weekly overload) but nothing worse, and its refusal has its own prefix; history paging; account deletion; a run apply after a swap; crafted applies (two sides sharing a slot, an undetected or reversed Rest Day move, a hidden removal of anyone but the first hidden holder, a full slot, a partner in the slot, a holder now on vacation) are refused and leave the calendar and the swap tables untouched; undo never leaves someone with a Rest Day and a shift on one day (also after a cover by the freed giver), unless both were there before the swap; a swap whose giver, partner or hidden holder was deleted shows why in History and is refused; a second account never sees or undoes the swaps, and the store reads and changes only the caller's rows; request dates outside 1900–2999 are a 422; shifts saved near 9999-12-31 never break a search, apply or undo; a stretch longer than the search window is acknowledged once

**Frontend Tests**:
- [x] `src/lib/swaps/format.test.ts` — every text helper (the apply and undo toasts with full names, History's Undo button names), the apply request of all three modes, the preview outline stylesheet, the drawer key
- [x] `src/lib/swaps/reveal.test.ts` — `nearestScrollDelta` follows the CSSOM View "nearest" rule: no scroll for a span inside the window or one larger than it on both sides; otherwise the edge it sticks out on (the other edge for a span larger than the window); the pill and sheet-name cases from the e2e tests
- [x] `src/api/client.swaps.test.ts` — JSON answers, `SwapApiError` (code, message, `revision` / `warnings` / `reasons`), string details, 401, paths and bodies; `src/lib/stateSaveQueue.test.ts` — `currentRevision()`
- [x] `src/pages/swapFlow.test.ts` — a search syncs first (a failed save blocks it; `state_changed` reloads and searches again only when the screen is unchanged) and reports whether it reloaded; apply and undo run pause → sync → send → hydrate → resume, where sync saves only unsaved edits or an unknown revision (a clean screen lets queued saves land and sends their revision, a failed one blocks the apply), refuse while busy, reload after a conflict (rethrown with `detail.reloaded`, so the text says whether it worked) and always resume
- [x] `src/components/swaps/SwapAssistantDrawer.test.tsx` — search on mount and per filter change but never on a re-render, summary, groups, live region, blocked target, save errors, a hand-over's target notes (once under the summary and beside the preview's checks, never in swap mode), the preview (checks, warnings, notice, consent, approver name, Rest Day moves with full names) and its apply request, refused applies (the list is said to be refreshed, or the calendar reloaded, only once it was; the apply waits for the new search; a failed new search or Refresh returns to the list with its error; the notice override uses the server's hours), an edit during a search marks its answer stale, Search again shows the progress instead of the old error, a blocked Whole day keeps its toggle, Preview buttons described by their option's line, focus kept in the drawer when it disables or removes the focused control (busy or refused apply, History Undo, Refresh, Search again, phone sheet and desktop drawer swapping places) but never pulled back after a press outside, the phone sheet and Escape (also after a click on the drawer's text), its Tab trap also from a History row after the last control, history with Undo, the preview outline
- [x] `AssignmentPill.test.tsx`, `ScheduleGrid.test.tsx`, `ClinicSheetGrid.test.tsx`, `ClinicianPickerPopover.test.tsx` — the ⇄ button (editable class pills only, S key, touch room) and "Find cover…" in the person list; `ShiftDetail.test.tsx`, `MyPlanView.flows.test.tsx` — "Find swap" in My plan; `HelpView.test.tsx` — "13. Find a swap"

**E2E Tests** (`e2e/swap-assistant.spec.ts`, mocked API, in CI; like the server, the mock keeps one calendar, refuses a save, search, apply or undo against an older revision with `state_changed`, applies and undoes swaps on the calendar it holds, and lists an undone swap as undone):
- [x] Find a swap from a pill and apply it against the revision of the calendar the page last saved; the partner's pill and the toast; the next autosave saves the swapped calendar under the applied revision; Undo from the toast, after which the autosave saves the restored calendar; no save is refused and no save banner shows
- [x] S on a pill's lock opens the drawer with focus on its heading; Escape returns focus to the lock
- [x] A refused apply (`swap_invalid`) shows its reasons, keeps the drawer open and searches again; focus stays in the drawer, so Escape closes it
- [x] A refused apply (`swap_stale`) of an option far down the list whose new search drops it: the list comes back from the top, and its message is focused and fully in view
- [x] With nothing unsaved, another tab's save refuses the apply itself (`state_changed`): no save first, the calendar reloads, the list is searched again with the preview kept and no save banner; the next apply goes through
- [x] Saving before a search or an apply (fake page clock): a clean screen searches against its saved revision and saves nothing; an edit inside the autosave's 500 ms window is saved before the search, which names that save's revision; a lock toggled just before "Swap shifts" is saved first, the apply names that save, and the toggle survives the apply on the server and on screen
- [x] Opening the Vacation Planner, Working Hours or Export closes the drawer first, so nothing covers the modal
- [x] Reveal on hover: in the clinic sheet a partner's name that shows stays put (even with its cell cut off) and one under the sticky row labels is scrolled out to their right; at 900 px, where the drawer overlays the grid, the partner's pill is scrolled out from under it and the grid keeps its layout; in a 320 px high window (fake page clock) an option's reveal that needs only the window to scroll comes while the previous option's sideways scroll still runs and stops it, so its name ends in view, not under the drawer; also with CI's browser (Playwright 1.57's headless Chromium 143), whose scrollIntoView with "nearest" does not scroll at all for a shift whose own box already lies inside the grid's scroll box, so scroll margins have no effect there and Reveal computes its offsets itself
- [x] "Find cover…" in an open slot's person list searches for cover; the TopBar "Swap history" button opens and closes the history; Undo in the history moves focus to its row once the Undo is gone, so Escape closes the drawer
- [x] Phone: hand over in the sheet; after an Undo in the history (focus on the row, after the sheet's last control) Tab and Shift+Tab stay in the sheet
- [x] Touch screen (`hover: none`): on pills and clinic sheet names the ⇄ button sits left of the lock and right of the name; tapping ⇄ opens the drawer, tapping the lock only toggles it

**Merged with v1.72–v1.80** (main's `REST_DAY` rule, the stacked team week, My plan, the Working Hours dialog, waiting for the calendar, weekly hours in the picker):
- [x] `test_validation_context.py` — the context holds the calendar's Rest Days; results are identical with and without a context also for lists that add or drop Rest Day entries, in both `own_rest_days` modes (which differ on some list); `test_rest_days_come_from_the_calendar_and_the_checked_list`
- [x] `test_swap_matching.py` — a Rest Day the plan moves or removes no longer counts (slice, full gate and search; four shapes); every duplicate of the taker's Rest Day is removed, and a moved Rest Day takes every duplicate of the giver's; no Rest Day follows a night onto a shift the taker holds (hidden by a vacation, untimed); a shift on a Rest Day the plan keeps is blocked with "Rest Day: Ben Ott has a Rest Day on Thu 8 Jan."; a pair that existed before is carried over (pre-existing `rest_day`, its check line right after vacation); a cover's slice sees a co-holder's Rest Day; a search reads the calendar's Rest Days once; a partner whose Rest Day the option removes comes after free partners, as a possible match with the note "Ben Ott has a Rest Day on Thu 8 Jan; it will be removed." (one per person and day, in a swap one for each person who loses one)
- [x] `test_swap_endpoints.py` — a swap that frees the partner's Rest Day applies and undoes (moved, or unticked and so removed); a hand-over removes every duplicate of the taker's Rest Day, or moves every duplicate of the giver's, and undo restores them right away (`canUndo` true in History); undo brings back a Rest Day the swap took from a day its holder worked, but refuses a new pair (also onto a vacation-hidden shift) with "Undo would give …", in History and at the endpoint alike; a shift on a Rest Day the swap keeps is a readable `swap_invalid`; History and undo follow a restored snapshot
- [x] `test_swap_property.py` — fifth dataset `rest_swap_state` (pairs that already exist, duplicate Rest Days, a vacation-hidden shift on the day after a night, a cover co-holder who rests that day): the search's plans never break `REST_DAY`, also with their moves unticked; with removals withheld, slice and calendar agree; a moved Rest Day leaves its giver none, duplicates included; a counter for each shape
- [x] `test_swap_policy.py` — the check list has "No new shift on a Rest Day"
- [x] `SwapAssistantDrawer.test.tsx` — partner avatars use the team grid's person colors (light and dark); once the first answer is in, the target's pill (a cover's cell) is revealed, only once, and an option's shift revealed first takes over; `format.test.ts` — `targetRevealKey`; `HelpView.test.tsx` — the "Rest Day removed" note
- [x] E2E: Find swap on a My plan shift (linked account) opens the drawer over the team week at that date, searches that assignment and outlines its pill; Escape focuses the pill's ⇄
- [x] E2E: an edit inside the autosave window is saved once (its own autosave does not save it again) and searched once
- [x] E2E: drawer beside a narrow stacked week (1100 px): the grid ends left of the drawer, the row band and section labels keep whole words, the target and the hovered option's shift are outlined, and Reveal scrolls the week sideways to a Sunday shift; the Sunday shift whose ⇄, or the open Sunday cell whose "Find cover…", opened the drawer is revealed beside it
- [x] E2E: drawer over a narrow week (700 px, below lg): the stacked labels keep their widths, and Reveal brings a Sunday shift fully out from under the drawer
- [x] E2E: Working Hours, a dialog itself since v1.78, still closes the drawer before it opens (the test finds the drawer by its name, "Find a swap")
- [x] E2E: the swap assistant waits until the calendar has loaded: while the demo calendar is shown, "Find cover…", ⇄ and S (on a pill added to the demo calendar) only show the toast "Swaps are available once the calendar has loaded.", "Swap history" is disabled with that tooltip, and nothing is saved or sent to `/v1/swaps`; once the mocked calendar is in, ⇄ opens the drawer and searches. `openCalendar` waits for the mocked calendar, not the demo grid (as in `team-page.spec.ts`)
- [x] `SwapHistoryButton.test.tsx` — disabled, with the reason as its tooltip, while the calendar loads; enabled, with the title "Swap history", and calls its handler once it has loaded
- [x] `test_weekly_hours_crosscheck.py` — on `src/lib/weeklyHours.crossCheck.json` (a slot without times, nights on Sundays, a vacation-hidden shift, Vacation-row and Rest Day entries, no tolerance, no contract, a week ending exactly at its limit, 2026-W53 across the new year, quarter hours: an Early shift 07:45–16:00 and a 19.25 h contract): saving keeps every slot, assignment and hours field; for every person-week the hours card (`week_minutes`, `person_hours`) and `validate_weekly_hours` give the file's total and limit; a cover search on an open Friday and on a Saturday open because its holder is on vacation blocks exactly the people the file marks over the limit, with the reason "week N would reach … h (limit … h)" in the hours the file says the picker prints too (32.3 h for 1935 minutes, limit 24.3 h for 1455), and offers everyone else with the file's hours card (fails when the hours card leaves out vacation-hidden shifts, keys weeks by calendar year or drops the tolerance, when stored people get no default tolerance, when the gate checks only the moved dates instead of whole weeks, or when the reason rounds an exact half to even, 32.2 h)
- [x] `src/lib/weeklyHours.crossCheck.test.ts` — the person picker on the same file: every person-week's total and limit, and for both covers exactly those people marked "Over weekly limit (after/limit h in week)", in the file's printed hours ("32.3/30 h", "32/24.3 h"), and all others listed as free; the vacation-hidden holder shows On vacation (fails when a slot without times counts 0, the default tolerance is 0, the ISO week takes the calendar year, the picker stops marking, or its label rounds 32.25 h down)
- [x] `test_swap_worktime.py` `test_label_hours_round_an_exact_half_up_like_the_browser` — the drawer's texts print 1935 minutes as 32.3 h, a 24.25 h limit as 24.3 h and "+0.3 h over contract" for 15 minutes over (fails with Python's half-to-even rounding: 32.2 h, "+0.2 h"); `format.test.ts` — the hours card writes "Week 47: 24.3 → 32.3 h (limit 24.3 h)" and 1929 minutes as 32.2 h, as the picker does (fails with `toFixed` alone: 32.1 h)
- [x] E2E: "Find cover…" stays in view below a long list of people over the weekly limit (26 people): the list scrolls, the footer stays inside the picker, in the window and on top; Tab walks every person, then reaches it and Enter searches; each name keeps more than 100 px and a long warning starts below its name (fails with main's row layout, 17 px; without the row's wrap, warning beside the name; and with the footer inside the list)

### 3.17 Strict section order for the AI planner (v1.82)

**Backend Tests**:
- [x] `test_cross_day_repair.py`: Pat (8 h a week) on two lower 4 h slots and the top section's 8 h slot open: the repair moves Pat to the top slot (1 -> 2 open, report section TOP, note "changed 3 assignment(s) across days to staff higher sections first (1 -> 2 open; TOP 1 -> 0, LOW 0 -> 2)"); freed hours (Sam takes Pat's Monday) go to the top slot although two lower slots would fill one more position (3 -> 2 open, vector [0, 2, 0]); a pure 1:1 upward trade is applied (1 -> 1 open); one vector entry per section (two blocks of COR share one) that sums to the open count; `first_difference`; the v1.80 tests (top section kept, gap within one section and across two blocks of one section, staffing the top at equal coverage) hold with the staged search
- [x] `test_agent_planning_workflow.py`: in both profiles `suggest_day_blocks` lists first the candidate whose block also reaches an open slot of a section above the selected one (P reaches A from X; Q's longer block would be first otherwise); classic candidates whose blocks reach only lower sections keep the v1.80 order (Q's 6 h block before P's 4 h block; fails when every reached section ranks first); `suggest_rescue_moves` moves Alice from B up to A without a substitute (2 moves, `leaves_open`, vector [0, 1, 0]); the shallow-rescue and paginated fixtures rank the stuck section lowest and still find no rescue
- [x] `test_agent_tools.py`: processing order ranks one section once (`section_rank` 3, 2, 1, 1; the earlier start of section A first)
- [x] `test_agent_quality_profile.py`: classic tuple of 7 fields starting `hard_violations_in_range, open_by_section_order, open_required_slots`; `QUALITY_VERSION` 4 in the overview

- [x] Review of the staged search (`test_cross_day_repair.py`): 20 sections needing 40 people each need three windows; at 10 s the top window still gets its time and Pat moves to the top section (fails on the per-tier time split); exact weights by brute force over 200 random groups and the 2**53 window bound; a stage hanging until StopSearch ends on cancel within 3 s (ABORTED); a model with no plan in any stage reports INFEASIBLE; the note for an unchanged vector says so
- [x] Review of the tools (`test_agent_harness.py`, `test_agent_quality_profile.py`, `test_agent_planning_workflow.py`): the day digest shows `|rank 1` and "SECTION ORDER: …", debugInfo carries `section_order`; the improvement note names the changed sections (at most five, "and N more"); `encode_quality` leaves the vector out; the balanced tuple starts hard, vector, count, uncomfortable days (12 fields); the overview carries the legend; in distribute-all mode the rescue moves Alice off a slot above its target without `leaves_open`
- [x] Second review (`test_agent_planning_workflow.py`, `test_agent_harness.py`): S > W > V > ON with on-call last and Quinn the only substitute for both stuck slots: the rescue for S comes first and the final audit leaves only ON open ([0, 0, 0, 1], one repair; the on-call-first order gave [0, 0, 1, 0]); in distribute-all mode moving Alice to A without a substitute (B stays at its target) is offered next to Cara's substitute rescue and comes first (fewer short days), and the audit applies it; with B over its capacity Cara's substitute rescue fails the apply check and no longer hides Alice's move (one repair, [0, 0]); the closing report and the review digest list Thursday's and Friday's TOP gaps before Monday-Wednesday's 12 LOW gaps; `test_cross_day_repair.py` with a recording CP-SAT stand-in: at 30 s the first of three windows may use 25 s and more (the equal split gave 9 s), the stages run with one presolve round, the completion solve with CP-SAT's default. Each fails on the code before
- [x] Review of the planner (`test_agent_planning_workflow.py`): A > B > C with S (A) open, Cara (A, B) on B1, Eve (A, C) on C1 and Finn (C) free: the only rescue is Eve to S with Finn on C1 (vector [0, 0, 0]), also with Dan (A, B) on B2, whose upward 2-move used to crowd it out; the final audit applies it; with A's blocks apart in the template (A-mon, B-tue, A-tue) `next_fillable_slot` names A-tue and the final audit gives [0, 2], not [1, 0]; inside one section Quinn (YTD 0 %, a shorter block meeting her minimum) comes before Pat's longer block (YTD 140 %). The first three fail on the previous tools code, the fairness test on the vector-first candidate sort; two upward moves to S (A): Dan's, which opens C1 (rank 3), comes before Cara's, which opens B1 (rank 2), and the final audit gives [0, 0, 1] (fails with the clinician order)

**Frontend Tests**: `HelpView.test.tsx` (the strict rule in section 3); `WeeklyTemplateBuilder.test.tsx` (`SECTION_PRIORITY_HELP`: "even if that leaves more slots open in total", a section counts at its first place), `SettingsView.test.tsx` (Planning goals: "strictly in the section priority order below"), `SolverInfoModal.test.tsx` ("How the agent plans": higher sections first, on-call at its place in that list, even if more slots stay open), `solverOutcome.test.ts` (the basic plan "does not follow the section priority"), `AutomatedPlanningPanel.test.tsx` (the section priority decides, on-call at its place); `test_cross_day_repair.py` pins the repair notes with the changed sections ("2 -> 1 open; SENO 1 -> 0, ECHO 1 -> 0, COR 0 -> 1"; "to staff higher sections first (1 -> 2 open; TOP 1 -> 0, LOW 0 -> 2)").

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
`e2e/model-settings.spec.ts`, `e2e/my-plan.spec.ts`, `e2e/team-page.spec.ts`,
`e2e/swap-assistant.spec.ts`) against a local Vite dev server with a mocked
API (`page.route`; no backend needed). Run the same set locally with
`npx playwright test e2e/agent-apply.spec.ts e2e/agent-activity.spec.ts
e2e/fixed-assignments.spec.ts e2e/holiday-region.spec.ts
e2e/model-settings.spec.ts e2e/my-plan.spec.ts e2e/team-page.spec.ts
e2e/swap-assistant.spec.ts` while
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
| 2026-11-02 | Claude | v1.78: working hours overview with a week view, a compact year view and fair targets (weeks counted from half of the team's target hours, vacation-scaled targets) |
| 2026-11-02 | Claude | v1.79: Calendar snapshots wait until the calendar has loaded; team-page e2e waits for the mocked calendar, not the demo grid |
| 2026-11-02 | Claude | v1.80 (merged onto v1.74–v1.79; the branch called it v1.74, later v1.79): cross-day coverage repair with the section order binding, weekly hours in the picker, direct strategy (arena), why a slot stayed open; `REST_DAY` among the blocking reasons; stop texts follow the run's status |
| 2026-11-02 | Claude | v1.81 (the branch called it v1.71, later v1.78 and v1.80): swap assistant (incl. `swap-assistant` in the CI spec list), merged with v1.72–v1.80: `REST_DAY` in the swap gates and undo, the "Rest Day removed" note, stacked week and My plan wiring, swaps wait until the calendar has loaded; one weekly-hours rule for the picker, the hours card, the cover search and the gate (one shared calendar), the drawer's hours round an exact half up like the picker, picker names keep their room next to a long warning; Reveal on hover computes its scroll offsets, since CI's headless Chromium 143 does not scroll a shift already inside the grid's scroll box into view with scroll margins (scrollIntoView "nearest") |
| 2026-11-02 | Claude | v1.82: strict section order for the AI planner (quality tuple `open_by_section_order`, QUALITY_VERSION 4; staged lexicographic cross-day repair; section rank in the day loop) |
