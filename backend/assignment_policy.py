"""Protection is independent of assignment provenance; legacy entries stay fixed."""

# The built-in Rest Day row. Its stored entries are people placed there by
# hand (the on-call rest rule's rest days are computed for display only).
REST_DAY_ROW_ID = "pool-rest-day"


def is_protected_assignment(assignment):
    return assignment.source != "solver" or assignment.locked


def is_replaced_by_draft(assignment, start_iso, end_iso):
    """A stored draft replaces every unprotected, non-pool entry in its range,
    including entries hidden by the clinician's vacation (the UI never shows
    them, and the agent harness already replaces them)."""
    return (start_iso <= assignment.dateISO <= end_iso
            and not assignment.rowId.startswith("pool-")
            and not is_protected_assignment(assignment))


def manual_rest_days(*assignment_lists):
    """``{(clinicianId, dateISO)}`` of every stored Rest Day row entry.

    Such a person is off that day: no planner places them on a shift dated
    that day (as with vacation, a shift counts on its start date, so an
    overnight shift starting the evening before stays possible). Any source
    counts. Stored ``pool-vacation`` entries are legacy and deliberately not
    read: vacation comes from ``Clinician.vacations``. One pass per list.
    """
    return {
        (a.clinicianId, a.dateISO)
        for assignments in assignment_lists
        for a in assignments
        if a.rowId == REST_DAY_ROW_ID
    }
