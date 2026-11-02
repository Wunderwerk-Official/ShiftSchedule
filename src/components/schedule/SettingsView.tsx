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
import { HOLIDAY_REGIONS, holidayRegionForCountry } from "../../lib/holidays";
import AgentSettingsPanel from "./AgentSettingsPanel";
import WeeklyTemplateBuilder, { SECTION_PRIORITY_HELP } from "./WeeklyTemplateBuilder";
import CustomSelect from "./CustomSelect";
import CustomNumberInput from "./CustomNumberInput";
import CustomDatePicker from "./CustomDatePicker";
import DatabaseHealthCheck from "./DatabaseHealthCheck";
import ToggleSwitch from "./ToggleSwitch";
import { useConfirm } from "../ui/ConfirmDialog";
import {
  describeShiftsImportQuestion,
  describeShiftsImportResult,
  MAX_SHIFTS_FILE_BYTES,
  SHIFTS_FILE_TOO_LARGE_MESSAGE,
  type PreparedShiftsImport,
  type ShiftsImportResult,
} from "../../lib/shiftsFileImport";

type SettingsViewProps = {
  classRows: WorkplaceRow[];
  poolRows: WorkplaceRow[];
  locations: Location[];
  clinicians: Array<{ id: string; name: string }>;
  holidays: Holiday[];
  holidayCountry: string;
  /** ISO 3166-2 code ("DE-NW") Load filters by; undefined = all regions. */
  holidayRegion?: string;
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
  onChangeHolidayRegion: (region: string | undefined) => void;
  onChangeHolidayYear: (year: number) => void;
  // Holiday changes ask first when they remove shifts that no longer fit
  // their day; they reject when the change could not be applied.
  /** Loads the public holidays; resolves to how many were added, null when cancelled. */
  onFetchHolidays: (countryCode: string, year: number, region?: string) => Promise<number | null>;
  /** Resolves to false when cancelled. */
  onAddHoliday: (holiday: Holiday) => Promise<boolean>;
  /** Resolves to false when cancelled. */
  onRemoveHoliday: (holiday: Holiday) => Promise<boolean>;
  onChangeSolverSettings: (settings: SolverSettings) => void;
  onChangeWeeklyTemplate: (template: WeeklyCalendarTemplate) => void;
  onCreateSection: (name: string) => string;
  onUpdateSectionColor: (sectionId: string, color: string | null) => void;
  onRemoveSection?: (sectionId: string) => void;
  onExportScheduleSnapshot: () => void;
  /** Checks a shifts file (throws with a message); the result's `apply` imports it. */
  onPrepareShiftsFileImport: (payload: unknown) => PreparedShiftsImport;
  isAdmin?: boolean;
};

export default function SettingsView({
  classRows,
  poolRows,
  locations,
  clinicians,
  holidays,
  holidayCountry,
  holidayRegion,
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
  onChangeHolidayRegion,
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
  onPrepareShiftsFileImport,
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
  // The stored list is never rewritten by a region change, so say so until
  // the next load.
  const [holidayRegionChanged, setHolidayRegionChanged] = useState(false);
  const [holidayError, setHolidayError] = useState<string | null>(null);
  const [holidayNotice, setHolidayNotice] = useState<string | null>(null);
  const [holidayInputError, setHolidayInputError] = useState<string | null>(null);
  // Only a missing date or name marks the date field: a refused change (busy,
  // failed backup) keeps a valid date unmarked.
  const [holidayDateInvalid, setHolidayDateInvalid] = useState(false);
  const [holidayListError, setHolidayListError] = useState<string | null>(null);
  const [snapshotImportError, setSnapshotImportError] = useState<string | null>(null);
  const [snapshotImportResult, setSnapshotImportResult] =
    useState<ShiftsImportResult | null>(null);
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
  // Load Holidays uses exactly the region the select shows: none for a
  // country without a region list or for a region of another country.
  const regionSet = HOLIDAY_REGIONS[normalizedCountry];
  const selectedRegion = regionSet
    ? holidayRegionForCountry(normalizedCountry, holidayRegion)
    : undefined;
  const regionOptions = regionSet
    ? [
        { value: "", label: `All ${regionSet.plural}` },
        ...(selectedRegion && !regionSet.regions.some((region) => region.code === selectedRegion)
          ? [{ value: selectedRegion, label: selectedRegion }]
          : []),
        ...regionSet.regions.map((region) => ({ value: region.code, label: region.name })),
      ]
    : [];
  const selectedRegionLabel =
    regionOptions.find((option) => option.value === (selectedRegion ?? ""))?.label ?? "";
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
      "Filled by the on-call rest rule. Names you drag in mark a day off: automatic planning leaves that person free that day.",
    "pool-vacation":
      "Filled from each person's vacation periods. Drag someone in to add a vacation day, or out to end it.",
  };
  const poolInputLabelById: Record<string, string> = {
    "pool-rest-day": "Rest Day row name",
    "pool-vacation": "Vacation row name",
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

  // The file is read and checked first; only an import that would bring
  // shifts asks to replace the current ones (with both counts).
  const handleSnapshotImport = async (file: File) => {
    setSnapshotImportError(null);
    setSnapshotImportResult(null);

    if (file.size > MAX_SHIFTS_FILE_BYTES) {
      setSnapshotImportError(SHIFTS_FILE_TOO_LARGE_MESSAGE);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await file.text());
    } catch (error) {
      setSnapshotImportError(
        "This file could not be read. Choose a .json file made with 'Download shifts file'.",
      );
      return;
    }

    let prepared: PreparedShiftsImport;
    try {
      prepared = onPrepareShiftsFileImport(payload);
    } catch (error) {
      setSnapshotImportError(error instanceof Error ? error.message : "Import failed.");
      return;
    }

    const confirmed = await confirm({
      title: "Replace all shifts?",
      message: describeShiftsImportQuestion(prepared, file.name),
      confirmLabel: "Replace shifts",
      cancelLabel: "Cancel",
      variant: "warning",
    });
    if (!confirmed) return;

    setSnapshotImporting(true);
    try {
      setSnapshotImportResult(await prepared.apply());
    } catch (error) {
      setSnapshotImportError(
        error instanceof Error ? error.message : "Import failed.",
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

  // Maintenance tools (database health check, inspector) stay folded away.
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Settings
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Set up locations, shifts, people, holidays and planning rules for your schedule.
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
              Defines every shift: rows are workplaces per location, columns are shift times
              per weekday and for holidays.
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
          <div className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Rest Day &amp; Vacation rows
          </div>
          <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Rename the two built-in rows below the shifts in the calendar. Only the displayed
            name changes.
          </div>
          <div className="mt-4 space-y-3">
            {poolRows.map((row) => (
              <div key={row.id} className="flex items-center gap-4">
                <input
                  type="text"
                  value={row.name}
                  onChange={(e) => onRenamePool(row.id, e.target.value)}
                  aria-label={poolInputLabelById[row.id] ?? "Row name"}
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
                Planning rules &amp; AI
              </div>
              <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                Rules and goals for automatic planning, and the AI it uses. Locked shifts are
                never changed.
              </div>
            </div>
          </div>
          <div className="mt-4 space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/70">
              <div>
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  One location per person per day
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Several shifts on one day stay at one location (the person picker warns
                  otherwise). Off: a day may span locations.
                </div>
              </div>
              <ToggleSwitch
                label="One location per person per day"
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
                  No gaps within a working day
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  A person&apos;s shifts on one day follow each other without a break (08–12 +
                  12–16, not 08–12 + 14–18). Gaps you set by hand stay.
                </div>
              </div>
              <ToggleSwitch
                label="No gaps within a working day"
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
                Planning goals (AI)
                <select value={solverSettings.agentQualityProfile ?? "classic"}
                  onChange={event => onChangeSolverSettings({ ...solverSettings,
                    agentQualityProfile: event.target.value as "classic" | "balanced" })}
                  className="rounded-lg border border-slate-200 bg-transparent px-3 py-2 dark:border-slate-700">
                  <option value="classic">Classic</option>
                  <option value="balanced">Balanced (preview)</option>
                </select>
              </label>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Both fill required slots first and keep all rules. Classic then avoids short days
                and matches contract hours; Balanced also weighs fair weekend/night/on-call shares,
                days off and fewer changes. On-call shares count only while “Rest days around
                on-call duty” is on (that is where the on-call section is chosen).
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={solverSettings.agentNeighborhoodSearch ?? false}
                  onChange={event => onChangeSolverSettings({ ...solverSettings,
                    agentNeighborhoodSearch: event.target.checked })} />
                Extra search across neighbouring days (experimental)
              </label>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                If a day still has open slots, the AI also tries reshuffling it with the day before
                and after. Locked shifts stay; runs take longer.
              </p>
            </div>
            <div className="flex flex-col gap-2 rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/70">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Instructions for the AI planner
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Plain-language wishes, e.g. who should not work Fridays. Rules, vacations and
                    locked shifts always win. Empty = none.
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
                  Section priority when short-staffed
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {SECTION_PRIORITY_HELP}
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
                Change order
              </button>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/70">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Rest days around on-call duty
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Days before/after a shift in the on-call section stay completely free; they show
                  in the Rest Day row.
                </div>
              </div>
              <ToggleSwitch
                label="Rest days around on-call duty"
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
                On-call section
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
                Rest days before
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
                Rest days after
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
            <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Calendar days, 0–7 (0 = none). Example: 1 after = the day after the duty stays free.
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
                Everyone who can be planned. Edit sets sections, working hours, vacations and
                wishes.
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
                        message: `Remove ${clinician.name}? Their shifts in all weeks, vacations and preferences are deleted. This cannot be undone.`,
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
              <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                Contract hours per week. Empty = no hours target or weekly limit; change it later
                under Edit.
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
                On these dates the calendar uses the template&apos;s Holiday column instead of the
                weekday.
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
              Load public holidays
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Replaces this year&apos;s loaded public holidays; holidays you added by hand stay.
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
                ariaLabel={`Country: ${
                  countryOptions.find((option) => option.code === normalizedCountry)?.label ??
                  normalizedCountry
                }`}
                className="w-56"
              />
              {regionSet ? (
                <CustomSelect
                  value={selectedRegion ?? ""}
                  onChange={(value) => {
                    const nextRegion = value || undefined;
                    if (nextRegion === selectedRegion) return;
                    onChangeHolidayRegion(nextRegion);
                    setHolidayRegionChanged(true);
                  }}
                  options={regionOptions}
                  ariaLabel={`${regionSet.noun[0].toUpperCase()}${regionSet.noun.slice(1)}: ${selectedRegionLabel}`}
                  className="w-56"
                />
              ) : null}
              <button
                type="button"
                onClick={async () => {
                  setHolidayError(null);
                  setHolidayNotice(null);
                  setIsFetchingHolidays(true);
                  try {
                    const added = await onFetchHolidays(
                      normalizedCountry,
                      holidayYear,
                      selectedRegion,
                    );
                    // Cancelled: the list (and the note about it) stays.
                    if (added === null) return;
                    setHolidayRegionChanged(false);
                    setHolidayNotice(
                      `Loaded ${added} public holiday${added === 1 ? "" : "s"} for ${holidayYear}.`,
                    );
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
                {isFetchingHolidays ? "Loading..." : `Load holidays for ${holidayYear}`}
              </button>
            </div>
            {regionSet && !selectedRegion ? (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Without a {regionSet.noun}, the regional holidays of all {regionSet.plural} are
                included.
              </div>
            ) : null}
            {holidayRegionChanged ? (
              <div className="text-xs font-semibold text-amber-700 dark:text-amber-300">
                The list below is unchanged until you load holidays again.
              </div>
            ) : null}
            {holidayError ? (
              <div className="text-xs font-semibold text-rose-600 dark:text-rose-200">
                {holidayError}
              </div>
            ) : null}
            {holidayNotice && !holidayError ? (
              <div role="status" className="text-xs text-emerald-600 dark:text-emerald-400">
                {holidayNotice}
              </div>
            ) : null}
          </div>

          <div className="mt-6 flex flex-col gap-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              Holidays in {holidayYear}
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
                    {holiday.source === "manual" ? (
                      <span className="ml-2 text-xs text-slate-400 dark:text-slate-500">
                        added by hand
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      setHolidayListError(null);
                      try {
                        await onRemoveHoliday(holiday);
                      } catch (error) {
                        setHolidayListError(
                          error instanceof Error ? error.message : "The holiday could not be removed.",
                        );
                      }
                    }}
                    className={buttonSmall.base}
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
            </div>
            {holidayListError ? (
              <div className="text-xs font-semibold text-rose-600 dark:text-rose-200">
                {holidayListError}
              </div>
            ) : null}
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
                      setHolidayDateInvalid(false);
                    }}
                    placeholder="DD.MM.YYYY"
                    hasError={holidayDateInvalid}
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
                  onClick={async () => {
                    const trimmedName = newHolidayName.trim();
                    const parsedDate = parseHolidayDate(newHolidayDate);
                    if (!parsedDate || !trimmedName) {
                      setHolidayInputError(
                        "Please select a date and enter a holiday name.",
                      );
                      setHolidayDateInvalid(true);
                      return;
                    }
                    setHolidayInputError(null);
                    setHolidayDateInvalid(false);
                    let added: boolean;
                    try {
                      added = await onAddHoliday({ dateISO: parsedDate, name: trimmedName });
                    } catch (error) {
                      setHolidayInputError(
                        error instanceof Error ? error.message : "The holiday could not be added.",
                      );
                      return;
                    }
                    // Cancelled: the form stays open with its entries.
                    if (!added) return;
                    setNewHolidayDate("");
                    setNewHolidayName("");
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
                    setHolidayDateInvalid(false);
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
                  Section priority when short-staffed
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {SECTION_PRIORITY_HELP}
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
                  No sections yet.
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
              Shifts file
            </h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Download every week&apos;s shifts as a file. Import replaces all shifts, locked ones
              too; the current calendar is saved in Calendar snapshots first.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onExportScheduleSnapshot}
              className={buttonSecondary.base}
            >
              Download shifts file
            </button>
            <label
              className={cx(
                buttonPrimary.base,
                snapshotImporting && "pointer-events-none opacity-70",
              )}
            >
              {snapshotImporting ? "Importing..." : "Import shifts file…"}
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
            {describeShiftsImportResult(snapshotImportResult)}
          </div>
        ) : null}
        {snapshotImportError ? (
          <div className="mt-3 text-xs text-rose-600 dark:text-rose-400">
            {snapshotImportError}
          </div>
        ) : null}
      </div>

      {/* Advanced (at the very bottom, collapsed): database health check and
          inspector link. The check only mounts (and loads) when opened. */}
      <div className="mt-6">
        <button
          type="button"
          aria-expanded={advancedOpen}
          aria-controls="settings-advanced"
          onClick={() => setAdvancedOpen((open) => !open)}
          className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left shadow-sm transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
        >
          <span>
            <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">Advanced</span>
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              Read-only troubleshooting: check saved data for errors and browse slots and shifts
              by week.
            </span>
          </span>
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cx("h-4 w-4 shrink-0 text-slate-400 transition-transform", advancedOpen && "rotate-90")}
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
        {advancedOpen ? (
          <div id="settings-advanced" className="mt-3">
            <DatabaseHealthCheck />
          </div>
        ) : null}
      </div>
    </div>
  );
}
