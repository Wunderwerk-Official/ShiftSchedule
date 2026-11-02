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
- [x] `TeamPlanHeader.test.tsx`, `LocationColorPicker.test.tsx`

**E2E Tests** (`e2e/my-plan.spec.ts`, mocked API, in CI):
- [x] Link yourself, change views, jump back into the team plan
- [x] My plan as start page; the team pills carry person colors (no "Color by" switch since v1.69)
- [x] A location color is saved with the calendar and tints the team rows
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
- [x] Moving a planner shift by hand locks it (v1.69)
- [x] A locked shift moved into the Rest Day row becomes a plain rest day entry that Reset → Unlocked shifts and rest days removes (v1.69)

**Frontend Tests (v1.66 compact cells and portrait PDF)**: `ScheduleGrid.test.tsx` (no section block or name in stacked cells, tooltip, +N badge, corner mark, hatched days without a slot, section tints, hover-only fix button, fixed pill keeps it, "Open"), `AssignmentPill.test.tsx` (full name in the pill's tooltip), `IcalExportModal.test.tsx` (page layout choice), `src/pages/printPage.test.ts` (A4 portrait geometry), `PrintWeekPage.test.tsx` / `PrintWeeksPage.test.tsx` (portrait page rule, seven columns, margins), `src/api/client.pdf.test.ts` (layout reaches the request); backend `test_pdf_revision.py` (layout → orientation, viewport and print route).

**Frontend Tests (v1.65 stacked times)**: `src/lib/stackedTeamLayout.test.ts` (time lanes: weekend columns by time, shorter shifts by nearest start, same-time columns by section), `ScheduleGrid.test.tsx` ("stacked times": one column per day, labels, own-time captions, drag between lanes), `TeamPlanHeader.test.tsx` (Times switch).

### 3.11 Background runs (v1.64)

**Backend Tests** (`backend/tests/test_solver_monitor.py`, `test_solver_run_endpoints.py`):
- [x] Watchdog hard stop kills the worker once; salvaged plans end `aborted`; a torn queue message cannot hang the monitor; agent spend recorded once
- [x] Invalid date ranges → 422 with no run row or process
- [x] Discard after apply / of a failed run → 409; discarding an open run twice → 200
- [x] A vacation-hidden unlocked solver row is replaced on apply (`is_replaced_by_draft`)

### 3.12 Swap assistant (v1.71)

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
- [x] Reveal on hover: in the clinic sheet a partner's name that shows stays put (even with its cell cut off) and one under the sticky row labels is scrolled out to their right; at 900 px, where the drawer overlays the grid, the partner's pill is scrolled out from under it and the grid keeps its layout
- [x] "Find cover…" in an open slot's person list searches for cover; the TopBar "Swap history" button opens and closes the history; Undo in the history moves focus to its row once the Undo is gone, so Escape closes the drawer
- [x] Phone: hand over in the sheet; after an Undo in the history (focus on the row, after the sheet's last control) Tab and Shift+Tab stay in the sheet
- [x] Touch screen (`hover: none`): on pills and clinic sheet names the ⇄ button sits left of the lock and right of the name; tapping ⇄ opens the drawer, tapping the lock only toggles it

---

## 4. Intentionally Not Covered

The following areas are explicitly excluded from automated testing:

1. **Visual styling** - Covered by manual review; snapshot tests avoided for maintainability
2. **PDF visual accuracy** - Only validates PDF generation, not pixel-perfect layout
3. **Real external API calls** - Holiday API (date.nager.at) is neither mocked nor referenced by any test
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
`e2e/fixed-assignments.spec.ts`, `e2e/model-settings.spec.ts`,
`e2e/my-plan.spec.ts`, `e2e/team-page.spec.ts`, `e2e/swap-assistant.spec.ts`)
against a local Vite dev server with a mocked API (`page.route`; no backend
needed). Run the same set locally with `npx playwright test
e2e/agent-apply.spec.ts e2e/agent-activity.spec.ts e2e/fixed-assignments.spec.ts
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
| 2026-11-01 | Claude | v1.71: swap assistant |
