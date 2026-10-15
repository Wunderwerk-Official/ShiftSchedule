import { MINUTES_PER_DAY, addDaysISO, dayDiff } from "./dates";
import { collectShifts, createPlanContext } from "./shifts";
import type { PlanShift, PlanSource } from "./types";

// "Working with you": colleagues found by interval overlap at the same
// location (not by the same dateISO), so a night also lists colleagues of the
// next morning who start before it ends. All groups stay at the shift's
// location (SPEC R12), "same duty" included.

export type Coworker = {
  clinicianId: string;
  name: string;
  /** The colleague's matching shift (times relative to its own dateISO). */
  shift: PlanShift;
};

export type CoworkerGroups = {
  /** Overlapping, same location, and same section or both duties. */
  sameDuty: Coworker[];
  /** Overlapping, same location, other section. */
  sameTimeAtLocation: Coworker[];
  /** Same location and start day, no overlap. */
  otherAtLocation: Coworker[];
};

const MAX_SHIFT_DAYS = 3;

export function findCoworkers(source: PlanSource, shift: PlanShift): CoworkerGroups {
  const ctx = createPlanContext(source);
  const lastDay = addDaysISO(shift.dateISO, Math.floor(shift.endMin / MINUTES_PER_DAY));
  const candidates = collectShifts(ctx, {
    fromISO: addDaysISO(shift.dateISO, -MAX_SHIFT_DAYS),
    toISO: lastDay,
  });
  // One entry per colleague: best group wins (0 = same duty), then earliest start.
  const best = new Map<string, { group: number; start: number; shift: PlanShift }>();
  for (const other of candidates) {
    if (other.clinicianId === shift.clinicianId) continue;
    if (other.locationId !== shift.locationId) continue;
    const offset = dayDiff(shift.dateISO, other.dateISO) * MINUTES_PER_DAY;
    const start = offset + other.startMin;
    const end = offset + other.endMin;
    const overlaps = start < shift.endMin && shift.startMin < end;
    let group: number;
    if (overlaps) {
      const sameSection = !!shift.sectionId && other.sectionId === shift.sectionId;
      group = sameSection || (shift.kind === "duty" && other.kind === "duty") ? 0 : 1;
    } else if (other.dateISO === shift.dateISO) {
      group = 2;
    } else {
      continue;
    }
    const current = best.get(other.clinicianId);
    if (!current || group < current.group || (group === current.group && start < current.start)) {
      best.set(other.clinicianId, { group, start, shift: other });
    }
  }
  const groups: Coworker[][] = [[], [], []];
  const entries = [...best.entries()].map(([clinicianId, entry]) => ({
    ...entry,
    coworker: {
      clinicianId,
      name: ctx.clinicianById.get(clinicianId)?.name ?? clinicianId,
      shift: entry.shift,
    },
  }));
  entries.sort((a, b) => a.start - b.start || a.coworker.name.localeCompare(b.coworker.name));
  for (const entry of entries) groups[entry.group].push(entry.coworker);
  return { sameDuty: groups[0], sameTimeAtLocation: groups[1], otherAtLocation: groups[2] };
}
