import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { SolverAgentDebug, SolverDebugInfo, SolverRunDetail } from "../../api/client";
import { agentReviewNotice, heuristicFallbackNotice } from "../../lib/solverOutcome";
import SolverInfoModal from "./SolverInfoModal";
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
  expect(await screen.findByText("Heuristic fallback", { exact: true })).toBeVisible();
  expect(screen.queryByText(/could not start/)).toBeNull();
  expect(heuristicFallbackNotice(debugInfo)).toContain("produced by heuristic v2");
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

it.each([true, false])("reports actual model selection and preserves every attempt in the log (available: %s)", async (available) => {
  const selected = available ? "Qwen/Qwen3.8-27B" : null;
  const requested = "nvidia/Qwen3.8-Flash-Next-NVFP4";
  const debugInfo = debug({ model: selected, result_producer: available ? "agent" : "heuristic_v2",
    model_selection: { requested_model: requested, selected_model: selected,
      attempts: [{ model: requested, status: "unavailable", reason: "Model not found" },
        { model: "Qwen/Qwen3.8-27B", status: available ? "selected" : "unavailable" }] },
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
    expect(screen.queryByText("Heuristic fallback", { exact: true })).toBeNull();
  } else {
    expect(screen.getByText(/No model answered successfully/)).toBeVisible();
    expect(screen.getByText("Heuristic fallback", { exact: true })).toBeVisible();
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
    { model: "27B", status: "unavailable", reason: "model_unavailable" },
  ] });
  expect(notice).toContain("Last successful model: Flash.");
  expect(notice).toContain("27B (model_unavailable)");
  expect(notice).not.toContain("Automatically switched");
});
