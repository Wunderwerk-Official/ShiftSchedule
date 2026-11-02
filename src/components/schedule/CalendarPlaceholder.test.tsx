import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CalendarPlaceholder from "./CalendarPlaceholder";

describe("CalendarPlaceholder", () => {
  it("keeps the Team | My plan switch usable while My plan is loading", () => {
    const onScopeChange = vi.fn();
    render(<CalendarPlaceholder onScopeChange={onScopeChange} />);

    const group = screen.getByRole("group", { name: "Choose plan" });
    const team = within(group).getByRole("button", { name: /Team/ });
    const me = within(group).getByRole("button", { name: /My plan/ });
    expect(team).toHaveAttribute("aria-pressed", "false");
    expect(me).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(team);
    expect(onScopeChange).toHaveBeenCalledWith("team");
  });

  it("announces the loading state and shows no initials before the calendar is known", () => {
    render(<CalendarPlaceholder onScopeChange={() => {}} />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Loading calendar…");
    // The linked person is only known once the calendar is loaded: plain label, no name.
    expect(screen.getByRole("button", { name: "My plan" })).toBeInTheDocument();
  });

  it("uses the compact switch on phones", () => {
    render(<CalendarPlaceholder onScopeChange={() => {}} isMobile />);
    const team = screen.getByRole("button", { name: "Team" });
    // Compact: no Team icon, only the label.
    expect(team.querySelector("svg")).toBeNull();
  });
});
