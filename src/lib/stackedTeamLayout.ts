import type { DayColumn } from "./calendarView";
import { buildShiftInterval, formatTimeRangeLabel } from "./schedule";
import type { ScheduleRow } from "./shiftRows";

// "Times: Stacked" team layout (compact week, like a "plan for all"): the
// time columns of a day (col bands) become rows below each other, so every
// day needs one column only and the whole week fits on screen. Each class
// row (location × row band) splits into time lanes, one sub-row each; the
// row band name and the lane's time move into the label column. Slots, their
// ids and all assignment keys stay the same — only the grid's rows and
// columns change, so drag & drop, the picker and "Show in team" keep working.

export type StackedRowMeta = {
  /** The class row this sub-row belongs to (location separators refer to it). */
  sourceRowId: string;
  /** Row band name; set on the first sub-row of its row only. */
  groupLabel?: string;
  /** The sub-row's section when it is not just the row band name again. */
  title?: string;
  /** Section most of the sub-row's visible slots have; a cell with another one names its own. */
  sectionName?: string;
  /** Time most of the sub-row's visible slots have; a cell with another one shows its own. */
  timeLabel?: string;
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
};

export type StackedTeamLayout = {
  rows: ScheduleRow[];
  /** One column per day. */
  columns: DayColumn[];
  /** Meta of every class sub-row by its id (pool rows have none). */
  metaByRowId: Map<string, StackedRowMeta>;
};

const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun", "holiday"];
const dayIndex = (dayType: string) => {
  const index = DAY_ORDER.indexOf(dayType);
  return index === -1 ? DAY_ORDER.length : index;
};
/** Start distance used when a slot or lane has no valid time. */
const UNKNOWN_START_DISTANCE = 10_000;
const MINUTES_PER_DAY = 24 * 60;

/** Distance of two start times on the clock (00:30 is close to 23:30). */
const startDistance = (a: number | undefined, b: number | undefined) => {
  if (a === undefined || b === undefined) return UNKNOWN_START_DISTANCE;
  const distance = Math.abs(a - b) % MINUTES_PER_DAY;
  return Math.min(distance, MINUTES_PER_DAY - distance);
};

/** Most frequent value; on a tie the one that reached that count first. */
const mostCommon = (values: string[]): string | undefined => {
  const counts = new Map<string, number>();
  let best: string | undefined;
  let bestCount = 0;
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
};

export const slotTimeLabel = (slot: ScheduleRow): string | undefined => {
  const interval = buildShiftInterval(slot);
  return interval ? formatTimeRangeLabel(interval.start, interval.end) : undefined;
};

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

type Lane = { time?: string; section?: string; start?: number; slots: ScheduleRow[] };

/**
 * Splits a row's slots into time lanes, at most one slot per day type each.
 * The day type with the most slots opens the lanes in column order; the
 * other days join them by the same time and section, then by the same time,
 * then by the nearest start — so a weekend with fewer columns still puts its
 * night shift into the night lane, and a shorter Friday shift stays in its
 * lane (its cell shows its own time). Matching on time, not on the column
 * number, matters because the template numbers each day's columns on its own.
 */
export function buildTimeLanes(slots: ScheduleRow[]): ScheduleRow[][] {
  const byDay = new Map<string, ScheduleRow[]>();
  for (const slot of slots) {
    const day = slot.dayType ?? "";
    byDay.set(day, [...(byDay.get(day) ?? []), slot]);
  }
  const days = [...byDay.entries()].sort(
    ([dayA, slotsA], [dayB, slotsB]) =>
      slotsB.length - slotsA.length || dayIndex(dayA) - dayIndex(dayB),
  );
  const lanes: Lane[] = [];
  for (const [, daySlots] of days) {
    const ordered = [...daySlots].sort((a, b) => (a.colBandOrder ?? 0) - (b.colBandOrder ?? 0));
    const facts = ordered.map((slot) => ({
      slot,
      time: slotTimeLabel(slot),
      section: slot.sectionId ?? slot.sectionName,
      start: buildShiftInterval(slot)?.start,
    }));
    const free = new Set(lanes.map((_, index) => index));
    const placed = new Map<ScheduleRow, number>();
    const take = (slot: ScheduleRow, index: number) => {
      placed.set(slot, index);
      free.delete(index);
    };
    const matchBy = (fits: (fact: (typeof facts)[number], lane: Lane) => boolean) => {
      for (const fact of facts) {
        if (placed.has(fact.slot)) continue;
        const index = lanes.findIndex((lane, i) => free.has(i) && fits(fact, lane));
        if (index !== -1) take(fact.slot, index);
      }
    };
    matchBy((fact, lane) => !!fact.time && fact.time === lane.time && fact.section === lane.section);
    matchBy((fact, lane) => !!fact.time && fact.time === lane.time);
    for (const fact of facts) {
      if (placed.has(fact.slot)) continue;
      let best = -1;
      let bestDistance = Infinity;
      for (const index of free) {
        const distance = startDistance(fact.start, lanes[index].start);
        // Ties keep the earlier lane (indexes run in lane order).
        if (distance < bestDistance) {
          best = index;
          bestDistance = distance;
        }
      }
      if (best !== -1) {
        take(fact.slot, best);
        continue;
      }
      lanes.push({ time: fact.time, section: fact.section, start: fact.start, slots: [] });
      placed.set(fact.slot, lanes.length - 1);
    }
    for (const [slot, index] of placed) lanes[index].slots.push(slot);
  }
  return lanes.map((lane) =>
    lane.slots.sort((a, b) => dayIndex(a.dayType ?? "") - dayIndex(b.dayType ?? "")),
  );
}

/** One column per day: the first col band column of each date. */
export const buildStackedColumns = (columns: DayColumn[]): DayColumn[] => {
  const seen = new Set<string>();
  const result: DayColumn[] = [];
  for (const column of columns) {
    if (seen.has(column.dateISO)) continue;
    seen.add(column.dateISO);
    result.push({
      ...column,
      colOrder: 1,
      isFirstInDay: true,
      columnIndex: result.length,
      columnTimeLabel: undefined,
      columnHasMixedTimes: false,
    });
  }
  return result;
};

export function buildStackedTeamLayout(
  rows: ScheduleRow[],
  columns: DayColumn[],
): StackedTeamLayout {
  const visibleDayTypes = new Set(columns.map((column) => column.dayType));
  const metaByRowId = new Map<string, StackedRowMeta>();
  const stackedRows: ScheduleRow[] = [];

  for (const row of rows) {
    if (row.kind !== "class") {
      stackedRows.push(row);
      continue;
    }
    const groupLabel = row.rowBandLabel?.trim() || row.sectionName || row.name;
    const slots = row.slotRows ?? [];
    if (slots.length === 0) {
      // Not a grouped row (buildCalendarRows always groups): one lane of its
      // own, moved to column 1 like every stacked slot.
      metaByRowId.set(row.id, {
        sourceRowId: row.id,
        groupLabel,
        timeLabel: slotTimeLabel(row),
        isFirstInGroup: true,
        isLastInGroup: true,
      });
      stackedRows.push({ ...row, colBandOrder: 1 });
      continue;
    }
    const lanes = buildTimeLanes(slots).map((laneSlots, index) => ({
      number: index + 1,
      laneSlots,
      visible: laneSlots.filter((slot) => !slot.dayType || visibleDayTypes.has(slot.dayType)),
    }));
    // A lane without a slot on the visible days would be an empty row; a row
    // without any keeps its first (inactive) lane, as in the side-by-side
    // layout, instead of vanishing from the plan.
    const visibleLanes = lanes.filter((lane) => lane.visible.length > 0);
    const subRows = visibleLanes.length > 0 ? visibleLanes : lanes.slice(0, 1);
    subRows.forEach(({ number, laneSlots, visible }, index) => {
      const id = subRows.length === 1 ? row.id : `${row.id}__t${number}`;
      const sectionName = mostCommon(
        visible.map((slot) => slot.sectionName ?? slot.name).filter(Boolean),
      );
      const timeLabel = mostCommon(
        visible.map(slotTimeLabel).filter((label): label is string => !!label),
      );
      // A later lane without its own time still needs a name in its label.
      const showTitle =
        !!sectionName && (!sameName(sectionName, groupLabel) || (index > 0 && !timeLabel));
      metaByRowId.set(id, {
        sourceRowId: row.id,
        groupLabel: index === 0 ? groupLabel : undefined,
        title: showTitle ? sectionName : undefined,
        sectionName,
        timeLabel,
        isFirstInGroup: index === 0,
        isLastInGroup: index === subRows.length - 1,
      });
      stackedRows.push({
        ...row,
        id,
        // A sub-row has one column per day: its slots move to column 1.
        slotRows: laneSlots.map((slot) => ({ ...slot, colBandOrder: 1 })),
      });
    });
  }

  return { rows: stackedRows, columns: buildStackedColumns(columns), metaByRowId };
}
