import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import HelpView from "./HelpView";

it("describes the current planning panel and drop rules", () => {
  const { container } = render(<HelpView />);
  const text = container.textContent ?? "";
  expect(text).toContain("Unlocked shifts and rest days");
  expect(text).not.toContain("Reset Unfixed");
  expect(text).toContain("Dropping it back on its own cell changes nothing.");
  expect(text).toMatch(/Unlocked shifts removes every shift\s+without a lock in the selected timeframe/);
  expect(text).toMatch(/Names\s+you place or move by hand are locked right away/);
  expect(text).toMatch(/unlocking a shift hands it to the planner/);
  expect(text).toMatch(/marks that day as vacation \(their shifts\s+that\s+day are removed\)/);
  expect(text).toMatch(/Copy Day copies all columns and slots\s+of one day to another\. It replaces/);
  // Removed UI and behaviour that the guide used to describe.
  expect(text).not.toContain("Distribute all people");
  expect(text).not.toContain("snaps back");
  expect(text).not.toContain("not responding");
  expect(screen.getByRole("heading", { name: "12. My plan" })).toBeVisible();
});

it("explains Find a swap: the S key and Undo (v1.71)", () => {
  const { container } = render(<HelpView />);
  expect(screen.getByRole("heading", { name: "13. Find a swap" })).toBeVisible();
  const text = container.textContent ?? "";
  expect(text).toMatch(/press S while its\s+lock or ⇄ button has focus/);
  expect(text).toMatch(/Undo is in the toast for 10 seconds and later\s+under Swap history/);
  expect(text).toMatch(/inside 48 h before the start also tick the notice override/);
  expect(text).toMatch(
    /A hand-over that leaves the giver\s+under their contract hours says so once, in an amber note under the shift/,
  );
});
