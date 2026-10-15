import { useEffect, useRef, useState } from "react";
import type { AgentChatTestResult, AgentSettings, AgentSettingsUpdate } from "../../api/client";
import {
  agentChatTest,
  agentModelCheck,
  fetchAgentSettings,
  updateAgentSettings,
} from "../../api/client";
import { AGENT_MODEL_OPTIONS, formatCostUSD } from "../../lib/llmPricing";
import { modelSelectionNotice } from "../../lib/runLog";
import CustomSelect from "./CustomSelect";
import ToggleSwitch from "./ToggleSwitch";

// AI agent block of Settings → Solver Settings: provider, model, endpoint,
// API keys, model connection test and budget. Global settings, loaded from
// and saved to the server directly (not part of the calendar state). Kept in
// its own component so the chat-test timer and typing here do not re-render
// the whole settings page.

// Known self-hosted model choices; availability and fallback order are
// resolved by the backend. Other IDs remain available as custom choices.
// Qwen/Qwen3.8-27B was removed on 2026-10-06: the endpoint no longer serves it.
const SELF_HOSTED_MODEL_PRESETS = [
  "nvidia/Qwen3.8-Flash-Next-NVFP4",
  "Qwen/Qwen3.5-35B-A3B-GPTQ-Int4",
];

// Drop the "org/" prefix (Qwen/, unsloth/, …) for a compact picker label.
const presetLabel = (id: string) => id.split("/").pop() ?? id;

// Budget shown before the settings arrive (the backend default).
const DEFAULT_BUDGET_USD = 5;
// The backend accepts budgets from 0 to 10,000 USD.
const MAX_BUDGET_USD = 10_000;

// Admin model test: a direct chat with the configured model, kept only in
// memory. Each reply carries latency / token-throughput measurements.
type ChatTestEntry =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; reasoning: string | null; result: AgentChatTestResult };

export default function AgentSettingsPanel({ isAdmin }: { isAdmin: boolean }) {
  // Global agent settings (admin-chosen provider/model + per-account budget).
  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(null);
  const [agentSettingsError, setAgentSettingsError] = useState<string | null>(null);
  // Local editing state for the self-hosted endpoint + API keys. Key inputs
  // always start empty — the stored values never come back from the server.
  const [openaiBaseUrlInput, setOpenaiBaseUrlInput] = useState("");
  const [openaiModelInput, setOpenaiModelInput] = useState("");
  // "Custom model name…" picked while a preset is active: show the text field.
  const [customModelMode, setCustomModelMode] = useState(false);
  // Budget text while the admin edits it; null shows the stored budget. It is
  // saved on blur / Enter only, so clearing the field never saves 0.
  const [budgetInput, setBudgetInput] = useState<string | null>(null);
  const settingsSaveTailRef = useRef<Promise<unknown>>(Promise.resolve());
  const settingsSaveErrorRef = useRef<Error | null>(null);
  // Model name / budget of the latest queued save, until that save settles.
  // The "unchanged" checks compare against it rather than the stored
  // settings, so a value reverted while its save runs is still saved and
  // blurring again does not queue the same value twice.
  const pendingModelRef = useRef<{ value: string } | null>(null);
  const pendingBudgetRef = useRef<{ value: number } | null>(null);
  const modelGenerationRef = useRef(0);
  const modelCheckControllerRef = useRef<AbortController | null>(null);
  const chatTestControllerRef = useRef<AbortController | null>(null);
  const settingsMountedRef = useRef(true);
  const invalidateModelChecks = () => {
    modelGenerationRef.current += 1;
    modelCheckControllerRef.current?.abort();
    chatTestControllerRef.current?.abort();
    setModelCheck(null);
    setChatTestPending(false);
    setChatTestEntries([]);
    setChatTestError(null);
  };
  useEffect(() => {
    settingsMountedRef.current = true;
    return () => {
      settingsMountedRef.current = false;
      modelGenerationRef.current += 1;
      modelCheckControllerRef.current?.abort();
      chatTestControllerRef.current?.abort();
    };
  }, []);
  // Responsiveness check of a freshly selected self-hosted model: verifies
  // the endpoint serves it and answers a 1-token completion.
  const [modelCheck, setModelCheck] = useState<
    { status: "checking" } | { status: "ok"; latency?: number } | { status: "error"; message: string } | null
  >(null);
  const applyOpenaiModel = async (model: string) => {
    setOpenaiModelInput(model);
    const pending = { value: model };
    pendingModelRef.current = pending;
    const save = applyAgentSettings({ openai_model: model });
    const generation = modelGenerationRef.current;
    const saved = await save;
    if (pendingModelRef.current === pending) pendingModelRef.current = null;
    if (!saved || generation !== modelGenerationRef.current || !settingsMountedRef.current) return;
    if (!model.trim()) {
      setModelCheck(null);
      return;
    }
    setModelCheck({ status: "checking" });
    const controller = new AbortController();
    modelCheckControllerRef.current = controller;
    try {
      const result = await agentModelCheck(model.trim(), controller.signal);
      if (generation !== modelGenerationRef.current || !settingsMountedRef.current) return;
      setModelCheck(
        result.ok
          ? { status: "ok", latency: result.latency_seconds }
          : { status: "error", message: result.error ?? "Model did not respond." },
      );
    } catch (err) {
      if (controller.signal.aborted || generation !== modelGenerationRef.current) return;
      setModelCheck({
        status: "error",
        message: err instanceof Error ? err.message : "Model check failed.",
      });
    }
  };
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
    // The budget does not affect the model: keep model checks and the chat.
    if (Object.keys(patch).some((key) => key !== "budget_usd")) invalidateModelChecks();
    const queued = settingsSaveTailRef.current.then(() => updateAgentSettings(patch));
    settingsSaveTailRef.current = queued.then(() => undefined, () => undefined);
    try {
      setAgentSettingsError(null);
      const updated = await queued;
      settingsSaveErrorRef.current = null;
      if (settingsMountedRef.current) {
        setAgentSettingsError(null);
        setAgentSettings((prev) => prev ? { ...prev, ...updated } : prev);
      }
      return updated;
    } catch {
      settingsSaveErrorRef.current = new Error("Could not save AI agent settings. Save them successfully before testing the model.");
      if (settingsMountedRef.current) setAgentSettingsError(settingsSaveErrorRef.current.message);
      return null;
    }
  };
  const commitOpenaiModelInput = () => {
    const latest = pendingModelRef.current?.value ?? agentSettings?.openai_model ?? "";
    if (openaiModelInput.trim() !== latest.trim()) void applyOpenaiModel(openaiModelInput);
  };
  const commitBudget = async () => {
    if (budgetInput === null) return;
    const committed = budgetInput;
    const value = Number(committed.trim());
    // Empty or invalid: show the stored budget again.
    if (!committed.trim() || !Number.isFinite(value) || value < 0 || value > MAX_BUDGET_USD) {
      setBudgetInput(null);
      return;
    }
    // Already being saved: that save clears the field when it succeeds.
    if (pendingBudgetRef.current?.value === value) return;
    // Unchanged: show the stored budget again.
    if (!pendingBudgetRef.current && value === (agentSettings?.budget_usd ?? DEFAULT_BUDGET_USD)) {
      setBudgetInput(null);
      return;
    }
    const pending = { value };
    pendingBudgetRef.current = pending;
    const saved = await applyAgentSettings({ budget_usd: value });
    if (pendingBudgetRef.current === pending) pendingBudgetRef.current = null;
    // Keep a failed value visible next to the error; leave newer typing alone.
    if (saved && settingsMountedRef.current) {
      setBudgetInput((current) => (current === committed ? null : current));
    }
  };
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
    const generation = modelGenerationRef.current;
    const controller = new AbortController();
    chatTestControllerRef.current = controller;
    try {
      await settingsSaveTailRef.current;
      if (generation !== modelGenerationRef.current || controller.signal.aborted) return;
      if (settingsSaveErrorRef.current) throw settingsSaveErrorRef.current;
      const result = await agentChatTest(
        history.map((entry) => ({ role: entry.role, content: entry.content })),
        controller.signal,
      );
      if (generation !== modelGenerationRef.current || controller.signal.aborted) return;
      if (result.error) {
        setChatTestError([result.error, modelSelectionNotice(result.model_selection)].filter(Boolean).join(" "));
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
      if (generation === modelGenerationRef.current && !controller.signal.aborted) {
        setChatTestError(err instanceof Error ? err.message : "Model test failed.");
      }
    } finally {
      if (generation === modelGenerationRef.current) setChatTestPending(false);
    }
  };
  const showCustomModel =
    customModelMode || !SELF_HOSTED_MODEL_PRESETS.includes(openaiModelInput);

  return (
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
          <div className="flex w-80 flex-col gap-1">
            <CustomSelect
              className="w-80"
              value={showCustomModel ? "__custom__" : openaiModelInput}
              onChange={(value) => {
                if (value === "__custom__") {
                  // Keep the current name in the field: a blur without
                  // typing must not save an empty model.
                  setCustomModelMode(true);
                  return;
                }
                setCustomModelMode(false);
                void applyOpenaiModel(value);
              }}
              options={[
                ...SELF_HOSTED_MODEL_PRESETS.map((id) => ({
                  value: id,
                  label: presetLabel(id),
                })),
                { value: "__custom__", label: "Custom model name…" },
              ]}
            />
            {showCustomModel && (
              <input
                type="text"
                value={openaiModelInput}
                // No invalidation while typing: the check and chat refer to the
                // saved model, and committing a changed name invalidates them.
                onChange={(event) => setOpenaiModelInput(event.target.value)}
                onBlur={commitOpenaiModelInput}
                placeholder="model name on your endpoint"
                className="w-80 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-indigo-300 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              />
            )}
            {modelCheck && (
              <div
                className={
                  modelCheck.status === "error"
                    ? "text-xs text-rose-600 dark:text-rose-400"
                    : "text-xs text-slate-400 dark:text-slate-500"
                }
              >
                {modelCheck.status === "checking"
                  ? "Checking model responsiveness…"
                  : modelCheck.status === "ok"
                    ? `Model responds${modelCheck.latency ? ` (${modelCheck.latency}s)` : ""} ✓`
                    : `Model not usable: ${modelCheck.message}`}
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-full border border-slate-200 px-3 py-1 text-sm font-medium text-slate-700 dark:border-slate-700 dark:text-slate-200">
            {AGENT_MODEL_OPTIONS.find((o) => o.id === agentSettings?.effective_model)
              ?.label ??
              agentSettings?.effective_model ??
              "…"}
          </div>
        )}
      </div>
      {agentSettings?.provider === "openai" && (agentSettings.model_fallback_order?.length ?? 0) > 1 && (
        <p className="text-xs text-slate-500 dark:text-slate-400" title={agentSettings.model_fallback_order!.join(" → ")}>
          If a model is unavailable, planning and chat tests use: {agentSettings.model_fallback_order!.map(presetLabel).join(" → ")}. The responsiveness check tests only the selected model.
        </p>
      )}
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
            onChange={(event) => { invalidateModelChecks(); setOpenaiBaseUrlInput(event.target.value); }}
            onBlur={() => {
              if (openaiBaseUrlInput !== (agentSettings?.openai_base_url ?? "")) {
                void applyAgentSettings({ openai_base_url: openaiBaseUrlInput });
              }
            }}
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
          <ToggleSwitch
            label="Verify TLS certificate"
            checked={agentSettings?.openai_verify_tls !== false}
            onToggle={() =>
              void applyAgentSettings({
                openai_verify_tls: !(agentSettings?.openai_verify_tls !== false),
              })
            }
          />
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
                  void applyAgentSettings({ openai_api_key: openaiKeyInput }).then((saved) => {
                    if (!saved) return;
                    setOpenaiKeyInput("");
                    setAgentSettings((prev) =>
                      prev ? { ...prev, openai_api_key_set: true } : prev,
                    );
                  });
                } else {
                  void applyAgentSettings({ anthropic_api_key: anthropicKeyInput }).then(
                    (saved) => {
                      if (!saved) return;
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
                      Model: {entry.result.model}{" · "}
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
                    {modelSelectionNotice(entry.result.model_selection) && (
                      <p className="mt-1 px-1 text-xs text-slate-500 dark:text-slate-400">{modelSelectionNotice(entry.result.model_selection)}</p>
                    )}
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
                max={MAX_BUDGET_USD}
                step={0.5}
                aria-label="AI budget per user (USD)"
                value={budgetInput ?? String(agentSettings?.budget_usd ?? DEFAULT_BUDGET_USD)}
                onChange={(event) => setBudgetInput(event.target.value)}
                onBlur={() => void commitBudget()}
                onKeyDown={(event) => {
                  // Saved by the blur handler, so Enter and a later blur
                  // cannot save twice.
                  if (event.key === "Enter") event.currentTarget.blur();
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
  );
}
