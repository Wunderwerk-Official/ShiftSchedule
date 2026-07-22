import { useEffect, useRef, useState } from "react";
import { cx } from "../../lib/classNames";
import type { PreferredWorkingTimes } from "../../api/client";
import {
  DEFAULT_PREFERRED_WORKING_TIMES,
  normalizePreferredWorkingTimes,
} from "../../lib/clinicianPreferences";
import CustomSelect from "./CustomSelect";
import CustomNumberInput from "./CustomNumberInput";
import CustomTimePicker from "./CustomTimePicker";
import CustomDatePicker from "./CustomDatePicker";

// Convert ISO date (YYYY-MM-DD) to European format (DD.MM.YYYY)
function isoToEuropean(iso: string): string {
  if (!iso) return "";
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const [, year, month, day] = match;
  return `${day}.${month}.${year}`;
}

// Convert European format (DD.MM.YYYY) to ISO date (YYYY-MM-DD)
function europeanToIso(european: string): string {
  if (!european) return "";
  const match = european.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return "";
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

type ClinicianEditorProps = {
  clinician: {
    id: string;
    name: string;
    qualifiedClassIds: string[];
    vacations: Array<{ id: string; startISO: string; endISO: string }>;
    preferredWorkingTimes?: PreferredWorkingTimes;
    workingHoursPerWeek?: number;
    workingHoursToleranceHours?: number;
    planningWishes?: string;
  };
  classRows: Array<{ id: string; name: string }>;
  initialSection?: "vacations";
  vacationOnly?: boolean;
  onUpdateWorkingHours?: (clinicianId: string, workingHoursPerWeek?: number) => void;
  onUpdateWorkingHoursTolerance?: (clinicianId: string, toleranceHours?: number) => void;
  onUpdatePlanningWishes?: (clinicianId: string, planningWishes?: string) => void;
  onUpdatePreferredWorkingTimes?: (
    clinicianId: string,
    preferredWorkingTimes: PreferredWorkingTimes,
  ) => void;
  onToggleQualification: (clinicianId: string, classId: string) => void;
  onReorderQualification: (
    clinicianId: string,
    fromClassId: string,
    toClassId: string,
  ) => void;
  onAddVacation: (clinicianId: string) => void;
  onUpdateVacation: (
    clinicianId: string,
    vacationId: string,
    updates: { startISO?: string; endISO?: string },
  ) => void;
  onRemoveVacation: (clinicianId: string, vacationId: string) => void;
};

export default function ClinicianEditor({
  clinician,
  classRows,
  onToggleQualification,
  onReorderQualification,
  onAddVacation,
  onUpdateVacation,
  onRemoveVacation,
  initialSection,
  vacationOnly = false,
  onUpdateWorkingHours,
  onUpdateWorkingHoursTolerance,
  onUpdatePreferredWorkingTimes,
  onUpdatePlanningWishes,
}: ClinicianEditorProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [showPastVacations, setShowPastVacations] = useState(false);
  const [preferredWorkingTimes, setPreferredWorkingTimes] = useState(() =>
    normalizePreferredWorkingTimes(clinician.preferredWorkingTimes),
  );
  const [workingHoursPerWeek, setWorkingHoursPerWeek] = useState(
    clinician.workingHoursPerWeek ?? "",
  );
  const [workingHoursTolerance, setWorkingHoursTolerance] = useState(
    clinician.workingHoursToleranceHours ?? 5,
  );
  const [planningWishes, setPlanningWishes] = useState(
    clinician.planningWishes ?? "",
  );
  const [timeWarnings, setTimeWarnings] = useState<Record<string, string>>({});
  const suppressPreferredWorkingTimesUpdate = useRef(true);
  const vacationPanelRef = useRef<HTMLDivElement | null>(null);
  const eligibleIds = clinician.qualifiedClassIds;
  const eligibleRows = eligibleIds
    .map((id) => classRows.find((row) => row.id === id))
    .filter((row): row is { id: string; name: string } => Boolean(row));
  const availableRows = classRows.filter((row) => !eligibleIds.includes(row.id));
  const [selectedClassId, setSelectedClassId] = useState("");
  // Format today's LOCAL date; toISOString would convert local midnight to
  // UTC and yield yesterday's date in timezones east of UTC.
  const now = new Date();
  const todayISO = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const sortedVacations = [...clinician.vacations].sort((a, b) =>
    a.startISO.localeCompare(b.startISO),
  );
  const pastVacations = sortedVacations.filter((v) => v.endISO < todayISO);
  const upcomingVacations = sortedVacations.filter((v) => v.endISO >= todayISO);
  const preferredWorkingDays = [
    { id: "mon", label: "Mon" },
    { id: "tue", label: "Tue" },
    { id: "wed", label: "Wed" },
    { id: "thu", label: "Thu" },
    { id: "fri", label: "Fri" },
    { id: "sat", label: "Sat" },
    { id: "sun", label: "Sun" },
  ] as const;
  type PreferredWorkingDayId = (typeof preferredWorkingDays)[number]["id"];

  const parseTimeToMinutes = (value: string) => {
    const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return hours * 60 + minutes;
  };

  const clearTimeWarning = (dayId: PreferredWorkingDayId) => {
    setTimeWarnings((prev) => {
      if (!(dayId in prev)) return prev;
      const { [dayId]: _unused, ...rest } = prev;
      return rest;
    });
  };

  const validatePreferredWorkingTime = (dayId: PreferredWorkingDayId) => {
    const value = preferredWorkingTimes[dayId];
    if (value.requirement === "none") {
      clearTimeWarning(dayId);
      commitPreferredWorkingTimes();
      return;
    }
    const startMinutes = parseTimeToMinutes(value.startTime ?? "");
    const endMinutes = parseTimeToMinutes(value.endTime ?? "");
    if (startMinutes === null || endMinutes === null) {
      setTimeWarnings((prev) => ({
        ...prev,
        [dayId]: "Invalid time format.",
      }));
    } else if (endMinutes <= startMinutes) {
      setTimeWarnings((prev) => ({
        ...prev,
        [dayId]: "End time must be after start time.",
      }));
    } else {
      clearTimeWarning(dayId);
    }
    // Always commit - let the user keep their values
    commitPreferredWorkingTimes();
  };

  useEffect(() => {
    if (availableRows.length === 0) {
      if (selectedClassId) setSelectedClassId("");
      return;
    }
    if (!availableRows.some((row) => row.id === selectedClassId)) {
      setSelectedClassId(availableRows[0].id);
    }
  }, [availableRows, selectedClassId]);

  useEffect(() => {
    if (initialSection !== "vacations") return;
    if (pastVacations.length > 0) {
      setShowPastVacations(true);
    }
    // In vacation-only mode there is nothing above the panel to scroll past.
    if (!vacationOnly && vacationPanelRef.current) {
      vacationPanelRef.current.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [initialSection, vacationOnly, clinician.id, pastVacations.length]);
  useEffect(() => {
    setWorkingHoursPerWeek(clinician.workingHoursPerWeek ?? "");
  }, [clinician.id, clinician.workingHoursPerWeek]);
  useEffect(() => {
    setWorkingHoursTolerance(clinician.workingHoursToleranceHours ?? 5);
  }, [clinician.id, clinician.workingHoursToleranceHours]);
  useEffect(() => {
    setPreferredWorkingTimes(
      normalizePreferredWorkingTimes(clinician.preferredWorkingTimes),
    );
    suppressPreferredWorkingTimesUpdate.current = true;
  }, [clinician.id, clinician.preferredWorkingTimes]);
  useEffect(() => {
    setTimeWarnings({});
  }, [clinician.id]);
  useEffect(() => {
    if (suppressPreferredWorkingTimesUpdate.current) {
      suppressPreferredWorkingTimesUpdate.current = false;
      return;
    }
    onUpdatePreferredWorkingTimes?.(clinician.id, preferredWorkingTimes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferredWorkingTimes, clinician.id]);

  const updatePreferredWorkingTimes = (
    updater: (prev: PreferredWorkingTimes) => PreferredWorkingTimes,
  ) => {
    setPreferredWorkingTimes((prev) => updater(prev));
  };

  const commitPreferredWorkingTimes = (next?: PreferredWorkingTimes) => {
    const payload = next ?? preferredWorkingTimes;
    setPreferredWorkingTimes(payload);
  };

  return (
    <div>
      {!vacationOnly && (
      <div className="relative mt-4 rounded-2xl border-2 border-sky-200 bg-sky-50/60 px-4 py-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.8)] dark:border-sky-500/40 dark:bg-sky-900/20">
        <div className="absolute -top-3 left-4 rounded-full border border-sky-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-sky-600 dark:border-sky-500/40 dark:bg-slate-900 dark:text-sky-200">
          Eligible Sections
        </div>
        <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Drag to set priority, toggle to add or remove.
        </div>
        <div className="mt-4 space-y-2">
          {eligibleRows.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-3 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-300">
              No eligible sections selected yet.
            </div>
          ) : (
            eligibleRows.map((row, index) => (
              <div
                key={row.id}
                className={cx(
                  "flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200",
                  dragOverId === row.id && "border-sky-300 bg-sky-50",
                )}
                onDragOver={(event) => {
                  if (!draggingId || draggingId === row.id) return;
                  event.preventDefault();
                  setDragOverId(row.id);
                }}
                onDragLeave={() => {
                  setDragOverId((prev) => (prev === row.id ? null : prev));
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const fromId =
                    draggingId || event.dataTransfer.getData("text/plain");
                  if (!fromId || fromId === row.id) {
                    setDragOverId(null);
                    return;
                  }
                  onReorderQualification(clinician.id, fromId, row.id);
                  setDraggingId(null);
                  setDragOverId(null);
                }}
              >
                <span className="text-xs font-semibold text-slate-400 dark:text-slate-500">
                  {index + 1}
                </span>
                <button
                  type="button"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", row.id);
                    setDraggingId(row.id);
                  }}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setDragOverId(null);
                  }}
                  className="cursor-grab rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  aria-label={`Reorder ${row.name}`}
                >
                  ≡
                </button>
                <span className="flex-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
                  {row.name}
                </span>
                <button
                  type="button"
                  onClick={() => onToggleQualification(clinician.id, row.id)}
                  className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Remove
                </button>
              </div>
            ))
          )}
        </div>
        {availableRows.length > 0 ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Add section
            </div>
            <CustomSelect
              value={selectedClassId}
              onChange={(value) => setSelectedClassId(value)}
              options={availableRows.map((row) => ({
                value: row.id,
                label: row.name,
              }))}
              className="min-w-[140px]"
            />
            <button
              type="button"
              onClick={() => {
                if (!selectedClassId) return;
                onToggleQualification(clinician.id, selectedClassId);
              }}
              className={cx(
                "rounded-lg border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50",
                "dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800",
              )}
            >
              Add
            </button>
          </div>
        ) : null}
      </div>
      )}

      <div
        ref={vacationPanelRef}
        className="relative mt-4 rounded-2xl border-2 border-emerald-200 bg-emerald-50/60 px-4 py-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.8)] dark:border-emerald-500/40 dark:bg-emerald-900/20"
      >
        <div className="absolute -top-3 left-4 rounded-full border border-emerald-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-600 dark:border-emerald-500/40 dark:bg-slate-900 dark:text-emerald-200">
          Vacation
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">Vacation periods</div>
            <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Define ranges to move the user into Vacation automatically.
            </div>
          </div>
          <button
            type="button"
            onClick={() => onAddVacation(clinician.id)}
            className={cx(
              "rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600",
              "hover:bg-slate-50 hover:text-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100",
            )}
          >
            Add Vacation
          </button>
        </div>

        <div className="mt-4 space-y-2">
          {upcomingVacations.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-300">
              No upcoming vacations.
            </div>
          ) : (
            upcomingVacations.map((vacation) => {
              const isInvalid = vacation.endISO < vacation.startISO;
              return (
                <div
                  key={vacation.id}
                  className={cx(
                    "flex flex-wrap items-center gap-2 rounded-2xl border bg-white px-3 py-2 dark:bg-slate-900",
                    isInvalid
                      ? "border-rose-300 dark:border-rose-500/60"
                      : "border-slate-200 dark:border-slate-700",
                  )}
                >
                  <CustomDatePicker
                    value={isoToEuropean(vacation.startISO)}
                    onChange={(value) => {
                      const iso = europeanToIso(value);
                      if (iso) {
                        const updates: { startISO: string; endISO?: string } = { startISO: iso };
                        // If end date is before new start date, set end to start + 1 day
                        if (vacation.endISO < iso) {
                          const nextDay = new Date(iso);
                          nextDay.setDate(nextDay.getDate() + 1);
                          updates.endISO = nextDay.toISOString().slice(0, 10);
                        }
                        onUpdateVacation(clinician.id, vacation.id, updates);
                      }
                    }}
                    className="w-[120px]"
                  />
                  <span className="text-xs font-semibold text-slate-400">–</span>
                  <CustomDatePicker
                    value={isoToEuropean(vacation.endISO)}
                    onChange={(value) => {
                      const iso = europeanToIso(value);
                      if (iso) {
                        onUpdateVacation(clinician.id, vacation.id, {
                          endISO: iso,
                        });
                      }
                    }}
                    className="w-[120px]"
                  />
                  <button
                    type="button"
                    onClick={() => onRemoveVacation(clinician.id, vacation.id)}
                    className={cx(
                      "ml-auto rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600",
                      "hover:bg-slate-50 hover:text-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100",
                    )}
                  >
                    Remove
                  </button>
                </div>
              );
            })
          )}
        </div>

        {pastVacations.length > 0 ? (
          <details
            open={showPastVacations}
            onToggle={(event) => setShowPastVacations(event.currentTarget.open)}
            className="mt-4 rounded-2xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900"
          >
            <summary className="cursor-pointer text-sm font-semibold text-slate-700 dark:text-slate-200">
              Past vacations ({pastVacations.length})
            </summary>
            <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              Past vacations are hidden by default. Expand to view or edit.
            </div>
            <div className="mt-3 space-y-2">
              {pastVacations.map((vacation) => {
                const isInvalid = vacation.endISO < vacation.startISO;
                return (
                  <div
                    key={vacation.id}
                    className={cx(
                      "flex flex-wrap items-center gap-2 rounded-2xl border bg-slate-50 px-3 py-2 dark:bg-slate-800",
                      isInvalid
                        ? "border-rose-300 dark:border-rose-500/60"
                        : "border-slate-200 dark:border-slate-700",
                    )}
                  >
                    <CustomDatePicker
                      value={isoToEuropean(vacation.startISO)}
                      onChange={(value) => {
                        const iso = europeanToIso(value);
                        if (iso) {
                          const updates: { startISO: string; endISO?: string } = { startISO: iso };
                          // If end date is before new start date, set end to start + 1 day
                          if (vacation.endISO < iso) {
                            const nextDay = new Date(iso);
                            nextDay.setDate(nextDay.getDate() + 1);
                            updates.endISO = nextDay.toISOString().slice(0, 10);
                          }
                          onUpdateVacation(clinician.id, vacation.id, updates);
                        }
                      }}
                      className="w-[120px]"
                    />
                    <span className="text-xs font-semibold text-slate-400">–</span>
                    <CustomDatePicker
                      value={isoToEuropean(vacation.endISO)}
                      onChange={(value) => {
                        const iso = europeanToIso(value);
                        if (iso) {
                          onUpdateVacation(clinician.id, vacation.id, {
                            endISO: iso,
                          });
                        }
                      }}
                      className="w-[120px]"
                    />
                    <button
                      type="button"
                      onClick={() => onRemoveVacation(clinician.id, vacation.id)}
                      className={cx(
                        "ml-auto rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600",
                        "hover:bg-slate-50 hover:text-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100",
                      )}
                    >
                      Remove
                    </button>
                  </div>
                );
              })}
            </div>
          </details>
        ) : null}
      </div>

      {!vacationOnly && (
      <div className="relative mt-4 rounded-2xl border-2 border-indigo-200 bg-indigo-50/60 px-4 py-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.8)] dark:border-indigo-500/40 dark:bg-indigo-900/20">
        <div className="absolute -top-3 left-4 rounded-full border border-indigo-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-indigo-600 dark:border-indigo-500/40 dark:bg-slate-900 dark:text-indigo-200">
          Preferred Working Times
        </div>
        <div>
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            Optional availability windows per weekday.
          </div>
          <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Set a time range for each day and mark it as mandatory or a preference.
          </div>
        </div>
        <div className="mt-4 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Working hours per week
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={workingHoursPerWeek}
                  onChange={(event) => {
                    const value = event.target.value;
                    setWorkingHoursPerWeek(value === "" ? "" : Number(value));
                    if (!onUpdateWorkingHours) return;
                    const trimmed = value.trim();
                    if (!trimmed) {
                      onUpdateWorkingHours(clinician.id, undefined);
                      return;
                    }
                    const parsed = Number(trimmed);
                    if (!Number.isFinite(parsed)) return;
                    onUpdateWorkingHours(clinician.id, Math.max(0, parsed));
                  }}
                  className={cx(
                    "w-24 rounded-lg border border-slate-200 px-2 py-1 text-sm font-medium text-slate-900",
                    "focus:border-indigo-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
                  )}
                  placeholder="40"
                />
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Hours according to contract
              </div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Tolerance (hours)
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <CustomNumberInput
                  value={workingHoursTolerance}
                  onChange={(value) => {
                    setWorkingHoursTolerance(value);
                    onUpdateWorkingHoursTolerance?.(clinician.id, value);
                  }}
                  min={0}
                  max={40}
                  className="w-24"
                />
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Allowed deviation from target
              </div>
            </div>
          </div>
        </div>
        <div className="mt-4 space-y-2">
          {preferredWorkingDays.map((day) => {
            const value = preferredWorkingTimes[day.id];
            const isInactive = value.requirement === "none";
            return (
              <div
                key={day.id}
                className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              >
                <div className="min-w-[56px] text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {day.label}
                </div>
                <div className="flex items-center gap-1">
                  <CustomTimePicker
                    value={value.startTime ?? "07:00"}
                    onChange={(time) => {
                      updatePreferredWorkingTimes((prev) => ({
                        ...prev,
                        [day.id]: {
                          ...prev[day.id],
                          startTime: time,
                        },
                      }));
                      // Validate after a short delay to let state update
                      setTimeout(() => validatePreferredWorkingTime(day.id), 0);
                    }}
                    disabled={isInactive}
                    hasError={!!timeWarnings[day.id]}
                    className="w-[72px]"
                  />
                  <span className="text-[11px] font-semibold text-slate-400">–</span>
                  <CustomTimePicker
                    value={value.endTime ?? "17:00"}
                    onChange={(time) => {
                      updatePreferredWorkingTimes((prev) => ({
                        ...prev,
                        [day.id]: {
                          ...prev[day.id],
                          endTime: time,
                        },
                      }));
                      // Validate after a short delay to let state update
                      setTimeout(() => validatePreferredWorkingTime(day.id), 0);
                    }}
                    disabled={isInactive}
                    hasError={!!timeWarnings[day.id]}
                    className="w-[72px]"
                  />
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {[
                    { id: "none", label: "No preference" },
                    { id: "preference", label: "Preferred" },
                    { id: "mandatory", label: "Mandatory" },
                  ].map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => {
                        updatePreferredWorkingTimes((prev) => ({
                          ...prev,
                          [day.id]: {
                            ...prev[day.id],
                            requirement: option.id as
                              | "none"
                              | "preference"
                              | "mandatory",
                          },
                        }));
                        if (option.id === "none") clearTimeWarning(day.id);
                      }}
                      className={cx(
                        "rounded-full border px-2 py-1 text-[11px] font-semibold",
                        value.requirement === option.id
                          ? "border-indigo-300 bg-indigo-100 text-indigo-700"
                          : "border-slate-200 text-slate-600 hover:bg-slate-50",
                        "dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800",
                        value.requirement === option.id &&
                          "dark:border-indigo-500/60 dark:bg-indigo-500/20 dark:text-indigo-100",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {timeWarnings[day.id] ? (
                  <div className="w-full text-xs font-semibold text-rose-600">
                    {timeWarnings[day.id]}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      )}

      {!vacationOnly && (
      <div className="relative mt-4 rounded-2xl border-2 border-violet-200 bg-violet-50/60 px-4 py-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.8)] dark:border-violet-500/40 dark:bg-violet-900/20">
        <div className="absolute -top-3 left-4 rounded-full border border-violet-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-violet-600 dark:border-violet-500/40 dark:bg-slate-900 dark:text-violet-200">
          Planning Wishes
        </div>
        <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Free-text wishes for the AI planner.
        </div>
        <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Treated as soft preferences — hard rules, vacations, and fixed
          assignments always win.
        </div>
        <textarea
          rows={4}
          maxLength={500}
          value={planningWishes}
          onChange={(event) => setPlanningWishes(event.target.value)}
          onBlur={() =>
            onUpdatePlanningWishes?.(clinician.id, planningWishes.trim() || undefined)
          }
          placeholder="e.g. Prefers early shifts. No on-call before clinic days. Likes Fridays off."
          className="mt-3 w-full resize-y rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-violet-300 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        />
        <div className="mt-1 text-right text-xs text-slate-400 dark:text-slate-500">
          {planningWishes.length}/500
        </div>
      </div>
      )}
    </div>
  );
}
