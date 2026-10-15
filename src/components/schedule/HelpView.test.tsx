import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import HelpView from "./HelpView";

it("describes the current planning panel and drop rules", () => {
  const { container } = render(<HelpView />);
  const text = container.textContent ?? "";
  expect(text).toContain("Reset Solver Only");
  expect(text).toContain("Reset Unfixed");
  expect(text).toContain("Dropping it back on its own cell changes nothing.");
  expect(text).toMatch(/Reset Solver Only removes, in the\s+selected timeframe/);
  expect(text).toMatch(/Names placed by hand show a small lock: replanning and Reset Solver\s+Only keep them, Reset Unfixed removes them\./);
  expect(text).toMatch(/marks that day as vacation \(their shifts\s+that\s+day are removed\)/);
  expect(text).toMatch(/Copy Day copies all columns and slots\s+of one day to another\. It replaces/);
  // Removed UI and behaviour that the guide used to describe.
  expect(text).not.toContain("Distribute all people");
  expect(text).not.toContain("snaps back");
  expect(text).not.toContain("not responding");
  expect(screen.getByRole("heading", { name: "12. My plan" })).toBeVisible();
});
