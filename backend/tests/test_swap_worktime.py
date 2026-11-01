"""Working-time warnings and weekly hours of a swap."""

from typing import Dict

from backend.models import AppState, VacationRange
from backend.swaps import labels
from backend.swaps.policy import SwapRules
from backend.swaps.worktime import (
    WorkWarning,
    iso_week,
    kept_warnings,
    new_warnings,
    person_hours,
    person_warnings,
    week_minutes,
)
from backend.validation import VIOLATION_WEEKLY_HOURS, build_validation_context, validate_weekly_hours

from .conftest import DAY_TYPES, make_clinician, make_template_slot
from .swap_fixtures import ALL_SECTIONS, FRI, MON, SAT, SUN, THU, TUE, WEEK, asg, make_swap_state

NAMES = {"clin-anna": "Anna Weber", "clin-ben": "Ben Ott"}
RULES = SwapRules()


def _warnings(state: AppState, clinician_id: str, rules: SwapRules = RULES) -> Dict[str, WorkWarning]:
    vctx = build_validation_context(state)
    return person_warnings(vctx, rules, state.assignments, clinician_id, NAMES[clinician_id])


def test_short_rest_id_message_and_chip():
    state = make_swap_state([asg("c", "ct-thu", THU, "clin-ben")])
    before = list(state.assignments)
    after = before + [asg("n", "night-thu", THU, "clin-ben")]
    vctx = build_validation_context(state)
    (warning,) = new_warnings(vctx, RULES, before, after, ["clin-ben"], NAMES)
    assert warning.id == "rest:clin-ben:2026-01-08T16:00:2026-01-08T20:00"
    assert (warning.code, warning.check, warning.clinician_id) == ("rest_short", "rest", "clin-ben")
    assert warning.message == ("Ben Ott: only 4.0 h rest between Thu 8 Jan 16:00 and Thu 8 Jan 20:00 "
                               "(minimum 11 h).")
    assert warning.short == "Short rest 4 h"
    assert warning.date_iso == THU
    assert warning.as_json() == {
        "id": warning.id, "code": "rest_short", "check": "rest", "clinicianId": "clin-ben",
        "message": warning.message, "short": "Short rest 4 h",
    }


def test_an_existing_short_rest_is_kept_not_new():
    before = [asg("c", "ct-mon", MON, "clin-anna"), asg("n", "night-mon", MON, "clin-anna")]
    after = before + [asg("w", "ct-thu", THU, "clin-anna")]
    vctx = build_validation_context(make_swap_state(before))
    assert new_warnings(vctx, RULES, before, after, ["clin-anna"], NAMES) == []
    (kept,) = kept_warnings(vctx, RULES, before, after, ["clin-anna"], NAMES)
    assert kept.id == "rest:clin-anna:2026-01-05T16:00:2026-01-05T20:00"


def test_night_without_free_day_after_it():
    state = make_swap_state([asg("n", "night-thu", THU, "clin-anna"), asg("l", "late-fri", FRI, "clin-anna")])
    warnings = _warnings(state, "clin-anna")
    night = warnings["night:clin-anna:2026-01-08T20:00:2026-01-09"]
    assert (night.code, night.check, night.date_iso) == ("night_no_free_day", "night_free_day", THU)
    assert night.message == ("Anna Weber: no free day after the night ending Fri 9 Jan 08:00 "
                             "(works again Fri 9 Jan 12:00).")
    assert night.short == "No free day after night"
    # 08:00 to 12:00 is also a short rest.
    assert sorted(w.code for w in warnings.values()) == ["night_no_free_day", "rest_short"]


def test_night_followed_by_a_free_day_has_no_warning():
    state = make_swap_state([asg("n", "night-thu", THU, "clin-anna"), asg("s", "ct-sat", SAT, "clin-anna")])
    assert _warnings(state, "clin-anna") == {}


def test_block_longer_than_the_maximum():
    state = make_swap_state(
        [asg("o", "oncall-sat", SAT, "clin-anna"), asg("c", "ct-sun", SUN, "clin-anna")],
        solver_settings={"onCallRestEnabled": False},
    )
    (warning,) = _warnings(state, "clin-anna").values()
    assert warning.id == "long:clin-anna:2026-01-10T08:00:2026-01-11T16:00"
    assert (warning.code, warning.check, warning.date_iso) == ("block_too_long", "block_length", SAT)
    assert warning.message == ("Anna Weber: 32.0 h without a break, Sat 10 Jan 08:00 → Sun 11 Jan 16:00 "
                               "(maximum 24 h).")
    assert warning.short == "32 h stretch"


def test_custom_rules_change_the_limits():
    state = make_swap_state([asg("n", "night-sun", SUN, "clin-anna"),
                             asg("e", "evening-mon", "2026-01-12", "clin-anna")])
    state.weeklyTemplate.locations[0].slots.append(
        make_template_slot("evening-mon", col_band_id="col-mon", block_id="block-day",
                           start_time="18:30", end_time="22:00"))
    rest = _warnings(state, "clin-anna")["rest:clin-anna:2026-01-12T08:00:2026-01-12T18:30"]
    assert rest.message == ("Anna Weber: only 10.5 h rest between Mon 12 Jan 08:00 and Mon 12 Jan 18:30 "
                            "(minimum 11 h).")
    assert rest.short == "Short rest 10.5 h"
    relaxed = _warnings(state, "clin-anna", SwapRules(min_rest_hours=10))
    assert [w.code for w in relaxed.values()] == ["night_no_free_day"]

    long_state = make_swap_state([asg("o", "oncall-sat", SAT, "clin-anna")])
    assert _warnings(long_state, "clin-anna") == {}
    (long_warning,) = _warnings(long_state, "clin-anna", SwapRules(max_block_hours=20)).values()
    assert long_warning.message.endswith("(maximum 20 h).")


def test_warnings_ignore_hidden_items_and_other_people():
    anna = make_clinician("clin-anna", "Anna Weber", list(ALL_SECTIONS), working_hours_per_week=40,
                          vacations=[VacationRange(id="v", startISO=FRI, endISO=FRI)])
    state = make_swap_state(
        [
            asg("n", "night-thu", THU, "clin-anna"),
            asg("l", "late-fri", FRI, "clin-anna"),  # hidden: would be a short rest after the night
            asg("b", "ct-thu", THU, "clin-ben"),  # ends 16:00, four hours before Anna's night
        ],
        clinicians=[anna, make_clinician("clin-ben", "Ben Ott", list(ALL_SECTIONS))],
    )
    assert _warnings(state, "clin-anna") == {}
    assert _warnings(state, "clin-ben") == {}


def test_week_minutes_count_like_the_validator_including_hidden_assignments():
    ben = make_clinician("clin-ben", "Ben Ott", list(ALL_SECTIONS), working_hours_per_week=40,
                         vacations=[VacationRange(id="v", startISO=SUN, endISO=SUN)])
    assignments = [asg(f"c-{dt}", f"ct-{dt}", day, "clin-ben") for dt, day in zip(DAY_TYPES, WEEK)]
    assignments += [asg("rest", "pool-rest-day", "2026-01-12", "clin-ben", locked=False),
                    asg("other", "ct-mon", MON, "clin-anna")]
    state = make_swap_state(assignments, clinicians=[ben, make_clinician("clin-anna", "Anna Weber")])
    vctx = build_validation_context(state)
    (violation,) = [v for v in validate_weekly_hours(state, state.assignments)
                    if v.clinician_id == "clin-ben"]
    assert violation.code == VIOLATION_WEEKLY_HOURS
    minutes = week_minutes(vctx, state.assignments, "clin-ben", [iso_week(MON), iso_week("2026-01-12")])
    assert minutes == {(2026, 2): violation.context["assigned_minutes"], (2026, 3): 0}
    assert minutes[(2026, 2)] == 7 * 8 * 60  # Sunday's hidden shift counts


def test_person_hours_payload():
    anna = make_clinician("clin-anna", "Anna Weber", list(ALL_SECTIONS), working_hours_per_week=38.5)
    anna.workingHoursToleranceHours = 0
    dora = make_clinician("clin-dora", "Dora Klein", list(ALL_SECTIONS))
    state = make_swap_state(clinicians=[anna, dora])
    vctx = build_validation_context(state)
    before = [asg("a", "ct-mon", MON, "clin-anna"), asg("d", "ct-tue", TUE, "clin-dora")]
    after = [asg("a2", "night-thu", THU, "clin-anna"), asg("d", "ct-tue", TUE, "clin-dora"),
             asg("x", "ct-mon", "2026-01-12", "clin-anna")]
    weeks = [iso_week("2026-01-12"), iso_week(MON)]
    assert person_hours(vctx, anna, before, after, weeks) == {
        "clinicianId": "clin-anna",
        "name": "Anna Weber",
        "weeks": [
            {"isoYear": 2026, "isoWeek": 2, "weekStartISO": MON, "beforeMinutes": 480, "afterMinutes": 720,
             "contractMinutes": 2310, "limitMinutes": 2310},
            {"isoYear": 2026, "isoWeek": 3, "weekStartISO": "2026-01-12", "beforeMinutes": 0,
             "afterMinutes": 480, "contractMinutes": 2310, "limitMinutes": 2310},
        ],
    }
    dora_week = person_hours(vctx, dora, before, after, [iso_week(MON)])["weeks"][0]
    assert dora_week["beforeMinutes"] == 480
    assert (dora_week["contractMinutes"], dora_week["limitMinutes"]) == (None, None)


def test_iso_week_at_the_year_boundary():
    assert iso_week("2026-01-01") == (2026, 1)
    assert iso_week("2027-01-01") == (2026, 53)


def test_label_number_and_time_formats():
    assert labels.hours_text(2640) == "44.0"
    assert labels.compact_number(40) == "40"
    assert labels.compact_number(38.5) == "38.5"
    assert labels.compact_number(47.96) == "48"
    assert labels.day_label("2026-11-19") == "Thu 19 Nov"
    assert labels.day_label("2026-12-01") == "Tue 1 Dec"
    assert labels.time_range("2026-11-19T08:00", "2026-11-19T16:00") == "08:00–16:00"
    assert labels.time_range("2026-11-19T20:00", "2026-11-20T08:00") == "20:00 → 08:00"
    assert labels.window_range(420, 900) == "07:00–15:00"


def test_label_templates():
    assert labels.weekly_hours("Ben Ott", 47, 2880, 2700) == (
        "Ben Ott: week 47 would reach 48.0 h (limit 45.0 h).")
    assert labels.overlap("Julia Meier", "MRI", "2026-11-19", "2026-11-19T08:00", "2026-11-19T16:00") == (
        "Julia Meier already works MRI on Thu 19 Nov (08:00–16:00).")
    assert labels.swap_invalid(["One.", "Two.", "Three.", "Four."]) == (
        "This swap breaks a planning rule: One. Two. Three.")
    assert labels.notice(10, 48) == (
        "This swap starts in 10 h, inside the 48 h notice period. Confirm the override to apply it.")
    assert labels.hours_above_contract("Ben Ott", 47, 2640, 40) == labels.Note(
        "Ben Ott: week 47 at 44.0 h (contract 40 h).", "+4 h over contract")
    assert labels.giver_below_contract("Anna Weber", 47, 1920, 40) == labels.Note(
        "Anna Weber: week 47 drops to 32.0 h (contract 40 h).", "−8 h under contract")
    assert labels.partner_notice("Ben Ott", 10.0, 48) == labels.Note(
        "Ben Ott's shift starts in 10 h (notice period 48 h).", "Starts in 10 h")
    assert labels.solver_rule("Ben Ott", "Off after Thursday night", "2026-11-20") == labels.Note(
        "Ben Ott: breaks the rule “Off after Thursday night” on Fri 20 Nov.",
        "Rule: Off after Thursday night")
    assert labels.preference_window("Ben Ott", 420, 900, "thu").message == (
        "Ben Ott prefers to work 07:00–15:00 on Thursdays.")
    assert labels.mandatory_window("Ben Ott", 420, 900, "thu") == (
        "Ben Ott must work within 07:00–15:00 on Thursdays.")

