import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ClinicianEditor from "./ClinicianEditor";

const clinician = {
  id: "clin-1",
  name: "Dr. Smith",
  qualifiedClassIds: [],
  vacations: [{ id: "vac-1", startISO: "2026-08-03", endISO: "2026-08-07" }],
};

const renderEditor = (vacationOnly: boolean) =>
  render(
    <ClinicianEditor
      clinician={clinician}
      classRows={[{ id: "class-1", name: "Ward" }]}
      vacationOnly={vacationOnly}
      onToggleQualification={vi.fn()}
      onReorderQualification={vi.fn()}
      onAddVacation={vi.fn()}
      onUpdateVacation={vi.fn()}
      onRemoveVacation={vi.fn()}
    />,
  );

describe("ClinicianEditor vacationOnly", () => {
  it("renders all three sections by default", () => {
    renderEditor(false);
    expect(screen.getByText("Eligible Sections")).toBeInTheDocument();
    expect(screen.getByText("Vacation")).toBeInTheDocument();
    expect(screen.getByText("Preferred Working Times")).toBeInTheDocument();
  });

  it("renders only the vacation section when vacationOnly", () => {
    renderEditor(true);
    expect(screen.queryByText("Eligible Sections")).not.toBeInTheDocument();
    expect(screen.getByText("Vacation")).toBeInTheDocument();
    expect(screen.queryByText("Preferred Working Times")).not.toBeInTheDocument();
  });
});
