import type { DayType } from "../api/client";
import type { ScheduleRow } from "./shiftRows";
import { getDayType } from "./dayTypes";
import { addDays, daysInMonth, formatMonthLabel, startOfMonth, toISODate } from "./date";

// Colors lifted verbatim from the clinic's Excel Arbeitsplan.
export const EXCEL_GRAY = "#C0C0C0";
export const EXCEL_CYAN = "#00CCFF";
export const EXCEL_PINK = "#FF99CC";
export const EXCEL_GREEN = "#339966";

// Each day block is 6 name columns wide: 4 for the first (assistant) area
// and 2 for the second (senior/Oberarzt) area, per the Excel row structure.
export const SHEET_DAY_COLUMNS = 6;

export type ClinicSheetDay = {
  date: Date;
  dateISO: string;
  dayType: DayType;
  // Sat/Sun/holiday day blocks are tinted cyan across all rows, like Excel.
  isCyan: boolean;
  holidayName?: string;
};

export type ClinicSheetArea = {
  // The template slot this area assigns into (assignment rowId).
  slotId: string;
  areaIndex: number;
  sectionId?: string;
  sectionName?: string;
  blockColor?: string;
  startTime?: string;
  endTime?: string;
  requiredSlots: number;
  // 1-based position within the 6-column day block.
  startCol: number;
  colSpan: number;
};

export type ClinicSheetRow = {
  key: string;
  label: string;
  labelColor: string;
  areasByDate: Map<string, ClinicSheetArea[]>;
};

export type ClinicSheetSection = {
  locationId: string;
  locationName?: string;
  rows: ClinicSheetRow[];
};

export type ClinicSheetModel = {
  monthLabel: string;
  days: ClinicSheetDay[];
  sections: ClinicSheetSection[];
  poolRows: ScheduleRow[];
};

// Day blocks for an arbitrary consecutive range — the sheet grid renders
// whatever days it is given, so print/public pages can show single weeks
// in the same Excel optic the month view uses.
export function buildSheetDays(
  startDate: Date,
  dayCount: number,
  holidayDates: Set<string>,
  holidayNameByDate?: Record<string, string>,
): ClinicSheetDay[] {
  const days: ClinicSheetDay[] = [];
  for (let offset = 0; offset < dayCount; offset += 1) {
    const date = addDays(startDate, offset);
    const dateISO = toISODate(date);
    const dayType = getDayType(dateISO, holidayDates);
    days.push({
      date,
      dateISO,
      dayType,
      isCyan: dayType === "sat" || dayType === "sun" || dayType === "holiday",
      holidayName: holidayNameByDate?.[dateISO],
    });
  }
  return days;
}

export function buildMonthDays(
  monthAnchor: Date,
  holidayDates: Set<string>,
  holidayNameByDate?: Record<string, string>,
): ClinicSheetDay[] {
  return buildSheetDays(
    startOfMonth(monthAnchor),
    daysInMonth(monthAnchor),
    holidayDates,
    holidayNameByDate,
  );
}

// How the 6 columns of a day block are shared between the row's areas.
// One area spans the whole block; two areas follow the Excel 4+2 split;
// more areas fall back to an even split (remainder to the left).
export function resolveAreaWidths(areaCount: number): number[] {
  if (areaCount <= 0) return [];
  if (areaCount === 1) return [SHEET_DAY_COLUMNS];
  if (areaCount === 2) return [4, 2];
  const count = Math.min(areaCount, SHEET_DAY_COLUMNS);
  const base = Math.floor(SHEET_DAY_COLUMNS / count);
  const remainder = SHEET_DAY_COLUMNS % count;
  return Array.from({ length: count }, (_, idx) => base + (idx < remainder ? 1 : 0));
}

const resolveRequiredSlots = (
  slot: ScheduleRow,
  day: ClinicSheetDay,
  slotOverridesByKey: Record<string, number>,
  minSlotsByRowId: Record<string, { weekday: number; weekend: number }>,
): number => {
  // Mirrors the classic grid's semantics (ScheduleGrid cell resolution):
  // slot requiredSlots, falling back to per-row min slots, plus the additive
  // per-date override, clamped to >= 0.
  const minSlots = minSlotsByRowId[slot.id] ?? { weekday: 0, weekend: 0 };
  const baseRequired =
    typeof slot.requiredSlots === "number"
      ? slot.requiredSlots
      : day.isCyan
        ? minSlots.weekend
        : minSlots.weekday;
  const override = slotOverridesByKey[`${slot.id}__${day.dateISO}`] ?? 0;
  return Math.max(0, baseRequired + override);
};

export function buildClinicSheetModel(args: {
  calendarRows: ScheduleRow[];
  days: ClinicSheetDay[];
  slotOverridesByKey?: Record<string, number>;
  minSlotsByRowId?: Record<string, { weekday: number; weekend: number }>;
}): ClinicSheetModel {
  const { calendarRows, days } = args;
  const slotOverridesByKey = args.slotOverridesByKey ?? {};
  const minSlotsByRowId = args.minSlotsByRowId ?? {};

  const classRows = calendarRows.filter((row) => row.kind === "class");
  const poolRows = calendarRows.filter((row) => row.kind === "pool");

  let warnedAboutDroppedSlots = false;
  const sections: ClinicSheetSection[] = [];
  for (const row of classRows) {
    const locationId = row.locationId ?? "loc-default";
    let section = sections[sections.length - 1];
    if (!section || section.locationId !== locationId) {
      section = { locationId, locationName: row.locationName, rows: [] };
      sections.push(section);
    }

    // slotRows arrive sorted by dayType then colBandOrder (buildCalendarRows).
    const slotRows = row.slotRows?.length ? row.slotRows : [row];
    const areasByDate = new Map<string, ClinicSheetArea[]>();
    for (const day of days) {
      const daySlots = slotRows.filter((slot) => slot.dayType === day.dayType);
      if (!daySlots.length) continue;
      if (daySlots.length > SHEET_DAY_COLUMNS && !warnedAboutDroppedSlots) {
        warnedAboutDroppedSlots = true;
        console.warn(
          `clinicSheet: row "${row.name}" has ${daySlots.length} sub-columns on ${day.dayType}; ` +
            `only the first ${SHEET_DAY_COLUMNS} are shown in the monthly sheet.`,
        );
      }
      const visibleSlots = daySlots.slice(0, SHEET_DAY_COLUMNS);
      const widths = resolveAreaWidths(visibleSlots.length);
      let startCol = 1;
      const areas: ClinicSheetArea[] = visibleSlots.map((slot, areaIndex) => {
        const area: ClinicSheetArea = {
          slotId: slot.id,
          areaIndex,
          sectionId: slot.sectionId,
          sectionName: slot.sectionName,
          blockColor: slot.blockColor,
          startTime: slot.startTime,
          endTime: slot.endTime,
          requiredSlots: resolveRequiredSlots(slot, day, slotOverridesByKey, minSlotsByRowId),
          startCol,
          colSpan: widths[areaIndex],
        };
        startCol += widths[areaIndex];
        return area;
      });
      areasByDate.set(day.dateISO, areas);
    }

    const primarySlot = slotRows[0];
    section.rows.push({
      key: row.id,
      label: row.rowBandLabel || row.name,
      labelColor: primarySlot?.blockColor || EXCEL_PINK,
      areasByDate,
    });
  }

  return {
    monthLabel: formatMonthLabel(days[0]?.date ?? new Date()),
    days,
    sections,
    poolRows,
  };
}
