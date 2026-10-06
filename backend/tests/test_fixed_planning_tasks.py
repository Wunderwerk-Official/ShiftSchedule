"""Regression cases for fixed inputs, weekly wishes and final-plan verification."""
from datetime import date, timedelta
from threading import Event
import time

import pytest

from backend.agent.quality import extra_metrics
from backend.assignment_policy import is_protected_assignment
from backend.models import AppState, WorkPattern, VacationRange, Holiday
from backend.planning_preferences import daily_min_minutes, daily_comfort_minutes
from backend.run_apply import _candidate, planning_fingerprint, _new_violations
from backend.state import _normalize_state
from .conftest import make_app_state, make_assignment, make_clinician, make_template_slot
from .test_agent_planning_workflow import executor, run, paginated_rescue_fixture
from .test_agent_harness import _payload, _config, MockCancelEvent, ProgressRecorder, MockProvider, agent_solve_range

MON = '2026-01-05'


def week_state(days=3):
    clinician = make_clinician('a', 'Alice', working_hours_per_week=24)
    clinician.workPattern = WorkPattern(daysPerWeek=days, dailyHours=8)
    slots = [make_template_slot(d, col_band_id=f'col-{d}-1') for d in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')]
    return make_app_state(clinicians=[clinician], slots=slots)


def assignments(offsets):
    result = []
    for i in offsets:
        day = date.fromisoformat(MON) + timedelta(days=i)
        result.append(make_assignment(f'a{i}', ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')[day.weekday()], day.isoformat(), 'a', source='solver'))
    return result


@pytest.mark.parametrize('source,locked,protected', [(None, False, True), ('manual', False, True), ('solver', False, False), ('solver', True, True)])
def test_assignment_protection_and_round_trip(source, locked, protected):
    a = make_assignment(row_id='slot-a__mon', source=source).model_copy(update={'locked': locked})
    state = make_app_state(assignments=[a])
    assert is_protected_assignment(a) == protected
    loaded, _ = _normalize_state(AppState.model_validate(state.model_dump()))
    assert loaded.assignments[0].locked == locked
    assert loaded.assignments[0].source == source


def test_fixing_during_run_survives_apply_and_changes_fingerprint():
    a = make_assignment(row_id='slot-a__mon', source='solver')
    state = make_app_state(assignments=[a])
    before = planning_fingerprint(state)
    a.locked = True
    assert planning_fingerprint(state) != before
    draft = {'start_iso': MON, 'end_iso': MON, 'result': {'assignments': []}}
    kept, combined, added, replaced, removed = _candidate(state, draft)
    assert kept == combined == [a] and (added, replaced, removed) == (0, 0, 0)
    # A stale competing placement must not silently overwrite a newly fixed one.
    state.clinicians.append(make_clinician('other', 'Other'))
    draft['result']['assignments'] = [make_assignment('new', 'slot-a__mon', MON, 'other', 'solver').model_dump()]
    kept, combined, *_ = _candidate(state, draft)
    assert _new_violations(state, kept, combined, True)
    assert combined[0].locked


def test_harness_keeps_locked_solver_duty_as_context():
    fixed = make_assignment('fixed', 'slot-a__mon', MON, 'clin-1', 'solver').model_copy(update={'locked': True})
    state = make_app_state(assignments=[fixed])
    result = agent_solve_range(_payload(), state, MockCancelEvent(), ProgressRecorder(), time.time(),
                              provider=MockProvider([{'text': 'Done.'}]), config=_config())
    # Draft contains new assignments only. The original context is retained by apply.
    _, combined, *_ = _candidate(state, {'start_iso': MON, 'end_iso': MON, 'result': result})
    assert combined == [fixed]
    assert state.assignments == [fixed]


def test_same_hours_different_workdays_have_distinct_quality():
    state = week_state()
    ex = executor(state, end='2026-01-11')
    three_days = assignments([0, 1, 2])
    two_days = assignments([0, 1])
    assert extra_metrics(ex, three_days)['workday_deviation_days'] == 0
    longer = week_state()
    for slot in longer.weeklyTemplate.locations[0].slots:
        slot.endTime = '20:00'
    assert extra_metrics(executor(longer, end='2026-01-11'), two_days)['workday_deviation_days'] == 1
    # 3 × 8 hours and 2 × 12 hours both total 24 hours.
    # The workday score counts presence, not summed hours or number of slots.
    assert extra_metrics(ex, three_days + [three_days[0]])['workday_deviation_days'] == 0


def test_fractional_targets_average_across_complete_weeks():
    ex = executor(week_state(2.5), end='2026-01-18')
    assert extra_metrics(ex, assignments([0, 1, 7, 8, 9]))['workday_deviation_days'] == 0
    assert extra_metrics(ex, assignments([0, 1, 7, 8]))['workday_deviation_days'] == 1
    assert extra_metrics(executor(week_state(2.5), end='2026-01-11'), assignments([0, 1]))['workday_deviation_days'] == 0


def test_partial_week_uses_fixed_context_but_never_invents_missing_days():
    state = week_state(2)
    state.assignments = assignments([1, 2, 3])
    ex = executor(state)
    metrics = extra_metrics(ex, [])
    assert metrics['workday_deviation_days'] == 1
    assert metrics['workday_fixed_excess_days'] == 1
    assert metrics['workday_patterns'][0]['actual_days'] == 3
    assert metrics['workday_patterns'][0]['assessment'] == 'known_excess_only'
    assert extra_metrics(executor(week_state(2)), [])['workday_deviation_days'] == 0


def test_vacation_and_holiday_reduce_target_without_double_counting():
    state = week_state(5)
    state.clinicians[0].vacations = [VacationRange(id='v', startISO=MON, endISO='2026-01-06')]
    state.holidays = [Holiday(dateISO=MON, name='Holiday')]
    ex = executor(state, end='2026-01-11')
    metrics = extra_metrics(ex, assignments([2, 3, 4]))
    assert metrics['workday_deviation_days'] == 0
    assert metrics['workday_patterns'][0]['target_days'] == 3


def test_overnight_fixed_duty_counts_one_start_day_and_separate_fixed_burden():
    state = week_state(1)
    state.weeklyTemplate.locations[0].slots[0].endDayOffset = 1
    state.assignments = assignments([0])
    ex = executor(state, end='2026-01-11')
    metrics = extra_metrics(ex, [])
    assert metrics['workday_patterns'][0]['actual_days'] == 1
    assert metrics['duty_burden_total_penalty'] > 0
    assert metrics['duty_burden_fixed_penalty'] == metrics['duty_burden_total_penalty']
    assert metrics['duty_burden_penalty'] == 0


def test_explicit_zero_tolerance_and_legacy_thresholds():
    c = make_clinician(working_hours_per_week=40)
    c.workPattern = WorkPattern(dailyHours=8, dailyHoursTolerance=0)
    assert daily_min_minutes(c) == daily_comfort_minutes(c) == 480
    c.workPattern.dailyHoursTolerance = 1.5
    assert (daily_min_minutes(c), daily_comfort_minutes(c)) == (390, 570)
    c.workPattern.dailyHoursTolerance = None
    assert (daily_min_minutes(c), daily_comfort_minutes(c)) == (240, 540)


def test_task_checks_are_invalidated_by_other_day_changes():
    ex = executor(make_app_state(slots=[make_template_slot('mon'), make_template_slot('tue', col_band_id='col-tue-1')]),
                  [make_assignment('a', 'mon', MON, 'clin-1', 'solver')], end='2026-01-06')
    assert ex.workflow.review_day(MON)['complete']
    before = run(ex, 'get_plan_tasks')
    assert before['tasks'][0]['status'] == 'complete'
    run(ex, 'apply_moves', moves=[{'action': 'assign', 'slot_key': 'tue__2026-01-06', 'clinicianId': 'clin-1'}])
    after = run(ex, 'get_plan_tasks')
    assert after['plan_revision'] > before['plan_revision']
    assert after['tasks'][0]['status'] == 'pending'
    assert not after['tasks'][0]['proposal_ids']


def test_final_audit_repairs_verified_offer_and_rechecks_new_revision():
    ex = paginated_rescue_fixture()
    original = ex.best_quality
    audit = ex.workflow.final_audit([MON], Event())
    assert audit['repairs'] >= 1
    assert ex.best_quality < original
    assert audit['checks'][MON]['plan_revision'] == ex.workflow.revision
    assert audit['checks'][MON]['complete']
    assert ex.workflow.tasks()['required_checks_complete']
    assert not ex.workflow.tasks()['coverage_complete']  # genuine remaining qualification gaps


@pytest.mark.parametrize('stop', ['cancel', 'no_repairs', 'deadline'])
def test_final_audit_never_hides_unprocessed_improvement(stop):
    ex = paginated_rescue_fixture()
    original = list(ex.best_assignments)
    cancel = Event()
    if stop == 'cancel':
        cancel.set()
    audit = ex.workflow.final_audit([MON], cancel, max_repairs=0 if stop == 'no_repairs' else 4,
                                    max_seconds=0 if stop == 'deadline' else 60)
    assert audit['repairs'] == 0 and ex.best_assignments == original
    assert not audit['checks'][MON]['complete']
    assert not ex.workflow.tasks()['required_checks_complete']


def test_heuristic_backtracking_retains_explicitly_locked_solver_assignment():
    from backend.heuristic.solver_v2 import _mark_manual_assignments, _reset_day_to_manual_only
    from .test_heuristic_v2 import _make_slot, _make_clinician_state
    cs = _make_clinician_state()
    slot = _make_slot()
    a = make_assignment('fixed', slot.slot_id, slot.date_iso, cs.clinician_id, 'solver')
    a.locked = True
    states = {cs.clinician_id: cs}
    marked = _mark_manual_assignments([a], [slot], states)
    _reset_day_to_manual_only(slot.date_iso, states, marked)
    assert cs.assigned_slots_by_date[slot.date_iso] == [slot]
    assert a.source == 'solver' and a.locked


def test_classic_solver_includes_fixed_entries_in_constraint_context():
    from backend.solver import _collect_manual_assignments
    state = make_app_state(assignments=[make_assignment(row_id='slot-a__mon', source='solver')])
    state.assignments[0].locked = True
    selected, context, skipped = _collect_manual_assignments(state, [MON], {'slot-a__mon'},
        {'slot-a__mon': (480, 960, 'loc-default')}, lambda *_: False)
    assert selected == context == {('clin-1', MON): ['slot-a__mon']}
    assert skipped == []


def test_apply_safety_uses_pending_revision_tasks_even_with_old_completion_labels():
    from backend.run_apply import result_safety
    run_record = {'status': 'aborted', 'start_iso': MON, 'end_iso': MON,
                  'result': {'assignments': [make_assignment().model_dump()], 'debugInfo': {'agent': {
                      'daysPlanned': 1, 'daysIncomplete': [], 'daysSkipped': [],
                      'tasks': {'plan_revision': 5, 'tasks': [{'kind': 'required_check', 'status': 'pending', 'dateISO': MON}]},
                  }}}}
    empty, incomplete = result_safety(run_record)
    assert not empty and incomplete == [MON]


def test_explicit_day_length_is_independent_of_a_soft_clock_time_window():
    from backend.planning_preferences import daily_target_minutes
    c = make_clinician(working_hours_per_week=40)
    c.workPattern = WorkPattern(dailyHours=8, dailyHoursTolerance=1)
    preferred = ('preference', 420, 450)
    assert daily_target_minutes(c, preferred) == 480
    assert daily_min_minutes(c, preferred) == 420
    assert daily_comfort_minutes(c, preferred) == 540
    # A mandatory availability window still caps the achievable daily target.
    assert daily_target_minutes(c, ('mandatory', 480, 840)) == 360
    c.workPattern = None
    assert daily_target_minutes(c, preferred) == 60  # unchanged legacy default


def test_final_audit_gets_reserved_time_without_extending_caller_limit(monkeypatch):
    from backend.agent.workflow import PlanningWorkflow
    from backend.agent.tools import PlanToolExecutor
    observed_model, observed_audit = [], []
    actual_execute = PlanToolExecutor.execute
    actual_audit = PlanningWorkflow.final_audit
    def execute(ex, *args, **kwargs):
        if not observed_model:
            observed_model.append(ex.wall_deadline)
        return actual_execute(ex, *args, **kwargs)
    def audit(workflow, *args, **kwargs):
        observed_audit.append(workflow.executor.wall_deadline)
        return actual_audit(workflow, *args, **kwargs)
    monkeypatch.setattr(PlanToolExecutor, 'execute', execute)
    monkeypatch.setattr(PlanningWorkflow, 'final_audit', audit)
    started = time.time()
    result = agent_solve_range(_payload(timeout_seconds=600), make_app_state(), MockCancelEvent(),
                              ProgressRecorder(), started, provider=MockProvider([
                                  {'tool_calls': [{'name': 'get_plan_overview', 'arguments': {}}]}, {'text': 'Done.'}
                              ]), config=_config())
    assert observed_model == [started + 540]
    assert observed_audit == [started + 600]
    assert result['debugInfo']['agent']['completion']['required_checks_complete']


def test_week_audit_does_not_stop_after_four_verified_coverage_repairs():
    state = week_state(5)
    state.clinicians[0].workingHoursPerWeek = 56
    ex = executor(state, assignments([0]), end='2026-01-11')
    audit = ex.workflow.final_audit(ex.ctx.target_day_isos, Event())
    assert audit['repair_limit'] == 14
    assert audit['repairs'] == 6
    assert ex.best_quality[1] == 0
    assert all(check['complete'] for check in audit['checks'].values())
    assert ex.workflow.tasks()['coverage_complete']


def test_final_repair_budget_prioritizes_missing_coverage_before_an_earlier_long_day():
    state = make_app_state(clinicians=[make_clinician('a', 'Alice', working_hours_per_week=40),
                                      make_clinician('b', 'Bob', working_hours_per_week=40)], slots=[
        make_template_slot('early'),
        make_template_slot('late', start_time='16:00', end_time='00:00', end_day_offset=1),
        make_template_slot('tue', col_band_id='col-tue-1'),
    ])
    state.solverSettings['agentQualityProfile'] = 'balanced'
    ex = executor(state, [make_assignment('early', 'early', MON, 'a', 'solver'),
                          make_assignment('late', 'late', MON, 'a', 'solver')], end='2026-01-06')
    # A checked soft improvement exists on Monday, but Tuesday is unstaffed.
    assert ex.workflow.review_day(MON)['proposals']
    audit = ex.workflow.final_audit([MON, '2026-01-06'], Event(), max_repairs=1)
    assert audit['repairs'] == 1
    assert ex.best_quality[1] == 0
    assert any(a.dateISO == '2026-01-06' for a in ex.best_assignments)


# --- final audit budget, incremental re-checks and the "unverified" verdict (2026-10-06) ---

def test_audit_time_budget_scales_with_the_range():
    from backend.agent.workflow import audit_time_budget
    assert audit_time_budget(1) == 60
    assert audit_time_budget(7) == 70
    assert audit_time_budget(28) == 280


def test_final_audit_uses_scaled_budget_by_default():
    ex = executor(week_state(5), assignments([0]), end='2026-01-11')
    audit = ex.workflow.final_audit(ex.ctx.target_day_isos, Event())
    assert audit['time_limit_seconds'] == 70
    assert audit['checks'] and all(check['complete'] for check in audit['checks'].values())


def test_final_audit_keeps_completed_checks_outside_the_repaired_week(monkeypatch):
    """A repair in week 1 must not re-run the bounded searches of week 2."""
    from backend.agent.workflow import PlanningWorkflow
    state = week_state(5)
    state.clinicians[0].workingHoursPerWeek = 56
    ex = executor(state, assignments([0]), end='2026-01-18')  # two ISO weeks
    week2 = [d for d in ex.ctx.target_day_isos if d >= '2026-01-12']
    assert week2
    reviewed = []
    actual = PlanningWorkflow.review_day
    def review_day(workflow, day):
        reviewed.append(day)
        return actual(workflow, day)
    monkeypatch.setattr(PlanningWorkflow, 'review_day', review_day)
    audit = ex.workflow.final_audit(ex.ctx.target_day_isos, Event())
    assert audit['repairs'] >= 1
    assert all(check['complete'] for check in audit['checks'].values())
    assert all(check['plan_revision'] == ex.workflow.revision for check in audit['checks'].values())
    assert ex.workflow.tasks()['required_checks_complete']
    # Week-2 days were repaired too (week 2 is equally understaffed), but any
    # day is reviewed at most once per repair that touched its own week.
    counts = {d: reviewed.count(d) for d in ex.ctx.target_day_isos}
    assert max(counts.values()) <= audit['repairs'] + 1
    assert audit['rechecked_days'] < audit['repairs'] * len(ex.ctx.target_day_isos)


def test_days_affected_by_repair_covers_iso_week_and_neighbours():
    ex = executor(week_state(5), assignments([0]), end='2026-01-25')
    days = ex.ctx.target_day_isos  # 2026-01-05 .. 2026-01-25, three ISO weeks
    before = set()
    after = {('a1', '2026-01-14', 'a')}  # Wednesday of week 2
    stale = ex.workflow._days_affected_by_repair(days, before, after)
    assert stale == {d for d in days if '2026-01-12' <= d <= '2026-01-18'}  # the ISO week
    # A Monday change also drags in the Sunday before it (rest/overnight rules).
    stale = ex.workflow._days_affected_by_repair(days, before, {('a1', '2026-01-12', 'a')})
    assert stale == {d for d in days if '2026-01-11' <= d <= '2026-01-18'}
    # Unlocatable change or balanced profile: everything is stale.
    assert ex.workflow._days_affected_by_repair(days, set(), set()) == set(days)
    ex.ctx.settings.agentQualityProfile = 'balanced'
    assert ex.workflow._days_affected_by_repair(days, before, after) == set(days)


def test_exhausted_audit_reports_unverified_not_pending():
    from backend.run_apply import result_safety
    ex = paginated_rescue_fixture()
    audit = ex.workflow.final_audit([MON], Event(), max_seconds=0)
    assert audit['repairs'] == 0
    assert not audit['checks'][MON]['complete'] and audit['checks'][MON]['unverified']
    tasks = ex.workflow.tasks()
    assert not tasks['required_checks_complete']
    assert tasks['required_checks_unverified'] == [MON]
    row = next(t for t in tasks['tasks'] if t['kind'] == 'required_check')
    assert row['status'] == 'unverified'
    run_record = {'status': 'finished', 'start_iso': MON, 'end_iso': MON,
                  'result': {'assignments': [make_assignment().model_dump()],
                             'debugInfo': {'agent': {'daysSkipped': [], 'daysIncomplete': [], 'tasks': tasks}}}}
    empty, incomplete = result_safety(run_record)
    assert not empty and incomplete == []


def test_harness_keeps_completed_when_only_the_final_audit_ran_out_of_time(monkeypatch):
    from backend.agent.workflow import PlanningWorkflow
    actual = PlanningWorkflow.final_audit
    monkeypatch.setattr(PlanningWorkflow, 'final_audit',
                        lambda workflow, days, cancel, **kw: actual(workflow, days, cancel, max_seconds=0))
    result = agent_solve_range(_payload(), make_app_state(), MockCancelEvent(), ProgressRecorder(), time.time(),
                              provider=MockProvider([
                                  {'tool_calls': [{'name': 'apply_moves', 'arguments': {'moves': [
                                      {'action': 'assign', 'slot_key': 'slot-a__mon', 'clinicianId': 'clin-1'}]}}]},
                                  {'text': 'Done.'}]), config=_config())
    agent = result['debugInfo']['agent']
    assert agent['stopReason'] == 'completed'
    assert agent['daysUnverified'] == [MON]
    assert agent['daysIncomplete'] == [] and agent['daysSkipped'] == []
    assert agent['completion']['required_checks_unverified'] == 1
    assert not agent['completion']['required_checks_complete']
    assert any('ran out of time' in n for n in result['notes'])
