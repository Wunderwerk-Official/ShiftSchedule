import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ConstraintPulse, { type ConstraintPulseStats } from "./ConstraintPulse";

const stats = (filledSlots: number, totalRequiredSlots: number): ConstraintPulseStats => ({
  filledSlots,
  totalRequiredSlots,
  nonConsecutiveShifts: 0,
  locationChanges: 0,
  onCallRestViolations: 0,
  peopleWeeksWithinHours: 0,
  totalPeopleWeeksWithTarget: 0,
  sectionPreferenceMatches: 0,
  totalClassAssignments: 0,
  timeWindowFits: 0,
  totalAssignmentsWithTimeWindows: 0,
});

describe("ConstraintPulse coverage", () => {
  it("never reads 100% while a required position is open", () => {
    render(<ConstraintPulse stats={stats(209, 210)} onCallRestEnabled={false} />);
    expect(screen.getByText("99%")).toBeTruthy();
    expect(screen.queryByText("✓")).toBeNull();
  });

  it("reads 100% with a check mark once every position is filled", () => {
    render(<ConstraintPulse stats={stats(210, 210)} onCallRestEnabled={false} />);
    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.getByText("✓")).toBeTruthy();
  });

  it("rounds down in between", () => {
    render(<ConstraintPulse stats={stats(1, 26)} onCallRestEnabled={false} />);
    expect(screen.getByText("3%")).toBeTruthy();
  });
});
