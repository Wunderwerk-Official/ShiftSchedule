import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AgentActivityPanel from "./AgentActivityPanel";
import type { AgentActivityData } from "../../api/client";

// Distinct start/end markers so we can prove the WHOLE text is shown, not a
// clamped preview. ~1700 chars, well past THOUGHT_PREVIEW_CHARS (220).
const LONG =
  "START-MARKER " + "reasoning detail ".repeat(100) + "END-MARKER";

function ev(data: Partial<AgentActivityData>): AgentActivityData {
  return {
    kind: "thought",
    iteration: 1,
    max_iterations: 20,
    moves_accepted: 0,
    time_ms: 0,
    ...data,
  } as AgentActivityData;
}

describe("AgentActivityPanel full-text dialog", () => {
  it("opens the complete reasoning in a dialog, not just a clamped preview", () => {
    render(
      <AgentActivityPanel
        events={[
          ev({ kind: "stage", stage: "improve" }),
          ev({ kind: "thought", text: LONG, reasoning: true }),
        ]}
      />,
    );
    // The feed preview shows the start but is clamped before the end marker.
    expect(screen.queryByText(/END-MARKER/)).toBeNull();
    const opener = screen.getByRole("button", { name: /show full text/i });
    fireEvent.click(opener);
    // The dialog now shows the COMPLETE text — both markers are present.
    const dialogBody = screen.getByText(
      (_content, node) =>
        node?.tagName === "PRE" &&
        (node.textContent ?? "").includes("START-MARKER") &&
        (node.textContent ?? "").includes("END-MARKER"),
    );
    expect(dialogBody).toBeTruthy();
    expect(screen.getByText(/reasoning \(full text\)/i)).toBeTruthy();
    // Escape closes it.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText(/END-MARKER/)).toBeNull();
  });

  it("keeps short thoughts inline without an opener", () => {
    render(
      <AgentActivityPanel
        events={[
          ev({ kind: "stage", stage: "improve" }),
          ev({ kind: "thought", text: "Filling Monday gaps." }),
        ]}
      />,
    );
    expect(screen.getByText("Filling Monday gaps.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /show full text/i })).toBeNull();
  });
});
