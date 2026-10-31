import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { normalizePreferences } from "../../lib/userPreferences";
import TeamPlanHeader from "./TeamPlanHeader";

function renderHeader(showTimeLayout: boolean) {
  const onUpdatePrefs = vi.fn();
  render(
    <TeamPlanHeader
      isMobile={false}
      prefs={normalizePreferences({})}
      onUpdatePrefs={onUpdatePrefs}
      onScopeChange={vi.fn()}
      onApplyView={vi.fn()}
      showTimeLayout={showTimeLayout}
    >
      <div>navigator</div>
    </TeamPlanHeader>,
  );
  return onUpdatePrefs;
}

describe("TeamPlanHeader", () => {
  it("stores a team start page and offers no Color by switch (people are always colored)", () => {
    const onUpdatePrefs = renderHeader(true);
    fireEvent.click(screen.getByRole("button", { name: "Start page on computers" }));
    expect(onUpdatePrefs.mock.calls[0][0].startViewDesktop).toEqual({
      scope: "team",
      range: "week",
      orientation: "top",
    });
    expect(screen.queryByRole("group", { name: "Color by" })).toBeNull();
  });

  it("shows the stacked times by default and stores a switch to side by side", () => {
    const onUpdatePrefs = renderHeader(true);
    const times = screen.getByRole("group", { name: "Times" });
    expect(within(times).getByRole("button", { name: "Stacked" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(times).getByRole("button", { name: "Side by side" }));
    expect(onUpdatePrefs).toHaveBeenCalledWith({ teamTimeLayout: "columns" });
  });

  it("offers no Times switch on the monthly sheet", () => {
    renderHeader(false);
    expect(screen.queryByRole("group", { name: "Times" })).toBeNull();
  });
});
