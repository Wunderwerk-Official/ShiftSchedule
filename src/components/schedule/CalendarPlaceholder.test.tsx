import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CalendarPlaceholder from "./CalendarPlaceholder";

describe("CalendarPlaceholder", () => {
  it("keeps the Team | My plan switch usable while My plan is loading", () => {
    const onScopeChange = vi.fn();
    render(<CalendarPlaceholder scope="me" onScopeChange={onScopeChange} />);

    expect(screen.getByRole("region", { name: "My plan" })).toBeInTheDocument();
    const group = screen.getByRole("group", { name: "Choose plan" });
    const team = within(group).getByRole("button", { name: /Team/ });
    const me = within(group).getByRole("button", { name: /My plan/ });
    expect(team).toHaveAttribute("aria-pressed", "false");
    expect(me).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(team);
    expect(onScopeChange).toHaveBeenCalledWith("team");
  });

  it("stands in for the team plan with Team chosen and no controls of the calendar", () => {
    const onScopeChange = vi.fn();
    render(<CalendarPlaceholder scope="team" onScopeChange={onScopeChange} />);

    expect(screen.getByRole("region", { name: "Team plan" })).toBeInTheDocument();
    const group = screen.getByRole("group", { name: "Choose plan" });
    expect(within(group).getByRole("button", { name: /Team/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Loading calendar…");
    // Only the scope switch: no publish toggle, badges or week navigation yet.
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Team", "My plan"]);

    fireEvent.click(within(group).getByRole("button", { name: /My plan/ }));
    expect(onScopeChange).toHaveBeenCalledWith("me");
  });

  it("announces the loading state and shows no initials before the calendar is known", () => {
    render(<CalendarPlaceholder scope="me" onScopeChange={() => {}} />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Loading calendar…");
    // The linked person is only known once the calendar is loaded: plain label, no name.
    expect(screen.getByRole("button", { name: "My plan" })).toBeInTheDocument();
  });

  it("stops waiting when loading failed and offers a reload", () => {
    const onReload = vi.fn();
    render(<CalendarPlaceholder scope="team" onScopeChange={() => {}} loadFailed onReload={onReload} />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "false");
    expect(status).toHaveTextContent("The calendar could not be loaded.");
    expect(status).not.toHaveTextContent("Loading calendar…");
    fireEvent.click(screen.getByRole("button", { name: "Reload saved calendar" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("uses the compact switch on phones", () => {
    render(<CalendarPlaceholder scope="me" onScopeChange={() => {}} isMobile />);
    const team = screen.getByRole("button", { name: "Team" });
    // Compact: no Team icon, only the label.
    expect(team.querySelector("svg")).toBeNull();
  });
});
