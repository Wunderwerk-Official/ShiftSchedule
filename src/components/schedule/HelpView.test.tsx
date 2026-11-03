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
  // v1.84: the section order is strict for the AI planner.
  expect(text).toMatch(/The order under Settings → Planning rules\s+& AI → Section priority when short-staffed is strict: a required slot\s+in a section higher in the list comes before any number of slots further\s+down, even if more slots stay open in total/);
  expect(text).toMatch(/filling the\s+sections from the top of the list/);
  expect(text).toMatch(/The on-call section counts at\s+its own place in that list/);
  expect(text).toMatch(/slots only one person can take\s+and on-call duties first, then the sections in their order/);
  expect(text).toMatch(/The basic plan without AI \(no key, budget used up, AI error\) does not\s+follow the order/);
  expect(text).not.toContain("prefers to leave the");
  expect(text).toContain("46/45 h in 2026-W45");
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

it("says that a holiday change removes the shifts of the changed days only after asking", () => {
  const { container } = render(<HelpView />);
  const text = (container.textContent ?? "").replace(/\s+/g, " ");
  expect(text).toContain(
    "A day that becomes a holiday or stops being one (adding, removing or loading holidays) " +
      "switches to the other day's columns, so the shifts planned on it no longer fit and are " +
      "removed, locked ones too.",
  );
  expect(text).toContain("when you confirm, the calendar is saved as the automatic backup (see 10) before the change");
  expect(text).toContain(
    "Before a restore, a planning result, a shifts file import or a holiday change that removes " +
      "shifts is applied, the current calendar is saved as an automatic backup.",
  );
});

it("says that a name dragged into the Rest Day row keeps automatic planning away (v1.75)", () => {
  const { container } = render(<HelpView />);
  const text = (container.textContent ?? "").replace(/\s+/g, " ");
  expect(text).toContain(
    "A name you drag in marks a day off: automatic planning leaves that person free that day.",
  );
});

it("explains moving and removing rest days and the week in the address (v1.82)", () => {
  const { container } = render(<HelpView />);
  const text = (container.textContent ?? "").replace(/\s+/g, " ");
  expect(text).toContain(
    "Drag such a name to another day’s Rest Day row to move the day off, or out of the calendar to remove it.",
  );
  expect(text).toContain("Rest days from the on-call rule follow the on-call shift");
  expect(text).toContain("the monthly sheet, which lists no violations, underlines the name in red");
  expect(text).toContain("or out of the calendar, to end the vacation that day");
  expect(text).toContain("A week you move to becomes part of the page address");
  expect(text).toContain("The plain address, without a week, always opens the current week.");
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

it("explains short names and the accent-insensitive person search", () => {
  const { container } = render(<HelpView />);
  const text = (container.textContent ?? "").replace(/\s+/g, " ");
  expect(text).toContain("“muller” or “mueller” finds “Müller”");
  expect(text).toContain("A short name always stands for one person of the team, also in PDFs and on the public page");
  expect(text).toContain("shorten to “Jörg M.”; the clinic sheet lists the surname.");
});

it("explains Find a swap: the S key and Undo (v1.81)", () => {
  const { container } = render(<HelpView />);
  expect(screen.getByRole("heading", { name: "13. Find a swap" })).toBeVisible();
  const text = container.textContent ?? "";
  expect(text).toMatch(/press S while its\s+lock or ⇄ button has focus/);
  expect(text).toMatch(/Undo is in the toast for 10 seconds and later\s+under Swap history/);
  expect(text).toMatch(/inside 48 h before the start also tick the notice override/);
  expect(text).toMatch(
    /A hand-over that leaves the giver\s+under their contract hours says so once, in an amber note under the shift/,
  );
  // A Rest Day is a day off placed by hand (v1.75): removing it is never a best match.
  expect(text).toMatch(
    /A Rest Day of the person who\s+takes a shift is removed on that day, as when you add a shift by hand; such an\s+option is listed under Also possible with the\s+note Rest Day removed\./,
  );
});
