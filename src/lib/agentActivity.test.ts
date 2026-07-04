import { describe, expect, it } from "vitest";
import type { AgentActivityData } from "../api/client";
import { deriveAgentStatus, describeToolUse, formatFeedDate } from "./agentActivity";

const base = { max_iterations: 20, moves_accepted: 0, time_ms: 0 };

function event(partial: Partial<AgentActivityData> & { kind: AgentActivityData["kind"] }): AgentActivityData {
  return { iteration: 0, ...base, ...partial };
}

describe("deriveAgentStatus", () => {
  it("starts in the seed stage with an empty feed", () => {
    const status = deriveAgentStatus([]);
    expect(status.stage).toBe("seed");
    expect(status.feed).toEqual([]);
    expect(status.thinking).toBe(false);
  });

  it("tracks stage transitions and iteration progress", () => {
    const status = deriveAgentStatus([
      event({ kind: "stage", stage: "seed" }),
      event({ kind: "stage", stage: "improve" }),
      event({ kind: "iteration", iteration: 3, moves_accepted: 2 }),
    ]);
    expect(status.stage).toBe("improve");
    expect(status.iteration).toBe(3);
    expect(status.maxIterations).toBe(20);
    expect(status.movesAccepted).toBe(2);
    // Last signal is an iteration tick -> the LLM is working
    expect(status.thinking).toBe(true);
  });

  it("stops the thinking indicator once activity arrives", () => {
    const status = deriveAgentStatus([
      event({ kind: "stage", stage: "improve" }),
      event({ kind: "iteration", iteration: 1 }),
      event({
        kind: "moves_applied",
        iteration: 1,
        improved: true,
        moves: [
          { action: "assign", clinician: "Dr. Alice", section: "MRI", dateISO: "2026-01-05", start: "08:00", end: "16:00" },
        ],
      }),
    ]);
    expect(status.thinking).toBe(false);
    expect(status.feed).toHaveLength(1);
    expect(status.feed[0]).toMatchObject({ type: "move", improved: true });
  });

  it("builds a newest-first feed from moves, thoughts, and rejections", () => {
    const status = deriveAgentStatus([
      event({ kind: "thought", text: "Filling Monday gaps first." }),
      event({
        kind: "moves_applied",
        moves: [
          { action: "assign", clinician: "A", section: "CT", dateISO: "2026-01-05", start: "08:00", end: "12:00" },
          { action: "unassign", clinician: "B", section: "CT", dateISO: "2026-01-05", start: "08:00", end: "12:00" },
        ],
      }),
      event({ kind: "moves_rejected", count: 2, reason: "would violate OVERLAP" }),
    ]);
    expect(status.feed.map((entry) => entry.type)).toEqual([
      "rejected",
      "move",
      "move",
      "thought",
    ]);
    expect(status.feed[0]).toMatchObject({ count: 2, reason: "would violate OVERLAP" });
  });

  it("caps the feed length", () => {
    const events = Array.from({ length: 60 }, (_, i) =>
      event({ kind: "thought", text: `t${i}`, time_ms: i }),
    );
    const status = deriveAgentStatus(events);
    expect(status.feed).toHaveLength(30);
    // Newest first
    expect(status.feed[0]).toMatchObject({ text: "t59" });
  });
});

describe("formatFeedDate", () => {
  it("formats ISO dates as short weekday + DD.MM.", () => {
    expect(formatFeedDate("2026-01-05")).toBe("Mon 05.01.");
    expect(formatFeedDate("2026-01-11")).toBe("Sun 11.01.");
  });

  it("passes through malformed input", () => {
    expect(formatFeedDate("not-a-date")).toBe("not-a-date");
  });
});

describe("tool_use feed entries", () => {
  it("describes inspection tools in plain language and skips apply_moves", () => {
    expect(
      describeToolUse(["get_plan_overview", "apply_moves", "list_candidates_for_slot"]),
    ).toBe("reviewed the plan status · compared candidates for a slot");
    expect(describeToolUse(undefined)).toBe("");
  });

  it("derives a tools feed row from tool_use events", () => {
    const status = deriveAgentStatus([
      { kind: "stage", stage: "improve", iteration: 0, max_iterations: 20, moves_accepted: 0, time_ms: 0 },
      { kind: "tool_use", tools: ["list_open_slots"], iteration: 1, max_iterations: 20, moves_accepted: 0, time_ms: 100 },
    ]);
    expect(status.feed[0]).toMatchObject({ type: "tools", label: "scanned for open slots" });
  });
});
