import type { Assignment } from "../api/client";
import { isProtectedAssignment } from "../lib/assignmentPolicy";
import { splitAssignmentKey } from "../lib/schedule";

/**
 * "Reset → Unlocked shifts": remove what a stored solver draft would replace,
 * the same rule as backend/assignment_policy.py::is_replaced_by_draft.
 * Unlocked shifts (planner entries, and hand-placed ones someone unlocked) of
 * non-pool rows inside the range go, including entries on the clinician's
 * vacation days (hidden in the grid anyway). Locked shifts, pool entries and
 * everything outside the range stay. Returns `prev` itself when nothing changes.
 */
export function resetSolverAssignments(
  prev: Map<string, Assignment[]>,
  range: { startISO: string; endISO: string },
): Map<string, Assignment[]> {
  let next: Map<string, Assignment[]> | null = null;
  for (const [key, list] of prev) {
    const { rowId, dateISO } = splitAssignmentKey(key);
    if (!rowId || !dateISO || rowId.startsWith("pool-")) continue;
    if (dateISO < range.startISO || dateISO > range.endISO) continue;
    const kept = list.filter(isProtectedAssignment);
    if (kept.length === list.length) continue;
    next ??= new Map(prev);
    if (kept.length === 0) next.delete(key);
    else next.set(key, kept);
  }
  return next ?? prev;
}

/**
 * "Reset → Unlocked shifts and rest days": the shifts "Unlocked shifts"
 * removes, and the pool rows (Rest Day) of the range are emptied too. Locked
 * shifts stay — since v1.69 that includes every hand-placed shift nobody
 * unlocked (before, this reset removed manual entries). In pool rows, which
 * have no lock button, hand-made entries on the clinician's vacation days
 * stay (hidden in the grid). Returns `prev` when nothing changes.
 */
export function resetUnfixedAssignments(
  prev: Map<string, Assignment[]>,
  range: { startISO: string; endISO: string },
  isOnVacation: (clinicianId: string, dateISO: string) => boolean,
): Map<string, Assignment[]> {
  let next: Map<string, Assignment[]> | null = null;
  for (const [key, list] of prev) {
    const { rowId, dateISO } = splitAssignmentKey(key);
    if (!rowId || !dateISO) continue;
    if (dateISO < range.startISO || dateISO > range.endISO) continue;
    const isPool = rowId.startsWith("pool-");
    const kept = list.filter((item) =>
      isPool
        ? item.locked === true ||
          (isProtectedAssignment(item) && isOnVacation(item.clinicianId, dateISO))
        : isProtectedAssignment(item),
    );
    if (kept.length === list.length) continue;
    next ??= new Map(prev);
    if (kept.length === 0) next.delete(key);
    else next.set(key, kept);
  }
  return next ?? prev;
}
