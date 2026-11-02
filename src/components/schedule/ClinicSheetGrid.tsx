import { isProtectedAssignment, type AssignmentIdentity } from "../../lib/assignmentPolicy";
import AssignmentLockButton from "./AssignmentLockButton";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { DragEvent as ReactDragEvent, ReactNode } from "react";
import { cx } from "../../lib/classNames";
import {
  REST_DAY_POOL_ID,
  sortAssignmentsBySurname,
  VACATION_POOL_ID,
  type RenderedAssignment,
} from "../../lib/schedule";
import type { ScheduleRow } from "../../lib/shiftRows";
import { getLuminance } from "../../lib/shiftRows";
import {
  buildClinicianOptionsForSlot,
  buildDateIntervalIndex,
  buildRowKindById,
  buildShiftIntervalsByRowId,
  canDropAssignment,
  DRAG_MIME,
  readDragPayload,
  type DragPayload,
  type MoveRestDayArgs,
  type SlotOptionClinician,
} from "../../lib/clinicianSlotOptions";
import {
  EXCEL_CYAN,
  EXCEL_GRAY,
  SHEET_DAY_COLUMNS,
  type ClinicSheetArea,
  type ClinicSheetDay,
  type ClinicSheetModel,
  type ClinicSheetRow,
} from "../../lib/clinicSheet";
import { toISODate } from "../../lib/date";
import { nameLabelsOf, type PersonNameLabels } from "../../lib/personName";
import ClinicianPickerPopover from "./ClinicianPickerPopover";

// Faithful web rendering of the clinic's Excel Arbeitsplan: the whole month
// as horizontal day blocks (6 name columns each), Arial, plain-text names,
// gray weekday headers, cyan weekend/holiday blocks, and medium/hair borders.
// The sheet is intentionally paper-light in both themes — the Excel colors
// have no faithful dark equivalents and fidelity is the point of this layout.

const SHEET_FONT_FAMILY = '"Arial", "Helvetica Neue", Helvetica, sans-serif';
// Six name columns of 52px: an eight-letter surname fits one column.
// Names never widen it (inline-size containment, renderName).
const DAY_COLUMN_WIDTH = "minmax(312px, 1fr)";
const LABEL_COLUMN_WIDTH = "minmax(150px, 190px)";

const WEEKDAY_FORMAT = new Intl.DateTimeFormat("de-DE", { weekday: "long" });
const WEEKDAY_SHORT_FORMAT = new Intl.DateTimeFormat("de-DE", { weekday: "short" });

// The Excel sheet uses black text on its pink/gray/cyan fills. Only clearly
// dark backgrounds (e.g. the conference green) flip to white — a lower
// threshold than the app-wide getContrastTextColor, which would render the
// Excel pink with white text.
const sheetTextClass = (bgColor: string | undefined) => {
  if (!bgColor) return "text-slate-900";
  return getLuminance(bgColor) < 0.3 ? "text-white" : "text-slate-900";
};

// Names share their area's columns: fewer names than columns get equal,
// wider tracks, so an ordinary surname is not cut while columns next to it
// stay empty. A full area keeps one name per column and wraps the rest to
// extra lines, like the Excel sheet's continuation rows.
const nameTracks = (columns: number, items: number) =>
  `repeat(${Math.min(columns, Math.max(items, 1))}, minmax(0, 1fr))`;

const formatSheetDate = (date: Date) => {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${date.getFullYear()}`;
};

type ClinicSheetGridProps = {
  model: ClinicSheetModel;
  assignmentMap: Map<string, RenderedAssignment[]>;
  // Grouped calendar rows — the source the eligibility/interval indexes are
  // built from (same input the classic grid receives as `rows`).
  rows: ScheduleRow[];
  header?: ReactNode;
  readOnly?: boolean;
  getClinicianName: (clinicianId: string) => string;
  /**
   * Short names by clinician id (lib/personName buildNameLabels). The Excel
   * sheet lists people by surname; one shared by two people in the team gets
   * given-name letters ("J. Müller"), everywhere.
   */
  nameLabels?: Map<string, PersonNameLabels>;
  getIsQualified: (clinicianId: string, rowId: string) => boolean;
  clinicians?: SlotOptionClinician[];
  getIsOnRestDay?: (clinicianId: string, dateISO: string) => boolean;
  enforceSameLocationPerDay?: boolean;
  onAddAssignment?: (args: { rowId: string; dateISO: string; clinicianId: string }) => void;
  onToggleAssignmentLock?: (assignment: AssignmentIdentity) => void;
  onRemoveAssignment?: (args: {
    rowId: string;
    dateISO: string;
    assignmentId: string;
    clinicianId: string;
  }) => void;
  onMoveWithinDay?: (args: {
    dateISO: string;
    fromRowId: string;
    toRowId: string;
    assignmentId: string;
    clinicianId: string;
  }) => void;
  /** A Rest Day name dropped on the Rest Day row of another day (other drops on another day remove). */
  onMoveRestDay?: (args: MoveRestDayArgs) => void;
  onClinicianClick?: (clinicianId: string) => void;
};

export default function ClinicSheetGrid({
  model,
  assignmentMap,
  rows,
  header,
  readOnly = false,
  getClinicianName,
  nameLabels,
  getIsQualified,
  clinicians = [],
  getIsOnRestDay,
  enforceSameLocationPerDay = true,
  onAddAssignment,
  onRemoveAssignment,
  onToggleAssignmentLock,
  onMoveWithinDay,
  onMoveRestDay,
  onClinicianClick,
}: ClinicSheetGridProps) {
  const { days, sections, poolRows } = model;
  const todayISO = toISODate(new Date());

  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [pickerState, setPickerState] = useState<{
    open: boolean;
    rowId: string;
    dateISO: string;
    anchorRect: DOMRect | null;
    rowName: string;
  }>({ open: false, rowId: "", dateISO: "", anchorRect: null, rowName: "" });

  const rowKindById = useMemo(() => buildRowKindById(rows), [rows]);
  const shiftIntervalsByRowId = useMemo(() => buildShiftIntervalsByRowId(rows), [rows]);
  const { assignedIntervalsByDate, unknownIntervalsByDate } = useMemo(
    () => buildDateIntervalIndex(assignmentMap, rowKindById, shiftIntervalsByRowId),
    [assignmentMap, rowKindById, shiftIntervalsByRowId],
  );
  const dropIndex = useMemo(
    () => ({
      rowKindById,
      shiftIntervalsByRowId,
      assignedIntervalsByDate,
      unknownIntervalsByDate,
    }),
    [rowKindById, shiftIntervalsByRowId, assignedIntervalsByDate, unknownIntervalsByDate],
  );

  // Drop anywhere outside the sheet removes the dragged assignment — same
  // behavior as the classic grid.
  useEffect(() => {
    if (!dragging) return;
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
      if (dragging && onRemoveAssignment) {
        onRemoveAssignment(dragging);
      }
      setDragging(null);
    };
    window.addEventListener("dragover", handleWindowDragOver);
    window.addEventListener("drop", handleWindowDrop);
    return () => {
      window.removeEventListener("dragover", handleWindowDragOver);
      window.removeEventListener("drop", handleWindowDrop);
    };
  }, [dragging, onRemoveAssignment]);

  // Shared drop handling for slot areas and pool cells: a Rest Day name
  // dropped on the Rest Day row of another day moves there, other drops from
  // another day (or onto an incompatible slot) remove the assignment, drops
  // on the source cell are a no-op, valid same-day drops move. A Vacation
  // name stays on such drops: a vacation day ends only when its name leaves
  // the sheet.
  const handleCellDrop = (event: ReactDragEvent, targetRowId: string, dateISO: string) => {
    event.preventDefault();
    event.stopPropagation();
    const payload = readDragPayload(event.dataTransfer);
    setDragging(null);
    if (!payload) return;
    const removeOnMissedDrop = () => {
      if (payload.rowId !== VACATION_POOL_ID) onRemoveAssignment?.(payload);
    };
    if (payload.dateISO !== dateISO) {
      if (payload.rowId === REST_DAY_POOL_ID && targetRowId === REST_DAY_POOL_ID && onMoveRestDay) {
        onMoveRestDay({
          fromDateISO: payload.dateISO,
          toDateISO: dateISO,
          assignmentId: payload.assignmentId,
          clinicianId: payload.clinicianId,
        });
      } else {
        removeOnMissedDrop();
      }
      return;
    }
    if (payload.rowId === targetRowId) return;
    if (!canDropAssignment(payload, targetRowId, dateISO, dropIndex)) {
      removeOnMissedDrop();
      return;
    }
    onMoveWithinDay?.({
      dateISO,
      fromRowId: payload.rowId,
      toRowId: targetRowId,
      assignmentId: payload.assignmentId,
      clinicianId: payload.clinicianId,
    });
  };

  const handleCellDragOver = (event: ReactDragEvent) => {
    if (!dragging) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const startDrag = (
    event: ReactDragEvent,
    payload: DragPayload,
  ) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
    setDragging(payload);
  };

  const openPicker = (
    event: React.MouseEvent<HTMLElement>,
    rowId: string,
    dateISO: string,
    rowName: string,
  ) => {
    if (readOnly || !onAddAssignment) return;
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setPickerState({ open: true, rowId, dateISO, anchorRect: rect, rowName });
  };

  const pickerClinicians = pickerState.open
    ? buildClinicianOptionsForSlot({
        rowId: pickerState.rowId,
        dateISO: pickerState.dateISO,
        rows,
        assignmentMap,
        clinicians,
        enforceSameLocationPerDay,
        shiftIntervalsByRowId,
        assignedIntervalsByDate,
        unknownIntervalsByDate,
        getIsOnRestDay,
      })
    : [];
  const pickerDateLabel = pickerState.dateISO
    ? (() => {
        const date = new Date(`${pickerState.dateISO}T00:00:00`);
        return `${WEEKDAY_SHORT_FORMAT.format(date)} ${formatSheetDate(date)}`;
      })()
    : "";

  const renderName = (
    assignment: RenderedAssignment,
    slotRowId: string,
    dateISO: string,
    textClass: string,
    isPoolCell: boolean,
  ) => {
    const name = getClinicianName(assignment.clinicianId);
    const surname = nameLabels?.get(assignment.clinicianId)?.surname ?? nameLabelsOf(name).surname;
    const isUnqualified =
      !isPoolCell && !getIsQualified(assignment.clinicianId, slotRowId);
    // A shift on the person's rest day (on-call rule or Rest Day row): the
    // sheet has no violation list, so the name itself is marked.
    const isOnRestDay =
      !isPoolCell && (getIsOnRestDay?.(assignment.clinicianId, dateISO) ?? false);
    const warnings = [
      isUnqualified && "not qualified for this slot",
      isOnRestDay && "scheduled on a rest day",
    ].filter(Boolean);
    const isBeingDragged =
      dragging?.assignmentId === assignment.id &&
      dragging.rowId === slotRowId &&
      dragging.dateISO === dateISO;
    const hasLock = !isPoolCell && !readOnly && !!onToggleAssignmentLock;
    const isLocked = isProtectedAssignment(assignment);
    return (
      <span
        key={assignment.id}
        data-sheet-name="true"
        draggable={!readOnly}
        title={warnings.length > 0 ? `${name} — ${warnings.join("; ")}` : name}
        onDragStart={
          readOnly
            ? undefined
            : (e) =>
                startDrag(e, {
                  rowId: slotRowId,
                  dateISO,
                  assignmentId: assignment.id,
                  clinicianId: assignment.clinicianId,
                })
        }
        onDragEnd={readOnly ? undefined : () => setDragging(null)}
        onClick={
          readOnly || !onClinicianClick
            ? undefined
            : (e) => {
                e.stopPropagation();
                onClinicianClick(assignment.clinicianId);
              }
        }
        className={cx(
          // Inline-size containment: a long name never widens the day
          // columns (they would all grow to it, and the printed sheet shrink
          // to fit); it is cut off instead, the full name in the title. A
          // PDF has no title: there a double name wraps at its hyphen.
          "relative flex min-w-0 items-center px-0.5 text-[11px] leading-[24px] [contain:inline-size] print:[&>span]:whitespace-normal",
          // Touch screens always show an unlocked name's lock: keep its room.
          hasLock && !isLocked && "[@media(hover:none)]:pr-5",
          textClass,
          (isUnqualified || isOnRestDay) && "underline decoration-wavy",
          isOnRestDay ? "decoration-red-600" : isUnqualified && "decoration-amber-500",
          !readOnly && "cursor-grab active:cursor-grabbing hover:bg-black/5",
          isBeingDragged && "opacity-40",
        )}
      >
        <span className={cx("min-w-0 flex-1 truncate", hasLock && !isLocked && "pill-lock-fade")}>
          {surname}
        </span>
        {/* The same lock as the weekly grid: a locked name shows it, an
            unlocked one on hover (index.css); hand-placed shifts start locked. */}
        {hasLock && (
          <AssignmentLockButton
            name={name}
            locked={isLocked}
            onToggle={() => onToggleAssignmentLock(assignment)}
            className={
              isLocked
                ? "relative ml-auto"
                : "pill-lock-reveal absolute right-0 top-1/2 -translate-y-1/2"
            }
          />
        )}
      </span>
    );
  };

  const renderAreaCell = (row: ClinicSheetRow, area: ClinicSheetArea, day: ClinicSheetDay) => {
    const assignments = sortAssignmentsBySurname(
      assignmentMap.get(`${area.slotId}__${day.dateISO}`) ?? [],
      getClinicianName,
    );
    const areaBackground = day.isCyan
      ? undefined
      : area.areaIndex > 0
        ? area.blockColor
        : undefined;
    const textClass = areaBackground
      ? sheetTextClass(areaBackground)
      : "text-slate-900";
    const openSlots = Math.max(0, area.requiredSlots - assignments.length);
    const canEdit = !readOnly && Boolean(onAddAssignment);
    // The open-slot "+" marks take tracks like names.
    const areaTracks = nameTracks(area.colSpan, assignments.length + (canEdit ? openSlots : 0));
    const timeLabel =
      area.startTime && area.endTime ? `${area.startTime}–${area.endTime}` : undefined;
    const areaTitle = [area.sectionName ?? row.label, timeLabel, openSlots > 0 ? `${openSlots} offen` : undefined]
      .filter(Boolean)
      .join(" · ");
    return (
      <div
        key={`${area.slotId}`}
        role={canEdit ? "button" : undefined}
        tabIndex={canEdit ? 0 : undefined}
        data-schedule-cell="true"
        data-row-id={area.slotId}
        data-row-kind="class"
        data-date-iso={day.dateISO}
        title={areaTitle || undefined}
        onClick={
          canEdit
            ? (e) => {
                const target = e.target as HTMLElement;
                if (target.closest('[data-sheet-name="true"]')) return;
                openPicker(e, area.slotId, day.dateISO, area.sectionName ?? row.label);
              }
            : undefined
        }
        onKeyDown={
          canEdit
            ? (e) => {
                if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                e.preventDefault();
                (e.currentTarget as HTMLElement).click();
              }
            : undefined
        }
        onDragOver={readOnly ? undefined : handleCellDragOver}
        onDrop={readOnly ? undefined : (e) => handleCellDrop(e, area.slotId, day.dateISO)}
        className={cx("group/area relative min-h-[22px]", canEdit && "cursor-pointer")}
        style={{
          gridColumn: `${area.startCol} / span ${area.colSpan}`,
          backgroundColor: areaBackground,
        }}
      >
        <div
          className="grid items-start"
          style={{ gridTemplateColumns: areaTracks }}
        >
          {assignments.map((assignment) =>
            renderName(assignment, area.slotId, day.dateISO, textClass, false),
          )}
          {canEdit && openSlots > 0
            ? Array.from({ length: openSlots }, (_, idx) => (
                <span
                  key={`open-${idx}`}
                  aria-hidden="true"
                  className={cx(
                    "block select-none px-0.5 text-center text-[11px] leading-[20px] text-slate-400",
                    "opacity-0 transition-opacity group-hover/area:opacity-70",
                  )}
                >
                  +
                </span>
              ))
            : null}
        </div>
      </div>
    );
  };

  const renderPoolCell = (
    poolRow: ScheduleRow,
    day: ClinicSheetDay,
    isLastDay: boolean,
    rowBorders: string,
  ) => {
    const assignments = sortAssignmentsBySurname(
      assignmentMap.get(`${poolRow.id}__${day.dateISO}`) ?? [],
      getClinicianName,
    );
    return (
      <div
        key={`${poolRow.id}__${day.dateISO}`}
        data-schedule-cell="true"
        data-row-id={poolRow.id}
        data-row-kind="pool"
        data-date-iso={day.dateISO}
        onDragOver={readOnly ? undefined : handleCellDragOver}
        onDrop={readOnly ? undefined : (e) => handleCellDrop(e, poolRow.id, day.dateISO)}
        className={cx(
          "min-h-[22px]",
          rowBorders,
          !isLastDay && "border-r-2 border-r-slate-400",
        )}
        style={{ backgroundColor: day.isCyan ? EXCEL_CYAN : undefined }}
      >
        <div className="grid" style={{ gridTemplateColumns: nameTracks(SHEET_DAY_COLUMNS, assignments.length) }}>
          {assignments.map((assignment) =>
            renderName(assignment, poolRow.id, day.dateISO, "text-slate-900", true),
          )}
        </div>
      </div>
    );
  };

  const spacerRow = (key: string) => (
    <div key={key} className="h-2 bg-white" style={{ gridColumn: "1 / -1" }} />
  );

  return (
    <div
      className="schedule-grid mx-auto w-full px-4 pb-8 sm:px-6 sm:pb-10"
      style={{ fontFamily: SHEET_FONT_FAMILY }}
    >
      <div
        data-schedule-shell="true"
        className="relative mt-4 rounded-2xl border-2 border-slate-900/80 bg-white p-[2px] shadow-sm dark:border-slate-700 sm:mt-6 sm:rounded-3xl"
      >
        <div className="relative rounded-[calc(1.5rem-2px)] bg-white overflow-hidden">
          {header ? (
            <div className="relative z-20 rounded-t-[calc(1.5rem-2px)] bg-white px-4 py-3 dark:bg-slate-900 sm:px-6 sm:py-4">
              {header}
            </div>
          ) : null}
          <div className="relative overflow-hidden rounded-b-[calc(1.5rem-2px)]">
            <div className="calendar-scroll relative z-10 h-auto max-h-none overflow-x-auto overflow-y-hidden touch-pan-x [-webkit-overflow-scrolling:touch]">
              <div className="min-w-full w-full">
                {/* w-max lets the grid box span all its tracks (wider than the
                    scrollport) — without it, sticky left-0 cells run out of
                    room to travel and stop sticking mid-scroll. */}
                <div
                  data-schedule-grid="true"
                  className="relative grid w-max min-w-full bg-white text-slate-900"
                  onDragOver={
                    readOnly
                      ? undefined
                      : (e) => {
                          if (!dragging) return;
                          const target = e.target as HTMLElement | null;
                          const isCell = target?.closest?.('[data-schedule-cell="true"]');
                          if (isCell) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                        }
                  }
                  onDrop={
                    readOnly
                      ? undefined
                      : (e) => {
                          const target = e.target as HTMLElement | null;
                          const isCell = target?.closest?.('[data-schedule-cell="true"]');
                          if (isCell) return;
                          e.preventDefault();
                          const payload = readDragPayload(e.dataTransfer);
                          if (payload) {
                            onRemoveAssignment?.(payload);
                          }
                          setDragging(null);
                        }
                  }
                  style={{
                    gridTemplateColumns: `${LABEL_COLUMN_WIDTH} repeat(${Math.max(
                      days.length,
                      1,
                    )}, ${DAY_COLUMN_WIDTH})`,
                  }}
                >
                  {/* Header: weekday + date per day block, Excel gray / cyan. */}
                  <div className="sticky left-0 top-0 z-40 border-b-2 border-r-2 border-slate-500 bg-white" />
                  {days.map((day, dayIndex) => {
                    const isToday = day.dateISO === todayISO;
                    const isLastDay = dayIndex === days.length - 1;
                    return (
                      <div
                        key={`head-${day.dateISO}`}
                        className={cx(
                          "sticky top-0 z-30 border-b-2 border-slate-500 px-1 py-1 text-center",
                          !isLastDay && "border-r-2 border-r-slate-400",
                        )}
                        style={{ backgroundColor: day.isCyan ? EXCEL_CYAN : EXCEL_GRAY }}
                      >
                        <div className="truncate text-[13px] font-bold leading-tight">
                          {WEEKDAY_FORMAT.format(day.date)}
                        </div>
                        <div className="text-[13px] font-bold leading-tight">
                          <span
                            className={cx(
                              // A printout does not mark the day it was printed.
                              isToday && "rounded-sm px-1 ring-2 ring-inset ring-sky-600 print:ring-0",
                            )}
                          >
                            {formatSheetDate(day.date)}
                          </span>
                        </div>
                        {day.holidayName ? (
                          <div className="print-wrap truncate text-[9px] font-semibold leading-tight text-slate-700 [contain:inline-size]">
                            {day.holidayName}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}

                  {/* Workplace sections */}
                  {sections.map((section, sectionIndex) => (
                    <Fragment key={`section-${section.locationId}-${sectionIndex}`}>
                      {sectionIndex > 0 ? spacerRow(`section-gap-${sectionIndex}`) : null}
                      {section.rows.map((row, rowIndex) => {
                        const isFirstRow = rowIndex === 0;
                        const isLastRow = rowIndex === section.rows.length - 1;
                        const rowBorders = cx(
                          isFirstRow && "border-t-2 border-t-slate-500",
                          isLastRow
                            ? "border-b-2 border-b-slate-500"
                            : "border-b border-b-slate-300",
                        );
                        const labelText = sheetTextClass(row.labelColor);
                        return (
                          <Fragment key={row.key}>
                            <div
                              className={cx(
                                "sticky left-0 z-20 border-r-2 border-r-slate-500 px-1.5",
                                rowBorders,
                              )}
                              style={{ backgroundColor: row.labelColor }}
                            >
                              <div
                                className={cx(
                                  "print-wrap truncate text-[11px] font-bold leading-[22px]",
                                  labelText,
                                )}
                                title={row.label}
                              >
                                {row.label}
                              </div>
                            </div>
                            {days.map((day, dayIndex) => {
                              const isLastDay = dayIndex === days.length - 1;
                              const areas = row.areasByDate.get(day.dateISO) ?? [];
                              return (
                                <div
                                  key={`${row.key}__${day.dateISO}`}
                                  className={cx(
                                    "relative",
                                    rowBorders,
                                    !isLastDay && "border-r-2 border-r-slate-400",
                                  )}
                                  style={{
                                    backgroundColor: day.isCyan ? EXCEL_CYAN : undefined,
                                  }}
                                >
                                  {areas.length ? (
                                    <div
                                      className="grid h-full"
                                      style={{
                                        gridTemplateColumns: `repeat(${SHEET_DAY_COLUMNS}, minmax(0, 1fr))`,
                                      }}
                                    >
                                      {areas.map((area) => renderAreaCell(row, area, day))}
                                    </div>
                                  ) : (
                                    <div className="min-h-[22px]" />
                                  )}
                                </div>
                              );
                            })}
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  ))}

                  {/* Absence pools (Urlaub, Ruhetag, …) — no fill, Excel style */}
                  {poolRows.length ? (
                    <Fragment>
                      {spacerRow("pools-gap")}
                      {poolRows.map((poolRow, poolIndex) => {
                        const isFirstRow = poolIndex === 0;
                        const isLastRow = poolIndex === poolRows.length - 1;
                        const rowBorders = cx(
                          isFirstRow && "border-t-2 border-t-slate-500",
                          isLastRow
                            ? "border-b-2 border-b-slate-500"
                            : "border-b border-b-slate-300",
                        );
                        return (
                          <Fragment key={poolRow.id}>
                            <div
                              className={cx(
                                "sticky left-0 z-20 border-r-2 border-r-slate-500 bg-white px-1.5",
                                rowBorders,
                              )}
                            >
                              <div
                                className="print-wrap truncate text-[11px] font-bold leading-[22px] text-slate-900"
                                title={poolRow.name}
                              >
                                {poolRow.name}
                              </div>
                            </div>
                            {days.map((day, dayIndex) =>
                              renderPoolCell(
                                poolRow,
                                day,
                                dayIndex === days.length - 1,
                                rowBorders,
                              ),
                            )}
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  ) : null}
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
