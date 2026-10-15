import { useState, type ChangeEvent } from "react";
import {
  buttonAdd,
  buttonDanger,
  buttonPrimary,
  buttonSecondary,
  buttonSmall,
} from "../../lib/buttonStyles";
import { cx } from "../../lib/classNames";
import { Location, WorkplaceRow } from "../../data/mockData";
import type {
  Holiday,
  SolverSettings,
  WeeklyCalendarTemplate,
} from "../../api/client";
import { DEFAULT_AGENT_INSTRUCTIONS } from "../../lib/agentSettings";
import AgentSettingsPanel from "./AgentSettingsPanel";
import WeeklyTemplateBuilder from "./WeeklyTemplateBuilder";
import CustomSelect from "./CustomSelect";
import CustomNumberInput from "./CustomNumberInput";
import CustomDatePicker from "./CustomDatePicker";
import DatabaseHealthCheck from "./DatabaseHealthCheck";
import ToggleSwitch from "./ToggleSwitch";
import { useConfirm } from "../ui/ConfirmDialog";

type ScheduleSnapshotImportResult = {
  imported: number;
  droppedClinicians: number;
  droppedSlots: number;
};

type SettingsViewProps = {
  classRows: WorkplaceRow[];
  poolRows: WorkplaceRow[];
  locations: Location[];
  clinicians: Array<{ id: string; name: string }>;
  holidays: Holiday[];
  holidayCountry: string;
  holidayYear: number;
  solverSettings: SolverSettings;
  weeklyTemplate?: WeeklyCalendarTemplate;
  onRenamePool: (rowId: string, nextName: string) => void;
  onAddLocation: (name: string) => void;
  onRenameLocation: (locationId: string, nextName: string) => void;
  onSetLocationColor?: (locationId: string, color: string | null) => void;
  onRemoveLocation: (locationId: string) => void;
  onReorderLocations: (nextOrder: string[]) => void;
  onAddClinician: (name: string, workingHoursPerWeek?: number) => void;
  onEditClinician: (clinicianId: string) => void;
  onRemoveClinician: (clinicianId: string) => void;
  onChangeHolidayCountry: (countryCode: string) => void;
  onChangeHolidayYear: (year: number) => void;
  onFetchHolidays: (countryCode: string, year: number) => Promise<void>;
  onAddHoliday: (holiday: Holiday) => void;
  onRemoveHoliday: (holiday: Holiday) => void;
  onChangeSolverSettings: (settings: SolverSettings) => void;
  onChangeWeeklyTemplate: (template: WeeklyCalendarTemplate) => void;
  onCreateSection: (name: string) => string;
  onUpdateSectionColor: (sectionId: string, color: string | null) => void;
  onRemoveSection?: (sectionId: string) => void;
  onExportScheduleSnapshot: () => void;
  onImportScheduleSnapshot: (payload: unknown) => Promise<ScheduleSnapshotImportResult>;
  isAdmin?: boolean;
};

export default function SettingsView({
  classRows,
  poolRows,
  locations,
  clinicians,
  holidays,
  holidayCountry,
  holidayYear,
  solverSettings,
  weeklyTemplate,
  onRenamePool,
  onAddLocation,
  onRenameLocation,
  onSetLocationColor,
  onRemoveLocation,
  onReorderLocations,
  onAddClinician,
  onEditClinician,
  onRemoveClinician,
  onChangeHolidayCountry,
  onChangeHolidayYear,
  onFetchHolidays,
  onAddHoliday,
  onRemoveHoliday,
  onChangeSolverSettings,
  onChangeWeeklyTemplate,
  onCreateSection,
  onUpdateSectionColor,
  onRemoveSection,
  onExportScheduleSnapshot,
  onImportScheduleSnapshot,
  isAdmin = false,
}: SettingsViewProps) {
  const confirm = useConfirm();
  const [newClinicianName, setNewClinicianName] = useState("");
  const [newClinicianHours, setNewClinicianHours] = useState("");
  const [showNewClinician, setShowNewClinician] = useState(false);
  const [newHolidayDate, setNewHolidayDate] = useState("");
  const [newHolidayName, setNewHolidayName] = useState("");
  const [showNewHoliday, setShowNewHoliday] = useState(false);
  const [showSectionOrder, setShowSectionOrder] = useState(false);
  const [draggingSectionBlockId, setDraggingSectionBlockId] = useState<string | null>(
    null,
  );
  const [dragOverSectionBlockId, setDragOverSectionBlockId] = useState<string | null>(
    null,
  );
  const [isFetchingHolidays, setIsFetchingHolidays] = useState(false);
  const [holidayError, setHolidayError] = useState<string | null>(null);
  const [holidayInputError, setHolidayInputError] = useState<string | null>(null);
  const [snapshotImportError, setSnapshotImportError] = useState<string | null>(null);
  const [snapshotImportResult, setSnapshotImportResult] =
    useState<ScheduleSnapshotImportResult | null>(null);
  const [snapshotImporting, setSnapshotImporting] = useState(false);
  const countryOptions = [
    { code: "FR", label: "France 🇫🇷" },
    { code: "DE", label: "Germany 🇩🇪" },
    { code: "IT", label: "Italy 🇮🇹" },
    { code: "LU", label: "Luxembourg 🇱🇺" },
    { code: "NL", label: "Netherlands 🇳🇱" },
    { code: "PL", label: "Poland 🇵🇱" },
    { code: "RO", label: "Romania 🇷🇴" },
    { code: "RU", label: "Russia 🇷🇺" },
    { code: "ES", label: "Spain 🇪🇸" },
    { code: "CH", label: "Switzerland 🇨🇭" },
    { code: "UA", label: "Ukraine 🇺🇦" },
    { code: "GB", label: "United Kingdom 🇬🇧" },
  ];
  const normalizedCountry = holidayCountry.toUpperCase();
  const hasCountryOption = countryOptions.some(
    (option) => option.code === normalizedCountry,
  );
  const holidayYearPrefix = `${holidayYear}-`;
  const holidaysForYear = holidays
    .filter((holiday) => holiday.dateISO.startsWith(holidayYearPrefix))
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  // The date picker always yields "DD.MM.YYYY"; returns the ISO date or null.
  const parseHolidayDate = (value: string) => {
    const match = value.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!match) return null;
    const [, dayRaw, monthRaw, yearRaw] = match;
    const day = Number(dayRaw);
    const month = Number(monthRaw);
    const year = Number(yearRaw);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month) {
      return null;
    }
    return `${yearRaw}-${monthRaw.padStart(2, "0")}-${dayRaw.padStart(2, "0")}`;
  };
  const formatHolidayDate = (dateISO: string) => {
    const [year, month, day] = dateISO.split("-");
    if (!year || !month || !day) return dateISO;
    return `${day}.${month}.${year}`;
  };
  const poolNoteById: Record<string, string> = {
    "pool-rest-day":
      "Rest day pool for people placed before or after on-call duties.",
    "pool-vacation":
      "People on vacation. Drag in or out of this row to update vacations.",
  };
  const sectionBlocks = weeklyTemplate?.blocks ?? [];
  const sectionNameById = new Map(classRows.map((row) => [row.id, row.name]));
  const solverSectionRows = (() => {
    if (!weeklyTemplate) return classRows;
    const blockSectionIds = new Set(
      (weeklyTemplate.blocks ?? [])
        .map((block) => block.sectionId)
        .filter((id): id is string => Boolean(id)),
    );
    if (blockSectionIds.size === 0) return [];
    const blockOrder = new Map<string, number>();
    (weeklyTemplate.blocks ?? []).forEach((block, index) => {
      if (!block.sectionId || blockOrder.has(block.sectionId)) return;
      blockOrder.set(block.sectionId, index);
    });
    return classRows
      .filter((row) => blockSectionIds.has(row.id))
      .sort(
        (a, b) => (blockOrder.get(a.id) ?? 0) - (blockOrder.get(b.id) ?? 0),
      );
  })();
  const onCallRestClassId =
    solverSettings.onCallRestClassId &&
    solverSectionRows.some((row) => row.id === solverSettings.onCallRestClassId)
      ? solverSettings.onCallRestClassId
      : solverSectionRows[0]?.id ?? "";
  const reorderSectionBlocks = (fromId: string, toId: string) => {
    if (!weeklyTemplate || fromId === toId) return;
    const fromIndex = sectionBlocks.findIndex((block) => block.id === fromId);
    const toIndex = sectionBlocks.findIndex((block) => block.id === toId);
    if (fromIndex < 0 || toIndex < 0) return;
    const nextBlocks = [...sectionBlocks];
    const [moved] = nextBlocks.splice(fromIndex, 1);
    nextBlocks.splice(toIndex, 0, moved);
    onChangeWeeklyTemplate({ ...weeklyTemplate, blocks: nextBlocks });
  };

  const handleSnapshotImport = async (file: File) => {
    setSnapshotImportError(null);
    setSnapshotImportResult(null);

    let payload: unknown;
    try {
      payload = JSON.parse(await file.text());
    } catch (error) {
      setSnapshotImportError("Snapshot file could not be parsed. Please upload valid JSON.");
      return;
    }

    const confirmed = await confirm({
      title: "Import schedule snapshot?",
      message:
        "This replaces the current assignments with the snapshot. " +
        "Assignments for clinicians or slots that no longer exist are skipped.",
      confirmLabel: "Import snapshot",
      cancelLabel: "Cancel",
      variant: "warning",
    });
    if (!confirmed) return;

    setSnapshotImporting(true);
    try {
      const result = await onImportScheduleSnapshot(payload);
      setSnapshotImportResult(result);
    } catch (error) {
      setSnapshotImportError(
        error instanceof Error ? error.message : "Snapshot import failed.",
      );
    } finally {
      setSnapshotImporting(false);
    }
  };

  const handleSnapshotFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    handleSnapshotImport(file);
  };

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Settings
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Configure sites, shifts, pools, people, and holidays for your schedule.
          </p>
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Weekly Calendar Template
            </div>
            <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              Build the slot grid per location and day type.
            </div>
          </div>
        </div>
        <div className="mt-4">
          {weeklyTemplate ? (
            <WeeklyTemplateBuilder
              template={weeklyTemplate}
              locations={locations}
              rows={classRows}
              onChange={onChangeWeeklyTemplate}
              onCreateSection={onCreateSection}
              onUpdateSectionColor={onUpdateSectionColor}
              onRemoveSection={onRemoveSection}
              onAddLocation={onAddLocation}
              onRenameLocation={onRenameLocation}
              onSetLocationColor={onSetLocationColor}
              onRemoveLocation={onRemoveLocation}
              onReorderLocations={onReorderLocations}
            />
          ) : (
            <div className="text-sm text-slate-500 dark:text-slate-400">
              Template is loading...
            </div>
          )}
        </div>
      </div>

      <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <div className="text-base font-semibold text-slate-900 dark:text-slate-100">Pools</div>
          <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Label the system pools used for distribution and vacation.
          </div>
          <div className="mt-4 space-y-3">
            {poolRows.map((row) => (
              <div key={row.id} className="flex items-center gap-4">
                <input
                  type="text"
                  value={row.name}
                  onChange={(e) => onRenamePool(row.id, e.target.value)}
                  className={cx(
                    "w-full max-w-sm rounded-xl border border-slate-200 px-3 py-2 text-sm font-normal text-slate-900",
                    "focus:border-sky-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100",
                  )}
                />
                <span className="text-xs font-semibold text-slate-400 dark:text-slate-500">
                  {poolNoteById[row.id] ?? "Pool"}
                </span>
              </div>
            ))}
          </div>
        </div>

      <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Calendar Layout
              </div>
              <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                Choose how the calendar is displayed. The monthly sheet mirrors the
                clinic&apos;s Excel Arbeitsplan (whole month, horizontal). Desktop only —
                phones keep the daily view.
              </div>
            </div>
            <CustomSelect
              className="w-80"
              value={solverSettings.scheduleLayout ?? "classic"}
              onChange={(value) =>
                onChangeSolverSettings({
                  ...solverSettings,
                  scheduleLayout: value === "clinicSheet" ? "clinicSheet" : "classic",
                })
              }
              options={[
                { value: "classic", label: "Standard — weekly grid" },
                {
                  value: "clinicSheet",
                  label: "Klinik-Monatslayout — monthly sheet (Arbeitsplan)",
                },
              ]}
            />
          </div>
        </div>

      <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Solver Settings
              </div>
              <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                Control solver behavior and on-call rest days.
              </div>
            </div>
          </div>
          <div className="mt-4 space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/70">
              <div>
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Enforce same location per day
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  When multiple shifts per day, all must share the same location.
                </div>
              </div>
              <ToggleSwitch
                label="Enforce same location per day"
                checked={solverSettings.enforceSameLocationPerDay}
                onToggle={() =>
                  onChangeSolverSettings({
                    ...solverSettings,
                    enforceSameLocationPerDay: !solverSettings.enforceSameLocationPerDay,
                  })
                }
              />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/70">
              <div>
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Enforce continuous shifts
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Prevents new gaps: assignments must be consecutive at the same location.
                </div>
              </div>
              <ToggleSwitch
                label="Enforce continuous shifts"
                checked={solverSettings.preferContinuousShifts}
                onToggle={() =>
                  onChangeSolverSettings({
                    ...solverSettings,
                    preferContinuousShifts: !solverSettings.preferContinuousShifts,
                  })
                }
              />
            </div>
            <AgentSettingsPanel isAdmin={isAdmin} />
            <div className="space-y-3 rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/70">
              <label className="flex flex-wrap items-center gap-3 text-sm font-semibold">
                Planning quality profile
                <select value={solverSettings.agentQualityProfile ?? "classic"}
                  onChange={event => onChangeSolverSettings({ ...solverSettings,
                    agentQualityProfile: event.target.value as "classic" | "balanced" })}
                  className="rounded-lg border border-slate-200 bg-transparent px-3 py-2 dark:border-slate-700">
                  <option value="classic">Classic</option>
                  <option value="balanced">Balanced (preview)</option>
                </select>
              </label>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Both prioritize safe coverage. Balanced also scores section priority, short and long days,
                preferred days off, recent duty distribution and changes to existing assignments.
                The same safety rules apply to both profiles.
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={solverSettings.agentNeighborhoodSearch ?? false}
                  onChange={event => onChangeSolverSettings({ ...solverSettings,
                    agentNeighborhoodSearch: event.target.checked })} />
                Try extended swaps across nearby days (experimental)
              </label>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Searches up to three days together to repair gaps. May use more planning time.
              </p>
            </div>
            <div className="flex flex-col gap-2 rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/70">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    AI agent instructions
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Free-text guidance the AI agent follows in addition to the fixed rules above.
                    You can refer to people and sections by name — the AI sees the plan with
                    real names (use a self-hosted endpoint if data must stay in-house).
                    Clear the field to run without extra instructions.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    onChangeSolverSettings({
                      ...solverSettings,
                      agentInstructions: DEFAULT_AGENT_INSTRUCTIONS,
                    })
                  }
                  className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Reset to default
                </button>
              </div>
              <textarea
                value={solverSettings.agentInstructions ?? DEFAULT_AGENT_INSTRUCTIONS}
                onChange={(event) =>
                  onChangeSolverSettings({
                    ...solverSettings,
                    agentInstructions: event.target.value,
                  })
                }
                rows={4}
                maxLength={2000}
                placeholder="e.g. Dr. Meier should not work Fridays. Prefer two long shifts over four short ones."
                className="w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:placeholder:text-slate-500"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/70">
              <div>
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Section priority order
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Drag to reorder. Top blocks get higher solver priority.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowSectionOrder(true)}
                disabled={sectionBlocks.length === 0}
                className={cx(
                  "rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600",
                  "hover:bg-slate-50 hover:text-slate-900",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  "dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800",
                )}
              >
                Order sections
              </button>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/70">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  On-call rest days
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Place people into the Rest Day pool before or after an on-call duty.
                </div>
              </div>
              <ToggleSwitch
                label="On-call rest days"
                checked={solverSettings.onCallRestEnabled}
                onToggle={() =>
                  onChangeSolverSettings({
                    ...solverSettings,
                    onCallRestEnabled: !solverSettings.onCallRestEnabled,
                    onCallRestClassId: onCallRestClassId || solverSettings.onCallRestClassId,
                  })
                }
              />
            </div>
            <div
              className={cx(
                "mt-3 grid gap-3 sm:grid-cols-3",
                !solverSettings.onCallRestEnabled && "opacity-60",
              )}
            >
              <div className="flex flex-col gap-1 text-xs font-semibold text-slate-600 dark:text-slate-300">
                Section
                <CustomSelect
                  value={onCallRestClassId}
                  onChange={(value) =>
                    onChangeSolverSettings({
                      ...solverSettings,
                      onCallRestClassId: value,
                    })
                  }
                  options={solverSectionRows.map((row) => ({
                    value: row.id,
                    label: row.name,
                  }))}
                  disabled={!solverSettings.onCallRestEnabled}
                />
              </div>
              <div className="flex flex-col gap-1 text-xs font-semibold text-slate-600 dark:text-slate-300">
                Days before
                <CustomNumberInput
                  value={solverSettings.onCallRestDaysBefore}
                  onChange={(value) =>
                    onChangeSolverSettings({
                      ...solverSettings,
                      onCallRestDaysBefore: value,
                    })
                  }
                  min={0}
                  max={7}
                  disabled={!solverSettings.onCallRestEnabled}
                />
              </div>
              <div className="flex flex-col gap-1 text-xs font-semibold text-slate-600 dark:text-slate-300">
                Days after
                <CustomNumberInput
                  value={solverSettings.onCallRestDaysAfter}
                  onChange={(value) =>
                    onChangeSolverSettings({
                      ...solverSettings,
                      onCallRestDaysAfter: value,
                    })
                  }
                  min={0}
                  max={7}
                  disabled={!solverSettings.onCallRestEnabled}
                />
              </div>
            </div>
          </div>
        </div>

      <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-base font-semibold text-slate-900 dark:text-slate-100">
                People
              </div>
              <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                Add clinicians and open their details for editing.
              </div>
            </div>
          </div>
          <div className="mt-5 divide-y divide-slate-200 rounded-xl border border-slate-200 dark:border-slate-800 dark:divide-slate-800">
            {clinicians.map((clinician) => (
              <div
                key={clinician.id}
                className="flex items-center justify-between gap-4 px-4 py-3 dark:bg-slate-900/70"
              >
                <div className="text-sm font-normal text-slate-900 dark:text-slate-100">
                  {clinician.name}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onEditClinician(clinician.id)}
                    className={buttonSmall.base}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      // Removing a person also deletes their assignments in
                      // all weeks; there is no undo.
                      const confirmed = await confirm({
                        title: "Remove person",
                        message: `Remove ${clinician.name}? Their assignments in all weeks, vacations and preferences are deleted. This cannot be undone.`,
                        confirmLabel: "Remove",
                        cancelLabel: "Cancel",
                        variant: "danger",
                      });
                      if (confirmed) onRemoveClinician(clinician.id);
                    }}
                    className={buttonDanger.base}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowNewClinician(true)}
              className={buttonAdd.base}
            >
              Add Person
            </button>
          </div>
          {showNewClinician ? (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                New person
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <input
                  type="text"
                  value={newClinicianName}
                  onChange={(e) => setNewClinicianName(e.target.value)}
                  placeholder="Person name"
                  className={cx(
                    "w-full max-w-xs rounded-xl border border-slate-200 px-3 py-2 text-sm font-normal text-slate-900",
                    "focus:border-sky-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100",
                  )}
                />
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={newClinicianHours}
                  onChange={(event) => setNewClinicianHours(event.target.value)}
                  placeholder="Hours/week"
                  className={cx(
                    "w-32 rounded-xl border border-slate-200 px-3 py-2 text-sm font-normal text-slate-900",
                    "focus:border-sky-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:[color-scheme:dark]",
                  )}
                />
                <button
                  type="button"
                  onClick={() => {
                    const trimmed = newClinicianName.trim();
                    if (!trimmed) return;
                    const hoursValue = newClinicianHours.trim();
                    const parsed = hoursValue ? Number(hoursValue) : null;
                    if (hoursValue && !Number.isFinite(parsed)) return;
                    const workingHours =
                      parsed !== null ? Math.max(0, parsed) : undefined;
                    onAddClinician(trimmed, workingHours);
                    setNewClinicianName("");
                    setNewClinicianHours("");
                    setShowNewClinician(false);
                  }}
                  className={buttonPrimary.base}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowNewClinician(false);
                    setNewClinicianName("");
                    setNewClinicianHours("");
                  }}
                  className={buttonSecondary.base}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </div>

      <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Holidays
              </div>
              <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                Load public holidays and maintain the calendar list.
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Year
              </span>
              <div
                className={cx(
                  "inline-flex h-10 items-center rounded-full border border-slate-200 bg-white px-1 shadow-sm",
                  "dark:border-slate-700 dark:bg-slate-900/60",
                )}
              >
                <button
                  type="button"
                  onClick={() => onChangeHolidayYear(Math.max(1970, holidayYear - 1))}
                  className={cx(
                    "grid h-8 w-8 place-items-center rounded-full text-sm font-semibold text-slate-600",
                    "hover:bg-slate-100 active:bg-slate-200/80",
                    "dark:text-slate-300 dark:hover:bg-slate-800/70",
                  )}
                  aria-label="Previous year"
                >
                  {"<"}
                </button>
                <div className="min-w-[72px] text-center text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                  {holidayYear}
                </div>
                <button
                  type="button"
                  onClick={() => onChangeHolidayYear(holidayYear + 1)}
                  className={cx(
                    "grid h-8 w-8 place-items-center rounded-full text-sm font-semibold text-slate-600",
                    "hover:bg-slate-100 active:bg-slate-200/80",
                    "dark:text-slate-300 dark:hover:bg-slate-800/70",
                  )}
                  aria-label="Next year"
                >
                  {">"}
                </button>
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              Preload holidays
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <CustomSelect
                value={normalizedCountry}
                onChange={(value) => onChangeHolidayCountry(value.toUpperCase())}
                options={[
                  ...(!hasCountryOption
                    ? [{ value: normalizedCountry, label: normalizedCountry }]
                    : []),
                  ...countryOptions.map((option) => ({
                    value: option.code,
                    label: option.label,
                  })),
                ]}
                className="w-56"
              />
              <button
                type="button"
                onClick={async () => {
                  setHolidayError(null);
                  setIsFetchingHolidays(true);
                  try {
                    await onFetchHolidays(normalizedCountry, holidayYear);
                  } catch (error) {
                    setHolidayError(
                      error instanceof Error
                        ? error.message
                        : "Failed to fetch holidays.",
                    );
                  } finally {
                    setIsFetchingHolidays(false);
                  }
                }}
                className={cx(
                  "h-10 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-900 shadow-sm",
                  "hover:bg-slate-50 active:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-70",
                  "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
                )}
                disabled={!normalizedCountry || isFetchingHolidays}
              >
                {isFetchingHolidays ? "Loading..." : "Load Holidays"}
              </button>
            </div>
            {holidayError ? (
              <div className="text-xs font-semibold text-rose-600 dark:text-rose-200">
                {holidayError}
              </div>
            ) : null}
          </div>

          <div className="mt-6 flex flex-col gap-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              List of holidays that will be added to the calendar
            </div>
            <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:border-slate-800 dark:divide-slate-800">
            {holidaysForYear.length === 0 ? (
              <div className="px-4 py-4 text-sm text-slate-500 dark:text-slate-300">
                No holidays added for this year yet.
              </div>
            ) : (
              holidaysForYear.map((holiday) => (
                <div
                  key={`${holiday.dateISO}-${holiday.name}`}
                  className="grid grid-cols-[120px_1fr_auto] items-center gap-4 px-4 py-3 dark:bg-slate-900/70"
                >
                  <div className="text-sm font-normal text-slate-900 dark:text-slate-100">
                    {formatHolidayDate(holiday.dateISO)}
                  </div>
                  <div className="text-sm text-slate-600 dark:text-slate-300">
                    {holiday.name}
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveHoliday(holiday)}
                    className={buttonSmall.base}
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
            </div>
          </div>
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowNewHoliday(true)}
              className={buttonAdd.base}
            >
              Add Holiday
            </button>
          </div>
          {showNewHoliday ? (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                New holiday
              </div>
              <div className="mt-3 flex flex-wrap gap-3">
                <div className="w-40">
                  <CustomDatePicker
                    value={newHolidayDate}
                    onChange={(value) => {
                      setNewHolidayDate(value);
                      setHolidayInputError(null);
                    }}
                    placeholder="DD.MM.YYYY"
                    hasError={!!holidayInputError}
                  />
                </div>
                <input
                  type="text"
                  value={newHolidayName}
                  onChange={(event) => setNewHolidayName(event.target.value)}
                  placeholder="Holiday name"
                  className={cx(
                    "w-full max-w-xs rounded-xl border border-slate-200 px-3 py-2 text-sm font-normal text-slate-900",
                    "focus:border-sky-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100",
                  )}
                />
                <button
                  type="button"
                  onClick={() => {
                    const trimmedName = newHolidayName.trim();
                    const parsedDate = parseHolidayDate(newHolidayDate);
                    if (!parsedDate || !trimmedName) {
                      setHolidayInputError(
                        "Please select a date and enter a holiday name.",
                      );
                      return;
                    }
                    onAddHoliday({ dateISO: parsedDate, name: trimmedName });
                    setNewHolidayDate("");
                    setNewHolidayName("");
                    setHolidayInputError(null);
                    setShowNewHoliday(false);
                  }}
                  className={buttonPrimary.base}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowNewHoliday(false);
                    setNewHolidayDate("");
                    setNewHolidayName("");
                    setHolidayInputError(null);
                  }}
                  className={buttonSecondary.base}
                >
                  Cancel
                </button>
              </div>
              {holidayInputError ? (
                <div className="mt-2 text-xs font-semibold text-rose-600 dark:text-rose-200">
                  {holidayInputError}
                </div>
              ) : null}
            </div>
          ) : null}
      </div>

      {showSectionOrder ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setShowSectionOrder(false);
              setDraggingSectionBlockId(null);
              setDragOverSectionBlockId(null);
            }
          }}
        >
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-800 dark:bg-slate-950">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Section priority order
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Drag to reorder. Top blocks get higher solver priority.
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowSectionOrder(false);
                  setDraggingSectionBlockId(null);
                  setDragOverSectionBlockId(null);
                }}
                className="rounded-full border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Close
              </button>
            </div>
            <div className="mt-4 flex flex-col gap-2">
              {sectionBlocks.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 px-3 py-3 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-300">
                  No section blocks yet.
                </div>
              ) : (
                sectionBlocks.map((block, index) => {
                  const sectionName =
                    sectionNameById.get(block.sectionId) ?? "Section";
                  return (
                    <div
                      key={block.id}
                      className={cx(
                        "flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm",
                        "dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200",
                        dragOverSectionBlockId === block.id &&
                          "border-sky-300 bg-sky-50",
                      )}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData(
                          "application/x-block-id",
                          block.id,
                        );
                        setDraggingSectionBlockId(block.id);
                        setDragOverSectionBlockId(null);
                      }}
                      onDragEnd={() => {
                        setDraggingSectionBlockId(null);
                        setDragOverSectionBlockId(null);
                      }}
                      onDragOver={(event) => {
                        const activeId =
                          draggingSectionBlockId ||
                          event.dataTransfer.getData("application/x-block-id");
                        if (!activeId || activeId === block.id) return;
                        event.preventDefault();
                        setDragOverSectionBlockId(block.id);
                      }}
                      onDragLeave={() => {
                        setDragOverSectionBlockId((prev) =>
                          prev === block.id ? null : prev,
                        );
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const activeId =
                          draggingSectionBlockId ||
                          event.dataTransfer.getData("application/x-block-id");
                        if (!activeId || activeId === block.id) return;
                        reorderSectionBlocks(activeId, block.id);
                        setDraggingSectionBlockId(null);
                        setDragOverSectionBlockId(null);
                      }}
                    >
                      <span className="text-xs font-semibold text-slate-400 dark:text-slate-500">
                        {index + 1}
                      </span>
                      <span>{sectionName}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Schedule snapshot
            </h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Export the current assignments to a file and restore them later. Import replaces
              assignments and skips clinicians or slots that no longer exist.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onExportScheduleSnapshot}
              className={buttonSecondary.base}
            >
              Download snapshot
            </button>
            <label
              className={cx(
                buttonPrimary.base,
                snapshotImporting && "pointer-events-none opacity-70",
              )}
            >
              {snapshotImporting ? "Importing..." : "Import snapshot"}
              <input
                type="file"
                accept="application/json"
                className="hidden"
                onChange={handleSnapshotFileChange}
                disabled={snapshotImporting}
              />
            </label>
          </div>
        </div>
        {snapshotImportResult ? (
          <div className="mt-3 text-xs text-emerald-600 dark:text-emerald-400">
            Imported {snapshotImportResult.imported} assignments. Skipped{" "}
            {snapshotImportResult.droppedClinicians} clinician(s) and{" "}
            {snapshotImportResult.droppedSlots} slot(s).
          </div>
        ) : null}
        {snapshotImportError ? (
          <div className="mt-3 text-xs text-rose-600 dark:text-rose-400">
            {snapshotImportError}
          </div>
        ) : null}
      </div>

      {/* Database Health Check - at the very bottom */}
      <div className="mt-6">
        <DatabaseHealthCheck />
      </div>
    </div>
  );
}
