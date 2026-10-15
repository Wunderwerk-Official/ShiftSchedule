"""Protection is independent of assignment provenance; legacy entries stay fixed."""

def is_protected_assignment(assignment):
    return assignment.source != "solver" or assignment.locked


def is_replaced_by_draft(assignment, start_iso, end_iso):
    """A stored draft replaces every unprotected, non-pool entry in its range,
    including entries hidden by the clinician's vacation (the UI never shows
    them, and the agent harness already replaces them)."""
    return (start_iso <= assignment.dateISO <= end_iso
            and not assignment.rowId.startswith("pool-")
            and not is_protected_assignment(assignment))
