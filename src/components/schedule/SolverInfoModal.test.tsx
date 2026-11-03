import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { SolverAgentDebug, SolverDebugInfo, SolverRunDetail } from "../../api/client";
import { agentReviewNotice, heuristicFallbackNotice } from "../../lib/solverOutcome";
import SolverInfoModal, { parseUnresolvedNote } from "./SolverInfoModal";
import { buildRunLog, modelSelectionNotice, serverRunToHistoryEntry } from "../../lib/runLog";

function debug(agent?: SolverAgentDebug): SolverDebugInfo {
  return { timing: { total_ms: 1000 }, num_days: 1, num_slots: 1,
    solver_status: "AGENT_FALLBACK_SEED", agent };
}

it.each(["legacy", "current"])("shows heuristic provenance for %s fallback metadata without claiming the model never started", async (format) => {
  const debugInfo = debug(format === "current" ? {
    result_producer: "heuristic_v2", fallback: { producer: "heuristic_v2", model_stop_reason: "provider_error" },
    model: "test-model", iterations: 2, input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 20,
    daysSkipped: [], daysIncomplete: ["2026-01-05"], daysPlanned: 0,
    completion: { plan_revision: 1, workflow_finished: true, required_checks_complete: false,
      coverage_complete: true, soft_wishes_fulfilled: true, free_text_wishes_verified: true },
  } : undefined);
  const run: SolverRunDetail = { id: "fallback", status: "finished", has_result: true,
    start_iso: "2026-01-05", end_iso: "2026-01-05", attempt: 1, created_at: "2026-01-05T10:00:00Z",
    result: { startISO: "2026-01-05", endISO: "2026-01-05", assignments: [], notes: [], debugInfo } };
  render(<SolverInfoModal isOpen onClose={vi.fn()} serverRuns={[run]}
    onApplyRun={vi.fn()} onDiscardRun={vi.fn()} onRefreshRuns={vi.fn()}
    onFetchRunDetail={vi.fn().mockResolvedValue(run)} onSendFeedback={vi.fn()} />);
  fireEvent.click(screen.getByTitle("Show run details (stats, changes, log)."));
  expect(await screen.findByText("Basic plan (without AI)", { exact: true })).toBeVisible();
  expect(screen.queryByText(/could not start/)).toBeNull();
  expect(heuristicFallbackNotice(debugInfo)).toContain("the returned draft was made without the AI");
  if (format === "current") {
    expect(screen.getByText(/The model request failed/)).toBeVisible();
    expect(screen.getByText(/Tokens and costs below belong to the model attempts/)).toBeVisible();
    expect(screen.getByText("100 in · 20 out")).toBeVisible();
    expect(screen.getByText("Required checks: still open")).toBeVisible();
    expect(screen.getByText("Required positions: all filled")).toBeVisible();
    expect(agentReviewNotice(debugInfo)).toContain("need review");
    expect(agentReviewNotice(debugInfo)).not.toContain("slots remain open");
  }
});

it("reports budget fallback and unverified days separately from coverage", () => {
  const result = debug({ result_producer: "heuristic_v2", fallback: { producer: "heuristic_v2", model_stop_reason: "budget_exhausted" },
    daysSkipped: ["2026-01-05"], daysIncomplete: ["2026-01-05"] });
  expect(heuristicFallbackNotice(result)).toContain("budget was exhausted");
  expect(agentReviewNotice(result)).toContain("1 day(s) need review");
  expect(agentReviewNotice(debug())).toBeNull();
});

const runLineCases: Array<[string, Partial<SolverAgentDebug>, string]> = [
  // test_agent_retry: Tuesday's model call failed; the repair and the final checks completed it.
  ["finished", { stopReason: "partial", modelDaysSkipped: ["2026-01-06"] }, "Run: finished"],
  // Stop clicked while the closing report ran: the harness still says completed.
  ["aborted", { stopReason: "completed" }, "Run: stopped"],
  ["finished", { stopReason: "budget_exhausted" }, "Run: stopped early: planning budget used up"],
  ["finished", { stopReason: "budget_exhausted", iterations: 0 }, "Run: not started: this account's AI budget is used up"],
];

it.each(runLineCases)("shows the Run line from the run's status and final state (%s, %j)", async (status, extra, line) => {
  const debugInfo: SolverDebugInfo = { ...debug({
    model: "test-model", iterations: 4, daysSkipped: [], daysIncomplete: [], daysPlanned: 3,
    completion: { plan_revision: 2, workflow_finished: true, required_checks_complete: true,
      coverage_complete: true, soft_wishes_fulfilled: true, free_text_wishes_verified: true },
    ...extra,
  }), solver_status: "AGENT_COMPLETE" };
  const run: SolverRunDetail = { id: "run-line", status, has_result: true, start_iso: "2026-01-05", end_iso: "2026-01-07",
    attempt: 1, created_at: "2026-01-05T10:00:00Z",
    result: { startISO: "2026-01-05", endISO: "2026-01-07", assignments: [], notes: [], debugInfo } };
  render(<SolverInfoModal isOpen onClose={vi.fn()} serverRuns={[run]}
    onApplyRun={vi.fn()} onDiscardRun={vi.fn()} onRefreshRuns={vi.fn()}
    onFetchRunDetail={vi.fn().mockResolvedValue(run)} onSendFeedback={vi.fn()} />);
  fireEvent.click(screen.getByTitle("Show run details (stats, changes, log)."));
  expect(await screen.findByText(line)).toBeVisible();
  expect(screen.getByText("Required checks: complete")).toBeVisible();
});

it.each([true, false])("reports actual model selection and preserves every attempt in the log (available: %s)", async (available) => {
  const selected = available ? "Qwen/Qwen3.5-35B-A3B-GPTQ-Int4" : null;
  const requested = "nvidia/Qwen3.8-Flash-Next-NVFP4";
  const debugInfo = debug({ model: selected, result_producer: available ? "agent" : "heuristic_v2",
    model_selection: { requested_model: requested, selected_model: selected,
      attempts: [{ model: requested, status: "unavailable", reason: "Model not found" },
        { model: "Qwen/Qwen3.5-35B-A3B-GPTQ-Int4", status: available ? "selected" : "unavailable" }] },
  });
  debugInfo.solver_status = available ? "AGENT_COMPLETE" : "AGENT_FALLBACK_SEED";
  const run: SolverRunDetail = { id: "selection", status: "finished", has_result: true,
    start_iso: "2026-01-05", end_iso: "2026-01-05", attempt: 1, created_at: "2026-01-05T10:00:00Z",
    result: { startISO: "2026-01-05", endISO: "2026-01-05", assignments: [], notes: [], debugInfo } };
  render(<SolverInfoModal isOpen onClose={vi.fn()} serverRuns={[run]}
    onApplyRun={vi.fn()} onDiscardRun={vi.fn()} onRefreshRuns={vi.fn()}
    onFetchRunDetail={vi.fn().mockResolvedValue(run)} onSendFeedback={vi.fn()} />);
  fireEvent.click(screen.getByTitle("Show run details (stats, changes, log)."));
  expect(await screen.findByText(selected ?? "No model answered", { exact: true })).toBeVisible();
  expect(screen.getByText(/Model not found/)).toBeVisible();
  if (available) {
    expect(screen.getByText(/Automatically switched from/)).toBeVisible();
    expect(screen.queryByText("Basic plan (without AI)", { exact: true })).toBeNull();
  } else {
    expect(screen.getByText(/No model answered successfully/)).toBeVisible();
    expect(screen.getByText("Basic plan (without AI)", { exact: true })).toBeVisible();
  }
  const log = buildRunLog(serverRunToHistoryEntry(run));
  expect(log).toContain(`Requested model: ${requested}`);
  expect(log).toContain(`Last successful model: ${selected ?? "none"}`);
  expect(log).toContain(`Model attempt: ${requested} — unavailable: Model not found`);
});

it("keeps unchanged and legacy model selections quiet", () => {
  expect(modelSelectionNotice()).toBeNull();
  expect(modelSelectionNotice(null)).toBeNull();
  expect(modelSelectionNotice({ requested_model: "claude-sonnet-5", selected_model: "claude-sonnet-5",
    attempts: [{ model: "claude-sonnet-5", status: "selected" }] })).toBeNull();
});

it("does not claim untested fallback models were unavailable after a timeout", () => {
  const notice = modelSelectionNotice({ requested_model: "Flash", selected_model: null, attempts: [] });
  expect(notice).toBe("No model answered successfully (requested Flash).");
  expect(notice).not.toContain("unavailable");
});

it("retains the last successful first-choice model after later unavailability without a fictitious switch", () => {
  const notice = modelSelectionNotice({ requested_model: "Flash", selected_model: "Flash", attempts: [
    { model: "Flash", status: "selected" },
    { model: "Flash", status: "unavailable", reason: "model_unavailable" },
    { model: "35B", status: "unavailable", reason: "model_unavailable" },
  ] });
  expect(notice).toContain("Last successful model: Flash.");
  expect(notice).toContain("35B (model_unavailable)");
  expect(notice).not.toContain("Automatically switched");
});

const plainRun: SolverRunDetail = { id: "run-err", status: "finished", has_result: true,
  start_iso: "2026-01-05", end_iso: "2026-01-05", attempt: 1, created_at: "2026-01-05T10:00:00Z",
  result: { startISO: "2026-01-05", endISO: "2026-01-05", assignments: [], notes: [] } };

const renderModal = (overrides: Partial<Parameters<typeof SolverInfoModal>[0]> = {}) =>
  render(<SolverInfoModal isOpen onClose={vi.fn()} serverRuns={[plainRun]}
    onApplyRun={vi.fn()} onDiscardRun={vi.fn()} onRefreshRuns={vi.fn()}
    onFetchRunDetail={vi.fn().mockResolvedValue(plainRun)} onSendFeedback={vi.fn()} {...overrides} />);

it("shows an error and keeps the text when sending feedback fails", async () => {
  renderModal({ onSendFeedback: vi.fn().mockRejectedValue(new Error("500")) });
  fireEvent.click(screen.getByTitle(/Write a comment about this run/));
  const textarea = screen.getByPlaceholderText(/What should the admin know/);
  fireEvent.change(textarea, { target: { value: "Dr. A is missing on Monday" } });
  fireEvent.click(screen.getByText("Send to admin"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Sending the comment failed");
  expect(textarea).toHaveValue("Dr. A is missing on Monday");
});

it("shows the error in the failing run's card and clears it on Cancel", async () => {
  const otherRun: SolverRunDetail = { ...plainRun, id: "run-ok", start_iso: "2026-02-02", end_iso: "2026-02-02" };
  renderModal({ serverRuns: [plainRun, otherRun], onSendFeedback: vi.fn().mockRejectedValue(new Error("500")) });
  const errCard = screen.getByTestId("run-card-run-err");
  const okCard = screen.getByTestId("run-card-run-ok");
  fireEvent.click(within(errCard).getByTitle(/Write a comment about this run/));
  fireEvent.change(within(errCard).getByPlaceholderText(/What should the admin know/), {
    target: { value: "Dr. A is missing on Monday" },
  });
  fireEvent.click(within(errCard).getByText("Send to admin"));
  expect(await within(errCard).findByRole("alert")).toHaveTextContent("Sending the comment failed");
  expect(within(okCard).queryByRole("alert")).not.toBeInTheDocument();

  fireEvent.click(within(errCard).getByText("Cancel"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("shows an error when a run's details cannot be loaded", async () => {
  renderModal({ onFetchRunDetail: vi.fn().mockRejectedValue(new Error("502")) });
  fireEvent.click(screen.getByTitle("Show run details (stats, changes, log)."));
  expect(await screen.findByRole("alert")).toHaveTextContent("Loading the run failed");
  // Still on the info view with the run list.
  expect(screen.getByTitle("Show run details (stats, changes, log).")).toBeInTheDocument();
});

it("shows an error when the run log download fails", async () => {
  renderModal({ onFetchRunDetail: vi.fn().mockRejectedValue(new Error("502")) });
  fireEvent.click(screen.getByTitle(/Download the full run log/));
  expect(await screen.findByRole("alert")).toHaveTextContent("Downloading the log failed");
});

it("explains that the weights only affect the classic CP-SAT optimizer", () => {
  renderModal();
  fireEvent.click(screen.getByText("Optimization Weights"));
  expect(screen.getByText(/ignores these weights/)).toBeVisible();
});

it("turns the unresolved note into issue chips and keeps unknown shapes as text", () => {
  expect(parseUnresolvedNote(
    "Unresolved after this run: 11 open slot(s), 3 short day(s), 0 over-long day(s), 1 placement(s) outside preferred working times.",
  )).toEqual([
    { count: 11, label: "open slots", severe: true },
    { count: 3, label: "short days", severe: false },
    { count: 1, label: "outside preferred times", severe: false },
  ]);
  expect(parseUnresolvedNote("Unresolved after this run: 1 open slot(s).")).toEqual([
    { count: 1, label: "open slot", severe: true },
  ]);
  expect(parseUnresolvedNote("Unresolved after this run: something new")).toBeNull();
  expect(parseUnresolvedNote("No unresolved issues")).toBeNull();
});

it("shows a run card with issue chips, the cost and Apply as the main action", () => {
  const run: SolverRunDetail = { ...plainRun, id: "run-chips", created_at: "2026-11-01T16:56:12",
    finished_at: "2026-11-01T17:00:00", incomplete_dates: ["2026-11-05", "2026-11-06"],
    notes: "Unresolved after this run: 11 open slot(s), 3 short day(s), 7 over-long day(s), 4 placement(s) outside preferred working times." };
  const onApplyRun = vi.fn();
  renderModal({ serverRuns: [run], onApplyRun });
  const card = screen.getByTestId("run-card-run-chips");
  const chips = within(card).getByRole("list", { name: "Unresolved after this run" });
  expect(within(chips).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    "11 open slots", "3 short days", "7 over-long days", "4 outside preferred times",
  ]);
  expect(within(card).getByText("01.11.2026, 16:56")).toBeVisible();
  expect(within(card).getByText(/Incomplete draft: 2 day\(s\) need review/)).toBeVisible();
  fireEvent.click(within(card).getByRole("button", { name: "Apply" }));
  expect(onApplyRun).toHaveBeenCalledWith("run-chips");
  expect(within(card).getByRole("button", { name: "Discard" })).toBeVisible();
});

it("marks a run without open issues and folds the explanation away while runs exist", () => {
  renderModal({ serverRuns: [{ ...plainRun, notes: "No unresolved issues." }] });
  expect(screen.getByText("No unresolved issues")).toBeVisible();
  const toggle = screen.getByRole("button", { name: "How the agent plans" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(screen.getByText(/the way an experienced human planner does/)).toBeVisible();
  // v1.82: the strict section order, on-call at its place in it.
  expect(screen.getByText(/sections higher in the section priority\s+are staffed first \(on-call counts at its place in that list\), even if more slots stay open\s+in total/)).toBeVisible();
});

it.each([
  ["finished", [], "Finished with open positions on 1 day(s): check them before applying."],
  ["finished", ["2026-11-06"], "Incomplete draft: 1 day(s) need review before applying."],
  ["applied", [], null],
])("run card wording for a %s run with unfinished days %j", (status, unfinished, expected) => {
  const run: SolverRunDetail = { id: `card-${status}-${unfinished.length}`, status, has_result: true,
    start_iso: "2026-11-05", end_iso: "2026-11-06", attempt: 1, created_at: "2026-11-01T10:00:00Z",
    incomplete_dates: ["2026-11-06"], unfinished_dates: unfinished };
  render(<SolverInfoModal isOpen onClose={vi.fn()} serverRuns={[run]}
    onApplyRun={vi.fn()} onDiscardRun={vi.fn()} onRefreshRuns={vi.fn()}
    onFetchRunDetail={vi.fn().mockResolvedValue(run)} onSendFeedback={vi.fn()} />);
  if (expected) expect(screen.getByText(expected)).toBeVisible();
  else expect(screen.queryByText(/before applying/)).toBeNull();
});
