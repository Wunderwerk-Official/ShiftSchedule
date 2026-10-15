import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
const small = "Qwen/Qwen3.5-35B-A3B-GPTQ-Int4";
const third = "server/third-model";
const settings: AgentSettings = { provider: "openai", model: "claude-sonnet-5", effective_model: flash,
  openai_model: flash, model_fallback_order: [flash, small, third], budget_usd: 5, spent_usd: 0, remaining_usd: 5 };
const reply: AgentChatTestResult = { provider: "openai", model: small, text: "Hello from 35B", reasoning: null,
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

function setup(overrides: Partial<ComponentProps<typeof SettingsView>> = {}) {
  const props: ComponentProps<typeof SettingsView> = {
    classRows: [], poolRows: [], locations: [], clinicians: [], holidays: [], holidayCountry: "DE", holidayYear: 2026,
    solverSettings: defaultSolverSettings, isAdmin: true,
    onRenamePool: vi.fn(), onAddLocation: vi.fn(), onRenameLocation: vi.fn(), onRemoveLocation: vi.fn(),
    onReorderLocations: vi.fn(), onAddClinician: vi.fn(), onEditClinician: vi.fn(), onRemoveClinician: vi.fn(),
    onChangeHolidayCountry: vi.fn(), onChangeHolidayYear: vi.fn(), onFetchHolidays: vi.fn(), onAddHoliday: vi.fn(),
    onRemoveHoliday: vi.fn(), onChangeSolverSettings: vi.fn(), onChangeWeeklyTemplate: vi.fn(),
    onCreateSection: vi.fn().mockReturnValue("section"), onUpdateSectionColor: vi.fn(), onExportScheduleSnapshot: vi.fn(),
    onImportScheduleSnapshot: vi.fn().mockResolvedValue({ imported: 0, droppedClinicians: 0, droppedSlots: 0 }),
    ...overrides,
  };
  render(<ConfirmDialogProvider><SettingsView {...props} /></ConfirmDialogProvider>);
  return props;
}

it("shows the backend fallback order and checks the explicitly selected 35B model", async () => {
  setup();
  expect(await screen.findByText(/planning and chat tests use:/)).toHaveTextContent("Qwen3.8-Flash-Next-NVFP4 → Qwen3.5-35B-A3B-GPTQ-Int4 → third-model");
  fireEvent.click(screen.getByRole("button", { name: "Qwen3.8-Flash-Next-NVFP4" }));
  fireEvent.click(screen.getByRole("button", { name: "Qwen3.5-35B-A3B-GPTQ-Int4" }));
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
  expect(await screen.findByText("Hello from 35B")).toBeVisible();
  expect(screen.getByText(/Model: Qwen\/Qwen3.5-35B-A3B-GPTQ-Int4/)).toBeVisible();
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

it("removes a person only after confirming", async () => {
  const props = setup({ clinicians: [{ id: "c1", name: "Alice" }] });
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("Remove Alice?");
  expect(props.onRemoveClinician).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(props.onRemoveClinician).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(props.onRemoveClinician).toHaveBeenCalledTimes(1));
  expect(props.onRemoveClinician).toHaveBeenCalledWith("c1");
});

describe("AI budget field", () => {
  beforeEach(() => {
    vi.mocked(fetchAgentSettings).mockResolvedValue({ ...settings, provider: "anthropic" });
    // Stay on Anthropic after a save, so the budget field stays rendered.
    vi.mocked(updateAgentSettings).mockImplementation(async (patch) => ({ ...settings, provider: "anthropic", ...patch }));
  });

  async function budgetInput() {
    const input = await screen.findByLabelText("AI budget per user (USD)");
    await waitFor(() => expect(input).toHaveValue(5));
    return input;
  }

  it("does not save while the field is cleared and restores the stored budget", async () => {
    setup();
    const input = await budgetInput();
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue(null);
    fireEvent.blur(input);
    expect(input).toHaveValue(5);
    expect(updateAgentSettings).not.toHaveBeenCalled();
  });

  it("saves a new budget once, on blur", async () => {
    setup();
    const input = await budgetInput();
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.change(input, { target: { value: "12" } });
    expect(updateAgentSettings).not.toHaveBeenCalled();
    fireEvent.blur(input);
    await waitFor(() => expect(updateAgentSettings).toHaveBeenCalledTimes(1));
    expect(updateAgentSettings).toHaveBeenCalledWith({ budget_usd: 12 });
    await waitFor(() => expect(input).toHaveValue(12));
  });

  it("saves on Enter without a second save on blur", async () => {
    setup();
    const input = await budgetInput();
    input.focus();
    fireEvent.change(input, { target: { value: "8" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(updateAgentSettings).toHaveBeenCalledWith({ budget_usd: 8 }));
    fireEvent.blur(input);
    expect(updateAgentSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps the chat test history when the budget changes", async () => {
    setup();
    const input = await budgetInput();
    fireEvent.change(screen.getByPlaceholderText("Type a test message…"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Hello from 35B")).toBeVisible();
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.blur(input);
    await waitFor(() => expect(updateAgentSettings).toHaveBeenCalledWith({ budget_usd: 7 }));
    await waitFor(() => expect(input).toHaveValue(7));
    expect(screen.getByText("Hello from 35B")).toBeVisible();
  });

  it.each(["10001", "-1"])("restores the stored budget for the out-of-range value %s without saving", async (value) => {
    setup();
    const input = await budgetInput();
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
    expect(input).toHaveValue(5);
    expect(updateAgentSettings).not.toHaveBeenCalled();
  });

  it("keeps a budget that failed to save next to the error", async () => {
    vi.mocked(updateAgentSettings).mockRejectedValueOnce(new Error("offline"));
    setup();
    const input = await budgetInput();
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.blur(input);
    expect(await screen.findByText(/Could not save AI agent settings/)).toBeVisible();
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue(12);
  });

  it("does not queue the same budget twice and saves a budget reverted during the save", async () => {
    let release = () => {};
    vi.mocked(updateAgentSettings).mockImplementationOnce((patch) => new Promise((resolve) => {
      release = () => resolve({ ...settings, provider: "anthropic", ...patch });
    }));
    setup();
    const input = await budgetInput();
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.blur(input);
    await waitFor(() => expect(updateAgentSettings).toHaveBeenCalledTimes(1));
    // Blurring again while 12 is still being saved queues nothing.
    fireEvent.blur(input);
    expect(input).toHaveValue(12);
    // Back to the stored 5 before the save of 12 returns: 5 must be saved.
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.blur(input);
    release();
    await waitFor(() => expect(updateAgentSettings).toHaveBeenCalledTimes(2));
    expect(updateAgentSettings).toHaveBeenLastCalledWith({ budget_usd: 5 });
    await waitFor(() => expect(input).toHaveValue(5));
    expect(updateAgentSettings).toHaveBeenCalledTimes(2);
  });
});

describe("custom model name field", () => {
  beforeEach(() => {
    vi.mocked(fetchAgentSettings).mockResolvedValue({ ...settings, openai_model: "custom", model_fallback_order: [] });
  });

  async function modelInput() {
    const input = await screen.findByPlaceholderText("model name on your endpoint");
    await waitFor(() => expect(input).toHaveValue("custom"));
    return input;
  }

  it("keeps the model check when a typed name is reverted before blur", async () => {
    setup();
    const input = await modelInput();
    fireEvent.change(input, { target: { value: "server/x" } });
    fireEvent.blur(input);
    expect(await screen.findByText(/Model responds/)).toBeVisible();
    fireEvent.change(input, { target: { value: "server/y" } });
    fireEvent.change(input, { target: { value: "server/x" } });
    fireEvent.blur(input);
    expect(screen.getByText(/Model responds/)).toBeVisible();
    expect(updateAgentSettings).toHaveBeenCalledTimes(1);
    expect(agentModelCheck).toHaveBeenCalledTimes(1);
  });

  it("saves a model name reverted while its save is still running", async () => {
    let release = () => {};
    vi.mocked(updateAgentSettings).mockImplementationOnce((patch) => new Promise((resolve) => {
      release = () => resolve({ ...settings, ...patch });
    }));
    setup();
    const input = await modelInput();
    fireEvent.change(input, { target: { value: "server/x" } });
    fireEvent.blur(input);
    await waitFor(() => expect(updateAgentSettings).toHaveBeenCalledTimes(1));
    // Blurring again while server/x is still being saved queues nothing.
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "custom" } });
    fireEvent.blur(input);
    release();
    await waitFor(() => expect(agentModelCheck).toHaveBeenCalledWith("custom", expect.any(AbortSignal)));
    expect(updateAgentSettings).toHaveBeenCalledTimes(2);
    expect(updateAgentSettings).toHaveBeenLastCalledWith({ openai_model: "custom" });
    expect(input).toHaveValue("custom");
  });
});

it("offers a custom model name while a preset is selected and saves it only when changed", async () => {
  setup();
  await screen.findByText(/planning and chat tests use:/);
  expect(screen.queryByPlaceholderText("model name on your endpoint")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Qwen3.8-Flash-Next-NVFP4" }));
  fireEvent.click(screen.getByRole("button", { name: "Custom model name…" }));
  const input = screen.getByPlaceholderText("model name on your endpoint");
  expect(input).toHaveValue(flash);
  fireEvent.blur(input);
  expect(updateAgentSettings).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "server/x" } });
  fireEvent.blur(input);
  await waitFor(() => expect(updateAgentSettings).toHaveBeenCalledTimes(1));
  expect(updateAgentSettings).toHaveBeenCalledWith({ openai_model: "server/x" });
  await waitFor(() => expect(agentModelCheck).toHaveBeenCalledWith("server/x", expect.any(AbortSignal)));
});

it("adds a holiday picked in the date picker", async () => {
  const props = setup();
  fireEvent.click(screen.getByRole("button", { name: "Add Holiday" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByText("Please select a date and enter a holiday name.")).toBeVisible();
  expect(props.onAddHoliday).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "DD.MM.YYYY" }));
  const now = new Date();
  fireEvent.click(screen.getByRole("button", { name: "15" }));
  fireEvent.change(screen.getByPlaceholderText("Holiday name"), { target: { value: "Clinic day" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const month = String(now.getMonth() + 1).padStart(2, "0");
  expect(props.onAddHoliday).toHaveBeenCalledWith({ dateISO: `${now.getFullYear()}-${month}-15`, name: "Clinic day" });
});
