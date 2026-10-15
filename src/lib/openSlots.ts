import { getDayType } from "./dayTypes";
import type { ScheduleRow } from "./shiftRows";

export type OpenSlotTarget = { rowId: string; dateISO: string };

type MinSlotsByRowId = Record<string, { weekday: number; weekend: number }>;

/** Saturday, Sunday or a holiday (minimum slots then use the weekend count). */
export function isWeekendOrHoliday(dateISO: string, holidayDates: Set<string>): boolean {
  const day = new Date(`${dateISO}T00:00:00`).getDay();
  return day === 0 || day === 6 || holidayDates.has(dateISO);
}

/**
 * Open slots of the calendar: for every class row on every date, how many
 * people the cell still misses (required = template requiredSlots, else the
 * row's weekday/weekend minimum, plus the per-cell override, never below 0).
 * Rows whose day type does not match the date are skipped. `targets` lists
 * the cells that miss people, day by day and in row order within a day (the
 * order the open-slots badge cycles through).
 */
export function computeOpenSlots({
  dateISOs,
  rowIds,
  rowById,
  cells,
  minSlotsByRowId,
  slotOverridesByKey,
  holidayDates,
}: {
  dateISOs: string[];
  rowIds: string[];
  rowById: Map<string, ScheduleRow>;
  /** Assignments per `${rowId}__${dateISO}` as rendered (vacation-filtered). */
  cells: Map<string, unknown[]>;
  minSlotsByRowId: MinSlotsByRowId;
  slotOverridesByKey: Record<string, number>;
  holidayDates: Set<string>;
}): { count: number; targets: OpenSlotTarget[] } {
  let count = 0;
  const targets: OpenSlotTarget[] = [];
  for (const dateISO of dateISOs) {
    const dayType = getDayType(dateISO, holidayDates);
    for (const rowId of rowIds) {
      const row = rowById.get(rowId);
      if (!row || row.kind !== "class") continue;
      if (row.dayType && row.dayType !== dayType) continue;
      const minSlots = minSlotsByRowId[rowId] ?? { weekday: 0, weekend: 0 };
      const baseRequired =
        typeof row.requiredSlots === "number"
          ? row.requiredSlots
          : isWeekendOrHoliday(dateISO, holidayDates)
            ? minSlots.weekend
            : minSlots.weekday;
      const override = slotOverridesByKey[`${rowId}__${dateISO}`] ?? 0;
      const required = Math.max(0, baseRequired + override);
      const missing = required - (cells.get(`${rowId}__${dateISO}`)?.length ?? 0);
      if (missing > 0) {
        count += missing;
        targets.push({ rowId, dateISO });
      }
    }
  }
  return { count, targets };
}
