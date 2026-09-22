import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { AgentChatTestResult, AgentSettings } from "../../api/client";
import { agentChatTest, agentModelCheck, fetchAgentSettings, updateAgentSettings } from "../../api/client";
import { defaultSolverSettings } from "../../data/mockData";
import { ConfirmDialogProvider } from "../ui/ConfirmDialog";
import SettingsView from "./SettingsView";

vi.mock("../../api/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api/client")>(),
  fetchAgentSettings: vi.fn(), updateAgentSettings: vi.fn(), agentModelCheck: vi.fn(), agentChatTest: vi.fn(),
}));

const flash = "nvidia/Qwen3.8-Flash-Next-NVFP4";
const small = "Qwen/Qwen3.8-27B";
const third = "server/third-model";
const settings: AgentSettings = { provider: "openai", model: "claude-sonnet-5", effective_model: flash,
  openai_model: flash, model_fallback_order: [flash, small, third], budget_usd: 5, spent_usd: 0, remaining_usd: 5 };
const reply: AgentChatTestResult = { provider: "openai", model: small, text: "Hello from 27B", reasoning: null,
  error: null, duration_seconds: 1, input_tokens: 40, output_tokens: 20, cache_read_input_tokens: 60,
  tokens_per_second: 20, cost_usd: null,
  model_selection: { requested_model: flash, selected_model: small,
    attempts: [{ model: flash, status: "unavailable", reason: "Model not found" }, { model: small, status: "selected" }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchAgentSettings).mockResolvedValue(settings);
  vi.mocked(updateAgentSettings).mockImplementation(async (patch) => ({ ...settings, ...patch }));
  vi.mocked(agentModelCheck).mockResolvedValue({ ok: true });
  vi.mocked(agentChatTest).mockResolvedValue(reply);
});

function setup() {
  const props: ComponentProps<typeof SettingsView> = {
    classRows: [], poolRows: [], locations: [], clinicians: [], holidays: [], holidayCountry: "DE", holidayYear: 2026,
    solverSettings: defaultSolverSettings, isAdmin: true,
    onRenamePool: vi.fn(), onAddLocation: vi.fn(), onRenameLocation: vi.fn(), onRemoveLocation: vi.fn(),
    onReorderLocations: vi.fn(), onAddClinician: vi.fn(), onEditClinician: vi.fn(), onRemoveClinician: vi.fn(),
    onChangeHolidayCountry: vi.fn(), onChangeHolidayYear: vi.fn(), onFetchHolidays: vi.fn(), onAddHoliday: vi.fn(),
    onRemoveHoliday: vi.fn(), onChangeSolverSettings: vi.fn(), onChangeWeeklyTemplate: vi.fn(),
    onCreateSection: vi.fn().mockReturnValue("section"), onUpdateSectionColor: vi.fn(), onExportScheduleSnapshot: vi.fn(),
    onImportScheduleSnapshot: vi.fn().mockResolvedValue({ imported: 0, droppedClinicians: 0, droppedSlots: 0 }),
  };
  render(<ConfirmDialogProvider><SettingsView {...props} /></ConfirmDialogProvider>);
}

it("shows the backend fallback order and checks the explicitly selected 27B model", async () => {
  setup();
  expect(await screen.findByText(/planning and chat tests use:/)).toHaveTextContent("Qwen3.8-Flash-Next-NVFP4 → Qwen3.8-27B → third-model");
  fireEvent.click(screen.getByRole("button", { name: "Qwen3.8-Flash-Next-NVFP4" }));
  fireEvent.click(screen.getByRole("button", { name: "Qwen3.8-27B" }));
  await waitFor(() => expect(updateAgentSettings).toHaveBeenCalledWith({ openai_model: small }));
  await waitFor(() => expect(agentModelCheck).toHaveBeenCalledWith(small, expect.any(AbortSignal)));
});

it.each(["anthropic", "custom"])("does not add a fallback hint for %s selections", async (kind) => {
  vi.mocked(fetchAgentSettings).mockResolvedValue({ ...settings,
    provider: kind === "anthropic" ? "anthropic" : "openai", model_fallback_order: [], openai_model: "custom" });
  setup();
  await waitFor(() => expect(fetchAgentSettings).toHaveBeenCalled());
  await screen.findByText(kind === "anthropic" ? /Sonnet 5 —/ : "Custom model name…");
  expect(screen.queryByText(/planning and chat tests use:/)).toBeNull();
});

it("shows the answering model and why the chat test switched", async () => {
  setup();
  await screen.findByText(/planning and chat tests use:/);
  fireEvent.change(screen.getByPlaceholderText("Type a test message…"), { target: { value: "Hello" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Hello from 27B")).toBeVisible();
  expect(screen.getByText(/Model: Qwen\/Qwen3.8-27B/)).toBeVisible();
  expect(screen.getByText(/Automatically switched from/)).toHaveTextContent("Model not found");
});

it("keeps exhausted chat fallback attempts visible alongside the failure", async () => {
  vi.mocked(agentChatTest).mockResolvedValue({ ...reply, text: null, error: "No available model",
    model_selection: { requested_model: flash, selected_model: null,
      attempts: [{ model: flash, status: "unavailable", reason: "Model not found" }] } });
  setup();
  await screen.findByText(/planning and chat tests use:/);
  fireEvent.change(screen.getByPlaceholderText("Type a test message…"), { target: { value: "Hello" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText(/No available model/)).toHaveTextContent("No model answered successfully");
  expect(screen.getByText(/No available model/)).toHaveTextContent("Model not found");
});
