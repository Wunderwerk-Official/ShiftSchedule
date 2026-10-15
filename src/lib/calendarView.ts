import type { DayType, WeeklyCalendarTemplate } from "../api/client";
import type { ScheduleRow } from "./shiftRows";
import { getDayType } from "./dayTypes";
import { buildShiftInterval, formatTimeRangeLabel } from "./schedule";
import { toISODate } from "./date";

type ColumnTimeMeta = { label?: string; mixed: boolean };

export type DayColumn = {
  date: Date;
  dateISO: string;
  dayType: ReturnType<typeof getDayType>;
  colOrder: number;
  isFirstInDay: boolean;
  dayIndex: number;
  columnIndex: number;
  columnTimeLabel?: string;
  columnHasMixedTimes?: boolean;
};

export const buildCalendarRows = (scheduleRows: ScheduleRow[]) => {
  const grouped = new Map<string, ScheduleRow>();
  const classRows = scheduleRows.filter((row) => row.kind === "class");
  const poolRows = scheduleRows.filter((row) => row.kind === "pool");
  const dayOrder = new Map(
    ["mon", "tue", "wed", "thu", "fri", "sat", "sun", "holiday"].map((day, idx) => [
      day,
      idx,
    ]),
  );
  classRows.forEach((row) => {
    const groupKey = row.rowBandId
      ? `${row.locationId ?? "loc"}__${row.rowBandId}`
      : row.id;
    const existing = grouped.get(groupKey);
    if (!existing) {
      grouped.set(groupKey, {
        ...row,
        id: `group-${groupKey}`,
        slotRows: [row],
      });
      return;
    }
    const nextSlots = [...(existing.slotRows ?? []), row].sort((a, b) => {
      const dayOrderA = dayOrder.get(a.dayType ?? "mon") ?? 0;
      const dayOrderB = dayOrder.get(b.dayType ?? "mon") ?? 0;
      if (dayOrderA !== dayOrderB) return dayOrderA - dayOrderB;
      return (a.colBandOrder ?? 0) - (b.colBandOrder ?? 0);
    });
    grouped.set(groupKey, { ...existing, slotRows: nextSlots });
  });
  return [...grouped.values(), ...poolRows];
};

export const buildLocationSeparatorRowIds = (calendarRows: ScheduleRow[]) => {
  const ids = new Set<string>();
  let prevLocationId: string | undefined;
  let firstClassRowId: string | undefined;
  for (const row of calendarRows) {
    if (row.kind !== "class") continue;
    if (!row.locationId) continue;
    if (!firstClassRowId) {
      firstClassRowId = row.id;
    }
    if (prevLocationId && row.locationId !== prevLocationId) {
      ids.add(row.id);
    }
    prevLocationId = row.locationId;
  }
  const firstPoolRow = calendarRows.find((row) => row.kind === "pool")?.id;
  if (firstPoolRow) {
    ids.add(firstPoolRow);
  }
  if (firstClassRowId) {
    ids.add(firstClassRowId);
  }
  return Array.from(ids);
};

// Shared time-heading logic: groups class slots by keyOf (null = skip) and
// records one label per group, or mixed when the slots' times differ.
const buildTimeMeta = (
  scheduleRows: ScheduleRow[],
  keyOf: (row: ScheduleRow) => string | null,
): Map<string, ColumnTimeMeta> => {
  const map = new Map<string, ColumnTimeMeta>();
  const state = new Map<string, { label: string; hasSlot: boolean; mixed: boolean }>();
  for (const row of scheduleRows) {
    if (row.kind !== "class") continue;
    if (!row.dayType || !row.colBandOrder) continue;
    const key = keyOf(row);
    if (key === null) continue;
    const interval = buildShiftInterval(row);
    const entry = state.get(key) ?? { label: "", hasSlot: false, mixed: false };
    if (!interval) {
      state.set(key, entry);
      continue;
    }
    const label = formatTimeRangeLabel(interval.start, interval.end);
    entry.hasSlot = true;
    if (!entry.label) {
      entry.label = label;
    } else if (entry.label !== label) {
      entry.mixed = true;
    }
    state.set(key, entry);
  }
  for (const [key, entry] of state.entries()) {
    if (!entry.hasSlot) continue;
    map.set(key, {
      label: entry.mixed ? undefined : entry.label || undefined,
      mixed: entry.mixed,
    });
  }
  return map;
};

/** Time metadata per column. Key format: "dayType-colBandOrder". */
export const buildColumnTimeMetaByKey = (scheduleRows: ScheduleRow[]) =>
  buildTimeMeta(scheduleRows, (row) => `${row.dayType}-${row.colBandOrder}`);

/**
 * Build time metadata per location and column.
 * Key format: "locationId__dayType-colBandOrder"
 * This allows showing per-location time headings when the global column has mixed times.
 */
export const buildLocationColumnTimeMetaByKey = (scheduleRows: ScheduleRow[]) =>
  buildTimeMeta(scheduleRows, (row) =>
    row.locationId ? `${row.locationId}__${row.dayType}-${row.colBandOrder}` : null,
  );

export const buildDayColumns = (
  displayDays: Date[],
  weeklyTemplate: WeeklyCalendarTemplate | undefined,
  holidayDates: Set<string>,
  columnTimeMetaByKey: Map<string, ColumnTimeMeta>,
): DayColumn[] => {
  const columns: DayColumn[] = [];
  if (!weeklyTemplate) {
    displayDays.forEach((date, dayIndex) => {
      const dateISO = toISODate(date);
      const dayType = getDayType(dateISO, holidayDates);
      const meta = columnTimeMetaByKey.get(`${dayType}-1`);
      columns.push({
        date,
        dateISO,
        dayType,
        colOrder: 1,
        isFirstInDay: true,
        dayIndex,
        columnIndex: columns.length,
        columnTimeLabel: meta?.label,
        columnHasMixedTimes: meta?.mixed ?? false,
      });
    });
    return columns;
  }
  const colBandByIdByLocation = new Map(
    weeklyTemplate.locations.map((location) => [
      location.locationId,
      new Map(location.colBands.map((band) => [band.id, band])),
    ]),
  );
  displayDays.forEach((date, dayIndex) => {
    const dateISO = toISODate(date);
    const dayType = getDayType(dateISO, holidayDates);
    const orders = new Set<number>();
    weeklyTemplate.locations.forEach((location) => {
      const colBandById = colBandByIdByLocation.get(location.locationId);
      if (!colBandById) return;
      location.slots.forEach((slot) => {
        const colBand = colBandById.get(slot.colBandId);
        if (!colBand) return;
        if (colBand.dayType !== dayType) return;
        orders.add(colBand.order ?? 1);
      });
    });
    const sortedOrders = Array.from(orders).sort((a, b) => a - b);
    const finalOrders = sortedOrders.length ? sortedOrders : [1];
    finalOrders.forEach((order, idx) => {
      const meta = columnTimeMetaByKey.get(`${dayType}-${order}`);
      columns.push({
        date,
        dateISO,
        dayType,
        colOrder: order,
        isFirstInDay: idx === 0,
        dayIndex,
        columnIndex: columns.length,
        columnTimeLabel: meta?.label,
        columnHasMixedTimes: meta?.mixed ?? false,
      });
    });
  });
  return columns;
};
