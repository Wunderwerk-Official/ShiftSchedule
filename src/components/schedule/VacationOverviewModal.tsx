import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buttonPrimary, buttonSecondary, getPillToggleClasses } from "../../lib/buttonStyles";
import { cx } from "../../lib/classNames";
import { BLOCK_COLOR_SWATCH_OPTIONS } from "../../lib/colorPalette";
import { toISODate } from "../../lib/date";
import { formatVacationRangeLabel } from "../../lib/vacations";
import type { Assignment, WeeklyCalendarTemplate } from "../../api/client";
import ColorPickerPopover from "./ColorPickerPopover";

type VacationRange = { id: string; startISO: string; endISO: string };

type VacationOverviewModalProps = {
  open: boolean;
  onClose: () => void;
  clinicians: Array<{
    id: string;
    name: string;
    vacations: VacationRange[];
  }>;
  sections: Array<{ id: string; name: string; color?: string | null }>;
  assignments: Assignment[];
  weeklyTemplate?: WeeklyCalendarTemplate;
  onSelectClinician: (clinicianId: string) => void;
  onCreateVacationRange?: (clinicianId: string, startISO: string, endISO: string) => void;
  onReorderClinicians?: (reorderedIds: string[]) => void;
};

const DAY_WIDTH = 20;
const DRAG_THRESHOLD_PX = 5;
const MIN_LEFT_COLUMN_WIDTH = 100;
const LEFT_COLUMN_PADDING = 24; // px-3 = 12px each side
const BAR_HEIGHT = 16;
const YEAR_RANGE = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// Module-level state to preserve across open/close cycles
// (component unmounts when closed, so refs don't work)
const VACATION_BAND_ID = "__vacation__";
let persistedActiveSectionIds: string[] = [VACATION_BAND_ID];
let persistedSectionColorsById: Record<string, string> = {};

const isLeapYear = (year: number) =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysInMonth = (year: number, monthIndex: number) => {
  const base = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][monthIndex] ?? 30;
  return monthIndex === 1 && isLeapYear(year) ? base + 1 : base;
};

const daysInYear = (year: number) => (isLeapYear(year) ? 366 : 365);

const parseISODate = (value: string) => {
  const [yearRaw, monthRaw, dayRaw] = value.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return { year, month, day };
};

const dayIndexToISOInTimeline = (dayIndex: number, startYear: number) => {
  const date = new Date(Date.UTC(startYear, 0, 1) + dayIndex * MS_PER_DAY);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const dateToDayIndexInTimeline = (
  dateISO: string,
  startYear: number,
  endYear: number,
) => {
  const parsed = parseISODate(dateISO);
  if (!parsed) return null;
  const dateMs = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  const startMs = Date.UTC(startYear, 0, 1);
  const endMs = Date.UTC(endYear, 11, 31);
  if (dateMs < startMs || dateMs > endMs) return null;
  return Math.floor((dateMs - startMs) / MS_PER_DAY);
};

const clipRangeToTimeline = (
  startISO: string,
  endISO: string,
  startYear: number,
  endYear: number,
) => {
  const start = parseISODate(startISO);
  const end = parseISODate(endISO);
  if (!start || !end) return null;
  const startMs = Date.UTC(start.year, start.month - 1, start.day);
  const endMs = Date.UTC(end.year, end.month - 1, end.day);
  if (endMs < startMs) return null;
  const timelineStartMs = Date.UTC(startYear, 0, 1);
  const timelineEndMs = Date.UTC(endYear, 11, 31);
  const clippedStart = Math.max(startMs, timelineStartMs);
  const clippedEnd = Math.min(endMs, timelineEndMs);
  if (clippedStart > clippedEnd) return null;
  const startIndex = Math.floor((clippedStart - timelineStartMs) / MS_PER_DAY);
  const endIndex = Math.floor((clippedEnd - timelineStartMs) / MS_PER_DAY);
  return { startIndex, endIndex };
};

export default function VacationOverviewModal({
  open,
  onClose,
  clinicians,
  sections,
  assignments,
  weeklyTemplate,
  onSelectClinician,
  onCreateVacationRange,
  onReorderClinicians,
}: VacationOverviewModalProps) {
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [visibleYear, setVisibleYear] = useState(currentYear);
  const [pendingScrollToToday, setPendingScrollToToday] = useState(false);
  const [scrollBehavior, setScrollBehavior] = useState<"instant" | "smooth">("instant");
  const REST_DAY_BAND_ID = "__rest_day__";
  const DEFAULT_VACATION_COLOR = "#86efac"; // emerald-300 (softer)
  const DEFAULT_REST_DAY_COLOR = "#fca5a5"; // rose-300

  // Initialize state from module-level persisted values
  const [activeSectionIds, setActiveSectionIds] = useState<string[]>(() => persistedActiveSectionIds);
  const [sectionColorsById, setSectionColorsById] = useState<Record<string, string>>(
    () => persistedSectionColorsById,
  );

  // Keep module-level variables in sync with state
  useEffect(() => {
    persistedActiveSectionIds = activeSectionIds;
  }, [activeSectionIds]);
  useEffect(() => {
    persistedSectionColorsById = sectionColorsById;
  }, [sectionColorsById]);

  const isVacationActive = activeSectionIds.includes(VACATION_BAND_ID);
  const isRestDayActive = activeSectionIds.includes(REST_DAY_BAND_ID);
  const vacationColor = sectionColorsById[VACATION_BAND_ID] ?? DEFAULT_VACATION_COLOR;
  const restDayColor = sectionColorsById[REST_DAY_BAND_ID] ?? DEFAULT_REST_DAY_COLOR;
  const [referencePanelOpen, setReferencePanelOpen] = useState(false);
  const referencePanelRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  // Mouse tracking for cursor line and day highlight
  const [hoverDayIndex, setHoverDayIndex] = useState<number | null>(null);

  // Clinician drag reorder state
  const [dragClinicianId, setDragClinicianId] = useState<string | null>(null);
  const [dragOverClinicianId, setDragOverClinicianId] = useState<string | null>(null);

  // Drag-to-create vacation state. The ref mirrors the state so the Escape
  // handler and pointer events see the current drag without re-subscribing.
  type VacationDragState = {
    clinicianId: string;
    pointerId: number;
    anchorIndex: number;
    currentIndex: number;
    startClientX: number;
    status: "pending" | "dragging";
  };
  const [vacationDrag, setVacationDrag] = useState<VacationDragState | null>(null);
  const vacationDragRef = useRef<VacationDragState | null>(null);
  // Pointer capture makes the browser fire a click on the row button after
  // every completed drag; this ref swallows exactly that one click.
  const suppressRowClickRef = useRef(false);
  const updateVacationDrag = useCallback((next: VacationDragState | null) => {
    vacationDragRef.current = next;
    setVacationDrag(next);
  }, []);

  // Scroll to today every time the modal opens
  useEffect(() => {
    if (!open) return;
    setSelectedYear(currentYear);
    setScrollBehavior("instant");
    setPendingScrollToToday(true);
  }, [open, currentYear]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (vacationDragRef.current) {
          // Cancel an active drag without closing the modal; the pointerup
          // that follows still triggers a click, so swallow it too.
          suppressRowClickRef.current = true;
          updateVacationDrag(null);
          return;
        }
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose, updateVacationDrag]);

  // Close reference panel on click outside
  useEffect(() => {
    if (!referencePanelOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (
        referencePanelRef.current &&
        !referencePanelRef.current.contains(event.target as Node)
      ) {
        setReferencePanelOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [referencePanelOpen]);

  // Calculate left column width based on longest clinician name
  const leftColumnWidth = useMemo(() => {
    if (clinicians.length === 0) return MIN_LEFT_COLUMN_WIDTH;
    // Estimate character width (~7px per char for 14px text)
    const charWidth = 7;
    const longestName = clinicians.reduce(
      (max, c) => (c.name.length > max ? c.name.length : max),
      0,
    );
    const estimatedWidth = longestName * charWidth + LEFT_COLUMN_PADDING;
    return Math.max(MIN_LEFT_COLUMN_WIDTH, estimatedWidth);
  }, [clinicians]);

  const rangeStartYear = selectedYear - Math.floor(YEAR_RANGE / 2);
  const rangeEndYear = rangeStartYear + YEAR_RANGE - 1;
  const yearSpans = useMemo(() => {
    const spans: Array<{ year: number; days: number }> = [];
    for (let year = rangeStartYear; year <= rangeEndYear; year += 1) {
      spans.push({ year, days: daysInYear(year) });
    }
    return spans;
  }, [rangeStartYear, rangeEndYear]);
  const monthSpans = useMemo(() => {
    const spans: Array<{ label: string; days: number; year: number }> = [];
    for (let year = rangeStartYear; year <= rangeEndYear; year += 1) {
      for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
        spans.push({
          label: MONTH_LABELS[monthIndex],
          days: daysInMonth(year, monthIndex),
          year,
        });
      }
    }
    return spans;
  }, [rangeStartYear, rangeEndYear]);
  const totalDays = useMemo(() => {
    let sum = 0;
    for (const span of yearSpans) sum += span.days;
    return sum;
  }, [yearSpans]);
  const totalWidth = totalDays * DAY_WIDTH;
  const resolveYearForDayIndex = useCallback(
    (dayIndex: number) => {
      let remaining = dayIndex;
      for (const span of yearSpans) {
        if (remaining < span.days) return span.year;
        remaining -= span.days;
      }
      return yearSpans[yearSpans.length - 1]?.year ?? rangeStartYear;
    },
    [yearSpans, rangeStartYear],
  );
  const todayIndex = useMemo(() => {
    if (currentYear < rangeStartYear || currentYear > rangeEndYear) return null;
    return dateToDayIndexInTimeline(
      toISODate(new Date()),
      rangeStartYear,
      rangeEndYear,
    );
  }, [currentYear, rangeStartYear, rangeEndYear]);
  const vacationSegmentsByClinician = useMemo(() => {
    const map = new Map<
      string,
      Array<{ id: string; left: number; width: number; label: string }>
    >();
    for (const clinician of clinicians) {
      const segments: Array<{ id: string; left: number; width: number; label: string }> = [];
      for (const vacation of clinician.vacations) {
        const clipped = clipRangeToTimeline(
          vacation.startISO,
          vacation.endISO,
          rangeStartYear,
          rangeEndYear,
        );
        if (!clipped) continue;
        const width = (clipped.endIndex - clipped.startIndex + 1) * DAY_WIDTH;
        segments.push({
          id: vacation.id,
          left: clipped.startIndex * DAY_WIDTH,
          width,
          // Label the vacation's REAL range, even when the bar is clipped
          // to the visible three-year timeline.
          label: formatVacationRangeLabel(vacation.startISO, vacation.endISO),
        });
      }
      map.set(clinician.id, segments);
    }
    return map;
  }, [clinicians, rangeStartYear, rangeEndYear]);

  const restDaySegmentsByClinician = useMemo(() => {
    const REST_DAY_POOL_ID = "pool-rest-day";
    const dayIndexByClinician = new Map<string, Set<number>>();
    for (const assignment of assignments) {
      if (assignment.rowId !== REST_DAY_POOL_ID) continue;
      const dayIndex = dateToDayIndexInTimeline(
        assignment.dateISO,
        rangeStartYear,
        rangeEndYear,
      );
      if (dayIndex === null) continue;
      const set = dayIndexByClinician.get(assignment.clinicianId) ?? new Set();
      set.add(dayIndex);
      dayIndexByClinician.set(assignment.clinicianId, set);
    }
    const map = new Map<string, Array<{ id: string; left: number; width: number }>>();
    for (const [clinicianId, indicesSet] of dayIndexByClinician.entries()) {
      const indices = Array.from(indicesSet).sort((a, b) => a - b);
      if (indices.length === 0) continue;
      const segments: Array<{ id: string; left: number; width: number }> = [];
      let runStart = indices[0];
      let previous = indices[0];
      for (let i = 1; i <= indices.length; i += 1) {
        const current = indices[i];
        if (current !== undefined && current === previous + 1) {
          previous = current;
          continue;
        }
        const left = runStart * DAY_WIDTH;
        const width = (previous - runStart + 1) * DAY_WIDTH;
        segments.push({
          id: `${clinicianId}-rest-${runStart}-${previous}`,
          left,
          width,
        });
        runStart = current ?? 0;
        previous = current ?? 0;
      }
      map.set(clinicianId, segments);
    }
    return map;
  }, [assignments, rangeStartYear, rangeEndYear]);

  const slotSectionById = useMemo(() => {
    const map = new Map<string, string>();
    if (!weeklyTemplate) return map;
    const blockSectionById = new Map(
      (weeklyTemplate.blocks ?? []).map((block) => [block.id, block.sectionId]),
    );
    for (const location of weeklyTemplate.locations ?? []) {
      for (const slot of location.slots ?? []) {
        const sectionId = blockSectionById.get(slot.blockId);
        if (sectionId) map.set(slot.id, sectionId);
      }
    }
    return map;
  }, [weeklyTemplate]);

  const activeSections = useMemo(
    () => sections.filter((section) => activeSectionIds.includes(section.id)),
    [sections, activeSectionIds],
  );

  const sectionSegmentsByClinician = useMemo(() => {
    if (activeSectionIds.length === 0) return new Map();
    const activeSet = new Set(activeSectionIds);
    const dayIndexByClinicianSection = new Map<
      string,
      Map<string, Set<number>>
    >();
    for (const assignment of assignments) {
      const slotSectionId =
        slotSectionById.get(assignment.rowId) ??
        assignment.rowId.split("::")[0];
      if (!activeSet.has(slotSectionId)) continue;
      const dayIndex = dateToDayIndexInTimeline(
        assignment.dateISO,
        rangeStartYear,
        rangeEndYear,
      );
      if (dayIndex === null) continue;
      const clinicianMap =
        dayIndexByClinicianSection.get(assignment.clinicianId) ?? new Map();
      const set = clinicianMap.get(slotSectionId) ?? new Set();
      set.add(dayIndex);
      clinicianMap.set(slotSectionId, set);
      dayIndexByClinicianSection.set(assignment.clinicianId, clinicianMap);
    }
    const segmentsByClinician = new Map<
      string,
      Map<string, Array<{ id: string; left: number; width: number }>>
    >();
    for (const [clinicianId, sectionMap] of dayIndexByClinicianSection.entries()) {
      const segmentsBySection = new Map<
        string,
        Array<{ id: string; left: number; width: number }>
      >();
      for (const [sectionId, indicesSet] of sectionMap.entries()) {
        const indices = Array.from(indicesSet).sort((a, b) => a - b);
        if (indices.length === 0) continue;
        const segments: Array<{ id: string; left: number; width: number }> = [];
        let runStart = indices[0];
        let previous = indices[0];
        for (let i = 1; i <= indices.length; i += 1) {
          const current = indices[i];
          if (current !== undefined && current === previous + 1) {
            previous = current;
            continue;
          }
          const left = runStart * DAY_WIDTH;
          const width = (previous - runStart + 1) * DAY_WIDTH;
          segments.push({
            id: `${clinicianId}-${sectionId}-${runStart}-${previous}`,
            left,
            width,
          });
          runStart = current ?? 0;
          previous = current ?? 0;
        }
        segmentsBySection.set(sectionId, segments);
      }
      if (segmentsBySection.size) {
        segmentsByClinician.set(clinicianId, segmentsBySection);
      }
    }
    return segmentsByClinician;
  }, [activeSectionIds, assignments, rangeStartYear, rangeEndYear, slotSectionById]);

  const handleJumpToToday = () => {
    if (selectedYear !== currentYear) {
      setSelectedYear(currentYear);
    }
    setScrollBehavior("smooth");
    setPendingScrollToToday(true);
  };

  const dayIndexFromClientX = useCallback(
    (clientX: number) => {
      const timeline = timelineRef.current;
      if (!timeline) return null;
      const rect = timeline.getBoundingClientRect();
      // Subtract leftColumnWidth since timeline includes the name column
      const x = clientX - rect.left - leftColumnWidth;
      const dayIndex = Math.floor(x / DAY_WIDTH);
      if (dayIndex < 0 || dayIndex >= totalDays) return null;
      return dayIndex;
    },
    [totalDays, leftColumnWidth],
  );

  const clampedDayIndexFromClientX = useCallback(
    (clientX: number) => {
      const timeline = timelineRef.current;
      if (!timeline) return null;
      const rect = timeline.getBoundingClientRect();
      const x = clientX - rect.left - leftColumnWidth;
      const dayIndex = Math.floor(x / DAY_WIDTH);
      return Math.min(Math.max(dayIndex, 0), totalDays - 1);
    },
    [totalDays, leftColumnWidth],
  );

  // Mouse move handler to track hovered day
  const handleTimelineMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      setHoverDayIndex(dayIndexFromClientX(event.clientX));
    },
    [dayIndexFromClientX],
  );

  const handleTimelineMouseLeave = useCallback(() => {
    setHoverDayIndex(null);
  }, []);

  // Clinician drag handlers
  const handleClinicianDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, clinicianId: string) => {
      setDragClinicianId(clinicianId);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", clinicianId);
    },
    [],
  );

  const handleClinicianDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>, clinicianId: string) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDragOverClinicianId(clinicianId);
    },
    [],
  );

  const handleClinicianDragEnd = useCallback(() => {
    setDragClinicianId(null);
    setDragOverClinicianId(null);
  }, []);

  const handleClinicianDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>, targetClinicianId: string) => {
      event.preventDefault();
      const sourceId = dragClinicianId;
      if (!sourceId || sourceId === targetClinicianId || !onReorderClinicians) {
        handleClinicianDragEnd();
        return;
      }
      const ids = clinicians.map((c) => c.id);
      const sourceIndex = ids.indexOf(sourceId);
      const targetIndex = ids.indexOf(targetClinicianId);
      if (sourceIndex === -1 || targetIndex === -1) {
        handleClinicianDragEnd();
        return;
      }
      // Remove source and insert at target position
      const newIds = [...ids];
      newIds.splice(sourceIndex, 1);
      newIds.splice(targetIndex, 0, sourceId);
      onReorderClinicians(newIds);
      handleClinicianDragEnd();
    },
    [dragClinicianId, clinicians, onReorderClinicians, handleClinicianDragEnd],
  );

  // Drag-to-create vacation pointer handlers (mouse/pen only; touch keeps
  // panning the timeline and taps still open the vacation editor).
  const handleVacationPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, clinicianId: string) => {
      if (!onCreateVacationRange) return;
      if (event.pointerType === "touch") return;
      if (event.button !== 0) return;
      if (vacationDragRef.current) return;
      const dayIndex = dayIndexFromClientX(event.clientX);
      if (dayIndex === null) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is unavailable in jsdom and some older browsers.
      }
      updateVacationDrag({
        clinicianId,
        pointerId: event.pointerId,
        anchorIndex: dayIndex,
        currentIndex: dayIndex,
        startClientX: event.clientX,
        status: "pending",
      });
    },
    [onCreateVacationRange, dayIndexFromClientX, updateVacationDrag],
  );

  const handleVacationPointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = vacationDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dayIndex = clampedDayIndexFromClientX(event.clientX);
      if (dayIndex === null) return;
      const status =
        drag.status === "pending" &&
        Math.abs(event.clientX - drag.startClientX) >= DRAG_THRESHOLD_PX
          ? "dragging"
          : drag.status;
      if (dayIndex === drag.currentIndex && status === drag.status) return;
      updateVacationDrag({ ...drag, currentIndex: dayIndex, status });
    },
    [clampedDayIndexFromClientX, updateVacationDrag],
  );

  const handleVacationPointerUp = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = vacationDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.status === "dragging" && onCreateVacationRange) {
        const lo = Math.min(drag.anchorIndex, drag.currentIndex);
        const hi = Math.max(drag.anchorIndex, drag.currentIndex);
        onCreateVacationRange(
          drag.clinicianId,
          dayIndexToISOInTimeline(lo, rangeStartYear),
          dayIndexToISOInTimeline(hi, rangeStartYear),
        );
        suppressRowClickRef.current = true;
      }
      updateVacationDrag(null);
    },
    [onCreateVacationRange, rangeStartYear, updateVacationDrag],
  );

  const handleVacationPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = vacationDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      updateVacationDrag(null);
    },
    [updateVacationDrag],
  );

  useEffect(() => {
    if (!open) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const updateVisibleYear = () => {
      const visibleWidth = Math.max(0, container.clientWidth - leftColumnWidth);
      const centerIndex = Math.max(
        0,
        Math.floor((container.scrollLeft + visibleWidth / 2) / DAY_WIDTH),
      );
      const nextYear = resolveYearForDayIndex(centerIndex);
      setVisibleYear((prev) => (prev === nextYear ? prev : nextYear));
    };
    updateVisibleYear();
    container.addEventListener("scroll", updateVisibleYear, { passive: true });
    return () => container.removeEventListener("scroll", updateVisibleYear);
  }, [open, resolveYearForDayIndex]);

  useEffect(() => {
    if (!open) return;
    if (!pendingScrollToToday) return;
    if (todayIndex === null) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const target =
      leftColumnWidth + todayIndex * DAY_WIDTH - container.clientWidth / 2;
    window.requestAnimationFrame(() => {
      container.scrollTo({ left: Math.max(0, target), behavior: scrollBehavior });
    });
    setPendingScrollToToday(false);
  }, [open, pendingScrollToToday, todayIndex, scrollBehavior]);

  // Render the modal always but hide it when not open to preserve state
  // (activeSectionIds, sectionColorsById, clinician order, etc.)
  if (!open) {
    return null;
  }

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
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-6 py-4 dark:border-slate-800">
            <div>
              <div className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                Vacation Overview
              </div>
              <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                Year planner for clinician vacations.
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setReferencePanelOpen((prev) => !prev)}
                  className={cx(
                    "rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600",
                    "hover:bg-slate-50 active:bg-slate-100",
                    "dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800",
                  )}
                >
                  Display items
                </button>
                {referencePanelOpen ? (
                  <div
                    ref={referencePanelRef}
                    className="absolute right-0 top-full z-[60] mt-2 w-80 rounded-2xl border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900"
                  >
                    <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Choose bands
                    </div>
                    <div className="space-y-2">
                      {/* Vacation band option */}
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setActiveSectionIds((prev) =>
                              prev.includes(VACATION_BAND_ID)
                                ? prev.filter((id) => id !== VACATION_BAND_ID)
                                : [...prev, VACATION_BAND_ID],
                            )
                          }
                          className={cx(
                            "flex flex-1 items-center gap-2",
                            getPillToggleClasses(isVacationActive),
                          )}
                        >
                          <span
                            className="h-3 w-3 rounded-full border border-slate-200"
                            style={{ backgroundColor: vacationColor }}
                          />
                          Vacation
                        </button>
                        <ColorPickerPopover
                          value={vacationColor}
                          onChange={(color) =>
                            setSectionColorsById((prev) => ({
                              ...prev,
                              [VACATION_BAND_ID]: color ?? vacationColor,
                            }))
                          }
                          options={BLOCK_COLOR_SWATCH_OPTIONS}
                          label="Vacation color"
                          buttonClassName="h-7 w-7"
                          swatchClassName="h-4 w-4"
                          allowClear={false}
                          popoverClassName="z-[70]"
                        />
                      </div>
                      {/* Rest Day band option */}
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setActiveSectionIds((prev) =>
                              prev.includes(REST_DAY_BAND_ID)
                                ? prev.filter((id) => id !== REST_DAY_BAND_ID)
                                : [...prev, REST_DAY_BAND_ID],
                            )
                          }
                          className={cx(
                            "flex flex-1 items-center gap-2",
                            getPillToggleClasses(isRestDayActive),
                          )}
                        >
                          <span
                            className="h-3 w-3 rounded-full border border-slate-200"
                            style={{ backgroundColor: restDayColor }}
                          />
                          Rest Day
                        </button>
                        <ColorPickerPopover
                          value={restDayColor}
                          onChange={(color) =>
                            setSectionColorsById((prev) => ({
                              ...prev,
                              [REST_DAY_BAND_ID]: color ?? restDayColor,
                            }))
                          }
                          options={BLOCK_COLOR_SWATCH_OPTIONS}
                          label="Rest Day color"
                          buttonClassName="h-7 w-7"
                          swatchClassName="h-4 w-4"
                          allowClear={false}
                          popoverClassName="z-[70]"
                        />
                      </div>
                      {sections.map((section) => {
                        const isActive = activeSectionIds.includes(section.id);
                        const defaultColor = section.color ?? "#D9F0FF";
                        const swatch = sectionColorsById[section.id] ?? defaultColor;
                        return (
                          <div
                            key={section.id}
                            className="flex items-center justify-between gap-2"
                          >
                            <button
                              type="button"
                              onClick={() =>
                                setActiveSectionIds((prev) =>
                                  prev.includes(section.id)
                                    ? prev.filter((id) => id !== section.id)
                                    : [...prev, section.id],
                                )
                              }
                              className={cx(
                                "flex flex-1 items-center gap-2",
                                getPillToggleClasses(isActive),
                              )}
                            >
                              <span
                                className="h-3 w-3 rounded-full border border-slate-200"
                                style={{ backgroundColor: swatch }}
                              />
                              {section.name}
                            </button>
                            <ColorPickerPopover
                              value={swatch}
                              onChange={(color) =>
                                setSectionColorsById((prev) => ({
                                  ...prev,
                                  [section.id]: color ?? swatch,
                                }))
                              }
                              options={BLOCK_COLOR_SWATCH_OPTIONS}
                              label={`${section.name} color`}
                              buttonClassName="h-7 w-7"
                              swatchClassName="h-4 w-4"
                              allowClear={false}
                              popoverClassName="z-[70]"
                            />
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-4 flex justify-end">
                      <button
                        type="button"
                        onClick={() => setReferencePanelOpen(false)}
                        className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        Done
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={handleJumpToToday}
                className={buttonSecondary.base}
              >
                Today
              </button>
              <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                <button
                  type="button"
                  onClick={() => setSelectedYear((prev) => prev - 1)}
                  className="rounded-full px-2 py-1 text-xs font-semibold text-slate-500 hover:text-slate-700 dark:text-slate-300 dark:hover:text-slate-100"
                  aria-label="Previous year"
                >
                  -
                </button>
                <span className="min-w-[96px] text-center font-semibold">
                  {rangeStartYear}-{rangeEndYear}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedYear((prev) => prev + 1)}
                  className="rounded-full px-2 py-1 text-xs font-semibold text-slate-500 hover:text-slate-700 dark:text-slate-300 dark:hover:text-slate-100"
                  aria-label="Next year"
                >
                  +
                </button>
              </div>
              <button
                type="button"
                onClick={onClose}
                className={buttonPrimary.base}
              >
                Close
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <div ref={scrollContainerRef} className="h-full overflow-auto">
              <div
                ref={timelineRef}
                className={cx("relative min-w-max", vacationDrag && "select-none")}
                onMouseMove={handleTimelineMouseMove}
                onMouseLeave={handleTimelineMouseLeave}
              >
                {/* Hover day column highlight */}
                {typeof hoverDayIndex === "number" && (
                  <div
                    className="pointer-events-none absolute top-0 bottom-0 z-10 bg-slate-400/10 dark:bg-slate-500/10"
                    style={{
                      left: leftColumnWidth + hoverDayIndex * DAY_WIDTH,
                      width: DAY_WIDTH,
                    }}
                  />
                )}
                {/* Hover cursor line */}
                {typeof hoverDayIndex === "number" && (
                  <div
                    className="pointer-events-none absolute top-0 bottom-0 z-20"
                    style={{
                      left: leftColumnWidth + hoverDayIndex * DAY_WIDTH + DAY_WIDTH / 2,
                    }}
                  >
                    <div className="h-full w-px bg-slate-400/60 dark:bg-slate-500/60" />
                  </div>
                )}
                {typeof todayIndex === "number" ? (
                  <div
                    className="pointer-events-none absolute top-0 bottom-0 z-20"
                    style={{
                      left: leftColumnWidth + todayIndex * DAY_WIDTH,
                    }}
                  >
                    <div className="h-full w-px bg-rose-400/80" />
                    <div className="absolute top-1 -translate-x-1/2 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-600 shadow-sm dark:bg-rose-900/40 dark:text-rose-200">
                      Today
                    </div>
                  </div>
                ) : null}

                <div className="sticky top-0 z-30 bg-white dark:bg-slate-900">
                  <div className="flex border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                    <div
                      className="sticky left-0 z-40 border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
                      style={{ width: leftColumnWidth }}
                    />
                    <div className="relative flex" style={{ width: totalWidth }}>
                      {/* Year labels row - absolutely positioned above months */}
                      <div className="pointer-events-none absolute left-0 right-0 top-0 flex" style={{ height: 18 }}>
                        {yearSpans.map((span, yearIdx) => {
                          // Calculate offset to the start of this year
                          let yearOffset = 0;
                          for (let i = 0; i < yearIdx; i++) {
                            yearOffset += yearSpans[i].days * DAY_WIDTH;
                          }
                          const yearWidth = span.days * DAY_WIDTH;

                          return (
                            <div
                              key={span.year}
                              className="absolute top-0 flex"
                              style={{
                                left: yearOffset,
                                width: yearWidth,
                              }}
                            >
                              <div
                                className="sticky flex items-center"
                                style={{ left: leftColumnWidth + 8 }}
                              >
                                <span className="rounded bg-white px-1 text-xs font-semibold text-slate-700 dark:bg-slate-900 dark:text-slate-100">
                                  {span.year}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {/* Month labels */}
                      {monthSpans.map((month) => (
                        <div
                          key={`${month.year}-${month.label}`}
                          className="flex flex-col items-center justify-end border-r border-slate-100 pt-5 dark:border-slate-800"
                          style={{ width: month.days * DAY_WIDTH }}
                        >
                          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                            {month.label}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                    <div
                      className="sticky left-0 z-40 border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
                      style={{ width: leftColumnWidth }}
                    />
                    <div className="flex" style={{ width: totalWidth }}>
                      {monthSpans.map((month) => (
                        <div key={`${month.year}-${month.label}`} className="flex">
                          {Array.from({ length: month.days }).map((_, idx) => (
                            <div
                              key={`${month.year}-${month.label}-${idx + 1}`}
                              className="flex h-7 items-center justify-center border-r border-slate-100 text-[10px] text-slate-400 dark:border-slate-800 dark:text-slate-500"
                              style={{ width: DAY_WIDTH }}
                            >
                              {idx + 1}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div>
                  {clinicians.map((clinician) => {
                    const segments =
                      vacationSegmentsByClinician.get(clinician.id) ?? [];
                    const restDaySegments =
                      restDaySegmentsByClinician.get(clinician.id) ?? [];
                    const sectionSegments =
                      sectionSegmentsByClinician.get(clinician.id) ?? new Map();
                    const bandCount = (isVacationActive ? 1 : 0) + (isRestDayActive ? 1 : 0) + activeSections.length;
                    const bandGap = 4;
                    const minRowHeight = 44; // Ensure clinician name is always visible
                    const calculatedHeight =
                      bandCount * BAR_HEIGHT + (bandCount - 1) * bandGap + 8;
                    const rowHeight = Math.max(minRowHeight, calculatedHeight);
                    const isDragging = dragClinicianId === clinician.id;
                    const isDragOver = dragOverClinicianId === clinician.id && dragClinicianId !== clinician.id;
                    return (
                      <div
                        key={clinician.id}
                        className={cx(
                          "flex border-b border-slate-300 dark:border-slate-700",
                          isDragging && "opacity-50",
                          isDragOver && "border-t-2 border-t-sky-500",
                        )}
                      >
                        <div
                          draggable={Boolean(onReorderClinicians)}
                          onDragStart={(e) => handleClinicianDragStart(e, clinician.id)}
                          onDragOver={(e) => handleClinicianDragOver(e, clinician.id)}
                          onDragEnd={handleClinicianDragEnd}
                          onDrop={(e) => handleClinicianDrop(e, clinician.id)}
                          className={cx(
                            "sticky left-0 z-50 flex flex-col justify-center border-r border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200",
                            onReorderClinicians && "cursor-grab active:cursor-grabbing",
                          )}
                          style={{ width: leftColumnWidth, minWidth: leftColumnWidth, height: rowHeight }}
                        >
                          <span className="block truncate">{clinician.name}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            if (suppressRowClickRef.current) {
                              suppressRowClickRef.current = false;
                              return;
                            }
                            onSelectClinician(clinician.id);
                          }}
                          onPointerDown={(e) => handleVacationPointerDown(e, clinician.id)}
                          onPointerMove={handleVacationPointerMove}
                          onPointerUp={handleVacationPointerUp}
                          onPointerCancel={handleVacationPointerCancel}
                          aria-label={`${clinician.name} vacation timeline`}
                          className={cx(
                            "relative flex flex-shrink-0 flex-col justify-center gap-1",
                            onCreateVacationRange && "cursor-crosshair",
                          )}
                          style={{ width: totalWidth, height: rowHeight }}
                        >
                          {vacationDrag &&
                            vacationDrag.status === "dragging" &&
                            vacationDrag.clinicianId === clinician.id &&
                            (() => {
                              const lo = Math.min(
                                vacationDrag.anchorIndex,
                                vacationDrag.currentIndex,
                              );
                              const hi = Math.max(
                                vacationDrag.anchorIndex,
                                vacationDrag.currentIndex,
                              );
                              return (
                                <div
                                  className="pointer-events-none absolute inset-y-0.5 z-20 rounded-md"
                                  style={{
                                    left: lo * DAY_WIDTH,
                                    width: (hi - lo + 1) * DAY_WIDTH,
                                    backgroundColor: vacationColor,
                                    opacity: 0.5,
                                    boxShadow: `inset 0 0 0 2px ${vacationColor}`,
                                  }}
                                >
                                  <div className="flex h-full items-center justify-center whitespace-nowrap text-[10px] font-semibold leading-none text-slate-900">
                                    {formatVacationRangeLabel(
                                      dayIndexToISOInTimeline(lo, rangeStartYear),
                                      dayIndexToISOInTimeline(hi, rangeStartYear),
                                    )}
                                  </div>
                                </div>
                              );
                            })()}
                          {isVacationActive && (
                            <div
                              className="relative w-full overflow-visible rounded-full bg-slate-200 dark:bg-slate-800"
                              style={{ height: BAR_HEIGHT }}
                            >
                              {segments.map((segment) => (
                                <div
                                  key={segment.id}
                                  className="absolute top-0"
                                  style={{
                                    left: segment.left,
                                    width: segment.width,
                                    height: BAR_HEIGHT,
                                    backgroundColor: vacationColor,
                                  }}
                                />
                              ))}
                              {segments.map((segment) => {
                                // The label may spill half a day cell to each
                                // side. Merged vacations are always separated
                                // by at least one free day, so neighbouring
                                // labels can meet but never overlap. The font
                                // shrinks until the text fits that box.
                                const labelWidth = segment.width + DAY_WIDTH;
                                const fontSize = Math.max(
                                  7,
                                  Math.min(10, labelWidth / (segment.label.length * 0.55)),
                                );
                                return (
                                  <div
                                    key={`${segment.id}-label`}
                                    className="pointer-events-none absolute top-0 z-10 flex items-center justify-center whitespace-nowrap font-medium leading-none text-slate-800"
                                    style={{
                                      left: segment.left + segment.width / 2 - labelWidth / 2,
                                      width: labelWidth,
                                      height: BAR_HEIGHT,
                                      fontSize,
                                    }}
                                  >
                                    {segment.label}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {isRestDayActive && (
                            <div
                              className="relative w-full overflow-visible rounded-full bg-slate-200 dark:bg-slate-800"
                              style={{ height: BAR_HEIGHT }}
                            >
                              {restDaySegments.map((segment) => (
                                <div
                                  key={segment.id}
                                  className="absolute top-0"
                                  style={{
                                    left: segment.left,
                                    width: segment.width,
                                    height: BAR_HEIGHT,
                                    backgroundColor: restDayColor,
                                  }}
                                />
                              ))}
                            </div>
                          )}
                          {activeSections.map((section) => {
                            const sectionSegmentRows =
                              sectionSegments.get(section.id) ?? [];
                            const bandColor =
                              sectionColorsById[section.id] ??
                              section.color ??
                              "#D9F0FF";
                            return (
                              <div
                                key={`${clinician.id}-${section.id}`}
                                className="relative w-full overflow-visible rounded-full bg-slate-200 dark:bg-slate-800"
                                style={{ height: BAR_HEIGHT }}
                              >
                                {sectionSegmentRows.map((segment: { id: string; left: number; width: number }) => (
                                  <div
                                    key={segment.id}
                                    className="absolute top-0"
                                    style={{
                                      left: segment.left,
                                      width: segment.width,
                                      height: BAR_HEIGHT,
                                      backgroundColor: bandColor,
                                    }}
                                  />
                                ))}
                              </div>
                            );
                          })}
                        </button>
                        {/* Sticky band labels - positioned after the button to overlay the timeline */}
                        <div
                          className="pointer-events-none sticky z-40 flex flex-col justify-center gap-1"
                          style={{
                            left: leftColumnWidth + 8,
                            width: 0,
                            height: rowHeight,
                            marginLeft: -totalWidth - 8,
                          }}
                        >
                          {isVacationActive && (
                            <div
                              className="flex items-center"
                              style={{ height: BAR_HEIGHT }}
                            >
                              <span className="whitespace-nowrap text-[11px] font-normal text-slate-600 dark:text-slate-300">
                                Vacation
                              </span>
                            </div>
                          )}
                          {isRestDayActive && (
                            <div
                              className="flex items-center"
                              style={{ height: BAR_HEIGHT }}
                            >
                              <span className="whitespace-nowrap text-[11px] font-normal text-slate-600 dark:text-slate-300">
                                Rest Day
                              </span>
                            </div>
                          )}
                          {activeSections.map((section) => (
                            <div
                              key={`label-${clinician.id}-${section.id}`}
                              className="flex items-center"
                              style={{ height: BAR_HEIGHT }}
                            >
                              <span className="whitespace-nowrap text-[11px] font-normal text-slate-600 dark:text-slate-300">
                                {section.name}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
