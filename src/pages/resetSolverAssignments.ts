import type { Assignment } from "../api/client";
import { isProtectedAssignment } from "../lib/assignmentPolicy";
import { splitAssignmentKey } from "../lib/schedule";

/**
 * "Reset Solver Only": remove what a stored solver draft would replace, the
 * same rule as backend/assignment_policy.py::is_replaced_by_draft. Unlocked
 * solver entries of non-pool rows inside the range go, including entries on
 * the clinician's vacation days (hidden in the grid anyway). Manual/legacy
 * and locked entries, pool entries and everything outside the range stay.
 * Returns `prev` itself when nothing changes.
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
 * "Reset Unfixed": remove every entry in the range (pool rows included)
 * except locked ones and manual/legacy ones on the clinician's vacation days.
 * Unlocked solver entries go on vacation days too, so this always removes at
 * least what "Reset Solver Only" removes. Returns `prev` when nothing changes.
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
    const kept = list.filter(
      (item) =>
        item.locked === true ||
        (isProtectedAssignment(item) && isOnVacation(item.clinicianId, dateISO)),
    );
    if (kept.length === list.length) continue;
    next ??= new Map(prev);
    if (kept.length === 0) next.delete(key);
    else next.set(key, kept);
  }
  return next ?? prev;
}
