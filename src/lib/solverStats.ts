import type { Assignment, Clinician } from "../api/client";
import type { ScheduleRow } from "./shiftRows";

export type SolverLiveStats = {
  filledSlots: number;
  totalRequiredSlots: number;
  openSlots: number;
  nonConsecutiveShifts: number;
  peopleWeeksWithinHours: number; // Number of (clinician, week) pairs within working hours
  totalPeopleWeeksWithTarget: number; // Total (clinician, week) pairs with targets
  locationChanges: number; // Number of (clinician, date) pairs with location changes
  totalAssignments: number; // Total assignments (solver + manual) in the solve range
  sectionPreferenceMatches: number; // Assignments matching clinician's preferred sections
  totalClassAssignments: number; // Total assignments to class (non-pool) rows
  timeWindowFits: number; // Assignments fitting clinician's preferred working times
  totalAssignmentsWithTimeWindows: number; // Assignments where clinician has time window defined
  onCallRestViolations: number; // Rest day violations around on-call shifts
  workingHoursDeviationMinutes: number; // Total minutes of deviation beyond tolerance band
  preferenceRankScore: number; // Weighted preference score (1st choice scores higher)
  maxPreferenceRankScore: number; // Max possible preference score if all assignments matched #1 choice
};

export type SolverSettingsForStats = {
  onCallRestEnabled?: boolean;
  onCallRestClassId?: string;
  onCallRestDaysBefore?: number;
  onCallRestDaysAfter?: number;
};

// Map day of week (0=Sun, 1=Mon, ..., 6=Sat) to DayType
const DAY_INDEX_TO_TYPE: Record<number, string> = {
  0: "sun",
  1: "mon",
  2: "tue",
  3: "wed",
  4: "thu",
  5: "fri",
  6: "sat",
};

// Helper to get all dates in a range (inclusive)
function getDatesInRange(startISO: string, endISO: string): string[] {
  const dates: string[] = [];
  const start = new Date(startISO);
  const end = new Date(endISO);
  const current = new Date(start);
  while (current <= end) {
    dates.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// Parse "HH:MM" to minutes since midnight
function parseTimeToMinutes(time: string | undefined): number | null {
  if (!time) return null;
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

// Calculate slot duration in minutes
function getSlotDurationMinutes(row: ScheduleRow): number {
  const start = parseTimeToMinutes(row.startTime);
  const end = parseTimeToMinutes(row.endTime);
  if (start === null || end === null) return 480; // Default 8 hours

  let duration = end - start;
  // Handle overnight shifts
  if (row.endDayOffset && row.endDayOffset > 0) {
    duration += row.endDayOffset * 24 * 60;
  } else if (duration < 0) {
    duration += 24 * 60; // Assume next day
  }
  return Math.max(0, duration);
}

/**
 * Calculate live solver statistics from the current solution.
 *
 * @param solverAssignments - Current solution's assignments from the solver
 * @param scheduleRows - Schedule row definitions (with requiredSlots, startTime, endTime, dayType)
 * @param clinicians - Clinician data (for working hours calculation)
 * @param solveRange - The date range being solved
 * @param holidays - Set of holiday date ISOs
 * @param existingAssignments - Existing (manual) assignments in the solve range (optional)
 * @returns Statistics about the current solution
 */
export function calculateSolverLiveStats(
  solverAssignments: Assignment[],
  scheduleRows: ScheduleRow[],
  clinicians: Clinician[],
  solveRange: { startISO: string; endISO: string },
  holidays: Set<string>,
  existingAssignments: Assignment[] = [],
  solverSettings?: SolverSettingsForStats,
): SolverLiveStats {
  // Merge existing assignments with solver assignments
  // Use a Set to deduplicate by unique key (rowId|dateISO|clinicianId)
  const seenKeys = new Set<string>();
  const assignments: Assignment[] = [];

  // Add solver assignments first (they take precedence)
  for (const a of solverAssignments) {
    const key = `${a.rowId}|${a.dateISO}|${a.clinicianId}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      assignments.push(a);
    }
  }

  // Add existing assignments that don't conflict with solver assignments
  for (const a of existingAssignments) {
    const key = `${a.rowId}|${a.dateISO}|${a.clinicianId}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      assignments.push(a);
    }
  }
  // Get all dates in the solve range
  const dates = getDatesInRange(solveRange.startISO, solveRange.endISO);

  // Count working days (Mon-Fri) excluding holidays for working hours scaling
  let workingDaysInRange = 0;
  for (const dateISO of dates) {
    const date = new Date(dateISO);
    const dayOfWeek = date.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5; // Mon-Fri
    const isHoliday = holidays.has(dateISO);
    if (isWeekday && !isHoliday) {
      workingDaysInRange++;
    }
  }
  // Scale based on working days: if 4 working days in range, scale = 4/5
  const scale = workingDaysInRange / 5.0;

  // Build maps for quick lookup
  const rowById = new Map(scheduleRows.map((r) => [r.id, r]));

  // Count assignments per (rowId, dateISO)
  const assignmentCounts = new Map<string, number>();
  for (const a of assignments) {
    const key = `${a.rowId}|${a.dateISO}`;
    assignmentCounts.set(key, (assignmentCounts.get(key) ?? 0) + 1);
  }

  // ===== 1. Calculate filled slots vs required slots =====
  // Build a map: rowId -> (dayType -> requiredSlots)
  const rowRequiredByDayType = new Map<string, Map<string, number>>();
  for (const row of scheduleRows) {
    if (row.kind !== "class" || !row.requiredSlots) continue;
    const required = row.requiredSlots;
    if (required <= 0) continue;

    if (!rowRequiredByDayType.has(row.id)) {
      rowRequiredByDayType.set(row.id, new Map());
    }
    const dayMap = rowRequiredByDayType.get(row.id)!;

    if (row.dayType) {
      // Row is specific to a day type
      dayMap.set(row.dayType, required);
    } else {
      // Row applies to all day types
      for (const dayType of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) {
        dayMap.set(dayType, required);
      }
    }
  }

  let totalRequiredSlots = 0;
  let filledSlots = 0;

  for (const [rowId, dayMap] of rowRequiredByDayType) {
    for (const dateISO of dates) {
      const date = new Date(dateISO);
      const dayType = holidays.has(dateISO)
        ? "holiday"
        : DAY_INDEX_TO_TYPE[date.getDay()] ?? "mon";

      const required = dayMap.get(dayType) ?? 0;
      if (required === 0) continue;

      const key = `${rowId}|${dateISO}`;
      const filled = assignmentCounts.get(key) ?? 0;

      totalRequiredSlots += required;
      filledSlots += Math.min(filled, required); // Don't count overfilling
    }
  }

  const openSlots = totalRequiredSlots - filledSlots;

  // ===== 2. Calculate non-consecutive shifts and location changes =====
  // Group assignments by clinician and date, then check for gaps and location changes
  const assignmentsByClinicianDate = new Map<string, Set<string>>();
  const locationsByClinicianDate = new Map<string, Set<string>>();
  for (const a of assignments) {
    const key = `${a.clinicianId}|${a.dateISO}`;
    if (!assignmentsByClinicianDate.has(key)) {
      assignmentsByClinicianDate.set(key, new Set());
    }
    assignmentsByClinicianDate.get(key)!.add(a.rowId);

    // Track locations per (clinician, date)
    const row = rowById.get(a.rowId);
    if (row?.locationId) {
      if (!locationsByClinicianDate.has(key)) {
        locationsByClinicianDate.set(key, new Set());
      }
      locationsByClinicianDate.get(key)!.add(row.locationId);
    }
  }

  let nonConsecutiveShifts = 0;

  for (const [_key, rowIds] of assignmentsByClinicianDate) {
    if (rowIds.size <= 1) continue;

    // Get time intervals for each row
    const intervals: { start: number; end: number }[] = [];
    for (const rowId of rowIds) {
      const row = rowById.get(rowId);
      if (!row) continue;
      const start = parseTimeToMinutes(row.startTime);
      const end = parseTimeToMinutes(row.endTime);
      if (start !== null && end !== null) {
        let adjustedEnd = end;
        if (row.endDayOffset && row.endDayOffset > 0) {
          adjustedEnd += row.endDayOffset * 24 * 60;
        } else if (end < start) {
          adjustedEnd += 24 * 60;
        }
        intervals.push({ start, end: adjustedEnd });
      }
    }

    if (intervals.length <= 1) continue;

    // Sort by start time
    intervals.sort((a, b) => a.start - b.start);

    // Check for gaps between consecutive intervals
    for (let i = 1; i < intervals.length; i++) {
      const prev = intervals[i - 1];
      const curr = intervals[i];
      // If there's a gap (current starts after previous ends), it's non-consecutive
      if (curr.start > prev.end) {
        nonConsecutiveShifts++;
        break; // Count once per (clinician, date) pair
      }
    }
  }

  // ===== 3. Calculate location changes =====
  // Count (clinician, date) pairs where the clinician works at multiple locations
  let locationChanges = 0;
  for (const [_key, locationIds] of locationsByClinicianDate) {
    if (locationIds.size > 1) {
      locationChanges++;
    }
  }

  // ===== 4. Calculate people-weeks within working hours =====
  // Group hours by (clinician, week) and compare to their target
  // A "week" is determined by the ISO week number of each date

  // Helper to get ISO week key (YYYY-Www format)
  const getWeekKey = (dateISO: string): string => {
    const date = new Date(dateISO);
    // Get Thursday of the current week to determine the year for ISO week
    const thursday = new Date(date);
    thursday.setDate(date.getDate() + (4 - ((date.getDay() + 6) % 7 + 1)));
    const yearStart = new Date(thursday.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${thursday.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
  };

  // Sum up hours per (clinician, week)
  const minutesByClinicianWeek = new Map<string, number>();
  const weeksInRange = new Set<string>();

  for (const dateISO of dates) {
    weeksInRange.add(getWeekKey(dateISO));
  }

  for (const a of assignments) {
    const row = rowById.get(a.rowId);
    if (!row) continue;
    const duration = getSlotDurationMinutes(row);
    const weekKey = getWeekKey(a.dateISO);
    const key = `${a.clinicianId}|${weekKey}`;
    minutesByClinicianWeek.set(key, (minutesByClinicianWeek.get(key) ?? 0) + duration);
  }

  let peopleWeeksWithinHours = 0;
  let totalPeopleWeeksWithTarget = 0;
  let workingHoursDeviationMinutes = 0;

  // For each clinician with a target, check each week in the solve range
  for (const clinician of clinicians) {
    const targetHoursPerWeek = clinician.workingHoursPerWeek;
    if (typeof targetHoursPerWeek !== "number" || targetHoursPerWeek <= 0) {
      continue; // Skip clinicians without a target
    }

    const toleranceHours = clinician.workingHoursToleranceHours ?? 5;
    const targetMinutes = targetHoursPerWeek * 60;
    const toleranceMinutes = toleranceHours * 60;

    // Check each week in the solve range for this clinician
    for (const weekKey of weeksInRange) {
      totalPeopleWeeksWithTarget++;

      const key = `${clinician.id}|${weekKey}`;
      const actualMinutes = minutesByClinicianWeek.get(key) ?? 0;
      const deviation = Math.abs(actualMinutes - targetMinutes);

      if (deviation <= toleranceMinutes) {
        peopleWeeksWithinHours++;
      }

      // Continuous deviation: minutes outside the tolerance band
      const beyondTolerance = Math.max(0, deviation - toleranceMinutes);
      workingHoursDeviationMinutes += beyondTolerance;
    }
  }

  // ===== 5. Total assignments =====
  const totalAssignments = assignments.length;

  // ===== 6. Section preference matches =====
  const clinicianById = new Map(clinicians.map((c) => [c.id, c]));
  let sectionPreferenceMatches = 0;
  let totalClassAssignments = 0;
  let preferenceRankScore = 0;
  let maxPreferenceRankScore = 0;

  for (const a of assignments) {
    const row = rowById.get(a.rowId);
    if (!row || row.kind !== "class") continue;
    totalClassAssignments++;
    const clinician = clinicianById.get(a.clinicianId);
    if (!clinician?.preferredClassIds?.length) continue;

    // Max possible score for this assignment = top rank weight
    const numPrefs = clinician.preferredClassIds.length;
    maxPreferenceRankScore += numPrefs; // Best case: 1st choice

    if (row.sectionId) {
      const prefIndex = clinician.preferredClassIds.indexOf(row.sectionId);
      if (prefIndex >= 0) {
        sectionPreferenceMatches++;
        // Ranked score: 1st choice gets numPrefs, 2nd gets numPrefs-1, etc.
        preferenceRankScore += numPrefs - prefIndex;
      }
    }
  }

  // ===== 7. Time window compliance =====
  const dayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  let timeWindowFits = 0;
  let totalAssignmentsWithTimeWindows = 0;

  for (const a of assignments) {
    const clinician = clinicianById.get(a.clinicianId);
    if (!clinician?.preferredWorkingTimes) continue;

    const date = new Date(a.dateISO);
    const dayKey = dayKeys[date.getDay()];
    const pref = clinician.preferredWorkingTimes[dayKey];
    if (!pref) continue;

    const req = pref.requirement;
    if (req !== "preference" && req !== "mandatory") continue;
    if (!pref.startTime || !pref.endTime) continue;

    const wStart = parseTimeToMinutes(pref.startTime);
    const wEnd = parseTimeToMinutes(pref.endTime);
    if (wStart === null || wEnd === null) continue;

    totalAssignmentsWithTimeWindows++;

    const row = rowById.get(a.rowId);
    if (!row) continue;

    const slotStart = parseTimeToMinutes(row.startTime);
    const slotEnd = parseTimeToMinutes(row.endTime);
    if (slotStart === null || slotEnd === null) continue;

    let adjustedSlotEnd = slotEnd;
    if (row.endDayOffset && row.endDayOffset > 0) {
      adjustedSlotEnd += row.endDayOffset * 24 * 60;
    } else if (slotEnd < slotStart) {
      adjustedSlotEnd += 24 * 60;
    }

    let adjustedWEnd = wEnd;
    if (wEnd < wStart) {
      adjustedWEnd += 24 * 60;
    }

    if (slotStart >= wStart && adjustedSlotEnd <= adjustedWEnd) {
      timeWindowFits++;
    }
  }

  // ===== 8. On-call rest day violations =====
  let onCallRestViolations = 0;

  if (
    solverSettings?.onCallRestEnabled &&
    solverSettings.onCallRestClassId &&
    ((solverSettings.onCallRestDaysBefore ?? 0) > 0 ||
      (solverSettings.onCallRestDaysAfter ?? 0) > 0)
  ) {
    const onCallSectionId = solverSettings.onCallRestClassId;
    const restBefore = solverSettings.onCallRestDaysBefore ?? 0;
    const restAfter = solverSettings.onCallRestDaysAfter ?? 0;

    // Find on-call section slot IDs
    const onCallSlotIds = new Set<string>();
    for (const row of scheduleRows) {
      if (row.sectionId === onCallSectionId && row.kind === "class") {
        onCallSlotIds.add(row.id);
      }
    }

    // Group assignments by (clinicianId, dateISO)
    const assignmentsByClinicianDateForRest = new Map<string, Set<string>>();
    for (const a of assignments) {
      const key = `${a.clinicianId}|${a.dateISO}`;
      if (!assignmentsByClinicianDateForRest.has(key)) {
        assignmentsByClinicianDateForRest.set(key, new Set());
      }
      assignmentsByClinicianDateForRest.get(key)!.add(a.rowId);
    }

    // Find on-call assignments and check rest days
    for (const a of assignments) {
      if (!onCallSlotIds.has(a.rowId)) continue;
      const onCallDate = new Date(a.dateISO);

      for (let offset = 1; offset <= restBefore; offset++) {
        const restDate = new Date(onCallDate);
        restDate.setDate(restDate.getDate() - offset);
        const restDateISO = restDate.toISOString().split("T")[0];
        const key = `${a.clinicianId}|${restDateISO}`;
        if (assignmentsByClinicianDateForRest.has(key)) {
          onCallRestViolations++;
        }
      }

      for (let offset = 1; offset <= restAfter; offset++) {
        const restDate = new Date(onCallDate);
        restDate.setDate(restDate.getDate() + offset);
        const restDateISO = restDate.toISOString().split("T")[0];
        const key = `${a.clinicianId}|${restDateISO}`;
        if (assignmentsByClinicianDateForRest.has(key)) {
          onCallRestViolations++;
        }
      }
    }
  }

  return {
    filledSlots,
    totalRequiredSlots,
    openSlots,
    nonConsecutiveShifts,
    peopleWeeksWithinHours,
    totalPeopleWeeksWithTarget,
    locationChanges,
    totalAssignments,
    sectionPreferenceMatches,
    totalClassAssignments,
    timeWindowFits,
    totalAssignmentsWithTimeWindows,
    onCallRestViolations,
    workingHoursDeviationMinutes,
    preferenceRankScore,
    maxPreferenceRankScore,
  };
}
