"""The swap search on the swap template, without a database: pre-filters, gate
reasons, findings, rest days, pre-existing problems, ranking, groups, caps
and blocked targets."""

from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional

import pytest
from fastapi import HTTPException

from backend.models import (
    AppState,
    Assignment,
    Clinician,
    PreferredWorkingTime,
    SolverRule,
    VacationRange,
    WorkPattern,
)
from backend.swaps import matching, policy
from backend.swaps.blocks import SwapUnit, instance_unit
from backend.swaps.matching import (
    MovePlan,
    SwapContext,
    find_candidates,
    plan_option,
    reason_for,
    scoped_gate,
)
from backend.swaps.policy import SwapRules, open_slot
from backend.swaps.schemas import CandidatesRequest
from backend.validation import ValidationReport

from .conftest import make_clinician, make_template_slot
from .swap_fixtures import (
    ALL_SECTIONS,
    FRI,
    MON,
    NOW,
    SAT,
    SUN,
    THU,
    TUE,
    WED,
    asg,
    default_clinicians,
    make_swap_state,
)

RULES = SwapRules()
NEXT_MON = "2026-01-12"


def _utc(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def _person(clinician_id: str, name: str, *, sections: Iterable[str] = ALL_SECTIONS,
            hours: Optional[float] = 40) -> Clinician:
    return make_clinician(clinician_id, name, list(sections), working_hours_per_week=hours)


def _people(*extra: Clinician) -> List[Clinician]:
    return default_clinicians() + list(extra)


def _search(state: AppState, assignment_id: str, mode: str = "handover", *, now: datetime = NOW,
            rules: SwapRules = RULES, **fields: Any) -> Dict[str, Any]:
    a = next(x for x in state.assignments if x.id == assignment_id)
    ref = {"assignmentId": a.id, "rowId": a.rowId, "dateISO": a.dateISO, "clinicianId": a.clinicianId}
    req = CandidatesRequest(mode=mode, assignment=ref, **fields)
    return find_candidates(SwapContext(state, rules, now), req)


def _cover(state: AppState, row_id: str, date_iso: str, *, now: datetime = NOW,
           **fields: Any) -> Dict[str, Any]:
    req = CandidatesRequest(mode="cover", slot={"rowId": row_id, "dateISO": date_iso}, **fields)
    return find_candidates(SwapContext(state, RULES, now), req)


def _options(result: Dict[str, Any]) -> List[Dict[str, Any]]:
    return result["best"] + result["possible"] + result["blocked"]


def _option(result: Dict[str, Any], key: str) -> Dict[str, Any]:
    return next(option for option in _options(result) if option["key"] == key)


def _keys(options: Iterable[Dict[str, Any]]) -> List[str]:
    return [option["key"] for option in options]


def _weekdays(prefix: str, clinician_id: str) -> List[Assignment]:
    """CT from Monday to Friday: 40 h in week 2."""
    days = zip(("mon", "tue", "wed", "thu", "fri"), (MON, TUE, WED, THU, FRI))
    return [asg(f"{prefix}-{d}", f"ct-{d}", day, clinician_id) for d, day in days]


# --- Pre-filters and gate reasons -------------------------------------------


def test_prefilter_reasons_name_the_taker():
    clinicians = _people()
    clinicians[1].vacations.append(VacationRange(id="v", startISO=FRI, endISO=FRI))  # Ben
    state = make_swap_state(
        [asg("a-night", "night-thu", THU, "clin-anna"), asg("a-fri", "ct-fri", FRI, "clin-anna"),
         asg("a-sat", "ct-sat", SAT, "clin-anna"), asg("b-sat", "ct-sat", SAT, "clin-ben")],
        clinicians=clinicians, slot_overrides={f"ct-sat__{SAT}": 1},
    )
    cases = [
        ("a-night", "clin-clara", "not_qualified", "Clara Schmidt is not qualified for Night duty."),
        ("a-fri", "clin-ben", "on_vacation", "Ben Ott is on vacation on Fri 9 Jan."),
        ("a-sat", "clin-ben", "already_assigned", "Ben Ott already works CT on Sat 10 Jan."),
    ]
    for assignment_id, partner_id, code, message in cases:
        result = _search(state, assignment_id, partnerId=partner_id)
        (option,) = result["blocked"]
        assert option["reason"] == {"code": code, "message": message}
        assert (option["blockerCount"], option["group"], result["checked"]) == (1, "blocked", 1)
        assert option["chips"] == option["warnings"] == option["hours"] == option["preexisting"] == []


GATE_CASES = [
    pytest.param([asg("x", "ct-thu", THU, "clin-anna"), asg("b", "early-thu", THU, "clin-ben")],
                 ("overlap", "Ben Ott already works Day on Thu 8 Jan (07:00–12:00)."), id="overlap"),
    pytest.param([asg("x", "oncall-wed", WED, "clin-anna"), asg("b", "ct-thu", THU, "clin-ben")],
                 ("on_call_rest", "On-call rest: Ben Ott works Thu 8 Jan."), id="on-call-moved"),
    pytest.param([asg("x", "ct-thu", THU, "clin-anna"), asg("b", "oncall-wed", WED, "clin-ben")],
                 ("on_call_rest", "On-call rest: Ben Ott is on call on Wed 7 Jan."), id="on-call-kept"),
    pytest.param([asg("x", "ct-sat", SAT, "clin-anna")] + _weekdays("b", "clin-ben"),
                 ("weekly_hours", "Ben Ott: week 2 would reach 48.0 h (limit 45.0 h)."), id="weekly-hours"),
    pytest.param([asg("x", "night-thu", THU, "clin-anna"), asg("b", "early-thu", THU, "clin-ben")],
                 ("split_shift", "Ben Ott would have a split day on Thu 8 Jan."), id="split-shift"),
]


@pytest.mark.parametrize("assignments, reason", GATE_CASES)
def test_gate_reasons(assignments: List[Assignment], reason: tuple):
    result = _search(make_swap_state(assignments), "x", partnerId="clin-ben")
    (option,) = result["blocked"]
    assert (option["reason"]["code"], option["reason"]["message"]) == reason
    assert option["blockerCount"] >= 1


def _hidden_ct_thu(*, override: int = 0) -> AppState:
    """Anna is on vacation Thu, so her ct-thu is hidden and the slot is open."""
    anna = _person("clin-anna", "Anna Weber")
    anna.vacations.append(VacationRange(id="v", startISO=THU, endISO=THU))
    overrides = {f"ct-thu__{THU}": override} if override else {}
    return make_swap_state([asg("hidden", "ct-thu", THU, "clin-anna")],
                           clinicians=[anna] + default_clinicians()[1:], slot_overrides=overrides)


def test_cover_without_a_required_hidden_removal_overfills_the_slot():
    state = _hidden_ct_thu()
    ctx = SwapContext(state, RULES, NOW)
    info = open_slot(ctx.vctx, ctx.by_instance, "ct-thu", THU)
    unit = instance_unit(ctx.vctx, "ct-thu", THU)
    kept = plan_option(ctx, "cover", unit, "clin-ben", cover=info)
    new, _carried = scoped_gate(ctx, kept)
    assert reason_for(ctx, kept, new) == ("capacity", "CT on Thu 8 Jan would be overfilled.")
    removed = plan_option(ctx, "cover", unit, "clin-ben", cover=info, hidden_removal=info.hidden[0])
    assert scoped_gate(ctx, removed)[0] == []


def test_cover_with_a_hidden_holder_requires_the_removal_and_is_valid():
    result = _cover(_hidden_ct_thu(), "ct-thu", THU)
    target = result["target"]
    assert target["hiddenHolder"] == {"clinicianId": "clin-anna", "name": "Anna Weber",
                                      "assignmentId": "hidden"}
    assert (target["openCount"], target["excludedPartnerIds"]) == (1, ["clin-anna"])
    ben = _option(result, "clin-ben|-")
    assert ben["group"] == "best"
    assert ben["hiddenRemoval"] == {"clinicianId": "clin-anna", "name": "Anna Weber",
                                    "assignmentId": "hidden", "required": True}
    assert [h["clinicianId"] for h in ben["hours"]] == ["clin-ben"]


def test_an_optional_hidden_removal_is_not_required():
    result = _cover(_hidden_ct_thu(override=1), "ct-thu", THU)
    assert result["target"]["openCount"] == 2
    assert _option(result, "clin-ben|-")["hiddenRemoval"]["required"] is False


def test_requests_naming_no_shift_or_a_wrong_partner_are_refused():
    state = make_swap_state([asg("x", "ct-thu", THU, "clin-anna")])
    ctx = SwapContext(state, RULES, NOW)

    def request(**fields: Any) -> CandidatesRequest:
        assignment = {"assignmentId": "x", "rowId": "ct-thu", "dateISO": THU, "clinicianId": "clin-anna"}
        return CandidatesRequest(mode="swap", assignment={**assignment, **fields.pop("ref", {})}, **fields)

    for req, status, code, message in [
        (request(ref={"clinicianId": "clin-ben"}), 409, "swap_stale",
         "This shift no longer exists. Refresh the plan."),
        (request(partnerId="clin-anna"), 400, "invalid_request", "Choose another person."),
        (request(partnerId="clin-nobody"), 400, "invalid_request", "This person is not in the plan."),
    ]:
        with pytest.raises(HTTPException) as error:
            find_candidates(ctx, req)
        assert error.value.status_code == status
        assert error.value.detail == {"code": code, "message": message}


def test_with_several_matches_the_named_assignment_is_the_target():
    state = make_swap_state([asg("first", "ct-thu", THU, "clin-anna"),
                             asg("second", "ct-thu", THU, "clin-anna")])
    result = _search(state, "second")
    assert [item["assignmentId"] for item in result["target"]["unit"]["items"]] == ["first", "second"]


# --- Groups and ranking -----------------------------------------------------


def test_like_for_like_ranks_before_a_closer_swap_in_the_same_week():
    state = make_swap_state([asg("x", "ct-thu", THU, "clin-anna"),
                             asg("like", "ct-tue", "2026-01-13", "clin-ben"),
                             asg("other", "early-fri", FRI, "clin-ben")])
    result = _search(state, "x", "swap")
    assert _keys(result["best"]) == ["clin-ben|ct-tue@2026-01-13", "clin-ben|early-fri@2026-01-09"]
    assert result["best"][0]["chips"][0] == {"code": "same_section", "label": "Same section",
                                             "tone": "positive"}


def test_same_week_ranks_before_next_week_even_when_further_away():
    state = make_swap_state([asg("x", "ct-sun", SUN, "clin-anna"), asg("far", "ct-mon", MON, "clin-ben"),
                             asg("near", "ct-mon", NEXT_MON, "clin-ben")])
    result = _search(state, "x", "swap")
    assert _keys(result["best"]) == ["clin-ben|ct-mon@2026-01-05", "clin-ben|ct-mon@2026-01-12"]


def test_smaller_hours_move_ranks_first():
    # Anna gives 5 h; taking Ben's 5 h early keeps everyone's hours, his 4 h late does not.
    state = make_swap_state([asg("x", "early-thu", THU, "clin-anna"),
                             asg("early", "early-wed", WED, "clin-ben"),
                             asg("late", "late-fri", FRI, "clin-ben")])
    result = _search(state, "x", "swap")
    assert _keys(result["best"]) == ["clin-ben|early-wed@2026-01-07", "clin-ben|late-fri@2026-01-09"]
    assert {"code": "hours_even", "label": "Hours even", "tone": "neutral"} in result["best"][0]["chips"]
    assert "hours_even" not in [chip["code"] for chip in result["best"][1]["chips"]]


def test_section_preference_ranks_a_partner_first():
    eva = _person("clin-eva", "Eva Lang")
    eva.preferredClassIds = ["sec-day", "sec-ct", "sec-night"]
    # Dora has no contract, so handing over leaves no note about her hours.
    state = make_swap_state([asg("x", "ct-thu", THU, "clin-dora")], clinicians=_people(eva))
    result = _search(state, "x")
    assert _keys(result["best"]) == ["clin-eva|-", "clin-anna|-", "clin-ben|-", "clin-clara|-"]
    assert {"code": "prefers", "label": "Prefers CT", "tone": "positive"} in result["best"][0]["chips"]


def _march_state(ben: Clinician) -> AppState:
    """Anna (no contract) works Mon 9 March; Ben worked every weekday of Jan
    and Feb, Eva never."""
    history = [asg(f"h{n}", f"ct-{('mon', 'tue', 'wed', 'thu', 'fri')[n % 5]}",
                   (date(2026, 1, 5) + timedelta(days=7 * (n // 5) + n % 5)).isoformat(), "clin-ben")
               for n in range(40)]
    return make_swap_state(history + [asg("x", "ct-mon", "2026-03-09", "clin-anna")],
                           clinicians=[_person("clin-anna", "Anna Weber", hours=None), ben,
                                       _person("clin-eva", "Eva Lang")])


def test_handover_ranks_by_year_to_date_deficit():
    result = _search(_march_state(_person("clin-ben", "Ben Ott")), "x")
    assert _keys(result["best"]) == ["clin-eva|-", "clin-ben|-"]
    behind = [[chip for chip in option["chips"] if chip["code"] == "behind_on_hours"]
              for option in result["best"]]
    # 40 shifts of 8 h against 40 h for 67/7 weeks: 16 % behind.
    assert behind == [[{"code": "behind_on_hours", "label": "100 % behind on hours", "tone": "positive"}],
                      [{"code": "behind_on_hours", "label": "16 % behind on hours", "tone": "positive"}]]


def test_unknown_year_to_date_ranks_after_known():
    ben = _person("clin-ben", "Ben Ott")
    ben.vacations.append(VacationRange(id="v", startISO="2026-01-01", endISO="2026-03-08"))
    state = _march_state(ben)
    assert "clin-ben" not in SwapContext(state, RULES, NOW).ytd_pct("2026-03-09")
    assert _keys(_search(state, "x")["best"]) == ["clin-eva|-", "clin-ben|-"]


def test_a_partner_without_contract_ranks_after_an_equal_one_with_contract():
    ada = _person("clin-ada", "Ada Klein", hours=None)
    state = make_swap_state([asg("x", "ct-thu", THU, "clin-anna"), asg("b", "ct-fri", FRI, "clin-ben"),
                             asg("a", "ct-wed", WED, "clin-ada")], clinicians=_people(ada))
    result = _search(state, "x", "swap")
    assert _keys(result["best"]) == ["clin-ben|ct-fri@2026-01-09", "clin-ada|ct-wed@2026-01-07"]
    chips = [[chip["code"] for chip in option["chips"]] for option in result["best"]]
    assert chips == [["same_section", "same_week", "hours_even"],
                     ["same_section", "same_week", "no_contract"]]


def _generated(count: int, prefix: str, **kwargs: Any) -> List[Clinician]:
    return [_person(f"clin-{prefix}{n:02d}", f"{prefix.title()} {n:02d}", **kwargs) for n in range(count)]


def test_caps_and_totals():
    best = _generated(12, "best")
    possible = _generated(25, "possible")
    for clinician in possible:
        clinician.workPattern = WorkPattern(preferredDaysOff=["thu"])
    blocked = _generated(3, "blocked", sections=["sec-day"])
    state = make_swap_state([asg("x", "ct-thu", THU, "clin-dora")],
                            clinicians=_people(*best, *possible, *blocked))
    result = _search(state, "x")
    # Anna, Ben and Clara also take it cleanly.
    assert result["totals"] == {"best": 15, "possible": 25, "blocked": 3}
    assert (len(result["best"]), len(result["possible"]), len(result["blocked"])) == (10, 20, 3)
    assert result["checked"] == 43
    assert result["closest"] == []
    assert result["truncated"] is False


def test_closest_lists_gate_blocked_options_first_when_nothing_works():
    state = make_swap_state(
        [asg("x", "night-thu", THU, "clin-anna"), asg("b", "demo-fri", FRI, "clin-ben"),
         asg("d", "early-fri", FRI, "clin-dora")],
        clinicians=_people(*_generated(40, "day", sections=["sec-day"])),
    )
    result = _search(state, "x")
    assert result["totals"] == {"best": 0, "possible": 0, "blocked": 43}
    assert len(result["blocked"]) == 30
    assert [(o["partnerId"], o["reason"]["code"]) for o in result["closest"]] == [
        ("clin-ben", "overlap"), ("clin-dora", "overlap"), ("clin-clara", "not_qualified")]
    assert result["closest"] == result["blocked"][:3]


def test_search_stops_after_the_gate_budget(monkeypatch):
    monkeypatch.setattr(policy, "MAX_GATE_EVALUATIONS", 5)
    state = make_swap_state([asg("x", "ct-thu", THU, "clin-anna")],
                            clinicians=_people(*_generated(10, "eva")))
    result = _search(state, "x")
    assert result["truncated"] is True
    assert result["checked"] == 5
    assert sum(result["totals"].values()) == 5


# --- Partner range and filters ----------------------------------------------


def _range_state() -> AppState:
    return make_swap_state([
        asg("x", "ct-thu", THU, "clin-anna"),
        asg("week-start", "ct-mon", MON, "clin-ben"),
        asg("early", "early-fri", FRI, "clin-ben"),
        asg("week-end", "ct-sun", SUN, "clin-ben"),
        asg("next", "ct-mon", NEXT_MON, "clin-ben"),
        asg("last", "ct-sun", "2026-02-01", "clin-ben"),
        asg("beyond", "ct-mon", "2026-02-02", "clin-ben"),
        asg("dora", "ct-tue", TUE, "clin-dora"),
    ])


SAME_WEEK = {"clin-ben|ct-mon@2026-01-05", "clin-ben|early-fri@2026-01-09", "clin-ben|ct-sun@2026-01-11",
             "clin-dora|ct-tue@2026-01-06"}
FOUR_WEEKS = SAME_WEEK | {"clin-ben|ct-mon@2026-01-12", "clin-ben|ct-sun@2026-02-01"}


@pytest.mark.parametrize("fields, expected", [
    ({"range": "sameWeek"}, SAME_WEEK),
    ({"range": "fourWeeks"}, FOUR_WEEKS),
    ({"range": "dates", "dates": [NEXT_MON, "2026-02-02"]},
     {"clin-ben|ct-mon@2026-01-12", "clin-ben|ct-mon@2026-02-02"}),
    ({"sameTypeOnly": True}, FOUR_WEEKS - {"clin-ben|early-fri@2026-01-09"}),
    ({"partnerId": "clin-dora"}, {"clin-dora|ct-tue@2026-01-06"}),
])
def test_partner_range_and_filters(fields: Dict[str, Any], expected: set):
    result = _search(_range_state(), "x", "swap", **fields)
    assert set(_keys(_options(result))) == expected
    assert result["checked"] == len(expected)


def test_a_started_partner_block_is_skipped():
    state = make_swap_state([asg("x", "ct-thu", THU, "clin-anna"), asg("mon", "ct-mon", MON, "clin-ben"),
                             asg("fri", "ct-fri", FRI, "clin-ben")])
    result = _search(state, "x", "swap", now=_utc("2026-01-05T07:30Z"))  # Mon 08:30 in Berlin
    assert _keys(_options(result)) == ["clin-ben|ct-fri@2026-01-09"]
    assert result["checked"] == 1


@pytest.mark.parametrize("assignment_id, whole_day, message", [
    ("ct", False, "This shift has already started."),
    ("night", True, "A shift of this day has already started."),
])
def test_a_started_target_offers_nothing(assignment_id: str, whole_day: bool, message: str):
    state = make_swap_state([asg("ct", "ct-thu", THU, "clin-anna"),
                             asg("night", "night-thu", THU, "clin-anna"),
                             asg("b", "ct-fri", FRI, "clin-ben")])
    result = _search(state, assignment_id, "swap", now=_utc("2026-01-08T07:30Z"), wholeDay=whole_day)
    target = result["target"]
    assert target["blocked"] == {"code": "started", "message": message}
    assert target["unit"] is not None
    assert (target["insideNotice"], target["hoursUntilStart"]) == (False, -0.5)
    assert target["wholeDay"] is whole_day
    assert result["checks"] == _options(result) == []
    assert (result["checked"], result["truncated"]) == (0, False)


def test_take_hours_until_start_in_swap_mode_only():
    state = make_swap_state([asg("x", "ct-thu", THU, "clin-anna"), asg("b", "ct-fri", FRI, "clin-ben")])
    swap = _search(state, "x", "swap")
    # Fri 9 Jan 08:00 in Berlin is 07:00 UTC, 191 h after NOW.
    assert swap["best"][0]["takeHoursUntilStart"] == 191.0
    handover = _search(state, "x")
    assert {option["takeHoursUntilStart"] for option in _options(handover)} == {None}


# --- Findings ---------------------------------------------------------------


def _single_finding(result: Dict[str, Any], key: str, code: str) -> Dict[str, Any]:
    option = _option(result, key)
    assert option["group"] == "possible"
    (finding,) = [f for f in option["findings"] if f["code"] == code]
    return finding


def test_solver_rule_finding():
    state = make_swap_state([asg("x", "night-thu", THU, "clin-anna"), asg("b", "late-fri", FRI, "clin-ben")])
    state.solverRules = [SolverRule(id="rule-1", name="Off after Thursday night", ifShiftRowId="night-thu",
                                    dayDelta=1, thenType="off").model_dump()]
    finding = _single_finding(_search(state, "x", partnerId="clin-ben"), "clin-ben|-", "solver_rule")
    assert finding == {"code": "solver_rule", "clinicianId": "clin-ben",
                       "message": "Ben Ott: breaks the rule “Off after Thursday night” on Fri 9 Jan.",
                       "short": "Rule: Off after Thursday night"}


def _ben_with(**changes: Any) -> List[Clinician]:
    clinicians = _people()
    for field, value in changes.items():
        setattr(clinicians[1], field, value)
    return clinicians


@pytest.mark.parametrize("assignment_id, changes, code, message, short", [
    ("ct", {"preferredWorkingTimes": {"thu": PreferredWorkingTime(startTime="07:00", endTime="15:00",
                                                                  requirement="preference")}},
     "preference_window", "Ben Ott prefers to work 07:00–15:00 on Thursdays.", "Outside preferred times"),
    ("ct", {"workPattern": WorkPattern(preferredDaysOff=["thu"])},
     "preferred_day_off", "Ben Ott prefers Thursdays off.", "Preferred day off"),
    ("night", {"preferredClassIds": ["sec-ct", "sec-day", "sec-night", "sec-oncall"]},
     "section_preference", "Ben Ott prefers other sections to Night duty.", "Less preferred section"),
])
def test_preference_findings(assignment_id: str, changes: Dict[str, Any], code: str, message: str,
                             short: str):
    state = make_swap_state([asg("ct", "ct-thu", THU, "clin-anna"),
                             asg("night", "night-thu", THU, "clin-anna")], clinicians=_ben_with(**changes))
    finding = _single_finding(_search(state, assignment_id, partnerId="clin-ben"), "clin-ben|-", code)
    assert finding == {"code": code, "clinicianId": "clin-ben", "message": message, "short": short}


def test_section_preference_in_a_swap_needs_a_worse_section_than_the_given_one():
    prefs = ["sec-ct", "sec-day", "sec-night", "sec-oncall"]
    shifts = [asg("x", "night-thu", THU, "clin-anna"), asg("b", "oncall-sat", SAT, "clin-ben")]
    state = make_swap_state(shifts, clinicians=_ben_with(preferredClassIds=prefs))
    option = _option(_search(state, "x", "swap"), "clin-ben|oncall-sat@2026-01-10")
    assert "section_preference" not in [f["code"] for f in option["findings"]]


def test_hours_above_contract_finding():
    state = make_swap_state(_weekdays("b", "clin-ben") + [asg("x", "early-sat", SAT, "clin-anna")])
    finding = _single_finding(_search(state, "x", partnerId="clin-ben"), "clin-ben|-", "hours_above_contract")
    assert finding == {"code": "hours_above_contract", "clinicianId": "clin-ben",
                       "message": "Ben Ott: week 2 at 45.0 h (contract 40 h).", "short": "+5 h over contract"}


def test_giver_below_contract_finding():
    state = make_swap_state(_weekdays("a", "clin-anna"))
    result = _search(state, "a-thu", partnerId="clin-ben")
    finding = _single_finding(result, "clin-ben|-", "giver_below_contract")
    assert finding == {"code": "giver_below_contract", "clinicianId": "clin-anna",
                       "message": "Anna Weber: week 2 drops to 32.0 h (contract 40 h).",
                       "short": "−8 h under contract"}


def test_partner_notice_finding():
    state = make_swap_state([asg("x", "ct-thu", THU, "clin-anna"), asg("b", "ct-wed", WED, "clin-ben")])
    # Ben's Wed 08:00 in Berlin is 10 h away; Anna's Thu shift 34 h.
    result = _search(state, "x", "swap", now=_utc("2026-01-06T21:00Z"))
    assert result["target"]["insideNotice"] is True
    finding = _single_finding(result, "clin-ben|ct-wed@2026-01-07", "partner_notice")
    assert finding == {"code": "partner_notice", "clinicianId": "clin-ben",
                       "message": "Ben Ott's shift starts in 10 h (notice period 48 h).",
                       "short": "Starts in 10 h"}
    option = _option(result, "clin-ben|ct-wed@2026-01-07")
    assert (option["insideNotice"], option["takeHoursUntilStart"]) == (True, 10.0)


# --- Rest days ----------------------------------------------------------------


def _rest(assignment_id: str, date_iso: str, clinician_id: str) -> Assignment:
    return asg(assignment_id, "pool-rest-day", date_iso, clinician_id, locked=False)


@pytest.mark.parametrize("assignments, moves", [
    ([asg("x", "night-thu", THU, "clin-anna"), _rest("r", FRI, "clin-anna")],
     [{"fromClinicianId": "clin-anna", "toClinicianId": "clin-ben", "dateISO": FRI}]),
    ([asg("x", "oncall-tue", TUE, "clin-anna"), _rest("r", WED, "clin-anna")],
     [{"fromClinicianId": "clin-anna", "toClinicianId": "clin-ben", "dateISO": WED}]),
    ([asg("x", "night-thu", THU, "clin-anna"), _rest("r", FRI, "clin-anna"), _rest("rb", FRI, "clin-ben")],
     []),
    ([asg("x", "night-thu", THU, "clin-anna"), _rest("r", FRI, "clin-anna"),
      asg("b", "late-fri", FRI, "clin-ben")], []),
], ids=["night", "on-call", "taker-rests", "taker-works"])
def test_rest_day_moves(assignments: List[Assignment], moves: List[Dict[str, str]]):
    option = _option(_search(make_swap_state(assignments), "x", partnerId="clin-ben"), "clin-ben|-")
    assert option["group"] != "blocked"
    assert option["restDayMoves"] == moves
    assert option["restDayRemovals"] == []


def _plan(state: AppState, mode: str, give_id: str, partner_id: str,
          take_id: Optional[str] = None) -> MovePlan:
    ctx = SwapContext(state, RULES, NOW)

    def unit(assignment_id: str) -> SwapUnit:
        block = next(b for cid in ctx.by_person for b in ctx.blocks(cid)
                     if any(i.assignment.id == assignment_id for i in b.items))
        return SwapUnit(block.clinician_id, (block,))

    return plan_option(ctx, mode, unit(give_id), partner_id, take=unit(take_id) if take_id else None)


def test_the_takers_rest_day_on_a_received_date_is_removed():
    rest = _rest("rb", THU, "clin-ben")
    state = make_swap_state([asg("x", "ct-thu", THU, "clin-anna"), rest])
    option = _option(_search(state, "x", partnerId="clin-ben"), "clin-ben|-")
    assert option["restDayRemovals"] == [{"clinicianId": "clin-ben", "name": "Ben Ott", "dateISO": THU}]
    plan = _plan(state, "handover", "x", "clin-ben")
    assert plan.rest_day_removals == [rest]
    assert any(a is rest for a in plan.removed)


def test_a_rest_day_on_the_end_date_of_a_received_night_stays():
    rest = _rest("rb", FRI, "clin-ben")
    state = make_swap_state([asg("x", "night-thu", THU, "clin-anna"), rest])
    plan = _plan(state, "handover", "x", "clin-ben")
    assert plan.rest_day_removals == [] and plan.rest_day_moves == []
    assert not any(a is rest for a in plan.removed)


def test_a_moved_rest_day_is_not_removed_twice():
    # Anna's Rest Day after her Wed night follows the night to Ben, although
    # Anna now works that Thursday.
    rest = _rest("ra", THU, "clin-anna")
    state = make_swap_state([asg("x", "night-wed", WED, "clin-anna"), rest,
                             asg("y", "ct-thu", THU, "clin-ben")])
    plan = _plan(state, "swap", "x", "clin-ben", "y")
    assert [(m.from_id, m.to_id, m.date_iso) for m in plan.rest_day_moves] == [("clin-anna", "clin-ben", THU)]
    assert plan.rest_day_removals == []
    assert sum(a is rest for a in plan.removed) == 1
    option = _option(_search(state, "x", "swap"), "clin-ben|ct-thu@2026-01-08")
    assert (len(option["restDayMoves"]), option["restDayRemovals"]) == (1, [])


# --- Pre-existing problems ----------------------------------------------------


def test_a_weekly_overload_the_handover_lowers_is_preexisting():
    days = zip(("mon", "tue", "wed", "thu", "fri", "sat", "sun"), (MON, TUE, WED, THU, FRI, SAT, SUN))
    state = make_swap_state([asg(f"b-{d}", f"ct-{d}", day, "clin-ben") for d, day in days])  # 56 h
    option = _option(_search(state, "b-thu", partnerId="clin-anna"), "clin-anna|-")
    assert option["group"] != "blocked"
    assert option["preexisting"] == ["weekly_hours"]


def test_a_kept_short_rest_is_preexisting():
    state = make_swap_state([asg("l", "late-mon", MON, "clin-anna"), asg("e", "early-tue", TUE, "clin-anna"),
                             asg("x", "ct-thu", THU, "clin-anna")])
    result = _search(state, "x", partnerId="clin-ben", rules=SwapRules(min_rest_hours=16))
    option = _option(result, "clin-ben|-")
    assert option["preexisting"] == ["rest"]
    assert option["warnings"] == []


def test_a_vacation_hidden_shift_is_never_a_preexisting_vacation_problem():
    anna = _person("clin-anna", "Anna Weber")
    anna.vacations.append(VacationRange(id="v", startISO=TUE, endISO=TUE))
    state = make_swap_state([asg("h", "ct-tue", TUE, "clin-anna"), asg("x", "ct-thu", THU, "clin-anna")],
                            clinicians=[anna] + default_clinicians()[1:])
    option = _option(_search(state, "x", partnerId="clin-ben"), "clin-ben|-")
    assert option["group"] != "blocked"
    assert option["preexisting"] == []


# --- Blocked targets ----------------------------------------------------------


def test_blocked_targets_without_a_unit():
    anna = _person("clin-anna", "Anna Weber")
    anna.vacations.append(VacationRange(id="v", startISO=FRI, endISO=FRI))
    state = make_swap_state([_rest("rest", THU, "clin-anna"), asg("hidden", "ct-fri", FRI, "clin-anna"),
                             asg("untimed", "bad-sat", SAT, "clin-anna")],
                            clinicians=[anna] + default_clinicians()[1:])
    # 20:00-08:00 without an end-day offset has no valid interval.
    state.weeklyTemplate.locations[0].slots.append(make_template_slot(
        "bad-sat", col_band_id="col-sat", block_id="block-night", start_time="20:00", end_time="08:00"))
    expected = {
        "rest": ("pool_row", "Rest Day and Vacation entries can't be swapped.", THU, "Rest Day"),
        "hidden": ("vacation_hidden", "Anna Weber is on vacation on Fri 9 Jan; this shift is hidden. "
                   "Use Find cover on the open slot instead.", FRI, "CT"),
        "untimed": ("no_times", "This shift has no valid times in the template.", SAT, "Night duty"),
    }
    for assignment_id, (code, message, day, section) in expected.items():
        result = _search(state, assignment_id, "swap")
        target = result["target"]
        assert target["blocked"] == {"code": code, "message": message}
        assert (target["dateISO"], target["sectionName"], target["holderId"]) == (day, section, "clin-anna")
        assert target["unit"] is target["startsAt"] is target["hoursUntilStart"] is None
        assert (target["blocksOnDate"], target["wholeDay"], target["insideNotice"]) == (0, False, False)
        assert result["checks"] == [] and result["closest"] == []


def test_cover_targets_inactive_full_and_with_holders():
    inactive = _cover(make_swap_state(), "ct-fri", THU)["target"]
    assert inactive["blocked"] == {"code": "inactive_slot",
                                   "message": "This slot does not exist on this day."}
    assert inactive["unit"] is inactive["openCount"] is inactive["startsAt"] is None
    assert inactive["sectionName"] == "CT"

    full = _cover(make_swap_state([asg("b", "ct-thu", THU, "clin-ben")]), "ct-thu", THU)
    assert full["target"]["blocked"] == {"code": "not_open", "message": "This slot has no open position."}
    assert full["target"]["unit"]["items"][0]["clinicianId"] is None
    assert full["target"]["openCount"] == 0
    assert full["checks"] == []

    anna = _person("clin-anna", "Anna Weber")
    anna.vacations.append(VacationRange(id="v", startISO=THU, endISO=THU))
    state = make_swap_state([asg("b", "ct-thu", THU, "clin-ben"), asg("a", "ct-thu", THU, "clin-anna")],
                            clinicians=[anna] + default_clinicians()[1:],
                            slot_overrides={f"ct-thu__{THU}": 1})
    result = _cover(state, "ct-thu", THU)
    assert result["target"]["excludedPartnerIds"] == ["clin-anna", "clin-ben"]
    assert result["target"]["blocked"] is None
    assert {option["partnerId"] for option in _options(result)} == {"clin-clara", "clin-dora"}
    assert [check["code"] for check in result["checks"]][-4:] == ["capacity", "rest", "night_free_day",
                                                                   "block_length"]


# --- Baseline cache -----------------------------------------------------------


def test_two_blocks_of_one_partner_in_one_week_share_a_baseline(monkeypatch):
    baselines: List[ValidationReport] = []
    original = matching.validate_assignments

    def counting(*args: Any, **kwargs: Any) -> ValidationReport:
        baselines.append(original(*args, **kwargs))
        return baselines[-1]

    monkeypatch.setattr(matching, "validate_assignments", counting)
    state = make_swap_state([asg("x", "ct-thu", THU, "clin-anna"), asg("tue", "ct-tue", TUE, "clin-ben"),
                             asg("fri", "ct-fri", FRI, "clin-ben")])
    result = _search(state, "x", "swap")
    assert result["totals"]["best"] == 2
    assert len(baselines) == 1
