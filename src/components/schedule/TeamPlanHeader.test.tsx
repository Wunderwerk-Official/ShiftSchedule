import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { normalizePreferences } from "../../lib/userPreferences";
import TeamPlanHeader from "./TeamPlanHeader";

function renderHeader(
  showTimeLayout: boolean,
  { me = null, isMobile = false }: { me?: { name: string; index: number } | null; isMobile?: boolean } = {},
) {
  const onUpdatePrefs = vi.fn();
  const onScopeChange = vi.fn();
  render(
    <TeamPlanHeader
      isMobile={isMobile}
      prefs={normalizePreferences({})}
      onUpdatePrefs={onUpdatePrefs}
      onScopeChange={onScopeChange}
      me={me}
      showTimeLayout={showTimeLayout}
    >
      <div>navigator</div>
    </TeamPlanHeader>,
  );
  return { onUpdatePrefs, onScopeChange };
}

describe("TeamPlanHeader", () => {
  it.each([false, true])(
    "offers no start-page star, Views menu or Color by switch (isMobile=%s)",
    (isMobile) => {
      renderHeader(true, { isMobile });
      expect(screen.queryByRole("button", { name: /Start page/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "Views" })).toBeNull();
      expect(screen.queryByRole("group", { name: "Color by" })).toBeNull();
      // Row 1 keeps the scope switch and the Times switch.
      expect(screen.getByRole("group", { name: "Choose plan" })).toBeInTheDocument();
      expect(screen.getByRole("group", { name: "Times" })).toBeInTheDocument();
    },
  );

  it("shows the stacked times by default and stores a switch to side by side", () => {
    const { onUpdatePrefs } = renderHeader(true);
    const times = screen.getByRole("group", { name: "Times" });
    expect(within(times).getByRole("button", { name: "Stacked" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(times).getByRole("button", { name: "Side by side" }));
    expect(onUpdatePrefs).toHaveBeenCalledWith({ teamTimeLayout: "columns" });
  });

  it("offers no Times switch on the monthly sheet", () => {
    renderHeader(false);
    expect(screen.queryByRole("group", { name: "Times" })).toBeNull();
  });

  it("names the linked person behind the initials on My plan", () => {
    const { onScopeChange } = renderHeader(true, { me: { name: "Anna Schmidt", index: 0 } });
    const myPlan = screen.getByRole("button", { name: "My plan (Anna Schmidt)" });
    expect(myPlan).toHaveAttribute("title", "My plan · Anna Schmidt");
    expect(myPlan).toHaveTextContent("AS");
    fireEvent.click(myPlan);
    expect(onScopeChange).toHaveBeenCalledWith("me");
  });

  it("keeps the plain My plan label while the account is not linked", () => {
    renderHeader(true);
    const myPlan = screen.getByRole("button", { name: "My plan" });
    expect(myPlan).toHaveAttribute("title", "My plan");
    expect(myPlan).not.toHaveAttribute("aria-label");
  });
});
