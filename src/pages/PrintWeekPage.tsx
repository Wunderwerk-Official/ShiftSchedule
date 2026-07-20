import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ClinicSheetGrid from "../components/schedule/ClinicSheetGrid";
import ScheduleGrid from "../components/schedule/ScheduleGrid";
import { getState, type Holiday, type WeeklyCalendarTemplate } from "../api/client";
import {
  Assignment,
  buildAssignmentMap,
  Clinician,
  defaultMinSlotsByRowId,
  defaultSolverSettings,
  WorkplaceRow,
  locations as defaultLocations,
} from "../data/mockData";
import { addDays, startOfWeek, formatRangeLabel } from "../lib/date";
import { buildClinicSheetModel, buildSheetDays } from "../lib/clinicSheet";
import { buildRenderedAssignmentMap } from "../lib/schedule";
import { cx } from "../lib/classNames";
import { buildScheduleRows, normalizeAppState } from "../lib/shiftRows";
import {
  buildCalendarRows,
  buildColumnTimeMetaByKey,
  buildDayColumns,
  buildLocationSeparatorRowIds,
} from "../lib/calendarView";

type PrintWeekPageProps = {
  theme: "light" | "dark";
};

const PRINT_DPI = 96;
const MM_TO_PX = PRINT_DPI / 25.4;
const PRINT_PAGE_WIDTH_MM = 297;
const PRINT_PAGE_HEIGHT_MM = 210;
const PRINT_PAGE_MARGIN_MM = 8;
const PRINT_SAFETY_SCALE = 0.95;
// Maximum scale-up factor (e.g., 1.5 means content can be scaled up to 150%)
const MAX_SCALE_UP = 1.5;

// Full A4 page dimensions in pixels
const getFullPagePx = () => ({
  width: PRINT_PAGE_WIDTH_MM * MM_TO_PX,
  height: PRINT_PAGE_HEIGHT_MM * MM_TO_PX,
});

// Printable area (page minus margins)
const getPrintAreaPx = () => ({
  width: (PRINT_PAGE_WIDTH_MM - PRINT_PAGE_MARGIN_MM * 2) * MM_TO_PX,
  height: (PRINT_PAGE_HEIGHT_MM - PRINT_PAGE_MARGIN_MM * 2) * MM_TO_PX,
});

// Margin in pixels
const getMarginPx = () => PRINT_PAGE_MARGIN_MM * MM_TO_PX;

const parseISODate = (value: string | null) => {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
};

export default function PrintWeekPage({ theme }: PrintWeekPageProps) {
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
  const [printLayout, setPrintLayout] = useState({
    scale: 1,
    width: 0,
    height: 0,
    offsetX: 0,
    offsetY: 0,
  });
  const printContentRef = useRef<HTMLDivElement | null>(null);
  const printArea = useMemo(() => getPrintAreaPx(), []);
  const fullPage = useMemo(() => getFullPagePx(), []);
  const marginPx = useMemo(() => getMarginPx(), []);

  const startParam =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("start") : null;
  const anchorDate = useMemo(() => parseISODate(startParam) ?? new Date(), [startParam]);
  const weekStart = useMemo(() => startOfWeek(anchorDate, 1), [anchorDate]);
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const weekEndInclusive = useMemo(() => addDays(weekStart, 6), [weekStart]);

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
  const poolsSeparatorId = useMemo(
    () => calendarRows.find((row) => row.kind === "pool")?.id ?? "",
    [calendarRows],
  );
  const columnTimeMetaByKey = useMemo(
    () => buildColumnTimeMetaByKey(scheduleRows),
    [scheduleRows],
  );
  const dayColumns = useMemo(
    () => buildDayColumns(weekDays, weeklyTemplate, holidayDates, columnTimeMetaByKey),
    [weekDays, weeklyTemplate, holidayDates, columnTimeMetaByKey],
  );
  const rowById = useMemo(() => new Map(scheduleRows.map((row) => [row.id, row])), [scheduleRows]);

  const isWeekendOrHoliday = (dateISO: string) => {
    const date = new Date(`${dateISO}T00:00:00`);
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
    return isWeekend || holidayDates.has(dateISO);
  };

  const renderAssignmentMap = useMemo(
    () =>
      buildRenderedAssignmentMap(assignmentMap, clinicians, weekDays, {
        scheduleRows,
        solverSettings,
        holidayDates,
      }),
    [assignmentMap, clinicians, weekDays, scheduleRows, solverSettings],
  );

  const isClinicSheet =
    (solverSettings.scheduleLayout ?? "classic") === "clinicSheet";
  const sheetDays = useMemo(
    () =>
      isClinicSheet
        ? buildSheetDays(weekStart, 7, holidayDates, holidayNameByDate)
        : [],
    [isClinicSheet, weekStart, holidayDates, holidayNameByDate],
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

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.__PDF_READY__ = false;
    }
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
    if (loading || !printLayout.width || !printLayout.height) return;
    if (typeof window === "undefined") return;
    const markReady = () => {
      window.__PDF_READY__ = true;
    };
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(markReady);
    });
  }, [
    loading,
    printLayout.width,
    printLayout.height,
    rows,
    clinicians,
    assignmentMap,
    minSlotsByRowId,
    slotOverridesByKey,
  ]);

  useLayoutEffect(() => {
    if (loading) return;
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
        // Centering is now handled by flexbox
        offsetX: 0,
        offsetY: 0,
      });
    };
    const frame = window.requestAnimationFrame(updateScale);
    return () => window.cancelAnimationFrame(frame);
  }, [loading, rows, clinicians, assignmentMap, minSlotsByRowId, slotOverridesByKey, printArea]);

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
      {/* Full A4 page container */}
      <div
        className="print-page"
        style={{
          width: fullPage.width,
          height: fullPage.height,
          padding: marginPx,
          boxSizing: "border-box",
          overflow: "hidden",
          breakInside: "avoid",
          pageBreakInside: "avoid",
          breakAfter: "auto",
          pageBreakAfter: "auto",
        }}
      >
        {/* Printable area within margins - use absolute positioning for centering */}
        <div
          style={{
            position: "relative",
            width: printArea.width,
            height: printArea.height,
            overflow: "hidden",
          }}
        >
          <div
            ref={printContentRef}
            style={{
              position: "absolute",
              left: printLayout.width ? (printArea.width - printLayout.width) / 2 : 0,
              top: printLayout.height ? (printArea.height - printLayout.height) / 2 : 0,
              transform: `scale(${printLayout.scale})`,
              transformOrigin: "top left",
            }}
          >
            {isClinicSheet && sheetModel ? (
              // w-max lets the measure container size to the sheet's
              // max-content width — without it the shrink-to-fit width lands
              // at min-content and the overflow-hidden shell clips the last
              // day column in the PDF.
              <div className="w-max">
                <ClinicSheetGrid
                  model={sheetModel}
                  assignmentMap={renderAssignmentMap}
                  rows={calendarRows}
                  readOnly
                  header={
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-semibold text-slate-600 dark:text-slate-300">
                        {formatRangeLabel(weekStart, weekEndInclusive)}
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
                assignmentMap={renderAssignmentMap}
                holidayDates={holidayDates}
                holidayNameByDate={holidayNameByDate}
                locationSeparatorRowIds={locationSeparatorRowIds}
                readOnly
                header={
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-slate-600 dark:text-slate-300">
                      {formatRangeLabel(weekStart, weekEndInclusive)}
                    </div>
                  </div>
                }
                separatorBeforeRowIds={poolsSeparatorId ? [poolsSeparatorId] : []}
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
}
