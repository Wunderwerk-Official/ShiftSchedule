import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import HelpView from "./HelpView";

const helpText = () => (render(<HelpView />).container.textContent ?? "").replace(/\s+/g, " ");

it("describes timed iCal events in the plan's time zone (v1.78)", () => {
  const text = helpText();
  expect(text).toContain("Each event has the shift’s start and end time in the plan’s time zone, which follows the holiday country");
  expect(text).toContain("A night shift ends the next morning");
  expect(text).toContain("Downloads contain published weeks only; tick Include unpublished weeks to add drafts.");
  expect(text).toContain("Removing a person from the plan ends their link.");
  expect(text).not.toMatch(/all-day/i);
});

it("says that My plan hours are real time across DST changes (v1.78)", () => {
  expect(helpText()).toContain("real time in the plan’s time zone: a night across a daylight saving change counts one hour more in October");
});
