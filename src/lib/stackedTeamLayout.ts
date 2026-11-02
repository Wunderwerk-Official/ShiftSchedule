import type { DayColumn } from "./calendarView";
import { buildShiftInterval, formatTimeRangeLabel, intervalsOverlap, type TimeRange } from "./schedule";
import type { ScheduleRow } from "./shiftRows";

// "Times: Stacked" team layout (compact week, like a "plan for all"): the
// time columns of a day (col bands) become rows below each other, so every
// day needs one column only and the whole week fits on screen. Each class
// row (location × row band) splits into lanes, one sub-row each: first by
// section, then by time, so a lane never mixes sections (v1.76). The row band
// name, the lane's section and time move into the label column and the cells
// hold only the people. Slots, their ids and all assignment keys stay the
// same — only the grid's rows and columns change, so drag & drop, the picker
// and "Show in team" keep working.

export type StackedRowMeta = {
  /** The class row this sub-row belongs to (location separators refer to it). */
  sourceRowId: string;
  /** Row band name; set on the first sub-row of its row only. */
  groupLabel?: string;
  /** Visible lanes of the class row; set on its first lane (the row band cell spans them). */
  groupSpan?: number;
  /**
   * The lane's section as the label names it. Not set when the section is
   * just the row band name again on the row's first section (the row band
   * name says it).
   */
  title?: string;
  /** The lane's section: every slot of a lane belongs to it. */
  sectionName?: string;
  /** Block color of that section: tints the label like a shift color. */
  sectionColor?: string;
  /** Visible lanes of the section in a row; set on its first lane (the section cell spans them). */
  sectionSpan?: number;
  /** Time most of the sub-row's visible slots have; a cell with another one shows its own. */
  timeLabel?: string;
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
  /** First / last visible lane of its section within the class row. */
  isFirstInSection: boolean;
  isLastInSection: boolean;
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

/**
 * Whether two shifts overlap on the clock, whatever day each starts (a
 * 00:00–08:00 Saturday night shift overlaps a 22:00–06:00 weekday one).
 * Shifts that only touch (07:30–13:00 and 13:00–16:00) do not overlap; a
 * shift without a valid time overlaps anything, so it still finds a lane.
 */
const overlapsOnClock = (a: TimeRange | null, b: TimeRange | null) => {
  if (!a || !b) return true;
  // Shifts last at most four days (end day offset 0–3): shifting one by up
  // to four days covers every way they can meet.
  for (let days = -4; days <= 4; days += 1) {
    const shift = days * MINUTES_PER_DAY;
    if (intervalsOverlap(a, { start: b.start + shift, end: b.end + shift })) return true;
  }
  return false;
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

const slotSection = (slot: ScheduleRow) => slot.sectionName ?? slot.name;
/** What makes two slots the same section (the id, else the name). */
const slotSectionKey = (slot: ScheduleRow) => slot.sectionId ?? slot.sectionName ?? slot.name;
const slotStart = (slot: ScheduleRow) => buildShiftInterval(slot)?.start;

export const slotTimeLabel = (slot: ScheduleRow): string | undefined => {
  const interval = buildShiftInterval(slot);
  return interval ? formatTimeRangeLabel(interval.start, interval.end) : undefined;
};

/** "08:00 - 17:00" → "08:00–17:00": the narrow form for labels and cells. */
export const compactTimeLabel = (label: string) => label.replace(" - ", "–");

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

type Lane = {
  time?: string;
  section?: string;
  /** The opening slot's shift: a slot of another time joins only if it overlaps it. */
  interval: TimeRange | null;
  slots: ScheduleRow[];
};

/**
 * Splits slots into time lanes, at most one slot per day type each (since
 * v1.76 called per section by buildSectionLanes). The day type with the most
 * slots opens the lanes in column order; the other days join them by the same
 * time and section, then by the same time, then by the nearest start among
 * the lanes whose shift overlaps theirs — so a weekend with fewer columns
 * still puts its night shift into the night lane, and a shorter Friday shift
 * or a Saturday 08:00–13:00 next to 07:30–13:00 stays in its lane (its cell
 * shows its own time). A slot that overlaps no free lane opens a lane of its
 * own (the other days are hatched there): a section's morning shift on one
 * day and its afternoon shift on another (07:30–13:00 / 13:00–16:00) never
 * share a lane. Matching on time, not on the column number, matters because
 * the template numbers each day's columns on its own.
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
      interval: buildShiftInterval(slot),
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
        if (!overlapsOnClock(fact.interval, lanes[index].interval)) continue;
        const distance = startDistance(fact.interval?.start, lanes[index].interval?.start);
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
      lanes.push({ time: fact.time, section: fact.section, interval: fact.interval, slots: [] });
      placed.set(fact.slot, lanes.length - 1);
    }
    for (const [slot, index] of placed) lanes[index].slots.push(slot);
  }
  return lanes.map((lane) =>
    lane.slots.sort((a, b) => dayIndex(a.dayType ?? "") - dayIndex(b.dayType ?? "")),
  );
}

export type SectionLane = {
  sectionKey: string;
  sectionName: string;
  /** The lane's slots, at most one per day type, in day order. */
  slots: ScheduleRow[];
};

/**
 * Splits a class row's slots into lanes that never mix sections: the slots
 * are grouped by section, and each section is split into time lanes by
 * buildTimeLanes (same time first, then the nearest overlapping start — a
 * weekend variant with another time stays in its section's lane and its cell
 * shows its own time, while a section's separate time blocks, e.g. a morning
 * on Monday and an afternoon on Wednesday, get a lane each). The order
 * depends only on the row's slots, not on the days on screen, so it is the
 * same in every week:
 * - sections by their earliest start, then by their first slot in template
 *   column order (Mon column 1, Mon column 2, …, Tue column 1, …), then by
 *   name;
 * - a section's lanes by their start: the start of the time most of the
 *   lane's slots have (the first day's on a tie), lanes without a valid time
 *   last.
 */
export function buildSectionLanes(slots: ScheduleRow[]): SectionLane[] {
  // Position in template column order: day, then the day's column.
  const position = (slot: ScheduleRow) =>
    dayIndex(slot.dayType ?? "") * 1000 + (slot.colBandOrder ?? 0);
  type Section = { key: string; name: string; first: number; earliest: number; slots: ScheduleRow[] };
  const sections = new Map<string, Section>();
  for (const slot of slots) {
    const key = slotSectionKey(slot);
    let section = sections.get(key);
    if (!section) {
      section = { key, name: slotSection(slot), first: Infinity, earliest: Infinity, slots: [] };
      sections.set(key, section);
    }
    section.slots.push(slot);
    section.first = Math.min(section.first, position(slot));
    section.earliest = Math.min(section.earliest, slotStart(slot) ?? Infinity);
  }
  const byStart = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);
  return [...sections.values()]
    .sort(
      (a, b) =>
        byStart(a.earliest, b.earliest) ||
        byStart(a.first, b.first) ||
        a.name.localeCompare(b.name),
    )
    .flatMap((section) =>
      buildTimeLanes(section.slots)
        .map((laneSlots, order) => {
          const time = mostCommon(laneSlots.map(slotTimeLabel).filter((label): label is string => !!label));
          const typical = laneSlots.find((slot) => slotTimeLabel(slot) === time);
          return { laneSlots, order, start: (typical && slotStart(typical)) ?? Infinity };
        })
        .sort((a, b) => byStart(a.start, b.start) || a.order - b.order)
        .map(({ laneSlots }) => ({
          sectionKey: section.key,
          sectionName: section.name,
          slots: laneSlots,
        })),
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
        groupSpan: 1,
        sectionName: slotSection(row),
        sectionColor: row.blockColor,
        sectionSpan: 1,
        timeLabel: slotTimeLabel(row),
        isFirstInGroup: true,
        isLastInGroup: true,
        isFirstInSection: true,
        isLastInSection: true,
      });
      stackedRows.push({ ...row, colBandOrder: 1 });
      continue;
    }
    const lanes = buildSectionLanes(slots).map((lane, index) => ({
      ...lane,
      number: index + 1,
      visible: lane.slots.filter((slot) => !slot.dayType || visibleDayTypes.has(slot.dayType)),
    }));
    // A lane without a slot on the visible days would be an empty row; a row
    // without any keeps its first (inactive) lane, as in the side-by-side
    // layout, instead of vanishing from the plan.
    const visibleLanes = lanes.filter((lane) => lane.visible.length > 0);
    const subRows = visibleLanes.length > 0 ? visibleLanes : lanes.slice(0, 1);
    let sectionIndex = -1;
    subRows.forEach((lane, index) => {
      const { number, slots: laneSlots, visible, sectionKey, sectionName } = lane;
      const id = subRows.length === 1 ? row.id : `${row.id}__t${number}`;
      const isFirstInSection = index === 0 || subRows[index - 1].sectionKey !== sectionKey;
      const isLastInSection =
        index === subRows.length - 1 || subRows[index + 1].sectionKey !== sectionKey;
      if (isFirstInSection) sectionIndex += 1;
      let sectionSpan = 0;
      if (isFirstInSection) {
        while (subRows[index + sectionSpan]?.sectionKey === sectionKey) sectionSpan += 1;
      }
      const sectionColor = (
        visible.find((slot) => slot.blockColor) ?? laneSlots.find((slot) => slot.blockColor)
      )?.blockColor;
      const timeLabel = mostCommon(
        visible.map(slotTimeLabel).filter((label): label is string => !!label),
      );
      // The row band name stands for a section of the same name only on the
      // row's first section; a later one, or a later lane without a time of
      // its own, is named.
      const showTitle =
        !sameName(sectionName, groupLabel) || sectionIndex > 0 || (index > 0 && !timeLabel);
      metaByRowId.set(id, {
        sourceRowId: row.id,
        groupLabel: index === 0 ? groupLabel : undefined,
        groupSpan: index === 0 ? subRows.length : undefined,
        title: showTitle ? sectionName : undefined,
        sectionName,
        sectionColor,
        sectionSpan: isFirstInSection ? sectionSpan : undefined,
        timeLabel,
        isFirstInGroup: index === 0,
        isLastInGroup: index === subRows.length - 1,
        isFirstInSection,
        isLastInSection,
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
