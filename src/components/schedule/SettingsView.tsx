import { useEffect, useState, type ChangeEvent } from "react";
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
  AgentChatTestResult,
  AgentSettings,
  AgentSettingsUpdate,
  Holiday,
  SolverSettings,
  WeeklyCalendarTemplate,
} from "../../api/client";
import { agentChatTest, fetchAgentSettings, updateAgentSettings } from "../../api/client";
import { AGENT_MODEL_OPTIONS, formatCostUSD } from "../../lib/llmPricing";
import { DEFAULT_AGENT_INSTRUCTIONS } from "../../lib/agentSettings";
import WeeklyTemplateBuilder from "./WeeklyTemplateBuilder";
import CustomSelect from "./CustomSelect";
import CustomNumberInput from "./CustomNumberInput";
import CustomDatePicker from "./CustomDatePicker";
import DatabaseHealthCheck from "./DatabaseHealthCheck";
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
  // Global agent settings (admin-chosen provider/model + per-account budget).
  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(null);
  const [agentSettingsError, setAgentSettingsError] = useState<string | null>(null);
  // Local editing state for the self-hosted endpoint + API keys. Key inputs
  // always start empty — the stored values never come back from the server.
  const [openaiBaseUrlInput, setOpenaiBaseUrlInput] = useState("");
  const [openaiModelInput, setOpenaiModelInput] = useState("");
  const [openaiKeyInput, setOpenaiKeyInput] = useState("");
  const [anthropicKeyInput, setAnthropicKeyInput] = useState("");
  useEffect(() => {
    let cancelled = false;
    fetchAgentSettings()
      .then((settings) => {
        if (cancelled) return;
        setAgentSettings(settings);
        setOpenaiBaseUrlInput(settings.openai_base_url ?? "");
        setOpenaiModelInput(settings.openai_model ?? "");
      })
      .catch(() => {
        if (!cancelled) setAgentSettingsError("Could not load AI agent settings.");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const applyAgentSettings = async (patch: AgentSettingsUpdate) => {
    try {
      setAgentSettingsError(null);
      const updated = await updateAgentSettings(patch);
      setAgentSettings((prev) =>
        prev ? { ...prev, ...updated } : prev,
      );
    } catch {
      setAgentSettingsError("Could not save AI agent settings.");
    }
  };
  // Admin model test: a direct chat with the configured model, kept only in
  // memory. Each reply carries latency / token-throughput measurements.
  type ChatTestEntry =
    | { role: "user"; content: string }
    | { role: "assistant"; content: string; reasoning: string | null; result: AgentChatTestResult };
  const [chatTestEntries, setChatTestEntries] = useState<ChatTestEntry[]>([]);
  const [chatTestInput, setChatTestInput] = useState("");
  const [chatTestPending, setChatTestPending] = useState(false);
  const [chatTestElapsed, setChatTestElapsed] = useState(0);
  const [chatTestError, setChatTestError] = useState<string | null>(null);
  useEffect(() => {
    if (!chatTestPending) return;
    const startedAt = Date.now();
    setChatTestElapsed(0);
    const id = window.setInterval(
      () => setChatTestElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, [chatTestPending]);
  const sendChatTest = async () => {
    const content = chatTestInput.trim();
    if (!content || chatTestPending) return;
    const history = [...chatTestEntries, { role: "user" as const, content }];
    setChatTestEntries(history);
    setChatTestInput("");
    setChatTestError(null);
    setChatTestPending(true);
    try {
      const result = await agentChatTest(
        history.map((entry) => ({ role: entry.role, content: entry.content })),
      );
      if (result.error) {
        setChatTestError(result.error);
      } else {
        setChatTestEntries((prev) => [
          ...prev,
          {
            role: "assistant",
            content: result.text ?? "(empty response)",
            reasoning: result.reasoning,
            result,
          },
        ]);
      }
    } catch (err) {
      setChatTestError(err instanceof Error ? err.message : "Model test failed.");
    } finally {
      setChatTestPending(false);
    }
  };
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
  const parseHolidayDate = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const dotMatch = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (dotMatch) {
      const [, dayRaw, monthRaw, yearRaw] = dotMatch;
      const day = Number(dayRaw);
      const month = Number(monthRaw);
      const year = Number(yearRaw);
      if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) {
        return null;
      }
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month) {
        return null;
      }
      return `${yearRaw.padStart(4, "0")}-${monthRaw.padStart(2, "0")}-${dayRaw.padStart(
        2,
        "0",
      )}`;
    }
    const textMatch = trimmed.match(
      /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\s*,?\s+(\d{4})$/,
    );
    if (textMatch) {
      const [, dayRaw, monthRaw, yearRaw] = textMatch;
      const monthKey = monthRaw.toLowerCase();
      const monthMap: Record<string, number> = {
        jan: 1,
        january: 1,
        feb: 2,
        february: 2,
        mar: 3,
        march: 3,
        apr: 4,
        april: 4,
        may: 5,
        jun: 6,
        june: 6,
        jul: 7,
        july: 7,
        aug: 8,
        august: 8,
        sep: 9,
        sept: 9,
        september: 9,
        oct: 10,
        october: 10,
        nov: 11,
        november: 11,
        dec: 12,
        december: 12,
      };
      const month = monthMap[monthKey];
      const day = Number(dayRaw);
      const year = Number(yearRaw);
      if (!month || !Number.isFinite(day) || !Number.isFinite(year)) return null;
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month) {
        return null;
      }
      return `${yearRaw}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return null;
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
              <button
                type="button"
                role="switch"
                aria-checked={solverSettings.enforceSameLocationPerDay}
                onClick={() =>
                  onChangeSolverSettings({
                    ...solverSettings,
                    enforceSameLocationPerDay: !solverSettings.enforceSameLocationPerDay,
                  })
                }
                className={cx(
                  "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                  solverSettings.enforceSameLocationPerDay
                    ? "bg-emerald-500"
                    : "bg-slate-300 dark:bg-slate-700",
                )}
              >
                <span
                  className={cx(
                    "inline-block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition-transform",
                    solverSettings.enforceSameLocationPerDay && "translate-x-[22px]",
                  )}
                />
              </button>
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
              <button
                type="button"
                role="switch"
                aria-checked={solverSettings.preferContinuousShifts}
                onClick={() =>
                  onChangeSolverSettings({
                    ...solverSettings,
                    preferContinuousShifts: !solverSettings.preferContinuousShifts,
                  })
                }
                className={cx(
                  "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                  solverSettings.preferContinuousShifts
                    ? "bg-emerald-500"
                    : "bg-slate-300 dark:bg-slate-700",
                )}
              >
                <span
                  className={cx(
                    "inline-block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition-transform",
                    solverSettings.preferContinuousShifts && "translate-x-[22px]",
                  )}
                />
              </button>
            </div>
            <div className="flex flex-col gap-3 rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/70">
              {isAdmin ? (
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      AI provider
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Anthropic (paid API), or a self-hosted OpenAI-compatible
                      endpoint such as vLLM. Applies to every planning run, for all users.
                    </div>
                  </div>
                  <CustomSelect
                    className="w-80"
                    value={agentSettings?.provider ?? "anthropic"}
                    onChange={(value) =>
                      void applyAgentSettings({ provider: value as "anthropic" | "openai" })
                    }
                    options={[
                      { value: "anthropic", label: "Anthropic (Claude)" },
                      { value: "openai", label: "Self-hosted / OpenAI-compatible (vLLM, …)" },
                    ]}
                  />
                </div>
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    AI agent model
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {isAdmin
                      ? agentSettings?.provider === "openai"
                        ? "Model name served by your endpoint (e.g. meta-llama/Llama-3.3-70B-Instruct)."
                        : "Claude model used by every planning run, for all users. Costs are rough estimates — the exact cost of each run shows in the solver history (gear icon)."
                      : "Set by your administrator and used for every planning run."}
                  </div>
                </div>
                {isAdmin && agentSettings?.provider !== "openai" ? (
                  <CustomSelect
                    className="w-80"
                    value={agentSettings?.model ?? AGENT_MODEL_OPTIONS[0].id}
                    onChange={(value) => void applyAgentSettings({ model: value })}
                    options={AGENT_MODEL_OPTIONS.map((option) => ({
                      value: option.id,
                      label: `${option.label} — ${option.description} · ${option.approxRunCost}`,
                    }))}
                  />
                ) : isAdmin ? (
                  <input
                    type="text"
                    value={openaiModelInput}
                    onChange={(event) => setOpenaiModelInput(event.target.value)}
                    onBlur={() => void applyAgentSettings({ openai_model: openaiModelInput })}
                    placeholder="model name on your endpoint"
                    className="w-80 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-indigo-300 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                  />
                ) : (
                  <div className="rounded-full border border-slate-200 px-3 py-1 text-sm font-medium text-slate-700 dark:border-slate-700 dark:text-slate-200">
                    {AGENT_MODEL_OPTIONS.find((o) => o.id === agentSettings?.effective_model)
                      ?.label ??
                      agentSettings?.effective_model ??
                      "…"}
                  </div>
                )}
              </div>
              {isAdmin && agentSettings?.provider === "openai" ? (
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Endpoint base URL
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      OpenAI-compatible server, e.g. http://10.0.0.5:8000/v1 for vLLM
                      (start vLLM with --enable-auto-tool-choice and a tool-call parser).
                    </div>
                  </div>
                  <input
                    type="text"
                    value={openaiBaseUrlInput}
                    onChange={(event) => setOpenaiBaseUrlInput(event.target.value)}
                    onBlur={() => void applyAgentSettings({ openai_base_url: openaiBaseUrlInput })}
                    placeholder="http://host:8000/v1"
                    className="w-80 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-indigo-300 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                  />
                </div>
              ) : null}
              {isAdmin && agentSettings?.provider === "openai" ? (
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Verify TLS certificate
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Switch off only for self-signed certificates on a trusted
                      internal network (https:// endpoints without a public CA).
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={agentSettings?.openai_verify_tls !== false}
                    onClick={() =>
                      void applyAgentSettings({
                        openai_verify_tls: !(agentSettings?.openai_verify_tls !== false),
                      })
                    }
                    className={cx(
                      "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                      agentSettings?.openai_verify_tls !== false
                        ? "bg-emerald-500"
                        : "bg-slate-300 dark:bg-slate-700",
                    )}
                  >
                    <span
                      className={cx(
                        "inline-block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition-transform",
                        agentSettings?.openai_verify_tls !== false && "translate-x-[22px]",
                      )}
                    />
                  </button>
                </div>
              ) : null}
              {isAdmin ? (
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {agentSettings?.provider === "openai"
                        ? "Endpoint API key (optional)"
                        : "Anthropic API key"}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {agentSettings?.provider === "openai"
                        ? agentSettings?.openai_api_key_set
                          ? "A key is stored. Most self-hosted servers don't need one."
                          : "Most self-hosted servers don't need one — leave empty."
                        : agentSettings?.anthropic_api_key_set
                          ? "A key is stored in the app settings and overrides the server .env."
                          : agentSettings?.anthropic_env_key_present
                            ? "Currently using the key from the server .env. Enter one here to override it."
                            : "No key configured yet — agent runs fall back to the draft plan."}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value={
                        agentSettings?.provider === "openai" ? openaiKeyInput : anthropicKeyInput
                      }
                      onChange={(event) =>
                        agentSettings?.provider === "openai"
                          ? setOpenaiKeyInput(event.target.value)
                          : setAnthropicKeyInput(event.target.value)
                      }
                      placeholder={
                        (agentSettings?.provider === "openai"
                          ? agentSettings?.openai_api_key_set
                          : agentSettings?.anthropic_api_key_set)
                          ? "•••••••• (stored)"
                          : "paste key"
                      }
                      autoComplete="off"
                      className="w-56 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-indigo-300 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                    />
                    <button
                      type="button"
                      disabled={
                        !(agentSettings?.provider === "openai" ? openaiKeyInput : anthropicKeyInput)
                      }
                      onClick={() => {
                        if (agentSettings?.provider === "openai") {
                          void applyAgentSettings({ openai_api_key: openaiKeyInput }).then(() => {
                            setOpenaiKeyInput("");
                            setAgentSettings((prev) =>
                              prev ? { ...prev, openai_api_key_set: true } : prev,
                            );
                          });
                        } else {
                          void applyAgentSettings({ anthropic_api_key: anthropicKeyInput }).then(
                            () => {
                              setAnthropicKeyInput("");
                              setAgentSettings((prev) =>
                                prev ? { ...prev, anthropic_api_key_set: true } : prev,
                              );
                            },
                          );
                        }
                      }}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      Save key
                    </button>
                  </div>
                </div>
              ) : null}
              {isAdmin ? (
                <div className="flex flex-col gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                  <div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Model connection test
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Chat directly with the configured model to check that the endpoint
                      works and how fast it generates. Replies show latency and token
                      throughput{agentSettings?.provider === "openai"
                        ? "."
                        : "; Anthropic test messages count toward the AI budget."}
                    </div>
                  </div>
                  {chatTestEntries.length > 0 && (
                    <div className="flex max-h-72 flex-col gap-2 overflow-y-auto rounded-lg bg-slate-50 p-2 dark:bg-slate-950/40">
                      {chatTestEntries.map((entry, index) =>
                        entry.role === "user" ? (
                          <div key={index} className="self-end rounded-lg bg-indigo-500/90 px-3 py-1.5 text-xs text-white">
                            {entry.content}
                          </div>
                        ) : (
                          <div key={index} className="self-start max-w-full">
                            {entry.reasoning ? (
                              <details className="mb-1 rounded-lg border border-violet-200 bg-violet-50/60 px-2 py-1 dark:border-violet-900 dark:bg-violet-950/30">
                                <summary className="cursor-pointer text-[11px] font-medium text-violet-500 dark:text-violet-300">
                                  Reasoning
                                </summary>
                                <div className="mt-1 whitespace-pre-wrap text-xs text-slate-500 dark:text-slate-400">
                                  {entry.reasoning}
                                </div>
                              </details>
                            ) : null}
                            <div className="rounded-lg bg-white px-3 py-1.5 text-xs text-slate-700 shadow-sm dark:bg-slate-800 dark:text-slate-200">
                              <span className="whitespace-pre-wrap">{entry.content}</span>
                            </div>
                            <div className="mt-0.5 px-1 text-[11px] tabular-nums text-slate-400 dark:text-slate-500">
                              {entry.result.duration_seconds}s
                              {" · "}
                              {entry.result.input_tokens} in / {entry.result.output_tokens} out
                              {entry.result.tokens_per_second !== null &&
                                ` · ${entry.result.tokens_per_second} tok/s`}
                              {entry.result.cache_read_input_tokens > 0 &&
                                ` · ${entry.result.cache_read_input_tokens} cached`}
                              {entry.result.cost_usd !== null &&
                                entry.result.cost_usd > 0 &&
                                ` · ${formatCostUSD(entry.result.cost_usd) ?? ""}`}
                            </div>
                          </div>
                        ),
                      )}
                    </div>
                  )}
                  {chatTestPending && (
                    <div className="text-xs text-slate-400 dark:text-slate-500">
                      Waiting for the model… ({chatTestElapsed}s)
                      {chatTestElapsed > 30 &&
                        " — slow self-hosted reasoning models can take minutes; the reply will show the measured speed."}
                    </div>
                  )}
                  {chatTestError && (
                    <div className="text-xs text-rose-600 dark:text-rose-400">{chatTestError}</div>
                  )}
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={chatTestInput}
                      onChange={(event) => setChatTestInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void sendChatTest();
                      }}
                      placeholder="Type a test message…"
                      className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-indigo-300 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                    />
                    <button
                      type="button"
                      disabled={chatTestPending || !chatTestInput.trim()}
                      onClick={() => void sendChatTest()}
                      className="rounded-lg bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-40"
                    >
                      Send
                    </button>
                    {chatTestEntries.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setChatTestEntries([]);
                          setChatTestError(null);
                        }}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              ) : null}
              {/* Budget + spend only exist for the metered Anthropic API —
                  self-hosted runs cost nothing per token and are never
                  limited, so hide the whole block for provider "openai". */}
              {agentSettings?.provider !== "openai" ? (
                <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-3 dark:border-slate-800">
                  <div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      AI budget per user
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {isAdmin
                        ? "Maximum cumulative AI cost per account (USD — Anthropic bills in USD). Once reached, planning falls back to the draft plan until you raise the budget."
                        : `Your usage: ${formatCostUSD(agentSettings?.spent_usd ?? 0) ?? "$0.00"} of ${formatCostUSD(agentSettings?.budget_usd ?? 0) ?? "…"} used. When the budget is reached, planning falls back to the draft plan.`}
                    </div>
                  </div>
                  {isAdmin ? (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-slate-500 dark:text-slate-400">$</span>
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={agentSettings?.budget_usd ?? 5}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (Number.isFinite(value) && value >= 0) {
                            void applyAgentSettings({ budget_usd: value });
                          }
                        }}
                        className="w-24 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-indigo-300 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
              {isAdmin && agentSettings?.provider !== "openai" && agentSettings?.usage?.length ? (
                <div className="border-t border-slate-100 pt-3 dark:border-slate-800">
                  <div className="mb-1 text-xs font-medium text-slate-600 dark:text-slate-300">
                    AI spend by user
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {agentSettings.usage.map((entry) => (
                      <span
                        key={entry.username}
                        className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                      >
                        {entry.username}: {formatCostUSD(entry.spent_usd) ?? "$0.00"}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {agentSettingsError ? (
                <div className="text-xs text-rose-600 dark:text-rose-400">{agentSettingsError}</div>
              ) : null}
            </div>
            <div className="flex flex-col gap-2 rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/70">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    AI agent instructions
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Free-text guidance the AI agent follows in addition to the fixed rules above.
                    You can refer to people and sections by name — names are replaced with
                    anonymous ids before anything is sent to the AI. Clear the field to run
                    without extra instructions.
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
              <button
                type="button"
                role="switch"
                aria-checked={solverSettings.onCallRestEnabled}
                onClick={() =>
                  onChangeSolverSettings({
                    ...solverSettings,
                    onCallRestEnabled: !solverSettings.onCallRestEnabled,
                    onCallRestClassId: onCallRestClassId || solverSettings.onCallRestClassId,
                  })
                }
                className={cx(
                  "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                  solverSettings.onCallRestEnabled
                    ? "bg-emerald-500"
                    : "bg-slate-300 dark:bg-slate-700",
                )}
              >
                <span
                  className={cx(
                    "inline-block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition-transform",
                    solverSettings.onCallRestEnabled && "translate-x-[22px]",
                  )}
                />
              </button>
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
                    onClick={() => onRemoveClinician(clinician.id)}
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
