import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import HelpView from "./HelpView";

const helpText = () => (render(<HelpView />).container.textContent ?? "").replace(/\s+/g, " ");

it("describes timed iCal events in the plan's time zone (v1.82)", () => {
  const text = helpText();
  expect(text).toContain("Each event has the shift’s start and end time in the plan’s time zone, which follows the holiday country");
  expect(text).toContain("A night shift ends the next morning");
  // Holds for any shift length (a 16:00–08:00 night lasts 17 h / 15 h).
  expect(text).toContain("a shift across a daylight saving change lasts its real time: one hour longer in October, one hour shorter in March.");
  expect(text).not.toMatch(/11 or 13 hours/);
  expect(text).toContain("Downloads contain published weeks only; tick Include unpublished weeks to add drafts.");
  expect(text).toContain("Removing a person from the plan ends their link; restoring a snapshot that brings them back (for example the automatic backup) brings their link back too.");
  expect(text).not.toMatch(/all-day/i);
});

it("says that My plan hours and the Next up countdown are real time across DST changes (v1.82)", () => {
  expect(helpText()).toContain("and the Next up countdown are real time in the plan’s time zone: a night across a daylight saving change counts one hour more in October");
});
