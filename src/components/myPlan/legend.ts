import type { Location } from "../../api/client";
import { locationTint, type LocationTint, type PersonPlan, type PlanDay } from "../../lib/myPlan";

// Footer legend (SPEC C3/C5.14): only what is visible in the period —
// sections, duties, absences, tinted locations, holidays — in that group
// order, each group in order of first appearance. Pure, so it is tested.

export type LegendGroup = "section" | "duty" | "absence" | "location" | "state";

export type LegendSwatch =
  | { kind: "block"; fill: string; border: string; duty: boolean }
  | { kind: "vacation" }
  | { kind: "rest" }
  | { kind: "location"; tint: LocationTint }
  | { kind: "holiday" };

export type LegendItem = { key: string; label: string; group: LegendGroup; swatch: LegendSwatch };

export type LegendResult = {
  items: LegendItem[];
  /** A visible shift lies in an unpublished week ("Draft – not published"). */
  hasDraft: boolean;
};

const GROUP_ORDER: LegendGroup[] = ["section", "duty", "absence", "location", "state"];

export function buildLegend(input: {
  /** Visible dates (the period); days of other plans outside it are ignored. */
  days: PlanDay[];
  /** The viewed plan first, then e.g. day-view colleague lanes. */
  plans: PersonPlan[];
  locationsById: Map<string, Location>;
}): LegendResult {
  const visible = new Set(input.days.map((day) => day.dateISO));
  const items = new Map<string, LegendItem>();
  let hasDraft = false;
  const add = (item: LegendItem) => {
    if (!items.has(item.key)) items.set(item.key, item);
  };

  for (const plan of input.plans) {
    for (const day of plan.days) {
      if (!visible.has(day.dateISO)) continue;
      for (const segment of day.segments) {
        const shift = plan.shifts.get(segment.shiftId);
        if (!shift) continue;
        if (!shift.published) hasDraft = true;
        const group: LegendGroup = shift.kind === "duty" ? "duty" : "section";
        add({
          key: `${group}:${shift.title}:${shift.colors.fill}`,
          label: shift.title,
          group,
          swatch: { kind: "block", fill: shift.colors.fill, border: shift.colors.border, duty: shift.kind === "duty" },
        });
      }
      for (const absence of day.absences) {
        add({
          key: `absence:${absence.kind}`,
          label: absence.label,
          group: "absence",
          swatch: { kind: absence.kind },
        });
      }
      for (const locationId of day.startLocationIds) {
        const location = input.locationsById.get(locationId);
        const tint = locationTint(location?.color);
        if (!location || !tint) continue;
        add({
          key: `location:${location.id}`,
          label: location.name,
          group: "location",
          swatch: { kind: "location", tint },
        });
      }
      if (day.holidayName) {
        add({ key: "state:holiday", label: "Holiday", group: "state", swatch: { kind: "holiday" } });
      }
    }
  }

  const sorted = [...items.values()].sort(
    (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
  );
  return { items: sorted, hasDraft };
}
