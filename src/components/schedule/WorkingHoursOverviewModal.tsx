import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { buttonPrimary, buttonSecondary } from "../../lib/buttonStyles";
import { cx } from "../../lib/classNames";
import type { Assignment, WeeklyCalendarTemplate } from "../../api/client";

type WorkingHoursOverviewModalProps = {
  open: boolean;
  onClose: () => void;
  clinicians: Array<{
    id: string;
    name: string;
    workingHoursPerWeek?: number;
  }>;
  assignments: Assignment[];
  weeklyTemplate?: WeeklyCalendarTemplate;
};

const WEEK_WIDTH = 56;
const LEFT_COLUMN_WIDTH = 160;
const TOTAL_COLUMN_WIDTH = 72;
const ROW_HEIGHT = 28;

// Parse "HH:MM" to minutes since midnight
function parseTimeToMinutes(time: string | undefined): number | null {
  if (!time) return null;
  const [h, m] = time.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

// Get duration in minutes for a slot
function getSlotDurationMinutes(
  slot: { startTime?: string; endTime?: string; endDayOffset?: number },
): number {
  const start = parseTimeToMinutes(slot.startTime);
  const end = parseTimeToMinutes(slot.endTime);
  if (start === null || end === null) return 8 * 60; // Default 8 hours
  const offset = slot.endDayOffset ?? 0;
  const endWithOffset = end + offset * 24 * 60;
  return Math.max(0, endWithOffset - start);
}

// Get the Monday of the week containing a date
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Format date as ISO string (YYYY-MM-DD)
function toISODate(date: Date): string {
  return date.toISOString().split("T")[0];
}

// Get all weeks in a year, starting Jan 1 and ending Dec 31
// Returns daysInWeek to calculate fractional expected hours for partial weeks
// Also returns weekMonday (the actual Monday) for matching assignments
function getWeeksInYear(year: number): Array<{ weekNum: number; start: Date; end: Date; weekMonday: Date; daysInWeek: number }> {
  const weeks: Array<{ weekNum: number; start: Date; end: Date; weekMonday: Date; daysInWeek: number }> = [];

  const jan1 = new Date(year, 0, 1);
  const dec31 = new Date(year, 11, 31);

  // Start from Jan 1, find its week's Monday
  let weekMonday = getWeekStart(jan1);
  let weekNum = 1;

  while (weekMonday <= dec31) {
    const weekSunday = new Date(weekMonday);
    weekSunday.setDate(weekSunday.getDate() + 6);

    // Clamp start to Jan 1 if week starts in previous year
    const clampedStart = weekMonday < jan1 ? jan1 : weekMonday;
    // Clamp end to Dec 31 if week ends in next year
    const clampedEnd = weekSunday > dec31 ? dec31 : weekSunday;

    // Calculate days in this week that fall within the year
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysInWeek = Math.round((clampedEnd.getTime() - clampedStart.getTime()) / msPerDay) + 1;

    weeks.push({
      weekNum,
      start: new Date(clampedStart),
      end: new Date(clampedEnd),
      weekMonday: new Date(weekMonday), // Store the actual Monday for matching
      daysInWeek,
    });

    weekMonday.setDate(weekMonday.getDate() + 7);
    weekNum++;

    // Safety check
    if (weekNum > 54) break;
  }

  return weeks;
}

// Format hours with one decimal
function formatHours(minutes: number): string {
  const hours = minutes / 60;
  if (hours === 0) return "–";
  return hours.toFixed(1).replace(/\.0$/, "");
}

export default function WorkingHoursOverviewModal({
  open,
  onClose,
  clinicians,
  assignments,
  weeklyTemplate,
}: WorkingHoursOverviewModalProps) {
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const todayColumnRef = useRef<HTMLDivElement | null>(null);

  // Scroll to current week when opening
  useEffect(() => {
    if (!open) return;
    const container = scrollContainerRef.current;
    const todayCol = todayColumnRef.current;
    if (!container || !todayCol) return;

    window.requestAnimationFrame(() => {
      const containerRect = container.getBoundingClientRect();
      const todayRect = todayCol.getBoundingClientRect();
      const scrollLeft = todayRect.left - containerRect.left + container.scrollLeft - containerRect.width / 2;
      // Feature-detect scrollTo: jsdom (tests) doesn't implement it, and older
      // Safari throws on the options object. Fall back to assigning scrollLeft.
      if (typeof container.scrollTo === "function") {
        container.scrollTo({ left: Math.max(0, scrollLeft), behavior: "auto" });
      } else {
        container.scrollLeft = Math.max(0, scrollLeft);
      }
    });
  }, [open, selectedYear]);

  // Build slot duration map
  const slotDurationMap = useMemo(() => {
    const map = new Map<string, number>();
    if (!weeklyTemplate) return map;

    for (const location of weeklyTemplate.locations ?? []) {
      for (const slot of location.slots ?? []) {
        const duration = getSlotDurationMinutes(slot);
        map.set(slot.id, duration);
      }
    }
    return map;
  }, [weeklyTemplate]);

  // Get weeks for selected year
  const weeks = useMemo(() => getWeeksInYear(selectedYear), [selectedYear]);

  // Find current week index
  const currentWeekIndex = useMemo(() => {
    const today = new Date();
    if (today.getFullYear() !== selectedYear) return -1;
    const todayStart = getWeekStart(today);
    return weeks.findIndex(w => toISODate(w.weekMonday) === toISODate(todayStart));
  }, [weeks, selectedYear]);

  // Calculate working hours per week for all clinicians
  const clinicianWeeklyHours = useMemo(() => {
    const result = new Map<string, Map<number, number>>();

    for (const clinician of clinicians) {
      const hoursMap = new Map<number, number>();

      // Filter assignments for this clinician
      const clinicianAssignments = assignments.filter(a => a.clinicianId === clinician.id);

      for (const assignment of clinicianAssignments) {
        // Skip pool assignments (they don't count as working hours)
        if (assignment.rowId.startsWith("pool-")) continue;

        const assignmentDate = new Date(assignment.dateISO);
        if (assignmentDate.getFullYear() !== selectedYear) continue;

        // Find which week this assignment belongs to (use weekMonday for matching)
        const weekStart = getWeekStart(assignmentDate);
        const weekIndex = weeks.findIndex(w => toISODate(w.weekMonday) === toISODate(weekStart));
        if (weekIndex === -1) continue;

        // Get duration from slot or use default
        let durationMinutes = 8 * 60; // Default 8 hours

        // Try to find slot duration from template
        const slotId = assignment.rowId;
        if (slotDurationMap.has(slotId)) {
          durationMinutes = slotDurationMap.get(slotId)!;
        }

        // Add to week total
        const current = hoursMap.get(weekIndex) ?? 0;
        hoursMap.set(weekIndex, current + durationMinutes);
      }

      result.set(clinician.id, hoursMap);
    }

    return result;
  }, [clinicians, assignments, weeks, selectedYear, slotDurationMap]);

  // Calculate yearly totals for all clinicians
  const clinicianYearlyTotals = useMemo(() => {
    const result = new Map<string, number>();
    for (const [clinicianId, hoursMap] of clinicianWeeklyHours) {
      let total = 0;
      for (const minutes of hoursMap.values()) {
        total += minutes;
      }
      result.set(clinicianId, total);
    }
    return result;
  }, [clinicianWeeklyHours]);

  // Handle escape key
  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const totalWidth = weeks.length * WEEK_WIDTH;

  // Calculate total expected hours for the year (accounting for partial weeks)
  const getTotalExpectedHours = (expectedWeeklyHours: number) => {
    return weeks.reduce((sum, w) => sum + expectedWeeklyHours * (w.daysInWeek / 7), 0);
  };

  return createPortal(
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-slate-900/40 backdrop-blur-[1px] dark:bg-slate-950/50"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="relative mx-auto h-full w-full max-w-screen-2xl px-4 py-6 sm:px-6">
        <div className="flex h-full flex-col rounded-3xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
          {/* Header */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-6 py-4 dark:border-slate-800">
            <div>
              <div className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                Working Hours Overview
              </div>
              <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                Track working hours by week for all clinicians.
              </div>
            </div>
            <div className="flex items-center gap-3">
              {/* Year selector */}
              <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                <button
                  type="button"
                  onClick={() => setSelectedYear((prev) => prev - 1)}
                  className="rounded-full px-2 py-1 text-xs font-semibold text-slate-500 hover:text-slate-700 dark:text-slate-300 dark:hover:text-slate-100"
                  aria-label="Previous year"
                >
                  ‹
                </button>
                <span className="min-w-[48px] text-center font-semibold">{selectedYear}</span>
                <button
                  type="button"
                  onClick={() => setSelectedYear((prev) => prev + 1)}
                  className="rounded-full px-2 py-1 text-xs font-semibold text-slate-500 hover:text-slate-700 dark:text-slate-300 dark:hover:text-slate-100"
                  aria-label="Next year"
                >
                  ›
                </button>
              </div>

              <button
                type="button"
                onClick={() => setSelectedYear(currentYear)}
                className={buttonSecondary.base}
              >
                Today
              </button>
              <button type="button" onClick={onClose} className={buttonPrimary.base}>
                Close
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="min-h-0 flex-1 overflow-hidden">
            <div ref={scrollContainerRef} className="h-full overflow-auto">
              <div className="relative min-w-max">
                {/* Header row with week numbers */}
                <div className="sticky top-0 z-30 flex border-b border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
                  <div
                    className="sticky left-0 z-40 flex items-center border-r border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900"
                    style={{ width: LEFT_COLUMN_WIDTH, minWidth: LEFT_COLUMN_WIDTH }}
                  >
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Week
                    </span>
                  </div>
                  <div className="flex" style={{ width: totalWidth }}>
                    {weeks.map((week, index) => {
                      const isCurrentWeek = index === currentWeekIndex;
                      return (
                        <div
                          key={week.weekNum}
                          ref={isCurrentWeek ? todayColumnRef : undefined}
                          className={cx(
                            "flex h-8 items-center justify-center border-r border-slate-100 text-[10px] font-semibold dark:border-slate-800",
                            isCurrentWeek
                              ? "bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300"
                              : "text-slate-500 dark:text-slate-400",
                          )}
                          style={{ width: WEEK_WIDTH }}
                        >
                          W{week.weekNum}
                        </div>
                      );
                    })}
                  </div>
                  <div
                    className="sticky right-0 z-40 flex h-8 items-center justify-center border-l-2 border-slate-300 bg-slate-100 text-[10px] font-semibold text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
                    style={{ width: TOTAL_COLUMN_WIDTH, minWidth: TOTAL_COLUMN_WIDTH }}
                  >
                    Total
                  </div>
                </div>

                {/* Date range row */}
                <div className="sticky top-8 z-30 flex border-b border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50">
                  <div
                    className="sticky left-0 z-40 flex items-center border-r border-slate-200 bg-slate-50 px-3 dark:border-slate-700 dark:bg-slate-800/50"
                    style={{ width: LEFT_COLUMN_WIDTH, minWidth: LEFT_COLUMN_WIDTH }}
                  >
                    <span className="text-[10px] text-slate-400 dark:text-slate-500">Date range</span>
                  </div>
                  <div className="flex" style={{ width: totalWidth }}>
                    {weeks.map((week, index) => {
                      const isCurrentWeek = index === currentWeekIndex;
                      const startStr = `${week.start.getDate()}.${week.start.getMonth() + 1}`;
                      const endStr = `${week.end.getDate()}.${week.end.getMonth() + 1}`;
                      return (
                        <div
                          key={week.weekNum}
                          className={cx(
                            "flex h-5 items-center justify-center border-r border-slate-100 text-[8px] dark:border-slate-800",
                            isCurrentWeek
                              ? "bg-sky-50 text-sky-600 dark:bg-sky-900/30 dark:text-sky-400"
                              : "text-slate-400 dark:text-slate-500",
                          )}
                          style={{ width: WEEK_WIDTH }}
                        >
                          {startStr}–{endStr}
                        </div>
                      );
                    })}
                  </div>
                  <div
                    className="sticky right-0 z-40 flex h-5 items-center justify-center border-l-2 border-slate-300 bg-slate-100 text-[9px] text-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400"
                    style={{ width: TOTAL_COLUMN_WIDTH, minWidth: TOTAL_COLUMN_WIDTH }}
                  >
                    {selectedYear}
                  </div>
                </div>

                {/* Clinician sections */}
                {clinicians.map((clinician, clinicianIndex) => {
                  const hoursMap = clinicianWeeklyHours.get(clinician.id) ?? new Map<number, number>();
                  const yearlyTotal = clinicianYearlyTotals.get(clinician.id) ?? 0;
                  const expectedWeeklyHours = clinician.workingHoursPerWeek;
                  const totalExpected = expectedWeeklyHours ? getTotalExpectedHours(expectedWeeklyHours) : null;
                  const yearlyDiff = totalExpected !== null ? yearlyTotal / 60 - totalExpected : null;

                  const isEvenSection = clinicianIndex % 2 === 0;
                  const sectionBg = isEvenSection
                    ? "bg-white dark:bg-slate-900"
                    : "bg-slate-50/50 dark:bg-slate-800/20";

                  return (
                    <div key={clinician.id} className={cx("border-b-2 border-slate-200 dark:border-slate-700", sectionBg)}>
                      {/* Clinician header row with hours worked */}
                      <div className="flex border-b border-slate-100 dark:border-slate-800">
                        <div
                          className={cx(
                            "sticky left-0 z-40 flex items-center justify-between gap-2 border-r border-slate-200 px-3 dark:border-slate-700",
                            sectionBg,
                          )}
                          style={{ width: LEFT_COLUMN_WIDTH, minWidth: LEFT_COLUMN_WIDTH, height: ROW_HEIGHT }}
                        >
                          <span className="truncate text-xs font-semibold text-slate-800 dark:text-slate-100">
                            {clinician.name}
                          </span>
                          {expectedWeeklyHours && (
                            <span className="shrink-0 text-[10px] text-slate-400 dark:text-slate-500">
                              {expectedWeeklyHours}h/w
                            </span>
                          )}
                        </div>
                        <div className="flex" style={{ width: totalWidth }}>
                          {weeks.map((week, weekIndex) => {
                            const minutes = hoursMap.get(weekIndex) ?? 0;
                            const hours = minutes / 60;
                            const isCurrentWeek = weekIndex === currentWeekIndex;

                            // Determine color based on expected hours
                            let colorClass = "text-slate-600 dark:text-slate-300";
                            if (expectedWeeklyHours && hours > 0) {
                              const fractionOfWeek = week.daysInWeek / 7;
                              const weekExpected = expectedWeeklyHours * fractionOfWeek;
                              const diff = hours - weekExpected;
                              if (diff > 2) {
                                colorClass = "text-rose-600 dark:text-rose-400 font-medium";
                              } else if (diff < -2) {
                                colorClass = "text-amber-600 dark:text-amber-400";
                              } else if (Math.abs(diff) <= 2) {
                                colorClass = "text-emerald-600 dark:text-emerald-400";
                              }
                            }

                            return (
                              <div
                                key={week.weekNum}
                                className={cx(
                                  "flex items-center justify-center border-r border-slate-100 text-[11px] dark:border-slate-800",
                                  isCurrentWeek && "bg-sky-50/70 dark:bg-sky-900/20",
                                  colorClass,
                                )}
                                style={{ width: WEEK_WIDTH, height: ROW_HEIGHT }}
                              >
                                {formatHours(minutes)}
                              </div>
                            );
                          })}
                        </div>
                        <div
                          className="sticky right-0 z-40 flex items-center justify-center border-l-2 border-slate-300 bg-slate-100 text-[11px] font-semibold text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
                          style={{ width: TOTAL_COLUMN_WIDTH, minWidth: TOTAL_COLUMN_WIDTH, height: ROW_HEIGHT }}
                        >
                          {formatHours(yearlyTotal)}
                        </div>
                      </div>

                      {/* Expected row (if contract hours set) */}
                      {expectedWeeklyHours && (
                        <div className="flex border-b border-slate-100 dark:border-slate-800">
                          <div
                            className={cx(
                              "sticky left-0 z-40 flex items-center border-r border-slate-200 px-3 dark:border-slate-700",
                              sectionBg,
                            )}
                            style={{ width: LEFT_COLUMN_WIDTH, minWidth: LEFT_COLUMN_WIDTH, height: ROW_HEIGHT }}
                          >
                            <span className="text-[10px] text-slate-400 dark:text-slate-500">Expected</span>
                          </div>
                          <div className="flex" style={{ width: totalWidth }}>
                            {weeks.map((week, weekIndex) => {
                              const isCurrentWeek = weekIndex === currentWeekIndex;
                              const fractionOfWeek = week.daysInWeek / 7;
                              const weekExpected = expectedWeeklyHours * fractionOfWeek;
                              return (
                                <div
                                  key={week.weekNum}
                                  className={cx(
                                    "flex items-center justify-center border-r border-slate-100 text-[10px] text-slate-400 dark:border-slate-800 dark:text-slate-500",
                                    isCurrentWeek && "bg-sky-50/50 dark:bg-sky-900/10",
                                  )}
                                  style={{ width: WEEK_WIDTH, height: ROW_HEIGHT }}
                                >
                                  {weekExpected === expectedWeeklyHours ? expectedWeeklyHours : weekExpected.toFixed(1)}
                                </div>
                              );
                            })}
                          </div>
                          <div
                            className="sticky right-0 z-40 flex items-center justify-center border-l-2 border-slate-300 bg-slate-100 text-[10px] text-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400"
                            style={{ width: TOTAL_COLUMN_WIDTH, minWidth: TOTAL_COLUMN_WIDTH, height: ROW_HEIGHT }}
                          >
                            {totalExpected?.toFixed(0)}
                          </div>
                        </div>
                      )}

                      {/* Difference row (if contract hours set) */}
                      {expectedWeeklyHours && (
                        <div className="flex border-b border-slate-100 dark:border-slate-800">
                          <div
                            className={cx(
                              "sticky left-0 z-40 flex items-center border-r border-slate-200 px-3 dark:border-slate-700",
                              sectionBg,
                            )}
                            style={{ width: LEFT_COLUMN_WIDTH, minWidth: LEFT_COLUMN_WIDTH, height: ROW_HEIGHT }}
                          >
                            <span className="text-[10px] text-slate-400 dark:text-slate-500">Difference</span>
                          </div>
                          <div className="flex" style={{ width: totalWidth }}>
                            {weeks.map((week, weekIndex) => {
                              const minutes = hoursMap.get(weekIndex) ?? 0;
                              const hours = minutes / 60;
                              const fractionOfWeek = week.daysInWeek / 7;
                              const weekExpected = expectedWeeklyHours * fractionOfWeek;
                              const diff = hours - weekExpected;
                              const isCurrentWeek = weekIndex === currentWeekIndex;

                              let colorClass = "text-slate-400 dark:text-slate-500";
                              if (hours > 0) {
                                if (diff > 2) {
                                  colorClass = "text-rose-600 dark:text-rose-400";
                                } else if (diff < -2) {
                                  colorClass = "text-amber-600 dark:text-amber-400";
                                } else {
                                  colorClass = "text-emerald-600 dark:text-emerald-400";
                                }
                              }

                              return (
                                <div
                                  key={week.weekNum}
                                  className={cx(
                                    "flex items-center justify-center border-r border-slate-100 text-[10px] dark:border-slate-800",
                                    isCurrentWeek && "bg-sky-50/50 dark:bg-sky-900/10",
                                    colorClass,
                                  )}
                                  style={{ width: WEEK_WIDTH, height: ROW_HEIGHT }}
                                >
                                  {hours === 0 ? "–" : (diff > 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1))}
                                </div>
                              );
                            })}
                          </div>
                          {(() => {
                            let colorClass = "text-slate-500 dark:text-slate-400";
                            if (yearlyDiff !== null) {
                              if (yearlyDiff > 8) {
                                colorClass = "text-rose-600 dark:text-rose-400";
                              } else if (yearlyDiff < -8) {
                                colorClass = "text-amber-600 dark:text-amber-400";
                              } else if (Math.abs(yearlyDiff) <= 8 && yearlyDiff !== 0) {
                                colorClass = "text-emerald-600 dark:text-emerald-400";
                              }
                            }
                            return (
                              <div
                                className={cx(
                                  "sticky right-0 z-40 flex items-center justify-center border-l-2 border-slate-300 bg-slate-100 text-[10px] font-semibold dark:border-slate-600 dark:bg-slate-800",
                                  colorClass,
                                )}
                                style={{ width: TOTAL_COLUMN_WIDTH, minWidth: TOTAL_COLUMN_WIDTH, height: ROW_HEIGHT }}
                              >
                                {yearlyDiff !== null ? (yearlyDiff > 0 ? `+${yearlyDiff.toFixed(1)}` : yearlyDiff.toFixed(1)) : "–"}
                              </div>
                            );
                          })()}
                        </div>
                      )}

                      {/* Cumulative row (if contract hours set) */}
                      {expectedWeeklyHours && (
                        <div className="flex">
                          <div
                            className={cx(
                              "sticky left-0 z-40 flex items-center border-r border-slate-200 px-3 dark:border-slate-700",
                              sectionBg,
                            )}
                            style={{ width: LEFT_COLUMN_WIDTH, minWidth: LEFT_COLUMN_WIDTH, height: ROW_HEIGHT }}
                          >
                            <span className="text-[10px] text-slate-400 dark:text-slate-500">Cumulative</span>
                          </div>
                          <div className="flex" style={{ width: totalWidth }}>
                            {(() => {
                              let cumulative = 0;
                              return weeks.map((week, weekIndex) => {
                                const minutes = hoursMap.get(weekIndex) ?? 0;
                                const hours = minutes / 60;
                                const fractionOfWeek = week.daysInWeek / 7;
                                const weekExpected = expectedWeeklyHours * fractionOfWeek;
                                cumulative += hours - weekExpected;
                                const isCurrentWeek = weekIndex === currentWeekIndex;

                                let colorClass = "text-slate-400 dark:text-slate-500";
                                if (cumulative > 8) {
                                  colorClass = "text-rose-600 dark:text-rose-400 font-medium";
                                } else if (cumulative < -8) {
                                  colorClass = "text-amber-600 dark:text-amber-400 font-medium";
                                } else if (cumulative !== 0) {
                                  colorClass = "text-slate-600 dark:text-slate-300";
                                }

                                return (
                                  <div
                                    key={week.weekNum}
                                    className={cx(
                                      "flex items-center justify-center border-r border-slate-100 text-[10px] dark:border-slate-800",
                                      isCurrentWeek && "bg-sky-50/50 dark:bg-sky-900/10",
                                      colorClass,
                                    )}
                                    style={{ width: WEEK_WIDTH, height: ROW_HEIGHT }}
                                  >
                                    {cumulative === 0 ? "–" : (cumulative > 0 ? `+${cumulative.toFixed(1)}` : cumulative.toFixed(1))}
                                  </div>
                                );
                              });
                            })()}
                          </div>
                          {(() => {
                            let colorClass = "text-slate-500 dark:text-slate-400";
                            if (yearlyDiff !== null) {
                              if (yearlyDiff > 8) {
                                colorClass = "text-rose-600 dark:text-rose-400";
                              } else if (yearlyDiff < -8) {
                                colorClass = "text-amber-600 dark:text-amber-400";
                              } else if (Math.abs(yearlyDiff) <= 8 && yearlyDiff !== 0) {
                                colorClass = "text-emerald-600 dark:text-emerald-400";
                              }
                            }
                            return (
                              <div
                                className={cx(
                                  "sticky right-0 z-40 flex items-center justify-center border-l-2 border-slate-300 bg-slate-100 text-[10px] font-semibold dark:border-slate-600 dark:bg-slate-800",
                                  colorClass,
                                )}
                                style={{ width: TOTAL_COLUMN_WIDTH, minWidth: TOTAL_COLUMN_WIDTH, height: ROW_HEIGHT }}
                              >
                                {yearlyDiff !== null ? (yearlyDiff > 0 ? `+${yearlyDiff.toFixed(1)}` : yearlyDiff.toFixed(1)) : "–"}
                              </div>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Empty state if no clinicians */}
                {clinicians.length === 0 && (
                  <div className="flex h-32 items-center justify-center text-sm text-slate-400 dark:text-slate-500">
                    No clinicians added yet.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
