import type { Assignment } from "../api/client";

/**
 * Locked shifts (closed lock in the calendars) survive replanning, applying a
 * draft and Reset: everything placed by hand (manual/legacy entries) and
 * planner entries locked afterwards. Same rule as
 * backend/assignment_policy.py::is_protected_assignment.
 */
export const isProtectedAssignment = (assignment: Assignment): boolean =>
  assignment.source !== "solver" || assignment.locked === true;

/**
 * One lock for every shift (v1.69): a shift placed by hand starts locked, a
 * planner shift starts unlocked, and the lock button flips either one.
 * Unlocking hands the shift to the planner (source "solver", so the next plan
 * or a reset may replace it); locking fixes it. Only the protection rule
 * above reads the result, so the backend needs no change.
 */
export function toggleAssignmentLock(assignment: Assignment): Assignment {
  return isProtectedAssignment(assignment)
    ? { ...assignment, source: "solver", locked: false }
    : { ...assignment, locked: true };
}

export type AssignmentIdentity = Pick<Assignment, "id" | "rowId" | "dateISO">;
