import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Assignment, TemplateSlot, WeeklyCalendarTemplate } from "../../api/client";
import { buttonPrimary, buttonSecondary } from "../../lib/buttonStyles";
import { cx } from "../../lib/classNames";
import { getShiftMinutes, personTone } from "../../lib/myPlan";
import type { ScheduleRow } from "../../lib/shiftRows";
import { compactTimeLabel, slotTimeLabel } from "../../lib/stackedTeamLayout";
import {
  buildWorkingHoursYear,
  getWeeksInYear,
  slotMinutesFromTemplate,
  weekIndexOf,
  type HoursClinician,
} from "../../lib/workingHours";
import { initialsOf } from "../myPlan/planChrome";
import { HoursLegend, todayISO, weekTitle } from "./WorkingHoursParts";
import WorkingHoursWeekView, { type HoursPerson, type WeekSort } from "./WorkingHoursWeekView";
import WorkingHoursYearView, { YEAR_METRIC_LABEL, type YearMetric } from "./WorkingHoursYearView";

// Working hours overview (v1.78): a week view (each person's days, planned
// vs target, the year's balance) and a compact year view (one row per
// person). Calculations: lib/workingHours.

type View = "week" | "year";

type WorkingHoursOverviewModalProps = {
  open: boolean;
  onClose: () => void;
  clinicians: Array<HoursClinician & { name: string }>;
  assignments: Assignment[];
  weeklyTemplate?: WeeklyCalendarTemplate;
  /** Slot rows of the calendar: names and times for the day tooltips. */
  scheduleRows?: ScheduleRow[];
  isDark?: boolean;
  /** The plan's time zone: shift hours are real time in it (DST nights 1 h longer/shorter). */
  timeZone?: string;
};

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-800">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx(
            "rounded-full px-3 py-1 text-xs font-medium",
            value === option.value
              ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-slate-100"
              : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export default function WorkingHoursOverviewModal({
  open,
  onClose,
  clinicians,
  assignments,
  weeklyTemplate,
  scheduleRows,
  isDark = false,
  timeZone,
}: WorkingHoursOverviewModalProps) {
  const today = todayISO();
  const currentYear = Number(today.slice(0, 4));
  const [view, setView] = useState<View>("week");
  const [year, setYear] = useState(currentYear);
  const [weekIndex, setWeekIndex] = useState(() => Math.max(0, weekIndexOf(getWeeksInYear(currentYear), today)));
  const [metric, setMetric] = useState<YearMetric>("hours");
  const [sort, setSort] = useState<WeekSort>("list");
  const yearScrollRef = useRef<HTMLDivElement | null>(null);

  const goToToday = () => {
    setYear(currentYear);
    setWeekIndex(Math.max(0, weekIndexOf(getWeeksInYear(currentYear), today)));
  };

  // Every opening starts at this week's week view.
  useEffect(() => {
    if (!open) return;
    setView("week");
    goToToday();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const slotMinutesById = useMemo(() => slotMinutesFromTemplate(weeklyTemplate), [weeklyTemplate]);
  // Real minutes of a shift on its date in the plan's zone (DST changes).
  const minutesOf = useMemo(() => {
    if (!timeZone) return undefined;
    const slotById = new Map<string, TemplateSlot>();
    for (const location of weeklyTemplate?.locations ?? []) {
      for (const slot of location.slots ?? []) slotById.set(slot.id, slot);
    }
    return (rowId: string, dateISO: string) => {
      const slot = slotById.get(rowId);
      return slot ? getShiftMinutes(slot, dateISO, timeZone) : undefined;
    };
  }, [weeklyTemplate, timeZone]);
  const data = useMemo(
    () => (open ? buildWorkingHoursYear({ year, clinicians, assignments, slotMinutesById, minutesOf }) : null),
    [open, year, clinicians, assignments, slotMinutesById, minutesOf],
  );
  const people = useMemo<HoursPerson[]>(
    () =>
      data
        ? clinicians.map((clinician, index) => ({
            id: clinician.id,
            name: clinician.name,
            initials: initialsOf(clinician.name),
            tone: personTone(index, isDark),
            hours: data.people[index],
          }))
        : [],
    [data, clinicians, isDark],
  );
  const slotLabelById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const row of scheduleRows ?? []) {
      if (row.kind !== "class") continue;
      const time = slotTimeLabel(row);
      labels.set(row.id, [row.sectionName ?? row.name, time ? compactTimeLabel(time) : null].filter(Boolean).join(" "));
    }
    return labels;
  }, [scheduleRows]);

  const weeks = data?.weeks ?? [];
  const safeWeekIndex = Math.min(weekIndex, Math.max(0, weeks.length - 1));
  const week = weeks[safeWeekIndex];
  const currentWeekIndex = year === currentYear ? weekIndexOf(weeks, today) : -1;

  // Center today's week in the year view (after the view or year changed).
  const centerCurrentWeek = () => {
    window.requestAnimationFrame(() => {
      const container = yearScrollRef.current;
      const column = container?.querySelector<HTMLElement>('[data-current-week="true"]');
      if (!container || !column) return;
      const containerRect = container.getBoundingClientRect();
      const columnRect = column.getBoundingClientRect();
      const left = columnRect.left - containerRect.left + container.scrollLeft - containerRect.width / 2;
      // jsdom has no scrollTo; older Safari rejects the options object.
      if (typeof container.scrollTo === "function") container.scrollTo({ left: Math.max(0, left) });
      else container.scrollLeft = Math.max(0, left);
    });
  };
  useEffect(() => {
    if (open && view === "year") centerCurrentWeek();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view, year]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open || !data || !week) return null;

  const stepWeek = (delta: -1 | 1) => {
    const next = safeWeekIndex + delta;
    if (next >= 0 && next < weeks.length) {
      setWeekIndex(next);
      return;
    }
    const nextYear = year + delta;
    setYear(nextYear);
    setWeekIndex(delta > 0 ? 0 : getWeeksInYear(nextYear).length - 1);
  };
  const navLabel = view === "week" ? weekTitle(week) : String(year);
  const navButton =
    "grid h-7 w-7 place-items-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100";

  return createPortal(
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-slate-900/40 backdrop-blur-[1px] dark:bg-slate-950/50"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="relative mx-auto h-full w-full max-w-screen-2xl px-2 py-3 sm:px-6 sm:py-6">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Working Hours Overview"
          className="flex h-full flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-6 pb-3 pt-4 dark:border-slate-800">
            <div>
              <div className="text-lg font-semibold text-slate-900 dark:text-slate-100">Working Hours Overview</div>
              <div className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
                Planned hours against contract hours, per week and over the year.
              </div>
            </div>
            <button type="button" onClick={onClose} className={buttonPrimary.base}>
              Close
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-6 py-2.5 dark:border-slate-800">
            <Segmented<View>
              label="View"
              value={view}
              onChange={setView}
              options={[
                { value: "week", label: "Week" },
                { value: "year", label: "Year" },
              ]}
            />
            <div className="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-1 py-0.5 dark:border-slate-700 dark:bg-slate-900">
              <button
                type="button"
                className={navButton}
                aria-label={view === "week" ? "Previous week" : "Previous year"}
                onClick={() => (view === "week" ? stepWeek(-1) : setYear((value) => value - 1))}
              >
                ‹
              </button>
              <span className="min-w-[48px] px-1 text-center text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-100" data-testid="hours-period">
                {navLabel}
              </span>
              <button
                type="button"
                className={navButton}
                aria-label={view === "week" ? "Next week" : "Next year"}
                onClick={() => (view === "week" ? stepWeek(1) : setYear((value) => value + 1))}
              >
                ›
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                goToToday();
                // Already at this year: no state change re-centers, so do it here.
                if (view === "year" && year === currentYear) centerCurrentWeek();
              }}
              className={buttonSecondary.base}
            >
              Today
            </button>
            <div className="ml-auto">
              {view === "week" ? (
                <Segmented<WeekSort>
                  label="Sort"
                  value={sort}
                  onChange={setSort}
                  options={[
                    { value: "list", label: "Team order" },
                    { value: "difference", label: "Most under first" },
                  ]}
                />
              ) : (
                <Segmented<YearMetric>
                  label="Show"
                  value={metric}
                  onChange={setMetric}
                  options={(["hours", "difference", "balance"] as const).map((value) => ({
                    value,
                    label: YEAR_METRIC_LABEL[value],
                  }))}
                />
              )}
            </div>
          </div>

          {view === "week" ? (
            <WorkingHoursWeekView
              week={week}
              team={data.team[week.index]}
              people={people}
              slotLabelById={slotLabelById}
              sort={sort}
              today={today}
            />
          ) : (
            <WorkingHoursYearView
              ref={yearScrollRef}
              weeks={weeks}
              team={data.team}
              people={people}
              metric={metric}
              currentWeekIndex={currentWeekIndex}
              onOpenWeek={(index) => {
                setWeekIndex(index);
                setView("week");
              }}
            />
          )}

          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-slate-100 px-6 py-2.5 dark:border-slate-800">
            <HoursLegend showUnplanned={view === "year"} />
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              A week counts once half of the team&rsquo;s target hours are planned. Vacation lowers the
              target; on target = within the person&rsquo;s tolerance (default ± 5 h a week).
            </p>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
