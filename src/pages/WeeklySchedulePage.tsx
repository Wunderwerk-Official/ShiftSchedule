import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ClinicianEditModal from "../components/schedule/ClinicianEditModal";
import AutomatedPlanningPanel from "../components/schedule/AutomatedPlanningPanel";
import SolverOverlay, { type LiveSolution, type StatsHistoryEntry } from "../components/schedule/SolverOverlay";
import HelpView from "../components/schedule/HelpView";
import IcalExportModal from "../components/schedule/IcalExportModal";
import ScheduleGrid from "../components/schedule/ScheduleGrid";
import SettingsView from "../components/schedule/SettingsView";
import TopBar from "../components/schedule/TopBar";
import VacationOverviewModal from "../components/schedule/VacationOverviewModal";
import ViolationLinesOverlay from "../components/schedule/ViolationLinesOverlay";
import WorkingHoursOverviewModal from "../components/schedule/WorkingHoursOverviewModal";
import WeekNavigator from "../components/schedule/WeekNavigator";
import AdminUsersPanel from "../components/auth/AdminUsersPanel";
import { ChevronLeftIcon, ChevronRightIcon } from "../components/schedule/icons";
import {
  exportWeekPdf,
  exportWeeksPdf,
  getIcalPublishStatus,
  getWebPublishStatus,
  getState,
  publishIcal,
  publishWeb,
  abortSolver,
  rotateIcalToken,
  saveState,
  solveRange,
  rotateWeb,
  unpublishIcal,
  unpublishWeb,
  subscribeSolverProgress,
  type AuthUser,
  type Holiday,
  type IcalPublishStatus,
  type ScheduleSnapshotExport,
  type SolverDebugInfo,
  type SolverSettings,
  type WeeklyCalendarTemplate,
  type WebPublishStatus,
} from "../api/client";
import SolverDebugPanel from "../components/schedule/SolverDebugPanel";
import SolverInfoModal, { type SolverHistoryEntry } from "../components/schedule/SolverInfoModal";
import {
  Assignment,
  assignments,
  buildAssignmentMap,
  Clinician,
  clinicians as defaultClinicians,
  defaultMinSlotsByRowId,
  defaultSolverSettings,
  locationsEnabled as defaultLocationsEnabled,
  locations as defaultLocations,
  weeklyTemplate as defaultWeeklyTemplate,
  WorkplaceRow,
  workplaceRows,
} from "../data/mockData";
import { cx } from "../lib/classNames";
import { calculateSolverLiveStats } from "../lib/solverStats";
import { normalizePreferredWorkingTimes } from "../lib/clinicianPreferences";
import { addDays, addWeeks, startOfWeek, toISODate } from "../lib/date";
import { getDayType } from "../lib/dayTypes";
import {
  buildCalendarRows,
  buildColumnTimeMetaByKey,
  buildDayColumns,
  buildLocationColumnTimeMetaByKey,
  buildLocationSeparatorRowIds,
} from "../lib/calendarView";

/**
 * Extract the dateISO (YYYY-MM-DD) from an assignment key of the form
 * `${rowId}__${dateISO}__${clinicianId}`. Uses a regex because rowId itself
 * can contain "__" (e.g. "section-a__sub-shift-1"), which breaks a naive split.
 */
function extractDateFromAssignmentKey(key: string): string | null {
  const match = key.match(/__(\d{4}-\d{2}-\d{2})__/);
  return match ? match[1] : null;
}

/**
 * Scroll to the first assignment element matching any of the given keys.
 * Uses the data-assignment-key attribute on AssignmentPill components.
 *
 * Instead of a fixed timeout — which used to fail on larger schedules where
 * the post-setAnchorDate re-render takes longer than the delay — we poll via
 * requestAnimationFrame up to `maxWaitMs`. The moment the pill appears in
 * the DOM we scroll to it. This handles:
 *   - already-visible pills (found on the first tick; no visible scroll)
 *   - pills in the current week but outside the scrolled viewport
 *   - pills that only appear after a week-switch triggered by the caller
 *
 * scrollIntoView with inline/block:"center" lets the browser walk every
 * scrollable ancestor and scroll each the minimum amount:
 *   - the horizontal .calendar-scroll container scrolls sideways
 *   - the window scrolls vertically (since .calendar-scroll has overflow-y:
 *     hidden, so vertical scrolling happens on the window)
 */
function scrollToAssignmentKeys(keys: string[], maxWaitMs: number = 1000): void {
  if (keys.length === 0) return;
  const startedAt = performance.now();
  const tick = () => {
    for (const key of keys) {
      const element = document.querySelector(
        `[data-assignment-key="${key}"]`,
      ) as HTMLElement | null;
      if (element) {
        element.scrollIntoView({
          behavior: "smooth",
          block: "center",
          inline: "center",
        });
        return;
      }
    }
    if (performance.now() - startedAt > maxWaitMs) return;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
import { buildICalendar, type ICalEvent } from "../lib/ical";
import {
  buildRenderedAssignmentMap,
  buildShiftInterval,
  intervalsOverlap,
  REST_DAY_POOL_ID,
  VACATION_POOL_ID,
} from "../lib/schedule";
import {
  buildScheduleRows,
  buildShiftRowId,
  DEFAULT_LOCATION_ID,
  getAvailableSubShiftId,
  normalizeAppState,
  normalizeSubShifts,
  type ScheduleRow,
} from "../lib/shiftRows";

type ScheduleSnapshotImportResult = {
  imported: number;
  droppedClinicians: number;
  droppedSlots: number;
};

const defaultAppState = normalizeAppState({
  locations: defaultLocations,
  locationsEnabled: defaultLocationsEnabled,
  rows: workplaceRows,
  clinicians: defaultClinicians,
  assignments,
  minSlotsByRowId: defaultMinSlotsByRowId,
  slotOverridesByKey: {},
  weeklyTemplate: defaultWeeklyTemplate,
  holidays: [],
  solverSettings: defaultSolverSettings,
  solverRules: [],
}).state;

const CLASS_COLORS = [
  "bg-violet-500",
  "bg-cyan-500",
  "bg-fuchsia-500",
  "bg-amber-400",
  "bg-blue-600",
  "bg-rose-500",
  "bg-emerald-500",
  "bg-sky-500",
  "bg-lime-500",
];
const SECTION_BLOCK_COLORS = [
  "#FDE2E4",
  "#FFD9C9",
  "#FFE8D6",
  "#FFEFD1",
  "#FFF4C1",
  "#EEF6C8",
  "#E6F7D9",
  "#DDF6EE",
  "#D9F0FF",
  "#DEE8FF",
  "#E8E1F5",
];

const splitAssignmentKey = (key: string) => {
  const parts = key.split("__");
  if (parts.length < 2) {
    return { rowId: key, dateISO: "" };
  }
  const dateISO = parts.pop() ?? "";
  return { rowId: parts.join("__"), dateISO };
};

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia?.(query).matches ?? false;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    if (media.addEventListener) {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, [query]);

  return matches;
}

function MobileDayNavigator({
  date,
  onPrevDay,
  onNextDay,
  onToday,
}: {
  date: Date;
  onPrevDay: () => void;
  onNextDay: () => void;
  onToday: () => void;
}) {
  const label = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onPrevDay}
        className="grid h-8 w-8 place-items-center rounded-md border border-slate-200/70 bg-white text-slate-600 hover:bg-slate-50 active:bg-slate-100 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:bg-slate-800"
        aria-label="Previous day"
      >
        <ChevronLeftIcon className="h-4 w-4" />
      </button>
      <div className="min-w-[96px] text-center text-sm font-normal tracking-tight text-slate-700 dark:text-slate-200">
        {label}
      </div>
      <button
        type="button"
        onClick={onNextDay}
        className="grid h-8 w-8 place-items-center rounded-md border border-slate-200/70 bg-white text-slate-600 hover:bg-slate-50 active:bg-slate-100 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:bg-slate-800"
        aria-label="Next day"
      >
        <ChevronRightIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onToday}
        className="h-8 rounded-md border border-slate-200/70 bg-white px-3 text-sm font-normal text-slate-700 hover:bg-slate-50 active:bg-slate-100 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        Today
      </button>
    </div>
  );
}

type WeeklySchedulePageProps = {
  currentUser: AuthUser;
  onLogout: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
};

export default function WeeklySchedulePage({
  currentUser,
  onLogout,
  theme,
  onToggleTheme,
}: WeeklySchedulePageProps) {
  const currentYear = new Date().getFullYear();
  const [viewMode, setViewMode] = useState<"calendar" | "settings" | "help">(
    "calendar",
  );
  const [exportOpen, setExportOpen] = useState(false);
  const [icalPublishStatus, setIcalPublishStatus] = useState<IcalPublishStatus | null>(
    null,
  );
  const [icalPublishLoading, setIcalPublishLoading] = useState(false);
  const [icalPublishError, setIcalPublishError] = useState<string | null>(null);
  const [webPublishStatus, setWebPublishStatus] = useState<WebPublishStatus | null>(
    null,
  );
  const [webPublishLoading, setWebPublishLoading] = useState(false);
  const [webPublishError, setWebPublishError] = useState<string | null>(null);
  const [pdfExporting, setPdfExporting] = useState(false);
  const [pdfProgress, setPdfProgress] = useState<{ current: number; total: number } | null>(
    null,
  );
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [anchorDate, setAnchorDate] = useState<Date>(new Date());
  const [assignmentMap, setAssignmentMap] = useState<Map<string, Assignment[]>>(() =>
    buildAssignmentMap(defaultAppState.assignments ?? []),
  );
  const [minSlotsByRowId, setMinSlotsByRowId] = useState<
    Record<string, { weekday: number; weekend: number }>
  >(defaultAppState.minSlotsByRowId ?? defaultMinSlotsByRowId);
  const [slotOverridesByKey, setSlotOverridesByKey] = useState<
    Record<string, number>
  >(defaultAppState.slotOverridesByKey ?? {});
  const [clinicians, setClinicians] = useState<Clinician[]>(() =>
    (defaultAppState.clinicians ?? defaultClinicians).map((clinician) => ({
      ...clinician,
      preferredClassIds: [...clinician.qualifiedClassIds],
      preferredWorkingTimes: normalizePreferredWorkingTimes(
        clinician.preferredWorkingTimes,
      ),
    })),
  );
  const [editingClinicianId, setEditingClinicianId] = useState<string>("");
  const [editingClinicianSection, setEditingClinicianSection] = useState<
    "vacations" | null
  >(null);
  const [vacationOverviewOpen, setVacationOverviewOpen] = useState(false);
  const [workingHoursOverviewOpen, setWorkingHoursOverviewOpen] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadedUserId, setLoadedUserId] = useState<string>("");
  const [solverNotice, setSolverNotice] = useState<{
    notes: string;
    debugInfo?: SolverDebugInfo;
  } | null>(null);
  const [autoPlanProgress, setAutoPlanProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [autoPlanStartedAt, setAutoPlanStartedAt] = useState<number | null>(null);
  const [autoPlanLastRunStats, setAutoPlanLastRunStats] = useState<{
    totalDays: number;
    durationMs: number;
  } | null>(null);
  const [autoPlanError, setAutoPlanError] = useState<string | null>(null);
  const [autoPlanRunning, setAutoPlanRunning] = useState(false);
  const [autoPlanElapsedMs, setAutoPlanElapsedMs] = useState(0);
  const [autoPlanDateRange, setAutoPlanDateRange] = useState<{
    startISO: string;
    endISO: string;
  } | null>(null);
  const autoPlanAbortRef = useRef<AbortController | null>(null);
  const skipApplyOnAbortRef = useRef(false); // When true, abort handler should NOT apply solution
  const [liveSolutions, setLiveSolutions] = useState<LiveSolution[]>([]);
  const liveSolutionsRef = useRef<LiveSolution[]>([]);
  const [solverPhase, setSolverPhase] = useState<string | null>(null);
  const [solverHistory, setSolverHistory] = useState<SolverHistoryEntry[]>([]);
  const [solverInfoOpen, setSolverInfoOpen] = useState(false);
  const [solverTimeoutSeconds, setSolverTimeoutSeconds] = useState(1800);
  const [holidays, setHolidays] = useState<Holiday[]>(defaultAppState.holidays ?? []);
  const [holidayCountry, setHolidayCountry] = useState(
    defaultAppState.holidayCountry ?? "DE",
  );
  const [holidayYear, setHolidayYear] = useState(currentYear);
  const [publishedWeekStartISOs, setPublishedWeekStartISOs] = useState<string[]>([]);
  const [solverSettings, setSolverSettings] = useState<SolverSettings>(
    defaultAppState.solverSettings ?? defaultSolverSettings,
  );
  const [locationsEnabled, setLocationsEnabled] = useState(
    defaultAppState.locationsEnabled ?? defaultLocationsEnabled,
  );
  const [ruleViolationsOpen, setRuleViolationsOpen] = useState(false);
  const [activeRuleViolationId, setActiveRuleViolationId] = useState<string | null>(null);
  const [hoveredRuleViolationId, setHoveredRuleViolationId] = useState<string | null>(null);
  const [isRuleViolationsHovered, setIsRuleViolationsHovered] = useState(false);
  const [isOpenSlotsHovered, setIsOpenSlotsHovered] = useState(false);
  const [nonConsecutiveShiftsOpen, setNonConsecutiveShiftsOpen] = useState(false);
  const [isSplitShiftsHovered, setIsSplitShiftsHovered] = useState(false);
  const [activeSplitShiftId, setActiveSplitShiftId] = useState<string | null>(null);
  const [hoveredSplitShiftId, setHoveredSplitShiftId] = useState<string | null>(null);
  const ruleViolationsRef = useRef<HTMLDivElement | null>(null);
  const nonConsecutiveShiftsRef = useRef<HTMLDivElement | null>(null);

  const isMobile = useMediaQuery("(max-width: 640px)");
  useEffect(() => {
    if (!ruleViolationsOpen) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!ruleViolationsRef.current || ruleViolationsRef.current.contains(target)) return;
      setRuleViolationsOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [ruleViolationsOpen]);
  useEffect(() => {
    if (!ruleViolationsOpen) {
      setActiveRuleViolationId(null);
    }
  }, [ruleViolationsOpen]);
  useEffect(() => {
    if (!nonConsecutiveShiftsOpen) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!nonConsecutiveShiftsRef.current || nonConsecutiveShiftsRef.current.contains(target)) return;
      setNonConsecutiveShiftsOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [nonConsecutiveShiftsOpen]);
  useEffect(() => {
    if (!nonConsecutiveShiftsOpen) {
      setActiveSplitShiftId(null);
      setHoveredSplitShiftId(null);
    }
  }, [nonConsecutiveShiftsOpen]);

  // Track elapsed time during solver run
  useEffect(() => {
    if (!autoPlanRunning || !autoPlanStartedAt) {
      return;
    }
    const updateElapsed = () => {
      setAutoPlanElapsedMs(Date.now() - autoPlanStartedAt);
    };
    updateElapsed();
    const intervalId = window.setInterval(updateElapsed, 100);
    return () => window.clearInterval(intervalId);
  }, [autoPlanRunning, autoPlanStartedAt]);

  // Subscribe to SSE for live solver progress when solver is running
  useEffect(() => {
    if (!autoPlanRunning) {
      return;
    }
    // Clear previous solutions when starting a new solve
    setLiveSolutions([]);
    liveSolutionsRef.current = [];
    setSolverPhase(null);

    const unsubscribe = subscribeSolverProgress(
      (event) => {
        if (event.event === "phase") {
          // Store the human-readable label from the backend
          setSolverPhase(event.data.label);
        } else if (event.event === "solution") {
          // Once we get solutions, clear the phase (we're in solve mode)
          setSolverPhase(null);
          const newSolution = {
            solution_num: event.data.solution_num,
            time_ms: event.data.time_ms,
            objective: event.data.objective,
            assignments: event.data.assignments,
          };
          setLiveSolutions((prev) => [...prev, newSolution]);
          liveSolutionsRef.current = [...liveSolutionsRef.current, newSolution];
        }
      },
      () => {
        // SSE error - ignore, the overlay will still work without live updates
      },
    );

    return unsubscribe;
  }, [autoPlanRunning]);

  const weekStart = useMemo(() => startOfWeek(anchorDate, 1), [anchorDate]);
  const currentWeekStartISO = useMemo(() => toISODate(weekStart), [weekStart]);
  const fullWeekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const displayDays = useMemo(
    () => (isMobile ? [anchorDate] : fullWeekDays),
    [anchorDate, fullWeekDays, isMobile],
  );
  const weekEndInclusive = useMemo(() => addDays(weekStart, 6), [weekStart]);
  const isWeekPublished = useMemo(
    () => publishedWeekStartISOs.includes(currentWeekStartISO),
    [currentWeekStartISO, publishedWeekStartISOs],
  );

  const [locations, setLocations] = useState(defaultAppState.locations ?? defaultLocations);
  const [rows, setRows] = useState<WorkplaceRow[]>(defaultAppState.rows ?? workplaceRows);
  const [weeklyTemplate, setWeeklyTemplateRaw] = useState<WeeklyCalendarTemplate | undefined>(
    defaultAppState.weeklyTemplate,
  );

  // Safeguard wrapper to prevent colBand explosion (max 20 per dayType)
  const setWeeklyTemplate = useCallback((update: React.SetStateAction<WeeklyCalendarTemplate | undefined>) => {
    setWeeklyTemplateRaw((prev) => {
      const next = typeof update === "function" ? update(prev) : update;
      if (!next?.locations) return next;

      // Log every update for debugging
      const prevTotal = prev?.locations?.reduce((s, l) => s + (l.colBands?.length ?? 0), 0) ?? 0;
      const nextTotal = next.locations.reduce((s, l) => s + (l.colBands?.length ?? 0), 0);
      if (nextTotal !== prevTotal) {
        console.log(`[setWeeklyTemplate] colBands: ${prevTotal} -> ${nextTotal}`, {
          stack: new Error().stack?.split('\n').slice(2, 6).join('\n')
        });
      }

      // Check for colBand explosion (reduced from 50 to 20)
      const MAX_COLBANDS_PER_DAY = 20;
      let needsSanitization = false;
      for (const loc of next.locations) {
        const countByDay = new Map<string, number>();
        for (const cb of loc.colBands ?? []) {
          const day = cb.dayType ?? "unknown";
          countByDay.set(day, (countByDay.get(day) ?? 0) + 1);
        }
        for (const [day, count] of countByDay) {
          if (count > MAX_COLBANDS_PER_DAY) {
            console.error(
              `[WeeklySchedulePage] BLOCKING colBand explosion! ` +
              `Location ${loc.locationId} has ${count} colBands for ${day} (max: ${MAX_COLBANDS_PER_DAY})`,
              { stack: new Error().stack }
            );
            needsSanitization = true;
            break;
          }
        }
        if (needsSanitization) break;
      }

      if (!needsSanitization) return next;

      // Sanitize: keep only first MAX_COLBANDS_PER_DAY colBands per dayType
      return {
        ...next,
        locations: next.locations.map((loc) => {
          const countByDay = new Map<string, number>();
          const filteredColBands = loc.colBands.filter((cb) => {
            const day = cb.dayType ?? "unknown";
            const current = countByDay.get(day) ?? 0;
            if (current >= MAX_COLBANDS_PER_DAY) return false;
            countByDay.set(day, current + 1);
            return true;
          });
          return { ...loc, colBands: filteredColBands };
        }),
      };
    });
  }, []);

  const classRows = useMemo(() => rows.filter((r) => r.kind === "class"), [rows]);
  const templateSectionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const block of weeklyTemplate?.blocks ?? []) {
      if (block.sectionId) ids.add(block.sectionId);
    }
    return ids;
  }, [weeklyTemplate]);
  const eligibleClassRows = useMemo(() => {
    if (templateSectionIds.size === 0) return classRows;
    return classRows.filter((row) => templateSectionIds.has(row.id));
  }, [classRows, templateSectionIds]);
  const poolRows = useMemo(() => rows.filter((r) => r.kind === "pool"), [rows]);
  const scheduleRows = useMemo(
    () => buildScheduleRows(rows, locations, locationsEnabled, weeklyTemplate),
    [rows, locations, locationsEnabled, weeklyTemplate],
  );
  const visibleScheduleRows = useMemo(() => scheduleRows, [scheduleRows]);
  const classShiftRows = useMemo(
    () => scheduleRows.filter((row) => row.kind === "class"),
    [scheduleRows],
  );
  const calendarRows = useMemo(
    () => buildCalendarRows(visibleScheduleRows),
    [visibleScheduleRows],
  );
  const locationSeparatorRowIds = useMemo(
    () => buildLocationSeparatorRowIds(calendarRows),
    [calendarRows],
  );
  const classShiftRowIds = useMemo(
    () => classShiftRows.map((row) => row.id),
    [classShiftRows],
  );
  const poolsSeparatorId = calendarRows.find((row) => row.kind === "pool")?.id ?? "";
  const clinicianNameById = useMemo(
    () => new Map(clinicians.map((clinician) => [clinician.id, clinician.name])),
    [clinicians],
  );
  const rowById = useMemo(
    () => {
      const map = new Map<string, ScheduleRow>();
      for (const row of scheduleRows) {
        map.set(row.id, row);
        row.slotRows?.forEach((slotRow) => {
          map.set(slotRow.id, slotRow);
        });
      }
      return map;
    },
    [scheduleRows],
  );
  const clinicianById = useMemo(
    () => new Map(clinicians.map((clinician) => [clinician.id, clinician])),
    [clinicians],
  );
  const holidayDates = useMemo(
    () => new Set(holidays.map((holiday) => holiday.dateISO)),
    [holidays],
  );
  const holidayNameByDate = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const holiday of holidays) {
      const list = map.get(holiday.dateISO) ?? [];
      list.push(holiday.name);
      map.set(holiday.dateISO, list);
    }
    const record: Record<string, string> = {};
    for (const [dateISO, names] of map.entries()) {
      record[dateISO] = names.join(" · ");
    }
    return record;
  }, [holidays]);
  const columnTimeMetaByKey = useMemo(
    () => buildColumnTimeMetaByKey(scheduleRows),
    [scheduleRows],
  );
  const locationColumnTimeMetaByKey = useMemo(
    () => buildLocationColumnTimeMetaByKey(scheduleRows),
    [scheduleRows],
  );

  // Detect slot collisions: multiple sections sharing the same rowBandId + dayType + colBandOrder
  // This is a critical configuration error - only one section will be visible in the UI
  type SlotCollision = {
    key: string;
    locationId: string;
    rowBandId: string;
    dayType: string;
    colBandOrder: number;
    sections: Array<{ slotId: string; sectionName: string }>;
  };
  const slotCollisions = useMemo((): SlotCollision[] => {
    const collisionMap = new Map<string, Array<{ slotId: string; sectionName: string; sectionId: string }>>();
    for (const row of classShiftRows) {
      if (!row.rowBandId || !row.dayType) continue;
      const key = `${row.locationId ?? "loc"}__${row.rowBandId}__${row.dayType}__${row.colBandOrder ?? 1}`;
      const existing = collisionMap.get(key) ?? [];
      existing.push({
        slotId: row.id,
        sectionName: row.sectionName ?? row.name,
        sectionId: row.sectionId ?? row.id,
      });
      collisionMap.set(key, existing);
    }
    const collisions: SlotCollision[] = [];
    for (const [key, slots] of collisionMap) {
      // Check if multiple DIFFERENT sections share the same position
      const uniqueSections = new Set(slots.map(s => s.sectionId));
      if (uniqueSections.size > 1) {
        const [locationId, rowBandId, dayType, colBandOrderStr] = key.split("__");
        collisions.push({
          key,
          locationId: locationId ?? "loc",
          rowBandId: rowBandId ?? "",
          dayType: dayType ?? "mon",
          colBandOrder: parseInt(colBandOrderStr ?? "1", 10),
          sections: slots.map(s => ({ slotId: s.slotId, sectionName: s.sectionName })),
        });
      }
    }
    return collisions;
  }, [classShiftRows]);

  const dayColumns = useMemo(
    () => buildDayColumns(displayDays, weeklyTemplate, holidayDates, columnTimeMetaByKey),
    [displayDays, weeklyTemplate, holidayDates, columnTimeMetaByKey],
  );
  const isWeekendOrHoliday = (dateISO: string) => {
    const date = new Date(`${dateISO}T00:00:00`);
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
    return isWeekend || holidayDates.has(dateISO);
  };

  const downloadTextFile = (filename: string, mimeType: string, content: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const downloadBlob = (filename: string, blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const buildScheduleSnapshot = (): ScheduleSnapshotExport => ({
    version: 1,
    exportedAt: new Date().toISOString(),
    sourceUser: currentUser.username,
    assignments: toAssignments(),
  });

  const extractAssignmentsFromSnapshot = (payload: unknown): Assignment[] | null => {
    if (!payload || typeof payload !== "object") return null;
    const maybePayload = payload as { assignments?: Assignment[]; state?: { assignments?: Assignment[] } };
    if (Array.isArray(maybePayload.assignments)) return maybePayload.assignments;
    if (Array.isArray(maybePayload.state?.assignments)) return maybePayload.state.assignments;
    return null;
  };

  const handleExportScheduleSnapshot = () => {
    const snapshot = buildScheduleSnapshot();
    const dateStamp = snapshot.exportedAt.slice(0, 10);
    downloadTextFile(
      `schedule-snapshot-${dateStamp}.json`,
      "application/json",
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
  };

  const handleImportScheduleSnapshot = async (
    payload: unknown,
  ): Promise<ScheduleSnapshotImportResult> => {
    const assignments = extractAssignmentsFromSnapshot(payload);
    if (!assignments) {
      throw new Error("No assignments found in the snapshot file.");
    }

    const clinicianIds = new Set(clinicians.map((clinician) => clinician.id));
    const filteredByClinician = assignments.filter((assignment) =>
      clinicianIds.has(assignment.clinicianId),
    );
    const droppedClinicians = assignments.length - filteredByClinician.length;

    const { state: normalized } = normalizeAppState({
      locations,
      locationsEnabled,
      rows,
      clinicians,
      assignments: filteredByClinician,
      minSlotsByRowId,
      slotOverridesByKey,
      holidays,
      holidayCountry,
      holidayYear,
      publishedWeekStartISOs,
      solverSettings,
      weeklyTemplate,
    });

    const normalizedAssignments = normalized.assignments ?? [];
    const droppedSlots = filteredByClinician.length - normalizedAssignments.length;

    if (hasLoaded && loadedUserId === currentUser.username) {
      saveState(normalized).catch(() => {
        /* Backend optional during local-only dev */
      });
    }

    setAssignmentMap(buildAssignmentMap(normalizedAssignments));

    return {
      imported: normalizedAssignments.length,
      droppedClinicians,
      droppedSlots,
    };
  };

  const toAssignments = () => {
    const out: Assignment[] = [];
    for (const list of assignmentMap.values()) {
      out.push(...list);
    }
    return out;
  };

  const toRenderedAssignments = () => {
    const out: Assignment[] = [];
    for (const list of renderAssignmentMap.values()) {
      out.push(...list);
    }
    return out;
  };

  // Get existing manual assignments within the solve range for accurate stats display
  const existingAssignmentsForSolver = useMemo(() => {
    if (!autoPlanDateRange) return [];
    const { startISO, endISO } = autoPlanDateRange;
    const out: Assignment[] = [];
    for (const list of assignmentMap.values()) {
      for (const a of list) {
        // Only include manual assignments (source !== "solver") within the solve range
        if (a.source !== "solver" && a.dateISO >= startISO && a.dateISO <= endISO) {
          out.push(a);
        }
      }
    }
    return out;
  }, [assignmentMap, autoPlanDateRange]);

  const collectClassAssignments = () => {
    const items: Assignment[] = [];
    for (const list of assignmentMap.values()) {
      for (const assignment of list) {
        const row = rowById.get(assignment.rowId);
        if (!row || row.kind !== "class") continue;
        items.push(assignment);
      }
    }
    return items;
  };

  const withinRange = (
    dateISO: string,
    range: { startISO?: string; endISO?: string },
  ) => {
    if (range.startISO && dateISO < range.startISO) return false;
    if (range.endISO && dateISO > range.endISO) return false;
    return true;
  };

  const buildIcalEventsForAssignments = (
    assignments: Assignment[],
    options: { includeClinicianInSummary: boolean },
  ): ICalEvent[] => {
    return assignments
      .map((assignment): ICalEvent | null => {
        const row = rowById.get(assignment.rowId);
        const clinician = clinicianById.get(assignment.clinicianId);
        if (!row || row.kind !== "class" || !clinician) return null;
        const sectionName = row.sectionName ?? row.name;
        const slotLabel = row.slotLabel;
        const label = slotLabel ? `${sectionName} (${slotLabel})` : sectionName;
        const summary = `${label} - ${clinician.name}`;
        const description = options.includeClinicianInSummary
          ? undefined
          : `Person: ${clinician.name}`;
        return {
          uid: `${assignment.id}@shift-planner`,
          dateISO: assignment.dateISO,
          summary,
          ...(description ? { description } : {}),
        };
      })
      .filter((item): item is ICalEvent => item !== null)
      .sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  };

  const handleDownloadIcalAll = (range: { startISO?: string; endISO?: string }) => {
    const classAssignments = collectClassAssignments().filter((assignment) =>
      withinRange(assignment.dateISO, range),
    );
    const events = buildIcalEventsForAssignments(classAssignments, {
      includeClinicianInSummary: true,
    });
    const ics = buildICalendar({
      calendarName: "Shift Planner (All people)",
      events,
    });
    downloadTextFile("shift-planner-all.ics", "text/calendar;charset=utf-8", ics);
  };

  const handleDownloadIcalClinician = (
    clinicianId: string,
    range: { startISO?: string; endISO?: string },
  ) => {
    const clinician = clinicianById.get(clinicianId);
    if (!clinician) return;
    const classAssignments = collectClassAssignments().filter(
      (assignment) =>
        assignment.clinicianId === clinicianId &&
        withinRange(assignment.dateISO, range),
    );
    const events = buildIcalEventsForAssignments(classAssignments, {
      includeClinicianInSummary: false,
    });
    const safeName = clinician.name
      .trim()
      .replaceAll(/[^\w\- ]+/g, "")
      .replaceAll(/\s+/g, "-")
      .toLowerCase();
    const ics = buildICalendar({
      calendarName: `Shift Planner (${clinician.name})`,
      events,
    });
    downloadTextFile(
      `shift-planner-${safeName || clinician.id}.ics`,
      "text/calendar;charset=utf-8",
      ics,
    );
  };

  const openExportModal = () => {
    setExportOpen(true);
    setIcalPublishError(null);
    setIcalPublishLoading(true);
    setWebPublishError(null);
    setWebPublishLoading(true);
    getIcalPublishStatus()
      .then(async (status) => {
        if (status.published) {
          try {
            const refreshed = await publishIcal();
            setIcalPublishStatus(refreshed);
            return;
          } catch {
            // fall through to show existing status
          }
        }
        setIcalPublishStatus(status);
      })
      .catch(() => {
        setIcalPublishError("Could not load subscription status.");
        setIcalPublishStatus(null);
      })
      .finally(() => setIcalPublishLoading(false));
    getWebPublishStatus()
      .then((status) => {
        setWebPublishStatus(status);
      })
      .catch(() => {
        setWebPublishError("Could not load web link status.");
        setWebPublishStatus(null);
      })
      .finally(() => setWebPublishLoading(false));
  };

  const closeExportModal = () => {
    setExportOpen(false);
    setIcalPublishError(null);
    setIcalPublishLoading(false);
    setWebPublishError(null);
    setWebPublishLoading(false);
  };

  const openClinicianEditor = (clinicianId: string, section?: "vacations") => {
    setEditingClinicianSection(section ?? null);
    setEditingClinicianId(clinicianId);
  };

  const closeClinicianEditor = () => {
    setEditingClinicianId("");
    setEditingClinicianSection(null);
  };

  const handlePublishSubscription = async () => {
    setIcalPublishError(null);
    setIcalPublishLoading(true);
    try {
      const status = await publishIcal();
      setIcalPublishStatus(status);
    } catch {
      setIcalPublishError("Publishing failed.");
    } finally {
      setIcalPublishLoading(false);
    }
  };

  const handleRotateSubscription = async () => {
    setIcalPublishError(null);
    setIcalPublishLoading(true);
    try {
      const status = await rotateIcalToken();
      setIcalPublishStatus(status);
    } catch {
      setIcalPublishError("Rotating the link failed.");
    } finally {
      setIcalPublishLoading(false);
    }
  };

  const handleUnpublishSubscription = async () => {
    setIcalPublishError(null);
    setIcalPublishLoading(true);
    try {
      await unpublishIcal();
      setIcalPublishStatus({ published: false });
    } catch {
      setIcalPublishError("Unpublishing failed.");
    } finally {
      setIcalPublishLoading(false);
    }
  };

  const handleWebPublish = async () => {
    setWebPublishError(null);
    setWebPublishLoading(true);
    try {
      const status = await publishWeb();
      setWebPublishStatus(status);
    } catch {
      setWebPublishError("Publishing failed.");
    } finally {
      setWebPublishLoading(false);
    }
  };

  const handleWebRotate = async () => {
    setWebPublishError(null);
    setWebPublishLoading(true);
    try {
      const status = await rotateWeb();
      setWebPublishStatus(status);
    } catch {
      setWebPublishError("Refreshing the link failed.");
    } finally {
      setWebPublishLoading(false);
    }
  };

  const handleWebUnpublish = async () => {
    setWebPublishError(null);
    setWebPublishLoading(true);
    try {
      await unpublishWeb();
      setWebPublishStatus({ published: false });
    } catch {
      setWebPublishError("Unpublishing failed.");
    } finally {
      setWebPublishLoading(false);
    }
  };

  const handleExportPdfBatch = async (args: {
    startISO: string;
    weeks: number;
    mode: "combined" | "individual";
  }) => {
    setPdfError(null);
    setPdfExporting(true);
    try {
      if (args.mode === "combined") {
        setPdfProgress({ current: 0, total: args.weeks });
        const pdfBlob = await exportWeeksPdf(args.startISO, args.weeks);
        const endISO = toISODate(addDays(addWeeks(new Date(`${args.startISO}T00:00:00`), args.weeks), -1));
        downloadBlob(`shift-planner-${args.startISO}-to-${endISO}.pdf`, pdfBlob);
      } else {
        const baseDate = startOfWeek(new Date(`${args.startISO}T00:00:00`), 1);
        for (let i = 0; i < args.weeks; i += 1) {
          const weekStartDate = addWeeks(baseDate, i);
          const weekStartISO = toISODate(weekStartDate);
          setPdfProgress({ current: i + 1, total: args.weeks });
          const pdfBlob = await exportWeekPdf(weekStartISO);
          downloadBlob(`shift-planner-${weekStartISO}.pdf`, pdfBlob);
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }
    } catch {
      setPdfError("PDF export failed.");
    } finally {
      setPdfExporting(false);
      setPdfProgress(null);
    }
  };

  const renderAssignmentMap = useMemo(
    () =>
      buildRenderedAssignmentMap(assignmentMap, clinicians, displayDays, {
        scheduleRows,
        solverSettings,
        holidayDates,
      }),
    [assignmentMap, clinicians, displayDays, scheduleRows, solverSettings],
  );

  // Full week rendered assignments for gap detection (uses fullWeekDays, not displayDays)
  const fullWeekRenderAssignmentMap = useMemo(
    () =>
      buildRenderedAssignmentMap(assignmentMap, clinicians, fullWeekDays, {
        scheduleRows,
        solverSettings,
        holidayDates,
      }),
    [assignmentMap, clinicians, fullWeekDays, scheduleRows, solverSettings],
  );

  const isOnVacation = (clinicianId: string, dateISO: string) => {
    const clinician = clinicians.find((item) => item.id === clinicianId);
    if (!clinician) return false;
    return clinician.vacations.some(
      (vacation) => vacation.startISO <= dateISO && dateISO <= vacation.endISO,
    );
  };

  const isOnRestDay = (clinicianId: string, dateISO: string) => {
    const restAssignments = renderAssignmentMap.get(
      `${REST_DAY_POOL_ID}__${dateISO}`,
    );
    if (!restAssignments || restAssignments.length === 0) return false;
    return restAssignments.some((assignment) => assignment.clinicianId === clinicianId);
  };

  const shiftDateISO = (dateISO: string, delta: number) =>
    toISODate(addDays(new Date(`${dateISO}T00:00:00`), delta));
  const formatEuropeanDate = (dateISO: string) => {
    const [year, month, day] = dateISO.split("-");
    if (!year || !month || !day) return dateISO;
    return `${day}.${month}.${year}`;
  };

  const applySolverAssignments = (assignments: Assignment[]) => {
    if (!assignments.length) return;
    setAssignmentMap((prev) => {
      const next = new Map(prev);
      for (const assignment of assignments) {
        const key = `${assignment.rowId}__${assignment.dateISO}`;
        const existing = next.get(key) ?? [];
        const already = existing.some(
          (item) =>
            item.clinicianId === assignment.clinicianId &&
            item.rowId === assignment.rowId &&
            item.dateISO === assignment.dateISO,
        );
        if (!already) next.set(key, [...existing, assignment]);
      }
      return next;
    });
  };

  const buildDateRange = (startISO: string, endISO: string) => {
    const dates: string[] = [];
    let current = new Date(`${startISO}T00:00:00`);
    const end = new Date(`${endISO}T00:00:00`);
    while (current <= end) {
      dates.push(toISODate(current));
      current = addDays(current, 1);
    }
    return dates;
  };

  const addSolverHistoryEntry = (entry: SolverHistoryEntry) => {
    setSolverHistory((prev) => {
      const updated = [entry, ...prev];
      // Keep only the last 5 entries
      return updated.slice(0, 5);
    });
  };

  const handleRunAutomatedPlanning = async (args: {
    startISO: string;
    endISO: string;
    onlyFillRequired: boolean;
    timeoutSeconds: number;
  }) => {
    if (autoPlanRunning) return;
    setAutoPlanError(null);
    const dateRange = buildDateRange(args.startISO, args.endISO);
    if (dateRange.length === 0) {
      setAutoPlanError("Select a valid timeframe to run the solver.");
      return;
    }
    const abortController = new AbortController();
    autoPlanAbortRef.current = abortController;
    setAutoPlanRunning(true);
    setAutoPlanElapsedMs(0);
    setAutoPlanDateRange({ startISO: args.startISO, endISO: args.endISO });
    const startedAt = Date.now();
    setAutoPlanStartedAt(startedAt);
    setAutoPlanProgress({ current: 0, total: dateRange.length });

    let historyStatus: "success" | "aborted" | "error" = "success";
    let historyNotes: string[] = [];
    let historyDebugInfo: SolverDebugInfo | undefined;

    // Capture existing manual assignments at the start for stats computation later
    const capturedExistingAssignments: Assignment[] = [];
    for (const list of assignmentMap.values()) {
      for (const a of list) {
        if (a.source !== "solver" && a.dateISO >= args.startISO && a.dateISO <= args.endISO) {
          capturedExistingAssignments.push(a);
        }
      }
    }

    try {
      if (hasLoaded && loadedUserId === currentUser.username) {
        const { state: normalized } = normalizeAppState({
          locations,
          locationsEnabled,
          rows,
          clinicians,
          assignments: toAssignments(),
          minSlotsByRowId,
          slotOverridesByKey,
          holidays,
          holidayCountry,
          holidayYear,
          publishedWeekStartISOs,
          solverSettings,
          weeklyTemplate,
        });
        await saveState(normalized);
      }
      const result = await solveRange(args.startISO, {
        endISO: args.endISO,
        onlyFillRequired: args.onlyFillRequired,
        timeoutSeconds: args.timeoutSeconds,
        signal: abortController.signal,
      });

      historyNotes = result.notes;
      historyDebugInfo = result.debugInfo;

      // Check if solver was aborted (based on notes or status)
      if (result.notes.some((n) => n.includes("aborted"))) {
        historyStatus = "aborted";
      }

      // Only show notice for warnings/errors, not for successful completion
      // Detailed debug info is available in the solver history (gear icon)
      const warningNotes = result.notes.filter(
        (n) => n.toLowerCase().includes("warning") ||
               n.toLowerCase().includes("error") ||
               n.toLowerCase().includes("could not") ||
               n.toLowerCase().includes("ignored")
      );
      if (warningNotes.length > 0) {
        setSolverNotice({
          notes: warningNotes.join("\n"),
        });
        // Auto-dismiss after 5 seconds for warnings
        window.setTimeout(() => setSolverNotice(null), 5000);
      }
      const filtered = result.assignments.filter(
        (a) => a.dateISO >= args.startISO && a.dateISO <= args.endISO,
      );
      // Clear only solver-generated assignments before applying new solution, preserve manual ones
      setAssignmentMap((prev) => {
        const next = new Map(prev);
        for (const [key, list] of next.entries()) {
          const { rowId, dateISO: keyDate } = splitAssignmentKey(key);
          if (!rowId || !keyDate) continue;
          if (rowId.startsWith("pool-")) continue;
          if (keyDate < args.startISO || keyDate > args.endISO) continue;
          // Keep manual assignments (source !== "solver") and vacation assignments
          const filteredList = list.filter(
            (item) => item.source !== "solver" || isOnVacation(item.clinicianId, keyDate)
          );
          if (filteredList.length === 0) {
            next.delete(key);
          } else {
            next.set(key, filteredList);
          }
        }
        return next;
      });
      applySolverAssignments(filtered);
      setAutoPlanProgress({ current: dateRange.length, total: dateRange.length });
      setAutoPlanLastRunStats({
        totalDays: dateRange.length,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // User aborted - construct partial debug info from live solutions
        historyStatus = "aborted";
        const shouldSkipApply = skipApplyOnAbortRef.current;
        skipApplyOnAbortRef.current = false; // Reset for next run

        historyNotes = shouldSkipApply
          ? ["Solver was aborted by user request."]
          : ["Solver was aborted - applied last available solution."];

        // Build partial debug info from SSE live solutions (always capture for history)
        const capturedSolutions = liveSolutionsRef.current;
        const elapsedMs = Date.now() - startedAt;
        // Get estimated CPU info (browser can't access actual CPU count, so use reasonable defaults)
        const estimatedCpuCores = navigator.hardwareConcurrency ?? 4;
        const estimatedCpuWorkers = Math.max(1, estimatedCpuCores - 2);
        historyDebugInfo = {
          timing: {
            total_ms: elapsedMs,
            checkpoints: [],
          },
          solution_times: capturedSolutions.map((s) => ({
            solution: s.solution_num,
            time_ms: s.time_ms,
            objective: s.objective,
          })),
          num_variables: 0,
          num_days: dateRange.length,
          num_slots: 0,
          solver_status: "ABORTED",
          cpu_workers_used: estimatedCpuWorkers,
          cpu_cores_available: estimatedCpuCores,
        };

        // Apply the last solution's assignments ONLY if not skipping (i.e., user clicked "Apply")
        if (!shouldSkipApply && capturedSolutions.length > 0) {
          const lastSolution = capturedSolutions[capturedSolutions.length - 1];
          if (lastSolution?.assignments && lastSolution.assignments.length > 0) {
            // Clear only solver-generated assignments for the solve range, preserve manual ones
            setAssignmentMap((prev) => {
              const next = new Map(prev);
              for (const [key, list] of next.entries()) {
                const { rowId, dateISO: keyDate } = splitAssignmentKey(key);
                if (!rowId || !keyDate) continue;
                if (rowId.startsWith("pool-")) continue;
                if (keyDate < args.startISO || keyDate > args.endISO) continue;
                // Keep manual assignments (source !== "solver") and vacation assignments
                const filtered = list.filter(
                  (item) => item.source !== "solver" || isOnVacation(item.clinicianId, keyDate)
                );
                if (filtered.length === 0) {
                  next.delete(key);
                } else {
                  next.set(key, filtered);
                }
              }
              return next;
            });
            applySolverAssignments(lastSolution.assignments);
          }
        }
      } else if (err instanceof Error && err.name === "SolverBusyError") {
        // Backend reports another solve is already running (or recovering from
        // a zombie state that couldn't be reset automatically). Surface the
        // server's message verbatim instead of the generic "not responding".
        historyStatus = "error";
        historyNotes = [err.message];
        setAutoPlanError(err.message);
        setSolverNotice({ notes: err.message });
        window.setTimeout(() => setSolverNotice(null), 5000);
      } else {
        historyStatus = "error";
        historyNotes = ["Solver service is not responding."];
        setAutoPlanError(
          `Solver failed for the selected timeframe starting ${formatEuropeanDate(
            args.startISO,
          )}.`,
        );
        setSolverNotice({ notes: "Solver service is not responding." });
        window.setTimeout(() => setSolverNotice(null), 4000);
      }
    } finally {
      // Compute statsHistory from live solutions before clearing state
      const historyStatsHistory: StatsHistoryEntry[] = [];
      const solveRange = { startISO: args.startISO, endISO: args.endISO };
      for (const solution of liveSolutionsRef.current) {
        const solverAssignments = solution.assignments ?? [];
        const stats = calculateSolverLiveStats(
          solverAssignments,
          scheduleRows,
          clinicians,
          solveRange,
          holidayDates,
          capturedExistingAssignments,
        );
        historyStatsHistory.push({
          time_ms: solution.time_ms,
          ...stats,
        });
      }

      // Add to history
      addSolverHistoryEntry({
        id: `solver-${startedAt}`,
        startISO: args.startISO,
        endISO: args.endISO,
        startedAt,
        endedAt: Date.now(),
        status: historyStatus,
        notes: historyNotes,
        debugInfo: historyDebugInfo,
        statsHistory: historyStatsHistory,
      });

      autoPlanAbortRef.current = null;
      setAutoPlanRunning(false);
      setAutoPlanProgress(null);
      setAutoPlanStartedAt(null);
      setAutoPlanElapsedMs(0);
      setAutoPlanDateRange(null);
    }
  };

  // Abort without applying - discards any solutions found
  const handleAbortWithoutApplying = () => {
    // Set flag so AbortError handler knows NOT to apply the solution
    // but it can still capture debug info for history
    skipApplyOnAbortRef.current = true;

    // Abort the fetch FIRST to prevent the response from being processed
    // This must happen before calling abortSolver, otherwise the backend might
    // return the last solution before we abort the fetch
    if (autoPlanAbortRef.current) {
      autoPlanAbortRef.current.abort();
    }

    // Then signal the backend to stop the solver (fire and forget)
    // Use force=true to trigger immediate subprocess kill
    abortSolver(true).catch(() => {
      // Ignore errors - the abort request is best-effort
    });

    // Reset state immediately since we're discarding
    autoPlanAbortRef.current = null;
    setAutoPlanRunning(false);
    setAutoPlanProgress(null);
    setAutoPlanStartedAt(null);
    setAutoPlanElapsedMs(0);
    setAutoPlanDateRange(null);
    // Clear live solutions display (but ref is read by AbortError handler first)
    setLiveSolutions([]);
  };

  // Apply solution - stops solver and applies the current best solution
  const handleApplySolution = () => {
    // CRITICAL: Abort the fetch FIRST to trigger the AbortError handler
    // which applies the last SSE solution. If we call abortSolver first,
    // the backend might return before we abort, and we'd miss the catch block.
    if (autoPlanAbortRef.current) {
      autoPlanAbortRef.current.abort();
    }

    // Then signal the backend to stop (fire and forget)
    // Use force=true when we have solutions to trigger immediate subprocess kill
    const hasSolutions = liveSolutionsRef.current.length > 0;
    abortSolver(hasSolutions).catch(() => {
      // Ignore errors - the abort request is best-effort
    });
  };

  // Reset only solver-generated assignments (keep manual ones)
  const handleResetSolver = (args: { startISO: string; endISO: string }) => {
    setAutoPlanError(null);
    setAssignmentMap((prev) => {
      const next = new Map(prev);
      for (const [key, list] of next.entries()) {
        const { rowId, dateISO: keyDate } = splitAssignmentKey(key);
        if (!rowId || !keyDate) continue;
        if (rowId.startsWith("pool-")) continue;
        if (keyDate < args.startISO || keyDate > args.endISO) continue;
        // Keep manual assignments (source === "manual" or undefined/missing) and vacation assignments
        // Assignments without a source field are treated as manual (legacy data)
        const filtered = list.filter(
          (item) => item.source !== "solver" || isOnVacation(item.clinicianId, keyDate)
        );
        if (filtered.length === 0) next.delete(key);
        else next.set(key, filtered);
      }
      return next;
    });
  };

  // Reset all assignments (both manual and solver-generated, including pool assignments)
  const handleResetAll = (args: { startISO: string; endISO: string }) => {
    setAutoPlanError(null);
    setAssignmentMap((prev) => {
      const next = new Map(prev);
      for (const [key, list] of next.entries()) {
        const { rowId, dateISO: keyDate } = splitAssignmentKey(key);
        if (!rowId || !keyDate) continue;
        if (keyDate < args.startISO || keyDate > args.endISO) continue;
        const filtered = list.filter((item) => isOnVacation(item.clinicianId, keyDate));
        if (filtered.length === 0) next.delete(key);
        else next.set(key, filtered);
      }
      return next;
    });
  };

  const addVacationDay = (clinicianId: string, dateISO: string) => {
    setClinicians((prev) =>
      prev.map((clinician) => {
        if (clinician.id !== clinicianId) return clinician;
        if (
          clinician.vacations.some(
            (vacation) => vacation.startISO <= dateISO && dateISO <= vacation.endISO,
          )
        ) {
          return clinician;
        }
        const nextVacations = [
          ...clinician.vacations,
          {
            id: `vac-${clinicianId}-${Date.now().toString(36)}`,
            startISO: dateISO,
            endISO: dateISO,
          },
        ].sort((a, b) => a.startISO.localeCompare(b.startISO));
        const merged: typeof nextVacations = [];
        for (const vacation of nextVacations) {
          const last = merged[merged.length - 1];
          if (!last) {
            merged.push(vacation);
            continue;
          }
          const lastEndPlus = shiftDateISO(last.endISO, 1);
          if (vacation.startISO <= lastEndPlus) {
            merged[merged.length - 1] = {
              ...last,
              endISO: vacation.endISO > last.endISO ? vacation.endISO : last.endISO,
            };
          } else {
            merged.push(vacation);
          }
        }
        return { ...clinician, vacations: merged };
      }),
    );
  };

  const removeVacationDay = (clinicianId: string, dateISO: string) => {
    setClinicians((prev) =>
      prev.map((clinician) => {
        if (clinician.id !== clinicianId) return clinician;
        let changed = false;
        const nextVacations: typeof clinician.vacations = [];
        for (const vacation of clinician.vacations) {
          if (dateISO < vacation.startISO || dateISO > vacation.endISO) {
            nextVacations.push(vacation);
            continue;
          }
          changed = true;
          if (vacation.startISO === dateISO && vacation.endISO === dateISO) {
            continue;
          }
          if (vacation.startISO === dateISO) {
            nextVacations.push({
              ...vacation,
              startISO: shiftDateISO(dateISO, 1),
            });
            continue;
          }
          if (vacation.endISO === dateISO) {
            nextVacations.push({
              ...vacation,
              endISO: shiftDateISO(dateISO, -1),
            });
            continue;
          }
          nextVacations.push(
            {
              id: `vac-${clinicianId}-${Date.now().toString(36)}a`,
              startISO: vacation.startISO,
              endISO: shiftDateISO(dateISO, -1),
            },
            {
              id: `vac-${clinicianId}-${Date.now().toString(36)}b`,
              startISO: shiftDateISO(dateISO, 1),
              endISO: vacation.endISO,
            },
          );
        }
        if (!changed) return clinician;
        nextVacations.sort((a, b) => a.startISO.localeCompare(b.startISO));
        return { ...clinician, vacations: nextVacations };
      }),
    );
  };

  const getBaseSlotsForDate = (rowId: string, dateISO: string) => {
    const row = rowById.get(rowId);
    if (row?.kind === "class") {
      const dayType = getDayType(dateISO, holidayDates);
      if (row.dayType && row.dayType !== dayType) return 0;
      if (typeof row.requiredSlots === "number") return row.requiredSlots;
    }
    const minSlots = minSlotsByRowId[rowId] ?? { weekday: 0, weekend: 0 };
    return isWeekendOrHoliday(dateISO) ? minSlots.weekend : minSlots.weekday;
  };

  const adjustSlotOverride = (rowId: string, dateISO: string, delta: number) => {
    const baseSlots = getBaseSlotsForDate(rowId, dateISO);
    setSlotOverridesByKey((prev) => {
      const key = `${rowId}__${dateISO}`;
      const current = prev[key] ?? 0;
      const nextValue = Math.max(-baseSlots, current + delta);
      if (nextValue === current) return prev;
      const next = { ...prev };
      if (nextValue === 0) {
        delete next[key];
      } else {
        next[key] = nextValue;
      }
      return next;
    });
  };

  const handleAddAssignment = (args: {
    rowId: string;
    dateISO: string;
    clinicianId: string;
  }) => {
    const { rowId, dateISO, clinicianId } = args;
    const targetRow = rowById.get(rowId);
    if (!targetRow || targetRow.kind !== "class") return;
    if (isOnVacation(clinicianId, dateISO)) {
      removeVacationDay(clinicianId, dateISO);
    }
    setAssignmentMap((prev) => {
      const key = `${rowId}__${dateISO}`;
      const existing = prev.get(key) ?? [];
      if (existing.some((item) => item.clinicianId === clinicianId)) return prev;
      const next = new Map(prev);
      const newAssignment: Assignment = {
        id: `as-${Date.now().toString(36)}-${clinicianId}`,
        rowId,
        dateISO,
        clinicianId,
        source: "manual",
      };
      next.set(key, [...existing, newAssignment]);
      // Remove clinician from Rest Day pool if they're being assigned
      const restDayPoolKey = `${REST_DAY_POOL_ID}__${dateISO}`;
      const restDayPoolList = next.get(restDayPoolKey) ?? [];
      const filteredRestDay = restDayPoolList.filter((item) => item.clinicianId !== clinicianId);
      if (filteredRestDay.length === 0) {
        next.delete(restDayPoolKey);
      } else if (filteredRestDay.length !== restDayPoolList.length) {
        next.set(restDayPoolKey, filteredRestDay);
      }
      return next;
    });
  };

  const handleRemoveAssignment = (args: {
    rowId: string;
    dateISO: string;
    assignmentId: string;
    clinicianId: string;
  }) => {
    const { rowId, dateISO, assignmentId } = args;
    const targetRow = rowById.get(rowId);
    if (!targetRow || targetRow.kind !== "class") return;
    setAssignmentMap((prev) => {
      const key = `${rowId}__${dateISO}`;
      const existing = prev.get(key) ?? [];
      const filtered = existing.filter((item) => item.id !== assignmentId);
      if (filtered.length === existing.length) return prev;
      const next = new Map(prev);
      if (filtered.length === 0) next.delete(key);
      else next.set(key, filtered);
      // Note: No longer adding clinician back to Distribution Pool (removed)
      return next;
    });
  };

  const openSlotsCount = useMemo(() => {
    const dateISOs = fullWeekDays.map(toISODate);
    let openSlots = 0;
      for (const rowId of classShiftRowIds) {
        const row = rowById.get(rowId);
        if (!row || row.kind !== "class") continue;
      for (const d of dateISOs) {
        const dayType = getDayType(d, holidayDates);
        const isActive = row.dayType ? row.dayType === dayType : true;
        if (!isActive) continue;
        const cell = assignmentMap.get(`${rowId}__${d}`) ?? [];
        const baseRequired =
          typeof row.requiredSlots === "number"
            ? row.requiredSlots
            : isWeekendOrHoliday(d)
              ? (minSlotsByRowId[rowId] ?? { weekday: 0, weekend: 0 }).weekend
              : (minSlotsByRowId[rowId] ?? { weekday: 0, weekend: 0 }).weekday;
        const override = slotOverridesByKey[`${rowId}__${d}`] ?? 0;
        const required = Math.max(0, baseRequired + override);
        if (required > cell.length) openSlots += required - cell.length;
      }
    }
    return openSlots;
  }, [
    fullWeekDays,
    assignmentMap,
    classShiftRowIds,
    minSlotsByRowId,
    slotOverridesByKey,
    holidayDates,
    rowById,
  ]);

  // Calculate non-consecutive shifts (gaps) for clinicians in the current week
  // Uses renderAssignmentMap (not raw assignmentMap) to match what's displayed in the UI
  type NonConsecutiveShift = {
    id: string;
    clinicianId: string;
    clinicianName: string;
    dateISO: string;
    dateFormatted: string;
    assignmentKeys: string[];
  };
  const nonConsecutiveShifts = useMemo((): NonConsecutiveShift[] => {
    const dateISOs = fullWeekDays.map(toISODate);
    const result: NonConsecutiveShift[] = [];

    // Helper to parse time string to minutes
    const parseTimeToMinutes = (time: string | undefined): number | null => {
      if (!time) return null;
      const match = time.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) return null;
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
      if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
      return hours * 60 + minutes;
    };

    // Group assignments by clinician and date using fullWeekRenderAssignmentMap (matches UI, covers full week)
    const assignmentsByClinicianDate = new Map<string, { rowId: string; clinicianId: string }[]>();
    for (const d of dateISOs) {
      for (const rowId of classShiftRowIds) {
        const cell = fullWeekRenderAssignmentMap.get(`${rowId}__${d}`) ?? [];
        for (const assignment of cell) {
          const key = `${assignment.clinicianId}|${d}`;
          if (!assignmentsByClinicianDate.has(key)) {
            assignmentsByClinicianDate.set(key, []);
          }
          assignmentsByClinicianDate.get(key)!.push({ rowId, clinicianId: assignment.clinicianId });
        }
      }
    }

    // Check each (clinician, date) for non-consecutive shifts
    for (const [key, assignments] of assignmentsByClinicianDate) {
      if (assignments.length <= 1) continue;

      const [clinicianId, dateISO] = key.split("|");
      const clinician = clinicians.find((c) => c.id === clinicianId);
      if (!clinician) continue;

      // Get time intervals for each assignment
      const intervals: { start: number; end: number; rowId: string }[] = [];
      for (const { rowId } of assignments) {
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
          intervals.push({ start, end: adjustedEnd, rowId });
        }
      }

      if (intervals.length <= 1) continue;

      // Sort by start time
      intervals.sort((a, b) => a.start - b.start);

      // Check for gaps between consecutive intervals
      let hasGap = false;
      for (let i = 1; i < intervals.length; i++) {
        const prev = intervals[i - 1];
        const curr = intervals[i];
        if (curr.start > prev.end) {
          hasGap = true;
          break;
        }
      }

      if (hasGap) {
        const date = new Date(dateISO);
        const dayName = date.toLocaleDateString("en-US", { weekday: "short" });
        const dayNum = date.getDate();
        const monthNum = date.getMonth() + 1;
        result.push({
          id: key,
          clinicianId,
          clinicianName: clinician.name,
          dateISO,
          dateFormatted: `${dayName} ${dayNum}.${monthNum}.`,
          assignmentKeys: intervals.map((i) => `${i.rowId}__${dateISO}__${clinicianId}`),
        });
      }
    }

    // Sort by date then clinician name
    result.sort((a, b) => {
      const dateCompare = a.dateISO.localeCompare(b.dateISO);
      if (dateCompare !== 0) return dateCompare;
      return a.clinicianName.localeCompare(b.clinicianName);
    });

    return result;
  }, [fullWeekDays, fullWeekRenderAssignmentMap, classShiftRowIds, clinicians, rowById]);

  const ruleAssignmentContext = useMemo(() => {
    const dateISOs = fullWeekDays.map(toISODate);
    const dateSet = new Set(dateISOs);
    const rowKindById = new Map(scheduleRows.map((row) => [row.id, row.kind]));
    const assignmentsByClinicianDate = new Map<string, Map<string, Set<string>>>();
    for (const [key, list] of assignmentMap.entries()) {
      const { rowId, dateISO } = splitAssignmentKey(key);
      if (!rowId || !dateISO || !dateSet.has(dateISO)) continue;
      if (rowKindById.get(rowId) !== "class") continue;
      for (const assignment of list) {
        if (isOnVacation(assignment.clinicianId, dateISO)) continue;
        let clinicianDates = assignmentsByClinicianDate.get(assignment.clinicianId);
        if (!clinicianDates) {
          clinicianDates = new Map();
          assignmentsByClinicianDate.set(assignment.clinicianId, clinicianDates);
        }
        let rowSet = clinicianDates.get(dateISO);
        if (!rowSet) {
          rowSet = new Set();
          clinicianDates.set(dateISO, rowSet);
        }
        rowSet.add(rowId);
      }
    }
    return { dateISOs, dateSet, rowKindById, assignmentsByClinicianDate };
  }, [fullWeekDays, scheduleRows, assignmentMap, clinicians]);

  const ruleViolations = useMemo(() => {
    const { dateISOs, dateSet, assignmentsByClinicianDate } = ruleAssignmentContext;
    const classLabelById = new Map(classRows.map((row) => [row.id, row.name]));
    const violations: Array<{
      id: string;
      clinicianId: string;
      clinicianName: string;
      summary: string;
      assignmentKeys: string[];
    }> = [];
    const buildAssignmentKeys = (
      clinicianId: string,
      dateISO: string,
      filterRows?: Set<string>,
    ) => {
      const rowSet = assignmentsByClinicianDate.get(clinicianId)?.get(dateISO);
      if (!rowSet) return [];
      const keys: string[] = [];
      for (const rowId of rowSet) {
        if (filterRows && !filterRows.has(rowId)) continue;
        keys.push(`${rowId}__${dateISO}__${clinicianId}`);
      }
      return keys;
    };

    const restBefore = Math.max(0, solverSettings.onCallRestDaysBefore ?? 0);
    const restAfter = Math.max(0, solverSettings.onCallRestDaysAfter ?? 0);
    const onCallClassId = solverSettings.onCallRestClassId;
    const onCallShiftRowIds = new Set(
      scheduleRows
        .filter(
          (row) =>
            row.kind === "class" && (row.sectionId ?? row.id) === onCallClassId,
        )
        .map((row) => row.id),
    );
    const onCallLabel = onCallClassId
      ? classLabelById.get(onCallClassId) ?? "On call"
      : "On call";

    if (
      solverSettings.onCallRestEnabled &&
      onCallShiftRowIds.size > 0 &&
      (restBefore > 0 || restAfter > 0)
    ) {
      for (const clinician of clinicians) {
        const clinicianDates = assignmentsByClinicianDate.get(clinician.id);
        if (!clinicianDates) continue;
        for (const dateISO of dateISOs) {
          const assigned = clinicianDates.get(dateISO);
          if (!assigned) continue;
          const hasOnCall = Array.from(assigned).some((rowId) =>
            onCallShiftRowIds.has(rowId),
          );
          if (!hasOnCall) continue;
          for (let offset = 1; offset <= restBefore; offset += 1) {
            const targetISO = shiftDateISO(dateISO, -offset);
            if (!dateSet.has(targetISO)) continue;
            const targetAssigned = clinicianDates.get(targetISO);
            if (!targetAssigned || targetAssigned.size === 0) continue;
            const assignmentKeys = [
              ...buildAssignmentKeys(clinician.id, dateISO, onCallShiftRowIds),
              ...buildAssignmentKeys(clinician.id, targetISO),
            ];
            if (assignmentKeys.length === 0) continue;
            violations.push({
              id: `rest-${clinician.id}-${dateISO}-${targetISO}-before-${offset}`,
              clinicianId: clinician.id,
              clinicianName: clinicianNameById.get(clinician.id) ?? clinician.id,
              summary: `Scheduled on ${formatEuropeanDate(targetISO)}, but needs ${offset} rest day${offset === 1 ? "" : "s"} before ${onCallLabel} shift on ${formatEuropeanDate(dateISO)}.`,
              assignmentKeys,
            });
          }
          for (let offset = 1; offset <= restAfter; offset += 1) {
            const targetISO = shiftDateISO(dateISO, offset);
            if (!dateSet.has(targetISO)) continue;
            const targetAssigned = clinicianDates.get(targetISO);
            if (!targetAssigned || targetAssigned.size === 0) continue;
            const assignmentKeys = [
              ...buildAssignmentKeys(clinician.id, dateISO, onCallShiftRowIds),
              ...buildAssignmentKeys(clinician.id, targetISO),
            ];
            if (assignmentKeys.length === 0) continue;
            violations.push({
              id: `rest-${clinician.id}-${dateISO}-${targetISO}-after-${offset}`,
              clinicianId: clinician.id,
              clinicianName: clinicianNameById.get(clinician.id) ?? clinician.id,
              summary: `Scheduled on ${formatEuropeanDate(targetISO)}, but needs ${offset} rest day${offset === 1 ? "" : "s"} after ${onCallLabel} shift on ${formatEuropeanDate(dateISO)}.`,
              assignmentKeys,
            });
          }
        }
      }
    }

    // Note: The old "allowMultipleShiftsPerDay" check has been removed.
    // We now only flag actual time overlaps (handled below), not just having multiple shifts.

    if (solverSettings.enforceSameLocationPerDay) {
      for (const clinician of clinicians) {
        const clinicianDates = assignmentsByClinicianDate.get(clinician.id);
        if (!clinicianDates) continue;
        for (const [dateISO, rowSet] of clinicianDates.entries()) {
          if (rowSet.size <= 1) continue;
          const locationIds = new Set<string>();
          for (const rowId of rowSet) {
            const row = rowById.get(rowId);
            locationIds.add(row?.locationId ?? DEFAULT_LOCATION_ID);
          }
          if (locationIds.size <= 1) continue;
          const assignmentKeys = buildAssignmentKeys(clinician.id, dateISO);
          if (assignmentKeys.length === 0) continue;
          violations.push({
            id: `location-${clinician.id}-${dateISO}`,
            clinicianId: clinician.id,
            clinicianName: clinicianNameById.get(clinician.id) ?? clinician.id,
            summary: `Assigned to multiple locations on ${formatEuropeanDate(dateISO)}. Each person should only work at one location per day.`,
            assignmentKeys,
          });
        }
      }
    }

    const shiftIntervalsByRowId = new Map(
      scheduleRows
        .filter((row) => row.kind === "class")
        .map((row) => [row.id, buildShiftInterval(row)]),
    );
    for (const clinician of clinicians) {
      const clinicianDates = assignmentsByClinicianDate.get(clinician.id);
      if (!clinicianDates) continue;
      for (const [dateISO, rowSet] of clinicianDates.entries()) {
        if (rowSet.size <= 1) continue;
        const rowIds = Array.from(rowSet);
        const overlapping = new Set<string>();
        for (let i = 0; i < rowIds.length; i += 1) {
          const intervalA = shiftIntervalsByRowId.get(rowIds[i]) ?? null;
          if (!intervalA) continue;
          for (let j = i + 1; j < rowIds.length; j += 1) {
            const intervalB = shiftIntervalsByRowId.get(rowIds[j]) ?? null;
            if (!intervalB) continue;
            if (intervalsOverlap(intervalA, intervalB)) {
              overlapping.add(rowIds[i]);
              overlapping.add(rowIds[j]);
            }
          }
        }
        if (overlapping.size === 0) continue;
        const assignmentKeys = Array.from(overlapping).map(
          (rowId) => `${rowId}__${dateISO}__${clinician.id}`,
        );
        violations.push({
          id: `overlap-${clinician.id}-${dateISO}`,
          clinicianId: clinician.id,
          clinicianName: clinicianNameById.get(clinician.id) ?? clinician.id,
          summary: `Assigned to overlapping shifts on ${formatEuropeanDate(dateISO)}. These shifts have conflicting time windows.`,
          assignmentKeys,
        });
      }
    }

    return violations;
  }, [
    solverSettings,
    scheduleRows,
    classRows,
    clinicians,
    clinicianNameById,
    rowById,
    ruleAssignmentContext,
  ]);

  const violatingAssignmentKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const violation of ruleViolations) {
      for (const key of violation.assignmentKeys) {
        keys.add(key);
      }
    }
    return keys;
  }, [ruleViolations]);
  const highlightedViolationKeys = useMemo(() => {
    const activeId = hoveredRuleViolationId ?? activeRuleViolationId;
    if (activeId) {
      const match = ruleViolations.find((violation) => violation.id === activeId);
      return match ? new Set(match.assignmentKeys) : undefined;
    }
    if (isRuleViolationsHovered) {
      return violatingAssignmentKeys.size ? new Set(violatingAssignmentKeys) : undefined;
    }
    return undefined;
  }, [
    activeRuleViolationId,
    hoveredRuleViolationId,
    isRuleViolationsHovered,
    ruleViolations,
    violatingAssignmentKeys,
  ]);

  // Violations to show connection lines for
  const visibleViolationsForLines = useMemo(() => {
    const activeId = hoveredRuleViolationId ?? activeRuleViolationId;
    if (activeId) {
      const match = ruleViolations.find((violation) => violation.id === activeId);
      return match ? [match] : [];
    }
    if (isRuleViolationsHovered) {
      return ruleViolations;
    }
    return [];
  }, [
    activeRuleViolationId,
    hoveredRuleViolationId,
    isRuleViolationsHovered,
    ruleViolations,
  ]);

  const showViolationLines = visibleViolationsForLines.length > 0;

  // Split shifts (non-consecutive) highlighting
  const splitShiftAssignmentKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const shift of nonConsecutiveShifts) {
      for (const key of shift.assignmentKeys) {
        keys.add(key);
      }
    }
    return keys;
  }, [nonConsecutiveShifts]);

  const highlightedSplitShiftKeys = useMemo(() => {
    // Priority: active (clicked) > hovered item > hovered badge
    if (activeSplitShiftId) {
      const match = nonConsecutiveShifts.find((shift) => shift.id === activeSplitShiftId);
      return match ? new Set(match.assignmentKeys) : undefined;
    }
    if (hoveredSplitShiftId) {
      const match = nonConsecutiveShifts.find((shift) => shift.id === hoveredSplitShiftId);
      return match ? new Set(match.assignmentKeys) : undefined;
    }
    if (isSplitShiftsHovered) {
      return splitShiftAssignmentKeys.size ? new Set(splitShiftAssignmentKeys) : undefined;
    }
    return undefined;
  }, [activeSplitShiftId, hoveredSplitShiftId, isSplitShiftsHovered, nonConsecutiveShifts, splitShiftAssignmentKeys]);

  // Split shifts to show connection lines for
  const visibleSplitShiftsForLines = useMemo(() => {
    // Priority: active (clicked) > hovered item > hovered badge
    if (activeSplitShiftId) {
      const match = nonConsecutiveShifts.find((shift) => shift.id === activeSplitShiftId);
      return match ? [match] : [];
    }
    if (hoveredSplitShiftId) {
      const match = nonConsecutiveShifts.find((shift) => shift.id === hoveredSplitShiftId);
      return match ? [match] : [];
    }
    if (isSplitShiftsHovered) {
      return nonConsecutiveShifts;
    }
    return [];
  }, [activeSplitShiftId, hoveredSplitShiftId, isSplitShiftsHovered, nonConsecutiveShifts]);

  const showSplitShiftLines = visibleSplitShiftsForLines.length > 0;

  const editingClinician = useMemo(
    () => clinicians.find((clinician) => clinician.id === editingClinicianId),
    [clinicians, editingClinicianId],
  );

  useEffect(() => {
    let alive = true;
    setHasLoaded(false);
    setLoadedUserId("");
    getState()
      .then((state) => {
        if (!alive) return;
        const { state: normalized } = normalizeAppState(state);
        if (normalized.locations?.length) setLocations(normalized.locations);
        setLocationsEnabled(normalized.locationsEnabled ?? true);
        if (normalized.rows?.length) {
          const filteredRows = normalized.rows.filter(
            (row) => row.id !== "pool-not-working",
          );
          let nextRows = filteredRows;
          const hasRestDayPool = nextRows.some((row) => row.id === REST_DAY_POOL_ID);
          if (!hasRestDayPool) {
            // Add Rest Day pool at the end if missing
            nextRows = [...nextRows, {
              id: REST_DAY_POOL_ID,
              name: "Rest Day",
              kind: "pool",
              dotColorClass: "bg-slate-200",
            }];
          }
          setRows(nextRows);
          normalized.rows = nextRows;
        }
        if (normalized.clinicians?.length) {
          setClinicians(
            normalized.clinicians.map((clinician) => ({
              ...clinician,
              preferredClassIds: [...clinician.qualifiedClassIds],
              preferredWorkingTimes: normalizePreferredWorkingTimes(
                clinician.preferredWorkingTimes,
              ),
            })),
          );
        }
        if (normalized.assignments) {
          const filteredAssignments = normalized.assignments.filter(
            (assignment) => assignment.rowId !== "pool-not-working",
          );
          setAssignmentMap(buildAssignmentMap(filteredAssignments));
          normalized.assignments = filteredAssignments;
        }
        if (normalized.minSlotsByRowId) setMinSlotsByRowId(normalized.minSlotsByRowId);
        if (normalized.slotOverridesByKey) {
          setSlotOverridesByKey(normalized.slotOverridesByKey);
        }
        if (normalized.weeklyTemplate) {
          setWeeklyTemplate(normalized.weeklyTemplate);
        }
        if (normalized.solverSettings) {
          setSolverSettings(normalized.solverSettings as SolverSettings);
        }
        if (normalized.holidays) setHolidays(normalized.holidays);
        if (normalized.holidayCountry) setHolidayCountry(normalized.holidayCountry);
        if (normalized.holidayYear) setHolidayYear(normalized.holidayYear);
        setPublishedWeekStartISOs(normalized.publishedWeekStartISOs ?? []);
      })
      .catch(() => {
        /* Backend optional during local-only dev */
      })
      .finally(() => {
        if (alive) {
          setLoadedUserId(currentUser.username);
          setHasLoaded(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [currentUser.username]);

  useEffect(() => {
    if (!hasLoaded || loadedUserId !== currentUser.username) return;

    // SAFEGUARD: Check for colBand explosion before saving
    // With 20 max per day × 8 day types × 5 locations = 800 theoretical max
    // Using 300 as a sanity check (allows 2-3 locations with reasonable usage)
    const totalColBands = weeklyTemplate?.locations?.reduce(
      (sum, loc) => sum + (loc.colBands?.length ?? 0),
      0
    ) ?? 0;
    if (totalColBands > 300) {
      console.error(
        `[WeeklySchedulePage] BLOCKING SAVE - colBand explosion detected: ${totalColBands} total colBands (max: 300)`,
        { stack: new Error().stack }
      );
      return; // Don't save corrupted state
    }

    const { state: normalized } = normalizeAppState({
      locations,
      locationsEnabled,
      rows,
      clinicians,
      assignments: toAssignments(),
      minSlotsByRowId,
      slotOverridesByKey,
      holidays,
      holidayCountry,
      holidayYear,
      publishedWeekStartISOs,
      solverSettings,
      weeklyTemplate,
    });
    const handle = window.setTimeout(() => {
      saveState(normalized).catch(() => {
        /* Backend optional during local-only dev */
      });
    }, 500);
    return () => window.clearTimeout(handle);
  }, [
    locations,
    locationsEnabled,
    rows,
    clinicians,
    assignmentMap,
    minSlotsByRowId,
    slotOverridesByKey,
    holidays,
    holidayCountry,
    holidayYear,
    publishedWeekStartISOs,
    solverSettings,
    weeklyTemplate,
    hasLoaded,
    currentUser.username,
  ]);

  useEffect(() => {
    if (templateSectionIds.size === 0) return;
    setClinicians((prev) =>
      prev.map((clinician) => {
        const nextQualified = clinician.qualifiedClassIds.filter((id) =>
          templateSectionIds.has(id),
        );
        if (nextQualified.length === clinician.qualifiedClassIds.length) {
          return clinician;
        }
        return {
          ...clinician,
          qualifiedClassIds: nextQualified,
          preferredClassIds: nextQualified,
        };
      }),
    );
  }, [templateSectionIds]);

  // Clean up orphaned assignments when template slots are deleted
  useEffect(() => {
    if (!weeklyTemplate?.locations) return;
    const validSlotIds = new Set<string>();
    for (const loc of weeklyTemplate.locations) {
      for (const slot of loc.slots) {
        validSlotIds.add(slot.id);
      }
    }
    // Pool rows are always valid assignment targets
    const poolRowIds = new Set(poolRows.map((r) => r.id));

    setAssignmentMap((prev) => {
      let hasOrphans = false;
      for (const [key] of prev) {
        const { rowId } = splitAssignmentKey(key);
        if (!poolRowIds.has(rowId) && !validSlotIds.has(rowId)) {
          hasOrphans = true;
          break;
        }
      }
      if (!hasOrphans) return prev;

      const next = new Map<string, Assignment[]>();
      for (const [key, list] of prev) {
        const { rowId } = splitAssignmentKey(key);
        if (poolRowIds.has(rowId) || validSlotIds.has(rowId)) {
          next.set(key, list);
        }
      }
      console.log(
        `[WeeklySchedulePage] Cleaned up ${prev.size - next.size} orphaned assignment(s)`,
      );
      return next;
    });
  }, [weeklyTemplate, poolRows]);

  const handleLogout = () => {
    if (hasLoaded && loadedUserId === currentUser.username) {
      const { state: normalized } = normalizeAppState({
        locations,
        locationsEnabled,
        rows,
        clinicians,
        assignments: toAssignments(),
        minSlotsByRowId,
        slotOverridesByKey,
        holidays,
        holidayCountry,
        holidayYear,
        publishedWeekStartISOs,
        solverSettings,
        weeklyTemplate,
      });
      saveState(normalized).catch(() => {
        /* Backend optional during local-only dev */
      });
    }
    onLogout();
  };

  const handleToggleQualification = (clinicianId: string, classId: string) => {
    setClinicians((prev) =>
      prev.map((clinician) => {
        if (clinician.id !== clinicianId) return clinician;
        const hasClass = clinician.qualifiedClassIds.includes(classId);
        const nextQualified = hasClass
          ? clinician.qualifiedClassIds.filter((id) => id !== classId)
          : [...clinician.qualifiedClassIds, classId];
        return {
          ...clinician,
          qualifiedClassIds: nextQualified,
          preferredClassIds: [...nextQualified],
        };
      }),
    );
  };

  const handleReorderQualification = (
    clinicianId: string,
    fromClassId: string,
    toClassId: string,
  ) => {
    setClinicians((prev) =>
      prev.map((clinician) => {
        if (clinician.id !== clinicianId) return clinician;
        const fromIndex = clinician.qualifiedClassIds.indexOf(fromClassId);
        const toIndex = clinician.qualifiedClassIds.indexOf(toClassId);
        if (fromIndex === -1 || toIndex === -1) return clinician;
        const nextQualified = [...clinician.qualifiedClassIds];
        const [moved] = nextQualified.splice(fromIndex, 1);
        nextQualified.splice(toIndex, 0, moved);
        return {
          ...clinician,
          qualifiedClassIds: nextQualified,
          preferredClassIds: [...nextQualified],
        };
      }),
    );
  };

  const handleAddVacation = (clinicianId: string) => {
    setClinicians((prev) =>
      prev.map((clinician) => {
        if (clinician.id !== clinicianId) return clinician;
        const id = `vac-${Date.now().toString(36)}`;
        const start = addDays(new Date(), 7);
        const end = addDays(start, 1);
        return {
          ...clinician,
          vacations: [
            ...clinician.vacations,
            { id, startISO: toISODate(start), endISO: toISODate(end) },
          ],
        };
      }),
    );
  };

  const handleUpdateVacation = (
    clinicianId: string,
    vacationId: string,
    updates: { startISO?: string; endISO?: string },
  ) => {
    setClinicians((prev) =>
      prev.map((clinician) => {
        if (clinician.id !== clinicianId) return clinician;
        return {
          ...clinician,
          vacations: clinician.vacations.map((vacation) =>
            vacation.id === vacationId ? { ...vacation, ...updates } : vacation,
          ),
        };
      }),
    );
  };

  const handleRemoveVacation = (clinicianId: string, vacationId: string) => {
    setClinicians((prev) =>
      prev.map((clinician) => {
        if (clinician.id !== clinicianId) return clinician;
        return {
          ...clinician,
          vacations: clinician.vacations.filter((vacation) => vacation.id !== vacationId),
        };
      }),
    );
  };

  const handleChangeClassLocation = (rowId: string, locationId: string) => {
    setRows((prev) =>
      prev.map((row) => (row.id === rowId ? { ...row, locationId } : row)),
    );
  };

  const handleToggleLocationsEnabled = () => {
    setLocationsEnabled((prev) => {
      const next = !prev;
      if (!next) {
        setRows((currentRows) =>
          currentRows.map((row) =>
            row.kind === "class" && row.locationId !== DEFAULT_LOCATION_ID
              ? { ...row, locationId: DEFAULT_LOCATION_ID }
              : row,
          ),
        );
      }
      return next;
    });
  };

  const handleRenameSubShift = (
    rowId: string,
    subShiftId: string,
    nextName: string,
  ) => {
    setRows((prev) =>
      prev.map((row) => {
        if (row.id !== rowId || row.kind !== "class") return row;
        return {
          ...row,
          subShifts: (row.subShifts ?? []).map((shift) =>
            shift.id === subShiftId ? { ...shift, name: nextName } : shift,
          ),
        };
      }),
    );
  };

  const handleUpdateSubShiftStartTime = (
    rowId: string,
    subShiftId: string,
    nextStartTime: string,
  ) => {
    setRows((prev) =>
      prev.map((row) => {
        if (row.id !== rowId || row.kind !== "class") return row;
        return {
          ...row,
          subShifts: (row.subShifts ?? []).map((shift) =>
            shift.id === subShiftId ? { ...shift, startTime: nextStartTime } : shift,
          ),
        };
      }),
    );
  };

  const handleUpdateSubShiftEndTime = (
    rowId: string,
    subShiftId: string,
    nextEndTime: string,
  ) => {
    setRows((prev) =>
      prev.map((row) => {
        if (row.id !== rowId || row.kind !== "class") return row;
        return {
          ...row,
          subShifts: (row.subShifts ?? []).map((shift) =>
            shift.id === subShiftId ? { ...shift, endTime: nextEndTime } : shift,
          ),
        };
      }),
    );
  };

  const handleUpdateSubShiftEndDayOffset = (
    rowId: string,
    subShiftId: string,
    nextOffset: number,
  ) => {
    const safeOffset = Math.min(3, Math.max(0, Math.floor(nextOffset)));
    setRows((prev) =>
      prev.map((row) => {
        if (row.id !== rowId || row.kind !== "class") return row;
        return {
          ...row,
          subShifts: (row.subShifts ?? []).map((shift) =>
            shift.id === subShiftId ? { ...shift, endDayOffset: safeOffset } : shift,
          ),
        };
      }),
    );
  };

  const handleSetSubShiftCount = (rowId: string, nextCount: number) => {
    const row = classRows.find((item) => item.id === rowId);
    if (!row) return;
    const currentShifts = normalizeSubShifts(row.subShifts);
    const usedShiftIds = new Set(currentShifts.map((shift) => shift.id));
    const clampedCount = Math.min(3, Math.max(1, Math.floor(nextCount)));
    if (currentShifts.length === clampedCount) return;

    const parseTime = (value: string | undefined) => {
      if (!value) return null;
      const match = value.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) return null;
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
      if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
      return hours * 60 + minutes;
    };
    const formatTime = (totalMinutes: number) => {
      const clamped = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
      const hours = Math.floor(clamped / 60);
      const minutes = clamped % 60;
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    };
    const getDefaultStart = (order: number) => 8 * 60 + (order - 1) * 8 * 60;

    const nextShifts = Array.from({ length: clampedCount }, (_, index) => {
      const order = (index + 1) as 1 | 2 | 3;
      const existing = currentShifts.find((shift) => shift.order === order);
      if (existing) return existing;
      const id = getAvailableSubShiftId(usedShiftIds, order);
      usedShiftIds.add(id);
      const prev = currentShifts.find((shift) => shift.order === order - 1);
      const startMinutes =
        (prev && parseTime(prev.endTime)) ??
        parseTime(prev?.startTime) ??
        getDefaultStart(order);
      const endMinutes = startMinutes + 8 * 60;
      return {
        id,
        name: `Shift ${order}`,
        order,
        startTime: formatTime(startMinutes),
        endTime: formatTime(endMinutes),
        endDayOffset: 0,
      };
    });

    const removedShiftIds = currentShifts
      .filter((shift) => shift.order > clampedCount)
      .map((shift) => shift.id);
    const fallbackShiftId = nextShifts[nextShifts.length - 1]?.id ?? "s1";
    const fallbackShiftRowId = buildShiftRowId(rowId, fallbackShiftId);
    const removedShiftRowIds = removedShiftIds.map((id) => buildShiftRowId(rowId, id));

    setRows((prev) =>
      prev.map((item) =>
        item.id === rowId && item.kind === "class"
          ? { ...item, subShifts: nextShifts }
          : item,
      ),
    );

    if (removedShiftRowIds.length > 0) {
      setAssignmentMap((prev) => {
        const next = new Map<string, Assignment[]>();
        for (const [key, list] of prev.entries()) {
          const { rowId: keyRowId, dateISO: keyDate } = splitAssignmentKey(key);
          if (!keyRowId || !keyDate) continue;
          if (!removedShiftRowIds.includes(keyRowId)) {
            next.set(key, list);
            continue;
          }
          const moved = list.map((assignment) => ({
            ...assignment,
            rowId: fallbackShiftRowId,
          }));
          const fallbackKey = `${fallbackShiftRowId}__${keyDate}`;
          const existing = next.get(fallbackKey) ?? [];
          next.set(fallbackKey, [...existing, ...moved]);
        }
        return next;
      });
    }

    setMinSlotsByRowId((prev) => {
      const next = { ...prev };
      for (const removed of removedShiftRowIds) {
        delete next[removed];
      }
      for (const shift of nextShifts) {
        const shiftRowId = buildShiftRowId(rowId, shift.id);
        if (!next[shiftRowId]) {
          next[shiftRowId] = { weekday: 0, weekend: 0 };
        }
      }
      return next;
    });

    setSlotOverridesByKey((prev) => {
      const next: Record<string, number> = { ...prev };
      for (const key of Object.keys(prev)) {
        const { rowId: keyRowId, dateISO: keyDate } = splitAssignmentKey(key);
        if (!keyRowId || !keyDate) continue;
        if (!removedShiftRowIds.includes(keyRowId)) continue;
        const fallbackKey = `${fallbackShiftRowId}__${keyDate}`;
        next[fallbackKey] = (next[fallbackKey] ?? 0) + (next[key] ?? 0);
        delete next[key];
      }
      return next;
    });
  };

  const handleRemoveSubShift = (rowId: string, subShiftId: string) => {
    const row = classRows.find((item) => item.id === rowId);
    if (!row) return;
    const currentShifts = normalizeSubShifts(row.subShifts);
    if (currentShifts.length <= 1) return;
    const remaining = currentShifts.filter((shift) => shift.id !== subShiftId);
    if (remaining.length === currentShifts.length || remaining.length === 0) return;

    const nextShifts = remaining
      .sort((a, b) => a.order - b.order)
      .map((shift, index) => ({
        ...shift,
        order: (index + 1) as 1 | 2 | 3,
      }));

    const removedShiftRowId = buildShiftRowId(rowId, subShiftId);
    const fallbackShiftId = nextShifts[nextShifts.length - 1]?.id ?? "s1";
    const fallbackShiftRowId = buildShiftRowId(rowId, fallbackShiftId);

    setRows((prev) =>
      prev.map((item) =>
        item.id === rowId && item.kind === "class"
          ? { ...item, subShifts: nextShifts }
          : item,
      ),
    );

    setAssignmentMap((prev) => {
      const next = new Map<string, Assignment[]>();
      for (const [key, list] of prev.entries()) {
        const { rowId: keyRowId, dateISO: keyDate } = splitAssignmentKey(key);
        if (!keyRowId || !keyDate) continue;
        if (keyRowId !== removedShiftRowId) {
          next.set(key, list);
          continue;
        }
        const moved = list.map((assignment) => ({
          ...assignment,
          rowId: fallbackShiftRowId,
        }));
        const fallbackKey = `${fallbackShiftRowId}__${keyDate}`;
        const existing = next.get(fallbackKey) ?? [];
        next.set(fallbackKey, [...existing, ...moved]);
      }
      return next;
    });

    setMinSlotsByRowId((prev) => {
      const next = { ...prev };
      delete next[removedShiftRowId];
      for (const shift of nextShifts) {
        const shiftRowId = buildShiftRowId(rowId, shift.id);
        if (!next[shiftRowId]) {
          next[shiftRowId] = { weekday: 0, weekend: 0 };
        }
      }
      return next;
    });

    setSlotOverridesByKey((prev) => {
      const next: Record<string, number> = { ...prev };
      for (const key of Object.keys(prev)) {
        const { rowId: keyRowId, dateISO: keyDate } = splitAssignmentKey(key);
        if (!keyRowId || !keyDate) continue;
        if (keyRowId !== removedShiftRowId) continue;
        const fallbackKey = `${fallbackShiftRowId}__${keyDate}`;
        next[fallbackKey] = (next[fallbackKey] ?? 0) + (next[key] ?? 0);
        delete next[key];
      }
      return next;
    });
  };

  const handleAddLocation = (name: string) => {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const id = `loc-${slug || "site"}-${Date.now().toString(36)}`;
    setLocations((prev) => [{ id, name }, ...prev]);
  };

  const handleRenameLocation = (locationId: string, nextName: string) => {
    setLocations((prev) =>
      prev.map((location) =>
        location.id === locationId ? { ...location, name: nextName } : location,
      ),
    );
  };

  const handleRemoveLocation = (locationId: string) => {
    setLocations((prev) => {
      if (prev.length <= 1) return prev;
      if (locationId !== DEFAULT_LOCATION_ID) {
        return prev.filter((location) => location.id !== locationId);
      }
      const fallback = prev.find((location) => location.id !== DEFAULT_LOCATION_ID);
      if (!fallback) return prev;
      return prev
        .filter((location) => location.id !== locationId)
        .map((location) =>
          location.id === fallback.id ? { ...location, id: DEFAULT_LOCATION_ID } : location,
        );
    });
    setWeeklyTemplate((prev) => {
      if (!prev) return prev;
      if (locationId !== DEFAULT_LOCATION_ID) {
        return {
          ...prev,
          locations: prev.locations.filter((loc) => loc.locationId !== locationId),
        };
      }
      const fallback = prev.locations.find(
        (loc) => loc.locationId !== DEFAULT_LOCATION_ID,
      );
      if (!fallback) return prev;
      const nextLocations = prev.locations
        .filter((loc) => loc.locationId !== locationId)
        .map((loc) =>
          loc.locationId === fallback.locationId
            ? {
                ...loc,
                locationId: DEFAULT_LOCATION_ID,
                slots: loc.slots.map((slot) => ({
                  ...slot,
                  locationId: DEFAULT_LOCATION_ID,
                })),
              }
            : loc,
        );
      return { ...prev, locations: nextLocations };
    });
    setRows((prev) =>
      prev.map((row) => {
        if (row.kind !== "class") return row;
        if (locationId === DEFAULT_LOCATION_ID) {
          const fallback = prev.find((loc) => loc.id !== DEFAULT_LOCATION_ID);
          if (!fallback) return row;
          return row.locationId === fallback.id
            ? { ...row, locationId: DEFAULT_LOCATION_ID }
            : row;
        }
        return row.locationId === locationId
          ? { ...row, locationId: DEFAULT_LOCATION_ID }
          : row;
      }),
    );
  };

  const handleReorderLocations = (nextOrder: string[]) => {
    setLocations((prev) => {
      const byId = new Map(prev.map((location) => [location.id, location]));
      const ordered = nextOrder
        .map((id) => byId.get(id))
        .filter((location) => location != null);
      const remaining = prev.filter((location) => !nextOrder.includes(location.id));
      return [...ordered, ...remaining];
    });
    setWeeklyTemplate((prev) => {
      if (!prev) return prev;
      const order = new Map(nextOrder.map((id, index) => [id, index]));
      const nextLocations = [...prev.locations].sort(
        (a, b) => (order.get(a.locationId) ?? 0) - (order.get(b.locationId) ?? 0),
      );
      return { ...prev, locations: nextLocations };
    });
  };

  const handleChangeSolverSettings = (settings: SolverSettings) => {
    setSolverSettings(settings);
  };

  const handleAddHoliday = (holiday: Holiday) => {
    const trimmedName = holiday.name.trim();
    if (!holiday.dateISO || !trimmedName) return;
    setHolidays((prev) => {
      const exists = prev.some(
        (item) => item.dateISO === holiday.dateISO && item.name === trimmedName,
      );
      if (exists) return prev;
      return [...prev, { dateISO: holiday.dateISO, name: trimmedName }];
    });
  };
  const handleRemoveHoliday = (holiday: Holiday) => {
    setHolidays((prev) =>
      prev.filter(
        (item) => !(item.dateISO === holiday.dateISO && item.name === holiday.name),
      ),
    );
  };
  const handleFetchHolidays = async (countryCode: string, year: number) => {
    const normalizedCountry = countryCode.trim().toUpperCase();
    const response = await fetch(
      `https://date.nager.at/api/v3/PublicHolidays/${year}/${normalizedCountry}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch holidays (${response.status}).`);
    }
    const data = (await response.json()) as Array<{
      date: string;
      localName?: string;
      name?: string;
    }>;
    const fetched = data.map((item) => ({
      dateISO: item.date,
      name: item.localName ?? item.name ?? "Holiday",
    }));
    const unique = new Map<string, Holiday>();
    for (const item of fetched) {
      unique.set(`${item.dateISO}__${item.name}`, item);
    }
    setHolidays((prev) => {
      const yearPrefix = `${year}-`;
      const keep = prev.filter((holiday) => !holiday.dateISO.startsWith(yearPrefix));
      return [...keep, ...Array.from(unique.values())];
    });
    setHolidayCountry(normalizedCountry);
    setHolidayYear(year);
  };
  const openSlotsBadge = (
    <span
      onMouseEnter={() => setIsOpenSlotsHovered(true)}
      onMouseLeave={() => setIsOpenSlotsHovered(false)}
      className={cx(
        "inline-flex items-center self-start rounded-full px-2.5 py-1 text-[11px] font-normal ring-1 ring-inset sm:self-auto sm:px-3",
        "bg-yellow-50 text-yellow-700 ring-yellow-200 dark:bg-yellow-900/40 dark:text-yellow-200 dark:ring-yellow-500/40",
      )}
    >
      {openSlotsCount} Open Slots
    </span>
  );
  const ruleViolationsCount = ruleViolations.length;
  // Get popover position from button ref
  const getPopoverPosition = useCallback(() => {
    if (!ruleViolationsRef.current) return { top: 0, right: 0 };
    const rect = ruleViolationsRef.current.getBoundingClientRect();
    return {
      top: rect.bottom + 8,
      right: window.innerWidth - rect.right,
    };
  }, []);
  const [popoverPosition, setPopoverPosition] = useState({ top: 0, right: 0 });
  useEffect(() => {
    if (ruleViolationsOpen) {
      setPopoverPosition(getPopoverPosition());
    }
  }, [ruleViolationsOpen, getPopoverPosition]);
  const ruleViolationsBadge =
    ruleViolationsCount > 0 ? (
      <>
        <div ref={ruleViolationsRef} className="relative">
          <button
            type="button"
            onClick={() => setRuleViolationsOpen((open) => !open)}
            onMouseEnter={() => setIsRuleViolationsHovered(true)}
            onMouseLeave={() => setIsRuleViolationsHovered(false)}
            className={cx(
              "inline-flex items-center self-start rounded-full px-2.5 py-1 text-[11px] font-normal ring-1 ring-inset sm:self-auto sm:px-3",
              "bg-red-50 text-red-700 ring-red-200 hover:bg-red-100 dark:bg-red-900/40 dark:text-red-200 dark:ring-red-500/40",
            )}
            aria-expanded={ruleViolationsOpen}
          >
            {ruleViolationsCount} Rule Violations
          </button>
        </div>
        {ruleViolationsOpen
          ? createPortal(
              <div
                className="fixed z-[1100] w-80 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-700 shadow-lg dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                style={{ top: popoverPosition.top, right: popoverPosition.right }}
              >
                <div className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
                  Rule violations in view
                </div>
                <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                  {ruleViolations.map((violation) => (
                    <button
                      key={violation.id}
                      type="button"
                      onClick={() => {
                        setActiveRuleViolationId((current) =>
                          current === violation.id ? null : violation.id,
                        );
                        // Figure out which week the violation lives in. If
                        // it's outside the currently displayed week range,
                        // swing the calendar to the target date first, then
                        // wait a bit longer before scrolling so the newly
                        // rendered pill is actually in the DOM.
                        const targetDateISO = violation.assignmentKeys
                          .map(extractDateFromAssignmentKey)
                          .find((d): d is string => d !== null);
                        const weekEndISO = toISODate(weekEndInclusive);
                        const outOfView =
                          targetDateISO !== undefined &&
                          (targetDateISO < currentWeekStartISO ||
                            targetDateISO > weekEndISO);
                        if (outOfView && targetDateISO) {
                          const [y, m, d] = targetDateISO.split("-").map(Number);
                          setAnchorDate(new Date(y, m - 1, d));
                        }
                        // scrollToAssignmentKeys now polls via rAF until the
                        // pill appears in the DOM (up to 1s), so callers no
                        // longer need to guess how long the re-render will
                        // take.
                        scrollToAssignmentKeys(violation.assignmentKeys);
                      }}
                      onMouseEnter={() => setHoveredRuleViolationId(violation.id)}
                      onMouseLeave={() => setHoveredRuleViolationId(null)}
                      className={cx(
                        "w-full rounded-lg border px-2 py-1 text-left transition-colors",
                        activeRuleViolationId === violation.id
                          ? "border-rose-200 bg-rose-50 dark:border-rose-500/40 dark:bg-rose-900/30"
                          : "border-slate-100 bg-white hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-950 dark:hover:bg-slate-900/70",
                      )}
                      aria-pressed={activeRuleViolationId === violation.id}
                    >
                      <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                        {violation.clinicianName}
                      </div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400">
                        {violation.summary}
                      </div>
                    </button>
                  ))}
                </div>
              </div>,
              document.body,
            )
          : null}
      </>
    ) : null;
  // Get popover position for non-consecutive shifts from button ref
  const getNonConsecutivePopoverPosition = useCallback(() => {
    if (!nonConsecutiveShiftsRef.current) return { top: 0, right: 0 };
    const rect = nonConsecutiveShiftsRef.current.getBoundingClientRect();
    return {
      top: rect.bottom + 8,
      right: window.innerWidth - rect.right,
    };
  }, []);
  const [nonConsecutivePopoverPosition, setNonConsecutivePopoverPosition] = useState({ top: 0, right: 0 });
  useEffect(() => {
    if (nonConsecutiveShiftsOpen) {
      setNonConsecutivePopoverPosition(getNonConsecutivePopoverPosition());
    }
  }, [nonConsecutiveShiftsOpen, getNonConsecutivePopoverPosition]);
  const nonConsecutiveShiftsCount = nonConsecutiveShifts.length;
  const nonConsecutiveShiftsBadge =
    nonConsecutiveShiftsCount > 0 ? (
      <>
        <div ref={nonConsecutiveShiftsRef} className="relative">
          <button
            type="button"
            onClick={() => setNonConsecutiveShiftsOpen((open) => !open)}
            onMouseEnter={() => setIsSplitShiftsHovered(true)}
            onMouseLeave={() => setIsSplitShiftsHovered(false)}
            className={cx(
              "inline-flex items-center self-start rounded-full px-2.5 py-1 text-[11px] font-normal ring-1 ring-inset sm:self-auto sm:px-3",
              "bg-orange-50 text-orange-700 ring-orange-200 hover:bg-orange-100 dark:bg-orange-900/40 dark:text-orange-200 dark:ring-orange-500/40",
            )}
            aria-expanded={nonConsecutiveShiftsOpen}
          >
            {nonConsecutiveShiftsCount} Split Shift{nonConsecutiveShiftsCount !== 1 ? "s" : ""}
          </button>
        </div>
        {nonConsecutiveShiftsOpen
          ? createPortal(
              <div
                className="fixed z-[1100] w-80 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-700 shadow-lg dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                style={{ top: nonConsecutivePopoverPosition.top, right: nonConsecutivePopoverPosition.right }}
              >
                <div className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
                  Split shifts (gaps between assignments)
                </div>
                <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                  {nonConsecutiveShifts.map((shift) => (
                    <button
                      key={shift.id}
                      type="button"
                      onClick={() => {
                        setActiveSplitShiftId((prev) => (prev === shift.id ? null : shift.id));
                        // Same out-of-view jump as rule violations above.
                        const targetDateISO = shift.assignmentKeys
                          .map(extractDateFromAssignmentKey)
                          .find((d): d is string => d !== null);
                        const weekEndISO = toISODate(weekEndInclusive);
                        const outOfView =
                          targetDateISO !== undefined &&
                          (targetDateISO < currentWeekStartISO ||
                            targetDateISO > weekEndISO);
                        if (outOfView && targetDateISO) {
                          const [y, m, d] = targetDateISO.split("-").map(Number);
                          setAnchorDate(new Date(y, m - 1, d));
                        }
                        scrollToAssignmentKeys(shift.assignmentKeys);
                      }}
                      onMouseEnter={() => setHoveredSplitShiftId(shift.id)}
                      onMouseLeave={() => setHoveredSplitShiftId(null)}
                      className={cx(
                        "w-full rounded-lg border px-2 py-1 text-left transition-colors",
                        activeSplitShiftId === shift.id
                          ? "border-rose-300 bg-rose-50 dark:border-rose-500/50 dark:bg-rose-900/30"
                          : "border-slate-100 bg-white hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-950 dark:hover:bg-slate-900/70",
                      )}
                    >
                      <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                        {shift.clinicianName}
                      </div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400">
                        {shift.dateFormatted} - Gap between shifts
                      </div>
                    </button>
                  ))}
                </div>
              </div>,
              document.body,
            )
          : null}
      </>
    ) : null;
  const publishToggle = (
    <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
      <span>Publish</span>
      <button
        type="button"
        role="switch"
        aria-checked={isWeekPublished}
        onClick={() => handleWeekPublishToggle(!isWeekPublished)}
        className={cx(
          "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
          isWeekPublished
            ? "bg-emerald-500"
            : "bg-slate-300 dark:bg-slate-700",
        )}
      >
        <span
          className={cx(
            "inline-block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform",
            isWeekPublished && "translate-x-[18px]",
          )}
        />
      </button>
    </div>
  );
  const handleWeekPublishToggle = (nextPublished: boolean) => {
    setPublishedWeekStartISOs((prev) => {
      const next = new Set(prev);
      if (nextPublished) {
        next.add(currentWeekStartISO);
      } else {
        next.delete(currentWeekStartISO);
      }
      return Array.from(next);
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <TopBar
        viewMode={viewMode}
        onSetViewMode={setViewMode}
        username={currentUser.username}
        onLogout={handleLogout}
        theme={theme}
        onToggleTheme={onToggleTheme}
      />

      {slotCollisions.length > 0 && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-3 dark:border-red-900 dark:bg-red-950">
          <div className="mx-auto max-w-7xl">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0">
                <svg className="h-5 w-5 text-red-600 dark:text-red-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-red-800 dark:text-red-200">
                  Template Configuration Error: Hidden Sections Detected
                </h3>
                <div className="mt-1 text-xs text-red-700 dark:text-red-300">
                  <p className="mb-2">
                    Multiple sections are assigned to the same row and time slot. Only one section will be visible in the calendar - others are hidden but still exist in the database.
                  </p>
                  <details className="group">
                    <summary className="cursor-pointer font-medium hover:underline">
                      Show {slotCollisions.length} collision{slotCollisions.length > 1 ? "s" : ""} ({slotCollisions.reduce((sum, c) => sum + c.sections.length, 0)} sections affected)
                    </summary>
                    <ul className="mt-2 space-y-1 pl-4">
                      {slotCollisions.slice(0, 10).map((collision) => {
                        const uniqueSections = [...new Set(collision.sections.map(s => s.sectionName))];
                        return (
                          <li key={collision.key} className="text-xs">
                            <span className="font-medium">{collision.dayType.toUpperCase()}</span> in row "{collision.rowBandId}": {uniqueSections.join(", ")}
                          </li>
                        );
                      })}
                      {slotCollisions.length > 10 && (
                        <li className="text-xs italic">...and {slotCollisions.length - 10} more</li>
                      )}
                    </ul>
                  </details>
                  <p className="mt-2 font-medium">
                    Fix: Open Weekly Template Builder and ensure each section has its own row.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setViewMode("settings")}
                className="flex-shrink-0 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600"
              >
                Open Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {viewMode === "calendar" ? (
        <>
          <ScheduleGrid
            leftHeaderTitle=""
            weekDays={displayDays}
            dayColumns={dayColumns}
            rows={calendarRows}
            assignmentMap={renderAssignmentMap}
            violatingAssignmentKeys={violatingAssignmentKeys}
            highlightedAssignmentKeys={highlightedViolationKeys}
            highlightedSplitShiftKeys={highlightedSplitShiftKeys}
            highlightOpenSlots={isOpenSlotsHovered}
            holidayDates={holidayDates}
            holidayNameByDate={holidayNameByDate}
            header={
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  {isMobile ? (
                    <MobileDayNavigator
                      date={anchorDate}
                      onPrevDay={() => setAnchorDate((d) => addDays(d, -1))}
                      onNextDay={() => setAnchorDate((d) => addDays(d, 1))}
                      onToday={() => setAnchorDate(new Date())}
                    />
                  ) : (
                    <WeekNavigator
                      variant="card"
                      rangeStart={weekStart}
                      rangeEndInclusive={weekEndInclusive}
                      onPrevWeek={() => setAnchorDate((d) => addWeeks(d, -1))}
                      onNextWeek={() => setAnchorDate((d) => addWeeks(d, 1))}
                      onToday={() => setAnchorDate(new Date())}
                      onGoToDate={(date) => setAnchorDate(date)}
                    />
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {openSlotsBadge}
                  {nonConsecutiveShiftsBadge}
                  {ruleViolationsBadge}
                  {publishToggle}
                </div>
              </div>
            }
            separatorBeforeRowIds={poolsSeparatorId ? [poolsSeparatorId] : []}
            locationSeparatorRowIds={locationSeparatorRowIds}
            locationColumnTimeMetaByKey={locationColumnTimeMetaByKey}
            minSlotsByRowId={minSlotsByRowId}
            getClinicianName={(id) => clinicianNameById.get(id) ?? "Unknown"}
            getHasEligibleClasses={(id) => {
              const clinician = clinicians.find((item) => item.id === id);
              return clinician ? clinician.qualifiedClassIds.length > 0 : false;
            }}
            getIsQualified={(clinicianId, rowId) => {
                const scheduleRow = rowById.get(rowId);
                const classId =
                  scheduleRow?.kind === "class"
                  ? scheduleRow.sectionId ?? scheduleRow.id
                  : rowId;
              const clinician = clinicians.find((item) => item.id === clinicianId);
              return clinician ? clinician.qualifiedClassIds.includes(classId) : false;
            }}
            clinicians={clinicians}
            getIsOnRestDay={isOnRestDay}
            enforceSameLocationPerDay={solverSettings.enforceSameLocationPerDay}
            slotOverridesByKey={slotOverridesByKey}
            enableSlotOverrides={false}
            onClinicianClick={(clinicianId) => openClinicianEditor(clinicianId)}
            onAddAssignment={handleAddAssignment}
            onRemoveAssignment={handleRemoveAssignment}
            onMoveWithinDay={({ 
              dateISO,
              fromRowId,
              toRowId,
              assignmentId,
              clinicianId,
            }) => {
              setAssignmentMap((prev) => {
                const fromKey = `${fromRowId}__${dateISO}`;
                const toKey = `${toRowId}__${dateISO}`;
                if (fromKey === toKey) return prev;
                const fromRow = rowById.get(fromRowId);
                const toRow = rowById.get(toRowId);
                if (!fromRow || !toRow) return prev;

                const next = new Map(prev);
                const removeAssignment = (key: string, targetId: string) => {
                  const list = next.get(key) ?? [];
                  const nextList = list.filter((a) => a.id !== targetId);
                  if (nextList.length === 0) next.delete(key);
                  else next.set(key, nextList);
                };
                const removeAssignmentsForDate = (
                  targetClinicianId: string,
                  targetDateISO: string,
                ) => {
                  for (const [key, list] of next.entries()) {
                    const { dateISO: keyDate } = splitAssignmentKey(key);
                    if (keyDate !== targetDateISO) continue;
                    const filtered = list.filter(
                      (assignment) => assignment.clinicianId !== targetClinicianId,
                    );
                    if (filtered.length === 0) next.delete(key);
                    else next.set(key, filtered);
                  }
                };
                const isToVacation = toRow.id === VACATION_POOL_ID;
                const isFromVacation = fromRow.id === VACATION_POOL_ID;

              if (isToVacation) {
                addVacationDay(clinicianId, dateISO);
                removeAssignmentsForDate(clinicianId, dateISO);
                return next;
              }

                if (isFromVacation) {
                  removeVacationDay(clinicianId, dateISO);
                }
                // Handle dropping to Rest Day pool
                if (toRow.kind === "pool" && toRow.id === REST_DAY_POOL_ID) {
                  if (fromRow.kind === "class" || fromRow.id === REST_DAY_POOL_ID) {
                    const fromList = next.get(fromKey) ?? [];
                    const moving = fromList.find((a) => a.id === assignmentId);
                    if (!moving) return prev;
                    removeAssignment(fromKey, assignmentId);
                    const toList = next.get(toKey) ?? [];
                    const already = toList.some((item) => item.clinicianId === clinicianId);
                    if (!already) {
                      next.set(toKey, [...toList, { ...moving, rowId: toRowId, dateISO }]);
                    }
                    return next;
                  }

                  const toList = next.get(toKey) ?? [];
                  const already = toList.some((item) => item.clinicianId === clinicianId);
                  if (!already) {
                    const newItem: Assignment = {
                      id: `pool-${toRowId}-${clinicianId}-${dateISO}`,
                      rowId: toRowId,
                      dateISO,
                      clinicianId,
                      source: "manual",
                    };
                    next.set(toKey, [...toList, newItem]);
                  }
                  return next;
                }

                // Handle dropping to other pool types (e.g., Vacation handled above)
                if (toRow.kind === "pool") {
                  if (fromRow.kind === "class" || fromRow.id === REST_DAY_POOL_ID) {
                    removeAssignment(fromKey, assignmentId);
                  }
                  return next;
                }

                if (fromRow.kind === "pool") {
                  if (fromRow.id === REST_DAY_POOL_ID) {
                    removeAssignment(fromKey, assignmentId);
                  }
                  const toList = next.get(toKey) ?? [];
                  const alreadyInTarget = toList.some(
                    (item) => item.clinicianId === clinicianId,
                  );
                  if (alreadyInTarget) return prev;
                  const newItem: Assignment = {
                    id: `as-${Date.now().toString(36)}-${clinicianId}`,
                    rowId: toRowId,
                    dateISO,
                    clinicianId,
                    source: "manual",
                  };
                  next.set(toKey, [...toList, newItem]);
                  return next;
                }

                const fromList = next.get(fromKey) ?? [];
                const moving = fromList.find((a) => a.id === assignmentId);
                if (!moving) return prev;
                const nextFrom = fromList.filter((a) => a.id !== assignmentId);
                if (nextFrom.length === 0) next.delete(fromKey);
                else next.set(fromKey, nextFrom);
                const toList = next.get(toKey) ?? [];
                const alreadyInTarget = toList.some(
                  (item) => item.clinicianId === clinicianId,
                );
                if (alreadyInTarget) return prev;
                next.set(toKey, [...toList, { ...moving, rowId: toRowId, dateISO }]);
                return next;
              });
            }}
            onCellClick={() => {}}
          />
          <div className="mx-auto w-full max-w-7xl px-4 pb-8 sm:px-6 sm:pb-10">
            <div className="flex flex-col gap-6">
              {/* First row: Automated Planning, Vacation Planner, Export */}
              <div className="flex w-full flex-col gap-6 lg:flex-row lg:items-start">
                <AutomatedPlanningPanel
                  weekStartISO={toISODate(weekStart)}
                  weekEndISO={toISODate(weekEndInclusive)}
                  isRunning={autoPlanRunning}
                  progress={autoPlanProgress}
                  startedAt={autoPlanStartedAt}
                  lastRunTotalDays={autoPlanLastRunStats?.totalDays ?? null}
                  lastRunDurationMs={autoPlanLastRunStats?.durationMs ?? null}
                  error={autoPlanError}
                  timeoutSeconds={solverTimeoutSeconds}
                  onRun={handleRunAutomatedPlanning}
                  onResetSolver={handleResetSolver}
                  onResetAll={handleResetAll}
                  onOpenInfo={() => setSolverInfoOpen(true)}
                />
                <div className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 shadow-sm dark:border-slate-800 dark:bg-slate-950 sm:max-w-xs sm:px-4">
                  <div className="flex flex-col gap-4">
                    <div className="-mt-7 inline-flex self-start rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm font-normal text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                      Vacation Planner
                    </div>
                    <div className="text-sm text-slate-600 dark:text-slate-300">
                      Review vacations across the year and jump into clinician edits.
                    </div>
                    <button
                      type="button"
                      onClick={() => setVacationOverviewOpen(true)}
                      className={cx(
                        "rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-normal text-slate-900 shadow-sm",
                        "hover:bg-slate-50 active:bg-slate-100",
                        "disabled:cursor-not-allowed disabled:opacity-70",
                        "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
                      )}
                    >
                      Open Vacation Planner
                    </button>
                  </div>
                </div>
                <div className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 shadow-sm dark:border-slate-800 dark:bg-slate-950 sm:max-w-xs sm:px-4">
                  <div className="flex flex-col gap-4">
                    <div className="-mt-7 inline-flex self-start rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm font-normal text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                      Working Hours
                    </div>
                    <div className="text-sm text-slate-600 dark:text-slate-300">
                      Track working hours per week and compare against contract hours.
                    </div>
                    <button
                      type="button"
                      onClick={() => setWorkingHoursOverviewOpen(true)}
                      className={cx(
                        "rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-normal text-slate-900 shadow-sm",
                        "hover:bg-slate-50 active:bg-slate-100",
                        "disabled:cursor-not-allowed disabled:opacity-70",
                        "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
                      )}
                    >
                      Open Working Hours
                    </button>
                  </div>
                </div>
                <div className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 shadow-sm dark:border-slate-800 dark:bg-slate-950 sm:max-w-xs sm:px-4">
                  <div className="flex flex-col gap-4">
                    <div className="-mt-7 inline-flex self-start rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm font-normal text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                      Export
                    </div>
                    <div className="text-sm text-slate-600 dark:text-slate-300">
                      Download PDFs, iCal feeds, or shareable web links for published weeks.
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setPdfError(null);
                        setPdfProgress(null);
                        openExportModal();
                      }}
                      className={cx(
                        "rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-normal text-slate-900 shadow-sm",
                        "hover:bg-slate-50 active:bg-slate-100",
                        "disabled:cursor-not-allowed disabled:opacity-70",
                        "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
                      )}
                    >
                      Open Export
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : viewMode === "settings" ? (
        <>
          <SettingsView
            classRows={eligibleClassRows}
            poolRows={poolRows}
            locations={locations}
            clinicians={clinicians}
            holidays={holidays}
            holidayCountry={holidayCountry}
            holidayYear={holidayYear}
            weeklyTemplate={weeklyTemplate}
            onRenamePool={(rowId, nextName) => {
              setRows((prev) =>
                prev.map((row) =>
                  row.id === rowId ? { ...row, name: nextName } : row,
                ),
              );
            }}
            onAddLocation={handleAddLocation}
            onRenameLocation={handleRenameLocation}
            onRemoveLocation={handleRemoveLocation}
            onReorderLocations={handleReorderLocations}
            solverSettings={solverSettings}
            onChangeSolverSettings={handleChangeSolverSettings}
            onChangeWeeklyTemplate={(nextTemplate) => setWeeklyTemplate(nextTemplate)}
            onAddClinician={(name, workingHoursPerWeek) => {
              const slug = name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/(^-|-$)/g, "");
              const id = `clin-${slug || "user"}-${Date.now().toString(36)}`;
              setClinicians((prev) => [
                ...prev,
                {
                  id,
                  name,
                  qualifiedClassIds: [],
                  preferredClassIds: [],
                  vacations: [],
                  preferredWorkingTimes: normalizePreferredWorkingTimes(),
                  workingHoursPerWeek,
                },
              ]);
            }}
            onEditClinician={(clinicianId) => {
              openClinicianEditor(clinicianId);
            }}
            onRemoveClinician={(clinicianId) => {
              setClinicians((prev) => prev.filter((clinician) => clinician.id !== clinicianId));
              setAssignmentMap((prev) => {
                const next = new Map(prev);
                for (const key of next.keys()) {
                  const assignments = next.get(key) ?? [];
                  const filtered = assignments.filter(
                    (assignment) => assignment.clinicianId !== clinicianId,
                  );
                  if (filtered.length === 0) {
                    next.delete(key);
                  } else {
                    next.set(key, filtered);
                  }
                }
                return next;
              });
            }}
            onChangeHolidayCountry={setHolidayCountry}
            onChangeHolidayYear={setHolidayYear}
            onFetchHolidays={async (countryCode, year) => {
              await handleFetchHolidays(countryCode, year);
            }}
            onAddHoliday={(holiday) => {
              setHolidays((prev) => [...prev, holiday]);
            }}
            onRemoveHoliday={(holiday) => {
              setHolidays((prev) =>
                prev.filter((item) => item.dateISO !== holiday.dateISO),
              );
            }}
            onCreateSection={(name) => {
              const trimmed = name.trim() || "New Section";
              const id = `class-${Date.now().toString(36)}`;
              setRows((prev) => {
                const nextClasses = prev.filter((row) => row.kind === "class");
                const nextPools = prev.filter((row) => row.kind === "pool");
                const classCount = nextClasses.length;
                const color = CLASS_COLORS[classCount % CLASS_COLORS.length];
                const blockColor =
                  SECTION_BLOCK_COLORS[classCount % SECTION_BLOCK_COLORS.length];
                return [
                  ...nextClasses,
                  {
                    id,
                    name: trimmed,
                    kind: "class",
                    dotColorClass: color,
                    blockColor,
                    locationId: DEFAULT_LOCATION_ID,
                    subShifts: [
                      {
                        id: "s1",
                        name: "Shift 1",
                        order: 1,
                        startTime: "08:00",
                        endTime: "16:00",
                        endDayOffset: 0,
                      },
                    ],
                  },
                  ...nextPools,
                ];
              });
              setMinSlotsByRowId((prev) => ({
                ...prev,
                [buildShiftRowId(id, "s1")]: { weekday: 1, weekend: 1 },
              }));
              return id;
            }}
            onRemoveSection={(sectionId) => {
              setRows((prev) => prev.filter((row) => row.id !== sectionId));
              setMinSlotsByRowId((prev) => {
                const next = { ...prev };
                for (const key of Object.keys(next)) {
                  if (key === sectionId || key.startsWith(`${sectionId}::`)) {
                    delete next[key];
                  }
                }
                return next;
              });
              setAssignmentMap((prev) => {
                const next = new Map(prev);
                for (const key of next.keys()) {
                  if (key.startsWith(`${sectionId}__`) || key.startsWith(`${sectionId}::`)) {
                    next.delete(key);
                  }
                }
                return next;
              });
            }}
            onUpdateSectionColor={(sectionId, color) => {
              setRows((prev) =>
                prev.map((row) =>
                  row.id === sectionId
                    ? { ...row, blockColor: color ?? undefined }
                    : row,
                ),
              );
            }}
            onExportScheduleSnapshot={handleExportScheduleSnapshot}
            onImportScheduleSnapshot={handleImportScheduleSnapshot}
          />
          <AdminUsersPanel
            isAdmin={currentUser.role === "admin"}
          />
        </>
      ) : (
        <HelpView />
      )}

      <VacationOverviewModal
        open={vacationOverviewOpen}
        onClose={() => setVacationOverviewOpen(false)}
        clinicians={clinicians}
        sections={eligibleClassRows.map((row) => ({
          id: row.id,
          name: row.name,
          color: row.blockColor ?? null,
        }))}
        assignments={toRenderedAssignments()}
        weeklyTemplate={weeklyTemplate}
        onSelectClinician={(clinicianId) => openClinicianEditor(clinicianId, "vacations")}
        onReorderClinicians={(reorderedIds) => {
          setClinicians((prev) => {
            const byId = new Map(prev.map((c) => [c.id, c]));
            return reorderedIds.map((id) => byId.get(id)).filter((c): c is Clinician => Boolean(c));
          });
        }}
      />

      <WorkingHoursOverviewModal
        open={workingHoursOverviewOpen}
        onClose={() => setWorkingHoursOverviewOpen(false)}
        clinicians={clinicians}
        assignments={toRenderedAssignments()}
        weeklyTemplate={weeklyTemplate}
      />

      <ClinicianEditModal
        open={editingClinicianId !== ""}
        onClose={closeClinicianEditor}
        clinician={editingClinician ?? null}
        classRows={eligibleClassRows}
        initialSection={editingClinicianSection ?? undefined}
        onToggleQualification={handleToggleQualification}
        onReorderQualification={handleReorderQualification}
        onAddVacation={handleAddVacation}
        onUpdateVacation={handleUpdateVacation}
        onRemoveVacation={handleRemoveVacation}
        onUpdateWorkingHours={(clinicianId, workingHoursPerWeek) => {
          setClinicians((prev) =>
            prev.map((clinician) =>
              clinician.id === clinicianId
                ? { ...clinician, workingHoursPerWeek }
                : clinician,
            ),
          );
        }}
        onUpdateWorkingHoursTolerance={(clinicianId, workingHoursToleranceHours) => {
          setClinicians((prev) =>
            prev.map((clinician) =>
              clinician.id === clinicianId
                ? { ...clinician, workingHoursToleranceHours }
                : clinician,
            ),
          );
        }}
        onUpdatePreferredWorkingTimes={(clinicianId, preferredWorkingTimes) => {
          setClinicians((prev) =>
            prev.map((clinician) =>
              clinician.id === clinicianId
                ? { ...clinician, preferredWorkingTimes }
                : clinician,
            ),
          );
        }}
        onUpdateName={(clinicianId, name) => {
          setClinicians((prev) =>
            prev.map((clinician) =>
              clinician.id === clinicianId
                ? { ...clinician, name }
                : clinician,
            ),
          );
        }}
      />

      <IcalExportModal
        open={exportOpen}
        onClose={closeExportModal}
        clinicians={clinicians.map((clinician) => ({ id: clinician.id, name: clinician.name }))}
        defaultStartISO={toISODate(weekStart)}
        defaultEndISO={toISODate(weekEndInclusive)}
        onDownloadAll={handleDownloadIcalAll}
        onDownloadClinician={handleDownloadIcalClinician}
        publishStatus={icalPublishStatus}
        publishLoading={icalPublishLoading}
        publishError={icalPublishError}
        onPublish={handlePublishSubscription}
        onRotate={handleRotateSubscription}
        onUnpublish={handleUnpublishSubscription}
        defaultPdfStartISO={currentWeekStartISO}
        onExportPdf={handleExportPdfBatch}
        pdfExporting={pdfExporting}
        pdfProgress={pdfProgress}
        pdfError={pdfError}
        webStatus={webPublishStatus}
        webLoading={webPublishLoading}
        webError={webPublishError}
        onWebPublish={handleWebPublish}
        onWebRotate={handleWebRotate}
        onWebUnpublish={handleWebUnpublish}
      />

      {solverNotice ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 dark:bg-black/40"
          onClick={() => setSolverNotice(null)}
        >
          <div
            className={cx(
              "relative max-h-[80vh] overflow-auto rounded-2xl border px-4 py-3 text-xs font-medium shadow-xl",
              solverNotice.debugInfo
                ? "max-w-xl border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
                : "max-w-lg border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-900/40 dark:text-amber-200"
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setSolverNotice(null)}
              className={cx(
                "absolute top-2 right-2 p-1 rounded-full transition-colors",
                solverNotice.debugInfo
                  ? "hover:bg-slate-100 dark:hover:bg-slate-800"
                  : "hover:bg-amber-200/50 dark:hover:bg-amber-800/50"
              )}
              aria-label="Dismiss"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            {solverNotice.notes && (
              <div
                className={cx(
                  "pr-6 whitespace-pre-wrap",
                  solverNotice.debugInfo && "mb-4 pb-4 border-b border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200"
                )}
              >
                {solverNotice.notes}
              </div>
            )}
            {solverNotice.debugInfo && (
              <SolverDebugPanel debugInfo={solverNotice.debugInfo} />
            )}
          </div>
        </div>
      ) : null}

      <ViolationLinesOverlay
        violations={visibleViolationsForLines}
        visible={showViolationLines}
      />

      <ViolationLinesOverlay
        violations={visibleSplitShiftsForLines}
        visible={showSplitShiftLines}
      />

      <SolverOverlay
        isVisible={autoPlanRunning}
        progress={autoPlanProgress}
        elapsedMs={autoPlanElapsedMs}
        totalAllowedMs={solverTimeoutSeconds * 1000}
        solveRange={autoPlanDateRange}
        displayedRange={{
          startISO: toISODate(weekStart),
          endISO: toISODate(weekEndInclusive),
        }}
        onAbort={handleAbortWithoutApplying}
        onApplySolution={handleApplySolution}
        liveSolutions={liveSolutions}
        scheduleRows={scheduleRows}
        clinicians={clinicians}
        holidays={holidayDates}
        currentPhase={solverPhase}
        existingAssignments={existingAssignmentsForSolver}
        solverSettings={solverSettings}
      />

      <SolverInfoModal
        isOpen={solverInfoOpen}
        onClose={() => setSolverInfoOpen(false)}
        history={solverHistory}
        timeoutSeconds={solverTimeoutSeconds}
        onTimeoutChange={setSolverTimeoutSeconds}
        solverSettings={solverSettings}
        onSolverSettingsChange={(partial) =>
          setSolverSettings((prev) => ({ ...prev, ...partial }))
        }
      />
    </div>
  );
}
