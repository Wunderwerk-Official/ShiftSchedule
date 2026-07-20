import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ClinicSheetGrid from "../components/schedule/ClinicSheetGrid";
import ScheduleGrid from "../components/schedule/ScheduleGrid";
import { getState, type Holiday, type WeeklyCalendarTemplate } from "../api/client";
import {
  Assignment,
  buildAssignmentMap,
  Clinician,
  defaultMinSlotsByRowId,
  defaultSolverSettings,
  locations as defaultLocations,
  WorkplaceRow,
} from "../data/mockData";
import { addDays, addWeeks, formatRangeLabel, startOfWeek } from "../lib/date";
import { buildClinicSheetModel, buildSheetDays } from "../lib/clinicSheet";
import { buildRenderedAssignmentMap } from "../lib/schedule";
import { cx } from "../lib/classNames";
import { buildScheduleRows, normalizeAppState, type ScheduleRow } from "../lib/shiftRows";
import {
  buildCalendarRows,
  buildColumnTimeMetaByKey,
  buildDayColumns,
  buildLocationSeparatorRowIds,
} from "../lib/calendarView";

type PrintWeeksPageProps = {
  theme: "light" | "dark";
};

const PRINT_DPI = 96;
const MM_TO_PX = PRINT_DPI / 25.4;
const PRINT_PAGE_WIDTH_MM = 297;
const PRINT_PAGE_HEIGHT_MM = 210;
const PRINT_PAGE_MARGIN_MM = 8;
const PRINT_SAFETY_SCALE = 0.98;
// Maximum scale-up factor (e.g., 1.5 means content can be scaled up to 150%)
const MAX_SCALE_UP = 1.5;

const getPrintAreaPx = () => ({
  width: (PRINT_PAGE_WIDTH_MM - PRINT_PAGE_MARGIN_MM * 2) * MM_TO_PX,
  height: (PRINT_PAGE_HEIGHT_MM - PRINT_PAGE_MARGIN_MM * 2) * MM_TO_PX,
});

type PrintableWeekProps = {
  weekIndex: number;
  totalWeeks: number;
  weekDays: Date[];
  scheduleRows: ScheduleRow[];
  calendarRows: ReturnType<typeof buildCalendarRows>;
  assignmentMap: Map<string, Assignment[]>;
  clinicians: Clinician[];
  holidayDates: Set<string>;
  holidayNameByDate: Record<string, string>;
  weeklyTemplate?: WeeklyCalendarTemplate;
  solverSettings: typeof defaultSolverSettings;
  locationSeparatorRowIds: string[];
  minSlotsByRowId: Record<string, { weekday: number; weekend: number }>;
  poolId?: string;
  rowById: Map<string, ScheduleRow>;
  slotOverridesByKey: Record<string, number>;
  columnTimeMetaByKey: ReturnType<typeof buildColumnTimeMetaByKey>;
  rangeLabel: string;
  onReady?: (weekIndex: number) => void;
};

const PrintableWeek = ({
  weekIndex,
  totalWeeks,
  weekDays,
  scheduleRows,
  calendarRows,
  assignmentMap,
  clinicians,
  holidayDates,
  holidayNameByDate,
  weeklyTemplate,
  solverSettings,
  locationSeparatorRowIds,
  minSlotsByRowId,
  poolId,
  rowById,
  slotOverridesByKey,
  columnTimeMetaByKey,
  rangeLabel,
  onReady,
}: PrintableWeekProps) => {
  const [printLayout, setPrintLayout] = useState({
    scale: 1,
    width: 0,
    height: 0,
    offsetX: 0,
    offsetY: 0,
  });
  const printContentRef = useRef<HTMLDivElement | null>(null);
  const printArea = useMemo(() => getPrintAreaPx(), []);
  const weekAssignments = useMemo(
    () =>
      buildRenderedAssignmentMap(assignmentMap, clinicians, weekDays, {
        scheduleRows,
        solverSettings,
        holidayDates,
      }),
    [assignmentMap, clinicians, weekDays, scheduleRows, solverSettings, holidayDates],
  );
  const dayColumns = useMemo(
    () => buildDayColumns(weekDays, weeklyTemplate, holidayDates, columnTimeMetaByKey),
    [weekDays, weeklyTemplate, holidayDates, columnTimeMetaByKey],
  );
  const isClinicSheet =
    (solverSettings.scheduleLayout ?? "classic") === "clinicSheet";
  const sheetDays = useMemo(
    () =>
      isClinicSheet
        ? buildSheetDays(weekDays[0], 7, holidayDates, holidayNameByDate)
        : [],
    [isClinicSheet, weekDays, holidayDates, holidayNameByDate],
  );
  const sheetModel = useMemo(
    () =>
      isClinicSheet
        ? buildClinicSheetModel({
            calendarRows,
            days: sheetDays,
            slotOverridesByKey,
            minSlotsByRowId,
          })
        : null,
    [isClinicSheet, calendarRows, sheetDays, slotOverridesByKey, minSlotsByRowId],
  );

  useLayoutEffect(() => {
    const content = printContentRef.current;
    if (!content) return;
    const updateScale = () => {
      const available = printArea;
      const contentRect = content.getBoundingClientRect();
      const contentWidth = Math.max(content.scrollWidth, contentRect.width);
      const contentHeight = Math.max(content.scrollHeight, contentRect.height);
      if (!contentWidth || !contentHeight) return;
      // Calculate scale to fit within printable area, allow scaling up to MAX_SCALE_UP
      const fitScale = Math.min(available.width / contentWidth, available.height / contentHeight);
      const safeScale = Number.isFinite(fitScale) ? fitScale * PRINT_SAFETY_SCALE : 1;
      // Allow scaling up to MAX_SCALE_UP to fill the page better
      const nextScale = Math.min(Math.max(safeScale, 0.01), MAX_SCALE_UP);
      const scaledWidth = contentWidth * nextScale;
      const scaledHeight = contentHeight * nextScale;
      setPrintLayout({
        scale: nextScale,
        width: scaledWidth,
        height: scaledHeight,
        // Horizontally centered
        offsetX: Math.max(0, (available.width - scaledWidth) / 2),
        // Top-aligned (no vertical centering)
        offsetY: 0,
      });
    };
    const frame = window.requestAnimationFrame(updateScale);
    return () => window.cancelAnimationFrame(frame);
  }, [weekIndex, scheduleRows, calendarRows, assignmentMap, clinicians, holidayDates, printArea]);

  useEffect(() => {
    if (printLayout.width > 0 && printLayout.height > 0) {
      onReady?.(weekIndex);
    }
  }, [printLayout.height, printLayout.width, weekIndex, onReady]);

  return (
    <div
      className="print-page"
      style={{
        breakInside: "avoid",
        pageBreakInside: "avoid",
        breakAfter: weekIndex === totalWeeks - 1 ? "auto" : "page",
        pageBreakAfter: weekIndex === totalWeeks - 1 ? "auto" : "always",
      }}
    >
      <div
        className="relative overflow-hidden"
        style={{
          width: printArea.width,
          height: printArea.height,
        }}
      >
        <div
          className="absolute left-0 top-0"
          style={{
            transform: `translate(${printLayout.offsetX}px, ${printLayout.offsetY}px)`,
            transformOrigin: "top left",
          }}
        >
          <div
            ref={printContentRef}
            style={{
              transform: `scale(${printLayout.scale})`,
              transformOrigin: "top left",
            }}
          >
            {isClinicSheet && sheetModel ? (
              // w-max: size the measure container to the sheet's max-content
              // width so the last day column is never clipped (see
              // PrintWeekPage for the min-content pitfall).
              <div className="w-max">
                <ClinicSheetGrid
                  model={sheetModel}
                  assignmentMap={weekAssignments}
                  rows={calendarRows}
                  readOnly
                  header={
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-semibold text-slate-600 dark:text-slate-300">
                        {rangeLabel}
                      </div>
                    </div>
                  }
                  getClinicianName={(id) =>
                    clinicians.find((c) => c.id === id)?.name ?? "Unknown"
                  }
                  getIsQualified={(clinicianId, rowId) => {
                    const scheduleRow = rowById.get(rowId);
                    const classId =
                      scheduleRow?.kind === "class"
                        ? scheduleRow.sectionId ?? scheduleRow.id
                        : rowId;
                    const clinician = clinicians.find((item) => item.id === clinicianId);
                    return clinician ? clinician.qualifiedClassIds.includes(classId) : false;
                  }}
                />
              </div>
            ) : (
            <ScheduleGrid
              leftHeaderTitle=""
              weekDays={weekDays}
              dayColumns={dayColumns}
              rows={calendarRows}
              assignmentMap={weekAssignments}
              holidayDates={holidayDates}
              holidayNameByDate={holidayNameByDate}
              locationSeparatorRowIds={locationSeparatorRowIds}
              readOnly
              header={
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-slate-600 dark:text-slate-300">
                    {rangeLabel}
                  </div>
                </div>
              }
              separatorBeforeRowIds={poolId ? [poolId] : []}
              minSlotsByRowId={minSlotsByRowId}
              getClinicianName={(id) =>
                clinicians.find((c) => c.id === id)?.name ?? "Unknown"
              }
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
              slotOverridesByKey={slotOverridesByKey}
              onRemoveEmptySlot={() => {}}
              onMoveWithinDay={() => {}}
              onCellClick={() => {}}
            />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const parseISODate = (value: string | null) => {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
};

const clampWeeks = (value: string | null) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(55, Math.trunc(parsed)));
};

export default function PrintWeeksPage({ theme }: PrintWeeksPageProps) {
  const [rows, setRows] = useState<WorkplaceRow[]>([]);
  const [locations, setLocations] = useState(defaultLocations);
  const [locationsEnabled, setLocationsEnabled] = useState(true);
  const [clinicians, setClinicians] = useState<Clinician[]>([]);
  const [assignmentMap, setAssignmentMap] = useState<Map<string, Assignment[]>>(new Map());
  const [minSlotsByRowId, setMinSlotsByRowId] = useState(defaultMinSlotsByRowId);
  const [slotOverridesByKey, setSlotOverridesByKey] = useState<Record<string, number>>({});
  const [weeklyTemplate, setWeeklyTemplate] = useState<WeeklyCalendarTemplate | undefined>(
    undefined,
  );
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [solverSettings, setSolverSettings] = useState(defaultSolverSettings);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [printReadyWeeks, setPrintReadyWeeks] = useState<Set<number>>(new Set());

  const searchParams =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const startParam = searchParams?.get("start") ?? null;
  const weeksParam = searchParams?.get("weeks") ?? null;
  const anchorDate = useMemo(() => parseISODate(startParam) ?? new Date(), [startParam]);
  const totalWeeks = useMemo(() => clampWeeks(weeksParam), [weeksParam]);
  const weekStart = useMemo(() => startOfWeek(anchorDate, 1), [anchorDate]);

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

  const scheduleRows = useMemo(
    () => buildScheduleRows(rows, locations, locationsEnabled, weeklyTemplate),
    [rows, locations, locationsEnabled, weeklyTemplate],
  );
  const visibleScheduleRows = scheduleRows;
  const calendarRows = useMemo(
    () => buildCalendarRows(visibleScheduleRows),
    [visibleScheduleRows],
  );
  const locationSeparatorRowIds = useMemo(
    () => buildLocationSeparatorRowIds(calendarRows),
    [calendarRows],
  );
  const columnTimeMetaByKey = useMemo(
    () => buildColumnTimeMetaByKey(scheduleRows),
    [scheduleRows],
  );
  const rowById = useMemo(() => new Map(scheduleRows.map((row) => [row.id, row])), [scheduleRows]);

  const getWeekDays = (weekIndex: number) =>
    Array.from({ length: 7 }, (_, i) => addDays(addWeeks(weekStart, weekIndex), i));

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.__PDF_READY__ = false;
    }
    setPrintReadyWeeks(new Set());
    let alive = true;
    setLoading(true);
    setError(null);
    getState()
      .then((state) => {
        if (!alive) return;
        const { state: normalized } = normalizeAppState(state);
        if (normalized.locations?.length) setLocations(normalized.locations);
        setLocationsEnabled(normalized.locationsEnabled ?? true);
        if (normalized.rows?.length) setRows(normalized.rows);
        if (normalized.clinicians?.length) {
          setClinicians(
            normalized.clinicians.map((clinician) => ({
              ...clinician,
              preferredClassIds: [...clinician.qualifiedClassIds],
            })),
          );
        }
        if (normalized.assignments) {
          setAssignmentMap(buildAssignmentMap(normalized.assignments));
        }
        if (normalized.minSlotsByRowId) setMinSlotsByRowId(normalized.minSlotsByRowId);
        if (normalized.slotOverridesByKey) setSlotOverridesByKey(normalized.slotOverridesByKey);
        if (normalized.weeklyTemplate) setWeeklyTemplate(normalized.weeklyTemplate);
        if (normalized.solverSettings) {
          setSolverSettings({
            ...defaultSolverSettings,
            ...normalized.solverSettings,
            onCallRestClassId:
              normalized.solverSettings.onCallRestClassId ??
              defaultSolverSettings.onCallRestClassId,
          });
        }
        if (normalized.holidays) setHolidays(normalized.holidays);
      })
      .catch(() => {
        if (!alive) return;
        setError("Unable to load schedule data.");
      })
      .finally(() => {
        if (!alive) return;
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (loading) return;
    if (typeof window === "undefined") return;
    if (printReadyWeeks.size < totalWeeks) return;
    const markReady = () => {
      window.__PDF_READY__ = true;
    };
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(markReady);
    });
  }, [
    loading,
    printReadyWeeks,
    totalWeeks,
    rows,
    clinicians,
    assignmentMap,
    minSlotsByRowId,
    slotOverridesByKey,
  ]);

  const handleWeekReady = useCallback((weekIndex: number) => {
    setPrintReadyWeeks((prev) => {
      if (prev.has(weekIndex)) return prev;
      const next = new Set(prev);
      next.add(weekIndex);
      return next;
    });
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-white px-6 py-10 text-sm text-slate-500">
        Preparing PDF…
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-white px-6 py-10 text-sm text-rose-600">
        {error}
      </div>
    );
  }

  return (
    <div className={cx("bg-white", theme === "dark" && "dark")}>
      {(() => {
        const poolId = calendarRows.find((row) => row.kind === "pool")?.id;
        return Array.from({ length: totalWeeks }, (_, index) => {
          const days = getWeekDays(index);
          const rangeStart = days[0];
          const rangeEnd = days[6];
          return (
            <PrintableWeek
              key={index}
              weekIndex={index}
              totalWeeks={totalWeeks}
              weekDays={days}
              scheduleRows={scheduleRows}
              calendarRows={calendarRows}
              assignmentMap={assignmentMap}
              clinicians={clinicians}
              holidayDates={holidayDates}
              holidayNameByDate={holidayNameByDate}
              weeklyTemplate={weeklyTemplate}
              solverSettings={solverSettings}
              locationSeparatorRowIds={locationSeparatorRowIds}
              minSlotsByRowId={minSlotsByRowId}
              poolId={poolId}
              rowById={rowById}
              slotOverridesByKey={slotOverridesByKey}
              columnTimeMetaByKey={columnTimeMetaByKey}
              rangeLabel={formatRangeLabel(rangeStart, rangeEnd)}
              onReady={handleWeekReady}
            />
          );
        });
      })()}
    </div>
  );
}
