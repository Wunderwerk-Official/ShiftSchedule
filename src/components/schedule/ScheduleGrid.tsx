import type { DayType } from "../../api/client";
import type { RenderedAssignment, TimeRange } from "../../lib/schedule";
import { cx } from "../../lib/classNames";
import {
  buildClinicianOptionsForSlot,
  buildDateIntervalIndex,
  buildRowKindById,
  buildShiftIntervalsByRowId,
  canDropAssignment as canDropAssignmentPure,
} from "../../lib/clinicianSlotOptions";
import { formatDayHeader, toISODate } from "../../lib/date";
import {
  formatTimeRangeLabel,
  intervalsOverlap,
  splitAssignmentKey,
} from "../../lib/schedule";
import { getDayType } from "../../lib/dayTypes";
import AssignmentPill from "./AssignmentPill";
import EmptySlotPill from "./EmptySlotPill";
import RowLabel from "./RowLabel";
import ClinicianPickerPopover from "./ClinicianPickerPopover";
import type { ClinicianOption } from "./ClinicianPickerPopover";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from "react";
import type { ScheduleRow } from "../../lib/shiftRows";
import { getContrastTextColor } from "../../lib/shiftRows";

type ScheduleGridProps = {
  leftHeaderTitle: string;
  weekDays: Date[];
  dayColumns?: {
    date: Date;
    dateISO: string;
    dayType: DayType;
    colOrder: number;
    isFirstInDay: boolean;
    dayIndex: number;
    columnIndex: number;
    columnTimeLabel?: string;
    columnHasMixedTimes?: boolean;
  }[];
  rows: ScheduleRow[];
  assignmentMap: Map<string, RenderedAssignment[]>;
  header?: React.ReactNode;
  holidayDates?: Set<string>;
  holidayNameByDate?: Record<string, string>;
  readOnly?: boolean;
  getClinicianName: (clinicianId: string) => string;
  getIsQualified: (clinicianId: string, rowId: string) => boolean;
  getHasEligibleClasses: (clinicianId: string) => boolean;
  onCellClick: (args: { row: ScheduleRow; date: Date }) => void;
  onClinicianClick?: (clinicianId: string) => void;
  enableSlotOverrides?: boolean;
  onMoveWithinDay: (args: {
    dateISO: string;
    fromRowId: string;
    toRowId: string;
    assignmentId: string;
    clinicianId: string;
  }) => void;
  separatorBeforeRowIds?: string[];
  locationSeparatorRowIds?: string[];
  locationColumnTimeMetaByKey?: Map<string, { label?: string; mixed: boolean }>;
  minSlotsByRowId?: Record<string, { weekday: number; weekend: number }>;
  slotOverridesByKey?: Record<string, number>;
  onRemoveEmptySlot?: (args: { rowId: string; dateISO: string }) => void;
  violatingAssignmentKeys?: Set<string>;
  highlightedAssignmentKeys?: Set<string>;
  highlightedSplitShiftKeys?: Set<string>;
  highlightOpenSlots?: boolean;
  clinicians?: Array<{
    id: string;
    name: string;
    qualifiedClassIds: string[];
    vacations: Array<{ startISO: string; endISO: string }>;
  }>;
  getIsOnRestDay?: (clinicianId: string, dateISO: string) => boolean;
  getHasTimeConflict?: (clinicianId: string, dateISO: string, rowId: string) => boolean;
  enforceSameLocationPerDay?: boolean;
  onAddAssignment?: (args: { rowId: string; dateISO: string; clinicianId: string }) => void;
  onRemoveAssignment?: (args: { rowId: string; dateISO: string; assignmentId: string; clinicianId: string }) => void;
};

export default function ScheduleGrid({
  leftHeaderTitle,
  weekDays,
  dayColumns,
  rows,
  assignmentMap,
  header,
  holidayDates,
  holidayNameByDate,
  readOnly = false,
  getClinicianName,
  getIsQualified,
  getHasEligibleClasses,
  onCellClick,
  onClinicianClick,
  enableSlotOverrides = true,
  onMoveWithinDay,
  separatorBeforeRowIds = [],
  locationSeparatorRowIds = [],
  locationColumnTimeMetaByKey,
  minSlotsByRowId = {},
  slotOverridesByKey = {},
  onRemoveEmptySlot,
  violatingAssignmentKeys,
  highlightedAssignmentKeys,
  highlightedSplitShiftKeys,
  highlightOpenSlots = false,
  clinicians = [],
  getIsOnRestDay,
  getHasTimeConflict,
  enforceSameLocationPerDay = true,
  onAddAssignment,
  onRemoveAssignment,
}: ScheduleGridProps) {
  type DayColumn = NonNullable<ScheduleGridProps["dayColumns"]>[number];
  const columns: DayColumn[] =
    dayColumns ??
    weekDays.map((date, index): DayColumn => {
      const dateISO = toISODate(date);
      return {
        date,
        dateISO,
        dayType: getDayType(dateISO, holidayDates),
        colOrder: 1,
        isFirstInDay: true,
        dayIndex: index,
        columnIndex: index,
        columnTimeLabel: undefined,
      };
    });
  const uniqueDayCount = useMemo(
    () => new Set(columns.map((column) => column.dateISO)).size,
    [columns],
  );
  const dayGroups = useMemo(() => {
    const groups: Array<{
      date: Date;
      dateISO: string;
      columns: typeof columns;
    }> = [];
    const byDate = new Map<
      string,
      { date: Date; dateISO: string; columns: typeof columns }
    >();
    for (const column of columns) {
      const existing = byDate.get(column.dateISO);
      if (existing) {
        existing.columns.push(column);
        continue;
      }
      const next = { date: column.date, dateISO: column.dateISO, columns: [column] };
      byDate.set(column.dateISO, next);
      groups.push(next);
    }
    return groups;
  }, [columns]);
  const showBlockTimes = useMemo(() => {
    const columnsWithSlots = new Set<string>();
    for (const row of rows) {
      if (row.kind !== "class") continue;
      if (row.slotRows?.length) {
        for (const slotRow of row.slotRows) {
          if (!slotRow.dayType) continue;
          const key = `${slotRow.dayType}-${slotRow.colBandOrder ?? 1}`;
          columnsWithSlots.add(key);
        }
        continue;
      }
      if (row.dayType) {
        const key = `${row.dayType}-${row.colBandOrder ?? 1}`;
        columnsWithSlots.add(key);
      }
    }
    if (columnsWithSlots.size === 0) return false;
    const hasMixedTimes = columns.some((column) => column.columnHasMixedTimes);
    if (hasMixedTimes) return true;
    return columns.some((column) => {
      const key = `${column.dayType}-${column.colOrder}`;
      return columnsWithSlots.has(key) && !column.columnTimeLabel;
    });
  }, [columns, rows]);
  const rowKindById = useMemo(() => buildRowKindById(rows), [rows]);
  // `dragState` was previously {dragging, dragOverKey}. dragOverKey was
  // re-set on every dragover tick (many per second) but was never read from
  // the render tree — it only served as an idempotency key inside the
  // dragover/dragLeave handlers to avoid redundant setState calls. In
  // practice it was the biggest source of "drag lag": each mouse movement
  // triggered a full ScheduleGrid re-render for no visual change.
  //
  // Split into two: `dragging` keeps state-driven rendering, `dragOverKeyRef`
  // is a mutable box for the idempotency check that no longer re-renders.
  // The wrapper `setDragState` preserves the old call sites.
  const [dragging, setDragging] = useState<{
    rowId: string;
    dateISO: string;
    assignmentId: string;
    clinicianId: string;
  } | null>(null);
  const dragOverKeyRef = useRef<string | null>(null);
  // Back-compat shim: reassemble the old shape for downstream code that still
  // reads `dragState.dragging`. We don't expose dragOverKey in this reader
  // (it's write-only now) — callers that need to check it use the ref directly.
  const dragState = { dragging, dragOverKey: null as string | null };
  type DragStateUpdate =
    | {
        dragging: {
          rowId: string;
          dateISO: string;
          assignmentId: string;
          clinicianId: string;
        } | null;
        dragOverKey: string | null;
      }
    | ((prev: {
        dragging: ReturnType<typeof getDragging>;
        dragOverKey: string | null;
      }) => {
        dragging: ReturnType<typeof getDragging>;
        dragOverKey: string | null;
      });
  const getDragging = () => dragging;
  const setDragState = (update: DragStateUpdate) => {
    const prevShape = {
      dragging,
      dragOverKey: dragOverKeyRef.current,
    };
    const next = typeof update === "function" ? update(prevShape) : update;
    // Dragging is rendered — fire setState only when it actually changes.
    const draggingChanged =
      next.dragging?.assignmentId !== prevShape.dragging?.assignmentId ||
      next.dragging?.rowId !== prevShape.dragging?.rowId ||
      next.dragging?.dateISO !== prevShape.dragging?.dateISO ||
      next.dragging?.clinicianId !== prevShape.dragging?.clinicianId;
    if (draggingChanged) {
      setDragging(next.dragging);
    }
    // dragOverKey is silent — just mutate the ref, no re-render.
    dragOverKeyRef.current = next.dragOverKey;
  };
  const [hoveredClassCell, setHoveredClassCell] = useState<{
    rowId: string;
    dateISO: string;
  } | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const hoveredClassCellRef = useRef<{ rowId: string; dateISO: string } | null>(
    null,
  );
  const [pickerState, setPickerState] = useState<{
    open: boolean;
    rowId: string;
    dateISO: string;
    anchorRect: DOMRect | null;
    rowName: string;
  }>({ open: false, rowId: "", dateISO: "", anchorRect: null, rowName: "" });
  const todayISO = toISODate(new Date());
  const isSingleDay = uniqueDayCount === 1;
  const dayColumnMin = isSingleDay ? 140 : 120;
  const leftColumn = isSingleDay ? "minmax(96px, 140px)" : "max-content";
  const shiftIntervalsByRowId = useMemo(() => buildShiftIntervalsByRowId(rows), [rows]);
  const { assignedIntervalsByDate, unknownIntervalsByDate } = useMemo(
    () => buildDateIntervalIndex(assignmentMap, rowKindById, shiftIntervalsByRowId),
    [assignmentMap, rowKindById, shiftIntervalsByRowId],
  );
  const setHoveredCell = (next: { rowId: string; dateISO: string } | null) => {
    hoveredClassCellRef.current = next;
    setHoveredClassCell(next);
  };

  const clearHoveredCell = () => {
    if (readOnly) return;
    if (!hoveredClassCellRef.current) return;
    hoveredClassCellRef.current = null;
    setHoveredClassCell(null);
  };

  const getClinicianOptionsForSlot = (rowId: string, dateISO: string): ClinicianOption[] =>
    buildClinicianOptionsForSlot({
      rowId,
      dateISO,
      rows,
      assignmentMap,
      clinicians,
      enforceSameLocationPerDay,
      shiftIntervalsByRowId,
      assignedIntervalsByDate,
      unknownIntervalsByDate,
      getIsOnRestDay,
      getHasTimeConflict,
    });

  const handleEmptySlotClick = (
    event: ReactMouseEvent<HTMLElement>,
    rowId: string,
    dateISO: string,
    rowName: string,
  ) => {
    if (readOnly || !onAddAssignment) return;
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setPickerState({
      open: true,
      rowId,
      dateISO,
      anchorRect: rect,
      rowName,
    });
  };

  const handleMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (readOnly) return;
    if (dragState.dragging) {
      clearHoveredCell();
      return;
    }
    const target = event.target as HTMLElement | null;
    const cell = target?.closest<HTMLElement>('[data-schedule-cell="true"]');
    if (!cell || cell.dataset.rowKind !== "class") {
      clearHoveredCell();
      return;
    }
    const rowId = cell.dataset.rowId;
    const dateISO = cell.dataset.dateIso;
    if (!rowId || !dateISO) {
      clearHoveredCell();
      return;
    }
    const prev = hoveredClassCellRef.current;
    if (prev && prev.rowId === rowId && prev.dateISO === dateISO) return;
    setHoveredCell({ rowId, dateISO });
  };

  useEffect(() => {
    if (!dragState.dragging) return;
    const handleWindowDragOver = (event: DragEvent) => {
      const target = event.target as HTMLElement | null;
      const inGrid = target?.closest?.('[data-schedule-grid="true"]');
      if (inGrid) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
    };
    const handleWindowDrop = (event: DragEvent) => {
      const target = event.target as HTMLElement | null;
      const inGrid = target?.closest?.('[data-schedule-grid="true"]');
      if (inGrid) return;
      event.preventDefault();
      // Remove assignment when dropped outside grid
      if (dragState.dragging && onRemoveAssignment) {
        const { rowId, dateISO, assignmentId, clinicianId } = dragState.dragging;
        onRemoveAssignment({ rowId, dateISO, assignmentId, clinicianId });
      }
      setDragState({ dragging: null, dragOverKey: null });
    };
    window.addEventListener("dragover", handleWindowDragOver);
    window.addEventListener("drop", handleWindowDrop);
    return () => {
      window.removeEventListener("dragover", handleWindowDragOver);
      window.removeEventListener("drop", handleWindowDrop);
    };
  }, [dragState.dragging, onRemoveAssignment]);

  const pickerClinicians = pickerState.open
    ? getClinicianOptionsForSlot(pickerState.rowId, pickerState.dateISO)
    : [];
  const pickerDateLabel = pickerState.dateISO
    ? (() => {
        const date = new Date(`${pickerState.dateISO}T00:00:00`);
        const { weekday, dayOfMonth } = formatDayHeader(date);
        return `${weekday} ${dayOfMonth}`;
      })()
    : "";

  return (
    <div className="schedule-grid mx-auto w-full max-w-7xl px-4 pb-8 sm:px-6 sm:pb-10 print:max-w-none print:px-0 print:pb-0">
      <div
        data-schedule-shell="true"
        className="relative mt-4 rounded-2xl border-2 border-slate-900/80 bg-white p-[2px] shadow-sm dark:border-slate-700 dark:bg-slate-900 sm:mt-6 sm:rounded-3xl"
      >
        <div className="relative rounded-[calc(1.5rem-2px)] bg-white dark:bg-slate-900 overflow-hidden">
          {header ? (
            <div className="relative z-20 rounded-t-[calc(1.5rem-2px)] bg-white px-4 py-3 dark:bg-slate-900 sm:px-6 sm:py-4">
              {header}
            </div>
          ) : null}
          <div className="relative overflow-hidden rounded-b-[calc(1.5rem-2px)]">
            <div
              className="calendar-scroll relative z-10 h-auto max-h-none overflow-x-auto overflow-y-hidden touch-pan-x [-webkit-overflow-scrolling:touch]"
            >
              <div className="min-w-full w-full">
                <div
                  ref={gridRef}
                  data-schedule-grid="true"
                  className="relative grid"
                  onMouseMove={readOnly ? undefined : handleMouseMove}
                  onMouseLeave={readOnly ? undefined : clearHoveredCell}
                  onDragOver={
                    readOnly
                      ? undefined
                      : (e) => {
                          if (!dragState.dragging) return;
                          // Allow drop on grid areas not covered by cells
                          const target = e.target as HTMLElement | null;
                          const isCell = target?.closest?.('[data-schedule-cell="true"]');
                          if (isCell) return;
                          e.preventDefault();
                          if (e.dataTransfer) {
                            e.dataTransfer.dropEffect = "move";
                          }
                        }
                  }
                  onDrop={
                    readOnly
                      ? undefined
                      : (e) => {
                          // Handle drop on grid areas not covered by cells (remove assignment)
                          const target = e.target as HTMLElement | null;
                          const isCell = target?.closest?.('[data-schedule-cell="true"]');
                          if (isCell) return;
                          e.preventDefault();
                          const raw = e.dataTransfer.getData("application/x-schedule-cell");
                          if (!raw) {
                            setDragState({ dragging: null, dragOverKey: null });
                            return;
                          }
                          try {
                            const payload = JSON.parse(raw) as {
                              rowId: string;
                              dateISO: string;
                              assignmentId: string;
                              clinicianId: string;
                            };
                            if (
                              onRemoveAssignment &&
                              payload?.rowId &&
                              payload.dateISO &&
                              payload.assignmentId &&
                              payload.clinicianId
                            ) {
                              onRemoveAssignment({
                                rowId: payload.rowId,
                                dateISO: payload.dateISO,
                                assignmentId: payload.assignmentId,
                                clinicianId: payload.clinicianId,
                              });
                            }
                          } catch {
                            // Malformed drag payload (e.g. cross-tab drop) — drop it silently,
                            // the finally block will still reset drag state.
                          } finally {
                            setDragState({ dragging: null, dragOverKey: null });
                          }
                        }
                  }
                  style={{
                    gridTemplateColumns: `${leftColumn} repeat(${Math.max(
                      columns.length,
                      1,
                    )}, minmax(${dayColumnMin}px, 1fr))`,
                  }}
                >
                  <div className="sticky top-0 z-30 flex items-center border-b border-r-2 border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900 sm:px-4">
                    <div className="text-base font-semibold text-slate-900 dark:text-slate-100">
                      {leftHeaderTitle}
                    </div>
                  </div>

                {dayGroups.map((group, groupIndex) => {
                  const { dateISO } = group;
                  const { weekday, dayOfMonth } = formatDayHeader(group.date);
                  const isLastGroup = groupIndex === dayGroups.length - 1;
                  const holidayName = holidayNameByDate?.[dateISO];
                  const isHoliday =
                    Boolean(holidayName) || (holidayDates?.has(dateISO) ?? false);
                  const isWeekend =
                    group.date.getDay() === 0 || group.date.getDay() === 6;
                  const isToday = dateISO === todayISO;
                  const isOtherDay =
                    !!dragState.dragging && dragState.dragging.dateISO !== dateISO;
                  const isActiveDay =
                    !!dragState.dragging && dragState.dragging.dateISO === dateISO;
                  return (
                    <div
                      key={`day-${dateISO}`}
                      className={cx(
                        "sticky top-0 z-30 relative border-b border-r-2 border-slate-300 px-2 py-1 text-center overflow-visible dark:border-slate-700 sm:px-3",
                        isHoliday
                          ? "bg-[#F3E8FF] dark:bg-slate-800"
                          : isWeekend
                            ? "bg-[#F3F4F6] dark:bg-slate-800"
                            : "bg-slate-50 dark:bg-slate-900",
                        isActiveDay && "bg-sky-50",
                        isOtherDay && "bg-slate-200/70 text-slate-400 opacity-60",
                        isLastGroup
                          ? "border-r-0"
                          : "border-r-2 border-slate-300 dark:border-slate-700",
                      )}
                      style={{ gridColumn: `span ${group.columns.length}` }}
                    >
                      <div className="flex flex-col items-center justify-center gap-0.5">
                        <div className="flex items-center justify-center gap-1.5">
                          <div className="text-[11px] font-semibold tracking-wide text-slate-500 dark:text-slate-300">
                            {weekday}
                          </div>
                          <div className="text-[11px] font-normal tracking-wide text-slate-900 dark:text-slate-100">
                            {isToday ? (
                              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100">
                                {dayOfMonth}
                              </span>
                            ) : (
                              dayOfMonth
                            )}
                          </div>
                        </div>
                        {holidayName ? (
                          <div className="max-w-[12ch] truncate text-[8px] font-normal leading-tight text-purple-700 dark:text-purple-200">
                            {holidayName}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}

                {rows.map((row, index) => {
                  const showSeparator = separatorBeforeRowIds.includes(row.id);
                  const showLocationSeparator =
                    locationSeparatorRowIds.includes(row.id);
                  const nextRow = rows[index + 1];
                  const nextRowId = nextRow?.id;
                  const suppressBottomBorder =
                    !!nextRowId && separatorBeforeRowIds.includes(nextRowId);
                  const isSubShiftContinuation = false;
                  const hasNextSubShift = false;
                  return (
                    <Fragment key={row.id}>
                      {showLocationSeparator ? (
                        <LocationSeparatorRow
                          columns={columns}
                          locationId={row.locationId}
                          locationColumnTimeMetaByKey={locationColumnTimeMetaByKey}
                          holidayDates={holidayDates}
                          holidayNameByDate={holidayNameByDate}
                        />
                      ) : null}
                      {showSeparator ? <SeparatorRow /> : null}
                      <RowSection
                        row={row}
                        dayColumns={columns}
                        assignmentMap={assignmentMap}
                        getClinicianName={getClinicianName}
                        getIsQualified={getIsQualified}
                        getHasEligibleClasses={getHasEligibleClasses}
                        onCellClick={onCellClick}
                        onClinicianClick={onClinicianClick}
                        enableSlotOverrides={enableSlotOverrides}
                        onMoveWithinDay={onMoveWithinDay}
                        onRemoveAssignment={onRemoveAssignment}
                        dragState={dragState}
                        setDragState={setDragState}
                        hoveredClassCell={hoveredClassCell}
                        setHoveredCell={setHoveredCell}
                        suppressBottomBorder={suppressBottomBorder}
                        isSubShiftContinuation={isSubShiftContinuation}
                        hasNextSubShift={hasNextSubShift}
                        minSlotsByRowId={minSlotsByRowId}
                        slotOverridesByKey={slotOverridesByKey}
                        onRemoveEmptySlot={onRemoveEmptySlot}
                        showBlockTimes={showBlockTimes}
                        readOnly={readOnly}
                        shiftIntervalsByRowId={shiftIntervalsByRowId}
                        assignedIntervalsByDate={assignedIntervalsByDate}
                        unknownIntervalsByDate={unknownIntervalsByDate}
                        violatingAssignmentKeys={violatingAssignmentKeys}
                        highlightedAssignmentKeys={highlightedAssignmentKeys}
                        highlightedSplitShiftKeys={highlightedSplitShiftKeys}
                        highlightOpenSlots={highlightOpenSlots}
                        rowKindById={rowKindById}
                        onEmptySlotClick={onAddAssignment ? handleEmptySlotClick : undefined}
                      />
                    </Fragment>
                  );
                })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <ClinicianPickerPopover
        open={pickerState.open}
        anchorRect={pickerState.anchorRect}
        rowName={pickerState.rowName}
        dateLabel={pickerDateLabel}
        clinicians={pickerClinicians}
        onClose={() =>
          setPickerState((prev) => ({ ...prev, open: false, anchorRect: null }))
        }
        onSelect={(clinicianId) => {
          if (!onAddAssignment) return;
          onAddAssignment({
            rowId: pickerState.rowId,
            dateISO: pickerState.dateISO,
            clinicianId,
          });
          setPickerState((prev) => ({ ...prev, open: false, anchorRect: null }));
        }}
      />
    </div>
  );
}

function RowSection({
  row,
  dayColumns,
  assignmentMap,
  getClinicianName,
  getIsQualified,
  getHasEligibleClasses,
  onCellClick,
  onClinicianClick,
  enableSlotOverrides,
  onMoveWithinDay,
  onRemoveAssignment,
  dragState,
  setDragState,
  hoveredClassCell,
  setHoveredCell,
  suppressBottomBorder,
  minSlotsByRowId,
  slotOverridesByKey,
  onRemoveEmptySlot,
  isSubShiftContinuation,
  hasNextSubShift,
  showBlockTimes,
  readOnly = false,
  shiftIntervalsByRowId,
  assignedIntervalsByDate,
  unknownIntervalsByDate,
  violatingAssignmentKeys,
  highlightedAssignmentKeys,
  highlightedSplitShiftKeys,
  highlightOpenSlots,
  rowKindById,
  onEmptySlotClick,
}: {
  row: ScheduleRow;
  dayColumns: {
    date: Date;
    dateISO: string;
    dayType: DayType;
    colOrder: number;
    isFirstInDay: boolean;
    dayIndex: number;
    columnIndex: number;
    columnTimeLabel?: string;
    columnHasMixedTimes?: boolean;
  }[];
  assignmentMap: Map<string, RenderedAssignment[]>;
  getClinicianName: (clinicianId: string) => string;
  getIsQualified: (clinicianId: string, rowId: string) => boolean;
  getHasEligibleClasses: (clinicianId: string) => boolean;
  onCellClick: (args: { row: ScheduleRow; date: Date }) => void;
  onClinicianClick?: (clinicianId: string) => void;
  enableSlotOverrides: boolean;
  onMoveWithinDay: (args: {
    dateISO: string;
    fromRowId: string;
    toRowId: string;
    assignmentId: string;
    clinicianId: string;
  }) => void;
  onRemoveAssignment?: (args: {
    rowId: string;
    dateISO: string;
    assignmentId: string;
    clinicianId: string;
  }) => void;
  dragState: {
    dragging: {
      rowId: string;
      dateISO: string;
      assignmentId: string;
      clinicianId: string;
    } | null;
    dragOverKey: string | null;
  };
  setDragState: Dispatch<
    SetStateAction<{
      dragging: {
        rowId: string;
        dateISO: string;
        assignmentId: string;
        clinicianId: string;
      } | null;
      dragOverKey: string | null;
    }>
  >;
  hoveredClassCell: { rowId: string; dateISO: string } | null;
  setHoveredCell: (next: { rowId: string; dateISO: string } | null) => void;
  suppressBottomBorder: boolean;
  minSlotsByRowId?: Record<string, { weekday: number; weekend: number }>;
  slotOverridesByKey: Record<string, number>;
  onRemoveEmptySlot?: (args: { rowId: string; dateISO: string }) => void;
  isSubShiftContinuation: boolean;
  hasNextSubShift: boolean;
  showBlockTimes: boolean;
  readOnly?: boolean;
  shiftIntervalsByRowId: Map<string, TimeRange>;
  assignedIntervalsByDate: Map<string, Map<string, TimeRange[]>>;
  unknownIntervalsByDate: Map<string, Set<string>>;
  violatingAssignmentKeys?: Set<string>;
  highlightedAssignmentKeys?: Set<string>;
  highlightedSplitShiftKeys?: Set<string>;
  highlightOpenSlots?: boolean;
  rowKindById: Map<string, "class" | "pool">;
  onEmptySlotClick?: (
    event: ReactMouseEvent<HTMLElement>,
    rowId: string,
    dateISO: string,
    rowName: string,
  ) => void;
}) {
  const rowBg =
    row.id === "pool-vacation"
      ? "bg-slate-200/80 dark:bg-slate-800/80"
      : row.id === "pool-rest-day"
        ? "bg-slate-50/70 dark:bg-slate-900/70"
        : "bg-white dark:bg-slate-900";
  const isRestDayPoolRow = row.id === "pool-rest-day";
  const hideBottomBorder = row.kind === "class" && hasNextSubShift;
  const borderBottomClass =
    suppressBottomBorder || hideBottomBorder
          ? "border-b-0"
          : row.id === "pool-vacation"
            ? "border-b-0"
            : "border-b border-slate-200 dark:border-slate-800";
  const subShiftSeparatorClass = isSubShiftContinuation
    ? "border-t border-slate-200 dark:border-slate-700"
    : "";
  const subShiftSeparatorStyle = isSubShiftContinuation
    ? { borderTopStyle: "dashed" as const }
    : undefined;
  const applyDragImage = (
    source: HTMLElement,
    event: ReactMouseEvent<HTMLElement> | DragEvent,
  ) => {
    // Kept lightweight: this runs on the critical path of every dragstart.
    // Instead of 30+ classList mutations we just tag the clone with a
    // data attribute — the "drag preview" styling lives in index.css
    // (see [data-pill-drag-preview="true"]). setDragImage reads the clone
    // synchronously, so the cleanup can happen on the next tick.
    const dragRoot =
      source.closest<HTMLElement>('[data-assignment-pill="true"]') ?? source;
    const clone = dragRoot.cloneNode(true) as HTMLElement;
    clone.setAttribute("data-pill-drag-preview", "true");
    clone.style.position = "absolute";
    clone.style.top = "-9999px";
    clone.style.left = "-9999px";
    clone.style.pointerEvents = "none";
    clone.style.width = `${dragRoot.offsetWidth}px`;
    clone.style.height = `${dragRoot.offsetHeight}px`;
    document.body.appendChild(clone);
    const dragEvent = event as DragEvent;
    dragEvent.dataTransfer?.setDragImage(
      clone,
      dragRoot.offsetWidth / 2,
      dragRoot.offsetHeight / 2,
    );
    window.setTimeout(() => clone.remove(), 0);
  };
  const dayGroups = useMemo(() => {
    const groups: Array<{
      date: Date;
      dateISO: string;
      dayType: DayType;
      columns: typeof dayColumns;
    }> = [];
    const byDate = new Map<
      string,
      { date: Date; dateISO: string; dayType: DayType; columns: typeof dayColumns }
    >();
    for (const column of dayColumns) {
      const existing = byDate.get(column.dateISO);
      if (existing) {
        existing.columns.push(column);
        continue;
      }
      const next = {
        date: column.date,
        dateISO: column.dateISO,
        dayType: column.dayType,
        columns: [column],
      };
      byDate.set(column.dateISO, next);
      groups.push(next);
    }
    return groups;
  }, [dayColumns]);
  const canDropAssignment = (
    payload: {
      rowId: string;
      assignmentId: string;
      clinicianId: string;
      dateISO: string;
    },
    targetRowId: string,
    targetDateISO: string,
  ) =>
    canDropAssignmentPure(payload, targetRowId, targetDateISO, {
      rowKindById,
      shiftIntervalsByRowId,
      assignedIntervalsByDate,
      unknownIntervalsByDate,
    });
  return (
    <>
      <div
        className={cx(
          "row border-r-2 border-slate-300 py-1 dark:border-slate-700 sm:py-1",
          borderBottomClass,
          subShiftSeparatorClass,
          rowBg,
        )}
        style={subShiftSeparatorStyle}
      >
        <RowLabel row={row} />
      </div>
      {row.kind === "pool"
        ? dayGroups.map((group, groupIndex) => {
            const { dateISO } = group;
            const isLastGroup = groupIndex === dayGroups.length - 1;
            const isDayDivider = !isLastGroup;
            const cellKey = `${row.id}__${dateISO}__pool`;
            const assignments = assignmentMap.get(`${row.id}__${dateISO}`) ?? [];
            const sortedAssignments =
              assignments.length > 1
                ? [...assignments].sort((a, b) => {
                    const nameA = getClinicianName(a.clinicianId);
                    const nameB = getClinicianName(b.clinicianId);
                    const surnameA =
                      nameA.trim().split(/\s+/).slice(-1)[0] ?? nameA;
                    const surnameB =
                      nameB.trim().split(/\s+/).slice(-1)[0] ?? nameB;
                    const bySurname = surnameA.localeCompare(surnameB);
                    return bySurname !== 0 ? bySurname : nameA.localeCompare(nameB);
                  })
                : assignments;
            const isOtherDay =
              !!dragState.dragging && dragState.dragging.dateISO !== dateISO;
            const isActiveDay =
              !!dragState.dragging && dragState.dragging.dateISO === dateISO;
            const cellBgClass = isOtherDay
              ? "bg-slate-200/70 text-slate-400 opacity-60"
              : rowBg;

            return (
              // Rendered as a <div> rather than a <button>. In Safari a
              // <button> ancestor captures the pointer gesture before its
              // descendants, so the inner draggable pill never receives
              // dragstart. Chrome routes correctly through the inner
              // element either way. This cell has no onClick (it's a
              // drop-target only), so no role/tabIndex is needed.
              <div
                key={cellKey}
                onDragOver={
                  readOnly
                    ? undefined
                    : (e) => {
                        if (!dragState.dragging) return;
                        e.preventDefault();
                        if (dragState.dragging.dateISO !== dateISO) {
                          setDragState((s) =>
                            s.dragOverKey ? { ...s, dragOverKey: null } : s,
                          );
                          return;
                        }
                        if (!canDropAssignment(dragState.dragging, row.id, dateISO)) {
                          e.dataTransfer.dropEffect = "move";
                          setDragState((s) =>
                            s.dragOverKey ? { ...s, dragOverKey: null } : s,
                          );
                          return;
                        }
                        e.dataTransfer.dropEffect = "move";
                        setDragState((s) =>
                          s.dragOverKey === cellKey
                            ? s
                            : { ...s, dragOverKey: cellKey },
                        );
                      }
                }
                onDragLeave={
                  readOnly
                    ? undefined
                    : () => {
                        setDragState((s) =>
                          s.dragOverKey === cellKey
                            ? { ...s, dragOverKey: null }
                            : s,
                        );
                      }
                }
                onDrop={
                  readOnly
                    ? undefined
                    : (e) => {
                        e.preventDefault();
                        const raw = e.dataTransfer.getData(
                          "application/x-schedule-cell",
                        );
                        if (!raw) return;
                        try {
                          const payload = JSON.parse(raw) as {
                            rowId: string;
                            dateISO: string;
                            assignmentId: string;
                            clinicianId: string;
                          };
                          if (payload.dateISO !== dateISO) {
                            if (onRemoveAssignment) {
                              onRemoveAssignment({
                                rowId: payload.rowId,
                                dateISO: payload.dateISO,
                                assignmentId: payload.assignmentId,
                                clinicianId: payload.clinicianId,
                              });
                            }
                            return;
                          }
                          if (payload.rowId === row.id) return;
                          if (!canDropAssignment(payload, row.id, dateISO)) {
                            if (onRemoveAssignment) {
                              onRemoveAssignment({
                                rowId: payload.rowId,
                                dateISO: payload.dateISO,
                                assignmentId: payload.assignmentId,
                                clinicianId: payload.clinicianId,
                              });
                            }
                            return;
                          }
                          onMoveWithinDay({
                            dateISO,
                            fromRowId: payload.rowId,
                            toRowId: row.id,
                            assignmentId: payload.assignmentId,
                            clinicianId: payload.clinicianId,
                          });
                        } finally {
                          setDragState({ dragging: null, dragOverKey: null });
                        }
                      }
                }
                data-schedule-cell="true"
                data-row-id={row.id}
                data-row-kind={row.kind}
                data-date-iso={dateISO}
                className={cx(
                  "row group relative border-r border-slate-200 p-0.5 text-left dark:border-slate-800 sm:p-1",
                  borderBottomClass,
                  subShiftSeparatorClass,
                  cellBgClass,
                  isDayDivider && "border-r-2 border-slate-300 dark:border-slate-700",
                  { "border-r-0": !isDayDivider },
                )}
                style={{
                  ...subShiftSeparatorStyle,
                  borderRightStyle: "solid",
                  gridColumn: `span ${group.columns.length}`,
                }}
              >
                {sortedAssignments.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    {(() => {
                      // Compute sibling names for uniqueness check
                      const siblingNames = sortedAssignments.map((a) =>
                        getClinicianName(a.clinicianId),
                      );
                      return sortedAssignments.map((assignment) => {
                        const isDraggingAssignment =
                          dragState.dragging?.assignmentId === assignment.id &&
                          dragState.dragging?.rowId === row.id &&
                          dragState.dragging?.dateISO === dateISO;
                        const isDragFocus =
                          !!dragState.dragging &&
                          dragState.dragging.dateISO === dateISO &&
                          dragState.dragging.clinicianId === assignment.clinicianId;
                        const violationKey = `${assignment.rowId}__${assignment.dateISO}__${assignment.clinicianId}`;
                        return (
                          <AssignmentPill
                            key={assignment.id}
                            name={getClinicianName(assignment.clinicianId)}
                            siblingNames={siblingNames}
                            assignmentKey={violationKey}
                            showNoEligibilityWarning={
                              !getHasEligibleClasses(assignment.clinicianId)
                            }
                            isManual={row.kind === "class" && assignment.source !== "solver"}
                            isViolation={violatingAssignmentKeys?.has(violationKey)}
                            isDragging={isDraggingAssignment}
                            isDragFocus={isDragFocus || isDraggingAssignment}
                            draggable={!readOnly}
                            onClick={
                              readOnly || !onClinicianClick
                                ? undefined
                                : (e) => {
                                    e.stopPropagation();
                                    onClinicianClick(assignment.clinicianId);
                                  }
                            }
                            onDragStart={
                              readOnly
                                ? undefined
                                : (e) => {
                                    e.stopPropagation();
                                    e.dataTransfer.effectAllowed = "move";
                                    applyDragImage(e.currentTarget, e);
                                    e.dataTransfer.setData(
                                      "application/x-schedule-cell",
                                      JSON.stringify({
                                        rowId: row.id,
                                        dateISO,
                                        assignmentId: assignment.id,
                                        clinicianId: assignment.clinicianId,
                                      }),
                                    );
                                    setDragState({
                                      dragging: {
                                        rowId: row.id,
                                        dateISO,
                                        assignmentId: assignment.id,
                                        clinicianId: assignment.clinicianId,
                                      },
                                      dragOverKey: null,
                                    });
                                  }
                            }
                            onDragEnd={
                              readOnly
                                ? undefined
                                : () =>
                                    setDragState({ dragging: null, dragOverKey: null })
                            }
                            className={cx(
                              !readOnly && "cursor-grab active:cursor-grabbing",
                              isDraggingAssignment && "opacity-0",
                            )}
                          />
                        );
                      });
                    })()}
                  </div>
                ) : null}
              </div>
            );
          })
        : dayColumns.map((column, index) => {
        const { dateISO, dayType, colOrder } = column;
        const isLastCol = index === dayColumns.length - 1;
        const nextColumn = dayColumns[index + 1];
        const isDayDivider =
          !isLastCol && nextColumn?.dateISO !== column.dateISO;
        const cellKey = `${row.id}__${dateISO}__${colOrder}__${index}`;
        const isHoliday = dayType === "holiday";
        const isWeekend =
          isHoliday || dayType === "sat" || dayType === "sun";
        const isHoverDate = hoveredClassCell?.dateISO === dateISO;
        const slotRow =
          row.kind === "class" && row.slotRows?.length
            ? row.slotRows.find(
                (slot) =>
                  slot.dayType === dayType && slot.colBandOrder === colOrder,
              )
            : row;
        const activeRow = slotRow ?? row;
        const resolvedMinSlots =
          minSlotsByRowId?.[activeRow.id] ??
          minSlotsByRowId?.[row.id] ?? { weekday: 0, weekend: 0 };
        const baseRequired =
          typeof activeRow.requiredSlots === "number"
            ? activeRow.requiredSlots
            : isWeekend
              ? resolvedMinSlots.weekend
              : resolvedMinSlots.weekday;
        const slotOverride =
          slotOverridesByKey[`${activeRow.id}__${dateISO}`] ?? 0;
        const isColumnMatch =
          row.kind !== "class"
            ? column.isFirstInDay
            : row.slotRows?.length
              ? !!slotRow
              : row.dayType
                ? row.dayType === dayType &&
                  (row.colBandOrder ?? 1) === colOrder
                : column.isFirstInDay;
        const isCellActive = isColumnMatch;
        const rowInterval = shiftIntervalsByRowId.get(activeRow.id) ?? null;
        const rowTimeLabel = rowInterval
          ? formatTimeRangeLabel(rowInterval.start, rowInterval.end)
          : undefined;
        const effectiveRowTimeLabel = showBlockTimes ? rowTimeLabel : undefined;
        const assignments = isCellActive
          ? assignmentMap.get(`${activeRow.id}__${dateISO}`) ?? []
          : [];
        const sortedAssignments =
          assignments.length > 1
            ? [...assignments].sort((a, b) => {
                const nameA = getClinicianName(a.clinicianId);
                const nameB = getClinicianName(b.clinicianId);
                const surnameA = nameA.trim().split(/\s+/).slice(-1)[0] ?? nameA;
                const surnameB = nameB.trim().split(/\s+/).slice(-1)[0] ?? nameB;
                const bySurname = surnameA.localeCompare(surnameB);
                return bySurname !== 0 ? bySurname : nameA.localeCompare(nameB);
              })
            : assignments;
        const targetSlots = isCellActive
          ? Math.max(0, baseRequired + slotOverride)
          : 0;
        const emptySlots =
          row.kind === "class" && isCellActive
            ? Math.max(0, targetSlots - assignments.length)
            : 0;
        const isOtherDay = !!dragState.dragging && dragState.dragging.dateISO !== dateISO;
        const isActiveDay = !!dragState.dragging && dragState.dragging.dateISO === dateISO;
        // The source cell (the one the pill is being dragged out of) would
        // otherwise fail canDropAssignment because its own interval overlaps
        // with itself. Dropping back on source is handled as a no-op by the
        // drop handler (ScheduleGrid.onDrop: `if (payload.rowId === row.id)
        // return;`), so treating the source cell as "qualified" for the
        // outline is visually consistent and functionally safe.
        const isSourceCell =
          !!dragState.dragging &&
          dragState.dragging.rowId === activeRow.id &&
          dragState.dragging.dateISO === dateISO;
        const showQualified =
          !readOnly &&
          !!dragState.dragging &&
          isActiveDay &&
          row.kind === "class" &&
          isCellActive &&
          getIsQualified(dragState.dragging.clinicianId, activeRow.id) &&
          (isSourceCell ||
            canDropAssignment(dragState.dragging, activeRow.id, dateISO));

        const isHoveredCell =
          hoveredClassCell?.rowId === activeRow.id &&
          hoveredClassCell?.dateISO === dateISO;
        const cellBgClass = isOtherDay
          ? "bg-slate-200/70 text-slate-400 opacity-60"
          : row.kind === "class" && !isCellActive
            ? "bg-white text-slate-300 dark:bg-slate-900 dark:text-slate-500"
          : isHoveredCell
            ? "bg-slate-50/70 dark:bg-slate-800/50"
              : row.kind === "class" && isWeekend
                ? "bg-white dark:bg-slate-900"
                : rowBg;

        return (
          // Same Safari drag-routing fix as the grouped-view cell above —
          // rendered as div role="button" so the inner pill can own the
          // drag gesture. This cell IS interactive (onClick), so keep
          // role + tabIndex + onKeyDown for keyboard a11y parity with
          // the previous <button>.
          <div
            key={cellKey}
            role="button"
            tabIndex={readOnly ? -1 : 0}
            onClick={(e) => {
              if (readOnly) return;
              const target = e.target as HTMLElement;
              if (target.closest('[data-assignment-pill="true"]')) return;
              if (row.kind === "class" && isCellActive && onEmptySlotClick) {
                onEmptySlotClick(e, activeRow.id, dateISO, activeRow.name);
                return;
              }
              if (
                enableSlotOverrides &&
                !(row.kind === "class" && !isCellActive)
              ) {
                onCellClick({ row: activeRow, date: column.date });
              }
            }}
            onKeyDown={(e) => {
              if (readOnly) return;
              // Only act on Enter / Space, like a native button.
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              (e.currentTarget as HTMLElement).click();
            }}
            onDragOver={
              readOnly
                ? undefined
                : (e) => {
                    if (!dragState.dragging) return;
                    e.preventDefault();
                    if (dragState.dragging.dateISO !== dateISO) {
                      setDragState((s) =>
                        s.dragOverKey ? { ...s, dragOverKey: null } : s,
                      );
                      return;
                    }
                    if (!canDropAssignment(dragState.dragging, activeRow.id, dateISO)) {
                      e.dataTransfer.dropEffect = "move";
                      setDragState((s) =>
                        s.dragOverKey ? { ...s, dragOverKey: null } : s,
                      );
                      return;
                    }
                    if (row.kind === "class" && !isCellActive) {
                      e.dataTransfer.dropEffect = "move";
                      setDragState((s) =>
                        s.dragOverKey ? { ...s, dragOverKey: null } : s,
                      );
                      return;
                    }
                    e.dataTransfer.dropEffect = "move";
                    setDragState((s) =>
                      s.dragOverKey === cellKey
                        ? s
                        : { ...s, dragOverKey: cellKey },
                    );
                  }
            }
            onDragLeave={
              readOnly
                ? undefined
                : () => {
                  setDragState((s) =>
                    s.dragOverKey === cellKey ? { ...s, dragOverKey: null } : s,
                  );
                }
            }
            onDrop={
              readOnly
                ? undefined
                : (e) => {
                    e.preventDefault();
                    const raw = e.dataTransfer.getData("application/x-schedule-cell");
                      if (!raw) return;
                      try {
                        const payload = JSON.parse(raw) as {
                          rowId: string;
                          dateISO: string;
                          assignmentId: string;
                          clinicianId: string;
                        };
                      if (payload.dateISO !== dateISO) {
                        if (onRemoveAssignment) {
                          onRemoveAssignment({
                            rowId: payload.rowId,
                            dateISO: payload.dateISO,
                            assignmentId: payload.assignmentId,
                            clinicianId: payload.clinicianId,
                          });
                        }
                        setDragState({ dragging: null, dragOverKey: null });
                        return;
                      }
                      if (payload.rowId === activeRow.id) {
                        setDragState({ dragging: null, dragOverKey: null });
                        return;
                      }
                      // Check for inactive cell first - always remove when dropping on empty cell
                      if (row.kind === "class" && !isCellActive) {
                        if (onRemoveAssignment) {
                          onRemoveAssignment({
                            rowId: payload.rowId,
                            dateISO: payload.dateISO,
                            assignmentId: payload.assignmentId,
                            clinicianId: payload.clinicianId,
                          });
                        }
                        setDragState({ dragging: null, dragOverKey: null });
                        return;
                      }
                      if (!canDropAssignment(payload, activeRow.id, dateISO)) {
                        if (onRemoveAssignment) {
                          onRemoveAssignment({
                            rowId: payload.rowId,
                            dateISO: payload.dateISO,
                            assignmentId: payload.assignmentId,
                            clinicianId: payload.clinicianId,
                          });
                        }
                        setDragState({ dragging: null, dragOverKey: null });
                        return;
                      }
                      // This check is now redundant but kept for safety
                      if (row.kind === "class" && !isCellActive) {
                        if (onRemoveAssignment) {
                          onRemoveAssignment({
                            rowId: payload.rowId,
                            dateISO: payload.dateISO,
                            assignmentId: payload.assignmentId,
                            clinicianId: payload.clinicianId,
                          });
                        }
                        setDragState({ dragging: null, dragOverKey: null });
                        return;
                      }
                      onMoveWithinDay({
                        dateISO,
                        fromRowId: payload.rowId,
                        toRowId: activeRow.id,
                        assignmentId: payload.assignmentId,
                        clinicianId: payload.clinicianId,
                      });
                    } finally {
                      setDragState({ dragging: null, dragOverKey: null });
                    }
                  }
            }
            data-schedule-cell="true"
            data-row-id={activeRow.id}
            data-row-kind={row.kind}
            data-date-iso={dateISO}
            className={cx(
              "row group relative border-r border-slate-200 p-0.5 text-left dark:border-slate-800 sm:p-1",
              borderBottomClass,
              subShiftSeparatorClass,
              cellBgClass,
              isDayDivider &&
                "border-solid border-r-2 border-r-slate-300 dark:border-r-slate-700",
              { "border-r-0": isLastCol },
            )}
            style={{
              ...subShiftSeparatorStyle,
              borderRightStyle: isDayDivider ? "solid" : "dashed",
            }}
          >
            {(() => {
              const showSlotPanel = row.kind === "class" && isCellActive;
              const hasHighlightedViolation = false;
              const cellContent = (
                <>
                  {sortedAssignments.length > 0 ? (
                    (() => {
                      // Compute sibling names for uniqueness check
                      const siblingNames = sortedAssignments.map((a) =>
                        getClinicianName(a.clinicianId),
                      );
                      return sortedAssignments.map((assignment) => {
                        const isDraggingAssignment =
                          dragState.dragging?.assignmentId === assignment.id &&
                          dragState.dragging?.rowId === activeRow.id &&
                          dragState.dragging?.dateISO === dateISO;
                        const isDragFocus =
                          !!dragState.dragging &&
                          dragState.dragging.dateISO === dateISO &&
                          dragState.dragging.clinicianId === assignment.clinicianId;
                        const violationKey = `${assignment.rowId}__${assignment.dateISO}__${assignment.clinicianId}`;
                        return (
                          <AssignmentPill
                            key={assignment.id}
                            name={getClinicianName(assignment.clinicianId)}
                            siblingNames={siblingNames}
                            assignmentKey={violationKey}
                            showNoEligibilityWarning={
                              !getHasEligibleClasses(assignment.clinicianId)
                            }
                            showIneligibleWarning={
                              row.kind === "class" &&
                              !getIsQualified(assignment.clinicianId, activeRow.id)
                            }
                            isManual={row.kind === "class" && assignment.source !== "solver"}
                            isHighlighted={highlightedSplitShiftKeys?.has(violationKey)}
                            isViolation={highlightedAssignmentKeys?.has(violationKey)}
                            isDragging={isDraggingAssignment}
                            isDragFocus={isDragFocus || isDraggingAssignment}
                            draggable={!readOnly}
                            onDragStart={
                              readOnly
                                ? undefined
                                : (e) => {
                                    e.stopPropagation();
                                    setHoveredCell(null);
                                    e.dataTransfer.effectAllowed = "move";
                                    applyDragImage(e.currentTarget, e);
                                    e.dataTransfer.setData(
                                      "application/x-schedule-cell",
                                      JSON.stringify({
                                        rowId: activeRow.id,
                                        dateISO,
                                        assignmentId: assignment.id,
                                        clinicianId: assignment.clinicianId,
                                      }),
                                    );
                                    setDragState({
                                      dragging: {
                                        rowId: activeRow.id,
                                        dateISO,
                                        assignmentId: assignment.id,
                                        clinicianId: assignment.clinicianId,
                                      },
                                      dragOverKey: null,
                                    });
                                  }
                            }
                            onClick={
                              readOnly || !onClinicianClick
                                ? undefined
                                : (e) => {
                                    e.stopPropagation();
                                    onClinicianClick(assignment.clinicianId);
                                  }
                            }
                            onDragEnd={
                              readOnly
                                ? undefined
                                : () =>
                                    setDragState({ dragging: null, dragOverKey: null })
                            }
                            className={cx(
                              !readOnly && "cursor-grab active:cursor-grabbing",
                              isDraggingAssignment && "opacity-0",
                            )}
                          />
                        );
                      });
                    })()
                  ) : null}
                  {emptySlots > 0
                ? Array.from({ length: emptySlots }).map((_, idx) => (
                    <EmptySlotPill
                      key={`${cellKey}-empty-${idx}`}
                      highlighted={highlightOpenSlots}
                      onRemove={
                        !readOnly && onRemoveEmptySlot && row.kind === "class"
                          ? () =>
                              onRemoveEmptySlot({
                                rowId: activeRow.id,
                                dateISO,
                              })
                          : undefined
                      }
                    />
                  ))
                  : assignments.length === 0 && row.kind === "class" && isCellActive
                  ? !readOnly && enableSlotOverrides && (
                      <EmptySlotPill
                        key={`${cellKey}-empty-ghost`}
                        variant="ghost"
                        showAddIcon
                        highlighted={highlightOpenSlots}
                        className={cx(
                          "opacity-0",
                          hoveredClassCell?.rowId === activeRow.id &&
                            hoveredClassCell?.dateISO === dateISO &&
                            "opacity-100",
                          dragState.dragging && "opacity-0 pointer-events-none",
                        )}
                    />
                  )
                : null}
                </>
              );
              return showSlotPanel ? (
                <div
                  // Border width is kept constant at 2px across every state.
                  // Previously this was `border` (1px) by default and
                  // `border-2` (2px) when highlighted/qualified-drop-target,
                  // and that 1px delta shifted every row underneath whenever
                  // the user hovered a drop-eligible cell during a drag.
                  // Only the color/dash style changes now.
                  className={cx(
                    "h-full w-full min-h-[48px] rounded-lg border-2 bg-white/95 px-2 py-0.5 shadow-sm dark:bg-slate-950",
                    hasHighlightedViolation
                      ? "border-rose-500 dark:border-rose-400"
                      : showQualified
                        ? "border-slate-900 dark:border-slate-100"
                        : "border-slate-200 dark:border-slate-700",
                  )}
                  style={
                    activeRow.blockColor
                      ? { backgroundColor: activeRow.blockColor }
                      : undefined
                  }
                >
                  {(() => {
                    const textColors = getContrastTextColor(activeRow.blockColor);
                    return (
                      <div className={cx("flex flex-col gap-0.5 text-[10px] font-semibold", textColors.primary)}>
                        <span className="truncate">
                          {activeRow.sectionName ?? activeRow.name}
                        </span>
                        {effectiveRowTimeLabel ? (
                          <span className={cx("text-[10px] font-medium", textColors.secondary)}>
                            {effectiveRowTimeLabel}
                          </span>
                        ) : null}
                      </div>
                    );
                  })()}
                  <div className="mt-1 flex flex-col gap-1">{cellContent}</div>
                </div>
              ) : (
                <div className="flex flex-col gap-1">{cellContent}</div>
              );
            })()}
          </div>
        );
      })}
    </>
  );
}

function SeparatorRow() {
  return (
    <div
      className="row h-0 border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
      style={{ gridColumn: "1 / -1" }}
    />
  );
}

function LocationSeparatorRow({
  columns,
  locationId,
  locationColumnTimeMetaByKey,
  holidayDates,
  holidayNameByDate,
}: {
  columns: {
    date: Date;
    dateISO: string;
    dayType: string;
    colOrder: number;
    isFirstInDay: boolean;
    dayIndex: number;
    columnIndex: number;
    columnTimeLabel?: string;
    columnHasMixedTimes?: boolean;
  }[];
  locationId?: string;
  locationColumnTimeMetaByKey?: Map<string, { label?: string; mixed: boolean }>;
  holidayDates?: Set<string>;
  holidayNameByDate?: Record<string, string>;
}) {
  // Check if any column has a location-specific time label for this location
  const hasAnyTimeLabel =
    locationId &&
    locationColumnTimeMetaByKey &&
    columns.some((col) => {
      const key = `${locationId}__${col.dayType}-${col.colOrder}`;
      const meta = locationColumnTimeMetaByKey.get(key);
      return meta?.label && !meta.mixed;
    });

  // If no time labels to show, just render the simple separator line
  if (!hasAnyTimeLabel) {
    return (
      <div
        className="row h-0 border-t-2 border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900"
        style={{ gridColumn: "1 / -1" }}
      />
    );
  }

  // Render a row with time labels for each column
  return (
    <>
      {/* Left header cell - empty */}
      <div className="row border-t-2 border-r-2 border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900" />
      {/* Time label cells for each column */}
      {columns.map((column, index) => {
        const key = locationId
          ? `${locationId}__${column.dayType}-${column.colOrder}`
          : "";
        const meta = locationColumnTimeMetaByKey?.get(key);
        const timeLabel = meta?.label && !meta.mixed ? meta.label : "";
        const isLastCol = index === columns.length - 1;
        const nextColumn = columns[index + 1];
        const isDayDivider = !isLastCol && nextColumn?.dateISO !== column.dateISO;
        const holidayName = holidayNameByDate?.[column.dateISO];
        const isHoliday =
          Boolean(holidayName) || (holidayDates?.has(column.dateISO) ?? false);
        const isWeekend = column.date.getDay() === 0 || column.date.getDay() === 6;

        return (
          <div
            key={`loc-time-${column.dateISO}-${column.colOrder}-${index}`}
            className={cx(
              "row border-t-2 border-r-2 border-slate-300 px-1 py-0.5 text-center text-[8px] font-medium text-slate-700 dark:text-slate-200 dark:border-slate-700",
              isHoliday
                ? "bg-[#F3E8FF] dark:bg-slate-800"
                : isWeekend
                  ? "bg-[#F3F4F6] dark:bg-slate-800"
                  : "bg-slate-50 dark:bg-slate-900",
              { "border-r-0": isLastCol },
            )}
            style={{
              borderRightStyle: isDayDivider ? "solid" : "dashed",
            }}
          >
            {timeLabel}
          </div>
        );
      })}
    </>
  );
}
