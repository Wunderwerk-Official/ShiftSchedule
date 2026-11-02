import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { changeLinkLabel } from "../myPlan/PersonPicker";
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
  // v1.74: the linked person can be changed; the quoted label is PersonPicker's
  // footer with a placeholder name. No star or saved views.
  const footerLabel = changeLinkLabel("<your name>");
  expect(footerLabel).toBe("Not <your name>? Change who you are");
  expect(text).toContain(
    `open the arrow next to the switch in My plan: the last entry, “${footerLabel}”, lets you choose again;`,
  );
  expect(text).toContain("on a computer, pointing at the circle shows the name.");
  expect(text).toContain("shows the initials of the person linked to your account");
  expect(text).not.toMatch(/start page|saved views/i);
});

it("uses the current Settings names", () => {
  const { container } = render(<HelpView />);
  const text = container.textContent ?? "";
  expect(text).not.toContain("Solver Settings");
  expect(text).toContain("Planning rules & AI");
  expect(text).toContain("gear button");
  expect(text).toContain("Shifts file");
  expect(text).not.toMatch(/Rest Day Pool|Vacation Pool|section block/);
});

it("describes the import backup and the regional holiday loading", () => {
  const { container } = render(<HelpView />);
  const text = (container.textContent ?? "").replace(/\s+/g, " ");
  expect(text).toContain("saved first as the latest automatic backup");
  expect(text).toContain("nothing is imported");
  expect(text).toContain("a file without a single shift for this calendar (or larger than 10 MB) changes nothing");
  expect(text).toContain("Load copy (Settings → Users) saves this backup first too");
  expect(text).not.toMatch(/without a backup|save a Calendar snapshot first/);
  expect(text).toContain("holidays you added by hand (date + name) stay");
  // Without a state every state's regional holidays are loaded (v1.72).
  expect(text).toContain("without one, the regional holidays of every state are loaded");
});

it("says that a name dragged into the Rest Day row keeps automatic planning away (v1.75)", () => {
  const { container } = render(<HelpView />);
  const text = (container.textContent ?? "").replace(/\s+/g, " ");
  expect(text).toContain(
    "A name you drag in marks a day off: automatic planning leaves that person free that day.",
  );
});

it("explains the stacked week: one workplace per row, no +N badge (v1.76)", () => {
  const { container } = render(<HelpView />);
  const text = (container.textContent ?? "").replace(/\s+/g, " ");
  expect(text).toContain("A row of the plan never mixes workplaces, nor separate times of one workplace");
  expect(text).toContain("hatched on the days without it");
  expect(text).toContain("a small clock under the names gives that day’s time");
  expect(text).not.toContain("+N next to a row name");
  expect(text).not.toContain("names its own workplace");
});

it("describes what the public web link shows", () => {
  const { container } = render(<HelpView />);
  const text = (container.textContent ?? "").replace(/\s+/g, " ");
  expect(text).toContain("the same layout and Times (stacked or side by side)");
  expect(text).toContain("On a phone it shows one day at a time, its times stacked.");
});
