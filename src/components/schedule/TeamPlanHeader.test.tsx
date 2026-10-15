import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { normalizePreferences } from "../../lib/userPreferences";
import TeamPlanHeader from "./TeamPlanHeader";

function renderHeader(showColorBy: boolean) {
  const onUpdatePrefs = vi.fn();
  render(
    <TeamPlanHeader
      isMobile={false}
      prefs={normalizePreferences({ teamColorBy: "person" })}
      onUpdatePrefs={onUpdatePrefs}
      onScopeChange={vi.fn()}
      onApplyView={vi.fn()}
      showColorBy={showColorBy}
    >
      <div>navigator</div>
    </TeamPlanHeader>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Start page on computers" }));
  return onUpdatePrefs.mock.calls[0][0];
}

describe("TeamPlanHeader", () => {
  it("stores the classic grid's Color by in a team start page", () => {
    expect(renderHeader(true).startViewDesktop).toMatchObject({ scope: "team", colorBy: "person" });
    expect(screen.getByRole("group", { name: "Color by" })).toBeTruthy();
  });

  it("stores the section look from the monthly sheet, which ignores Color by", () => {
    expect(renderHeader(false).startViewDesktop).toMatchObject({ scope: "team", colorBy: "section" });
    expect(screen.queryByRole("group", { name: "Color by" })).toBeNull();
  });
});
