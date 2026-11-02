import { describe, expect, it } from "vitest";
import type { AppState } from "../api/client";
import { buildAssignmentMap } from "../data/mockData";
import { buildCalendarRows } from "./calendarView";
import {
  buildClinicianOptionsForSlot,
  buildDateIntervalIndex,
  buildRowKindById,
  buildShiftIntervalsByRowId,
} from "./clinicianSlotOptions";
import { buildRenderedAssignmentMap, REST_DAY_POOL_ID } from "./schedule";
import { buildScheduleRows, normalizeAppState } from "./shiftRows";
import { buildGateMinutesByRowId, buildWeeklyMinutesIndex, checkWeeklyHours, weeklyCapMinutes } from "./weeklyHours";
import crossCheck from "./weeklyHours.crossCheck.json";

// One weekly-hours rule (v1.81): the person picker must count every week and
// limit of weeklyHours.crossCheck.json as the swap assistant's hours card, its
// cover search and validate_weekly_hours do, and print the hours the cover
// search's reason prints. The backend side is
// backend/tests/test_weekly_hours_crosscheck.py, on the same file.

const { state } = normalizeAppState(crossCheck.state as unknown as AppState);
const clinicians = state.clinicians;
const scheduleRows = buildScheduleRows(
  state.rows,
  state.locations ?? [],
  state.locationsEnabled ?? true,
  state.weeklyTemplate,
);
const calendarRows = buildCalendarRows(scheduleRows);
const assignmentMap = buildAssignmentMap(state.assignments);

// As WeeklySchedulePage builds getWeeklyHours: every stored assignment, also
// the vacation-hidden ones, and slot minutes as the gate counts them.
const gateMinutesByRowId = buildGateMinutesByRowId(scheduleRows);
const weeklyIndex = buildWeeklyMinutesIndex(
  Array.from(assignmentMap.values()).flat(),
  (rowId) => gateMinutesByRowId.get(rowId) ?? null,
);
const getWeeklyHours = (clinicianId: string, dateISO: string, rowId: string) => {
  const minutes = gateMinutesByRowId.get(rowId);
  const clinician = clinicians.find((item) => item.id === clinicianId);
  return clinician && minutes ? checkWeeklyHours(weeklyIndex, clinician, dateISO, minutes) : null;
};

/** The team grid's picker for one cell, its week shown (ScheduleGrid's inputs). */
function pickerOptions(rowId: string, dateISO: string) {
  const monday = new Date(`${dateISO}T00:00:00`);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + index);
    return day;
  });
  const rendered = buildRenderedAssignmentMap(assignmentMap, clinicians, days, {
    scheduleRows,
    solverSettings: state.solverSettings,
  });
  const rowKindById = buildRowKindById(calendarRows);
  const shiftIntervalsByRowId = buildShiftIntervalsByRowId(calendarRows);
  return buildClinicianOptionsForSlot({
    rowId,
    dateISO,
    rows: calendarRows,
    assignmentMap: rendered,
    clinicians,
    enforceSameLocationPerDay: state.solverSettings?.enforceSameLocationPerDay ?? true,
    shiftIntervalsByRowId,
    ...buildDateIntervalIndex(rendered, rowKindById, shiftIntervalsByRowId),
    getIsOnRestDay: (clinicianId, day) =>
      (rendered.get(`${REST_DAY_POOL_ID}__${day}`) ?? []).some((item) => item.clinicianId === clinicianId),
    getWeeklyHours,
  });
}

describe("weekly hours: the picker counts like the swap assistant and the gate", () => {
  it.each(crossCheck.expected.weeks)("$clinicianId in $week: $minutes min, limit $limitMinutes", (week) => {
    const clinician = clinicians.find((item) => item.id === week.clinicianId)!;
    expect(weeklyIndex.get(`${week.clinicianId}|${week.week}`) ?? 0).toBe(week.minutes);
    expect(weeklyCapMinutes(clinician)).toBe(week.limitMinutes);
  });

  describe.each(crossCheck.expected.covers)("cover $slot.rowId on $slot.dateISO", (cover) => {
    const options = pickerOptions(cover.slot.rowId, cover.slot.dateISO);
    const option = (clinicianId: string) => options.find((item) => item.id === clinicianId)!;

    it.each(cover.candidates)("$clinicianId: after $afterMinutes min, over $over", (candidate) => {
      const status = getWeeklyHours(candidate.clinicianId, cover.slot.dateISO, cover.slot.rowId);
      if (candidate.limitMinutes === null) {
        expect(status).toBeNull();
      } else {
        expect(status).toMatchObject({
          weekKey: cover.week,
          afterMinutes: candidate.afterMinutes,
          capMinutes: candidate.limitMinutes,
          over: candidate.over,
        });
      }
      // The swap search blocks exactly the people the picker marks; everyone
      // else it offers, and the picker lists them as free.
      const { id: _id, name: _name, ...flags } = option(candidate.clinicianId);
      expect(flags).toEqual({
        isQualified: true,
        isOnVacation: false,
        isOnRestDay: false,
        hasTimeConflict: false,
        hasLocationConflict: false,
        alreadyAssigned: false,
        ...(candidate.over
          ? {
              isOverWeeklyHours: true,
              // The hours the cover search's reason prints too: "32.3/30 h in 2026-W50"
              // for 1935 of 1800 minutes (an exact half rounds up on both sides).
              weeklyHoursLabel: `${candidate.shown!.after}/${candidate.shown!.limit} h in ${cover.week}`,
            }
          : {}),
      });
    });

    it("lists every person once; a holder hidden by vacation is on vacation (the search leaves them out)", () => {
      for (const holder of cover.holders) {
        expect(option(holder)).toMatchObject({ isOnVacation: true, alreadyAssigned: false });
      }
      expect(options.map((item) => item.id).sort()).toEqual(
        [...cover.candidates.map((candidate) => candidate.clinicianId), ...cover.holders].sort(),
      );
    });
  });
});
