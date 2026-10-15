import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import type { PreferredWorkingTimes } from "../../api/client";
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

// Mirrors the page wiring: emitted preferred times are written back into the
// clinician that is passed to the editor again.
function PreferredTimesHost({
  onEmit,
  vacationOnly = false,
}: {
  onEmit: (times: PreferredWorkingTimes) => void;
  vacationOnly?: boolean;
}) {
  const [current, setCurrent] = useState<typeof clinician & {
    preferredWorkingTimes?: PreferredWorkingTimes;
  }>(clinician);
  return (
    <ClinicianEditor
      clinician={current}
      classRows={[{ id: "class-1", name: "Ward" }]}
      vacationOnly={vacationOnly}
      onUpdatePreferredWorkingTimes={(_id, preferredWorkingTimes) => {
        onEmit(preferredWorkingTimes);
        setCurrent((prev) => ({ ...prev, preferredWorkingTimes }));
      }}
      onToggleQualification={vi.fn()}
      onReorderQualification={vi.fn()}
      onAddVacation={vi.fn()}
      onUpdateVacation={vi.fn()}
      onRemoveVacation={vi.fn()}
    />
  );
}

const mondayRow = () => {
  // "Mon" also appears in the work pattern editor; pick the preferred-times row.
  const row = screen
    .getAllByText("Mon")
    .map((label) => label.parentElement)
    .find((el) => el && within(el).queryByText("No preference"));
  if (!row) throw new Error("Monday row not found");
  return within(row);
};

const pickTime = (current: string, next: string) => {
  fireEvent.click(mondayRow().getByRole("button", { name: current }));
  fireEvent.click(mondayRow().getByRole("button", { name: next }));
};

const flushTimers = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)));

describe("ClinicianEditor preferred working times", () => {
  it("keeps a newly picked time and emits it", async () => {
    const onEmit = vi.fn();
    render(<PreferredTimesHost onEmit={onEmit} />);
    fireEvent.click(mondayRow().getByRole("button", { name: "Preferred" }));
    pickTime("07:00", "09:00");
    await flushTimers();

    expect(mondayRow().getByRole("button", { name: "09:00" })).toBeInTheDocument();
    const last: PreferredWorkingTimes = onEmit.mock.calls.at(-1)![0];
    expect(last.mon).toMatchObject({ startTime: "09:00", requirement: "preference" });
  });

  it.each([false, true])("does not emit on mount (vacationOnly=%s)", async (vacationOnly) => {
    const onEmit = vi.fn();
    render(<PreferredTimesHost onEmit={onEmit} vacationOnly={vacationOnly} />);
    await flushTimers();
    expect(onEmit).not.toHaveBeenCalled();
  });

  it("flags an end before the start immediately and keeps the value", async () => {
    const onEmit = vi.fn();
    render(<PreferredTimesHost onEmit={onEmit} />);
    fireEvent.click(mondayRow().getByRole("button", { name: "Preferred" }));
    pickTime("07:00", "18:00");
    expect(mondayRow().getByText("End time must be after start time.")).toBeInTheDocument();
    await flushTimers();
    expect(mondayRow().getByRole("button", { name: "18:00" })).toBeInTheDocument();
    expect(mondayRow().getByText("End time must be after start time.")).toBeInTheDocument();
  });
});

// One mounted editor whose clinician prop is switched, with emitted times
// written back into the matching clinician.
function SwitchingHost() {
  type Entry = typeof clinician & { preferredWorkingTimes?: PreferredWorkingTimes };
  const [byId, setById] = useState<Record<string, Entry>>({
    "clin-1": clinician,
    "clin-2": { ...clinician, id: "clin-2", name: "Dr. Jones" },
  });
  const [activeId, setActiveId] = useState("clin-1");
  return (
    <>
      <button type="button" onClick={() => setActiveId("clin-1")}>show A</button>
      <button type="button" onClick={() => setActiveId("clin-2")}>show B</button>
      <ClinicianEditor
        clinician={byId[activeId]}
        classRows={[{ id: "class-1", name: "Ward" }]}
        onUpdatePreferredWorkingTimes={(id, preferredWorkingTimes) =>
          setById((prev) => ({ ...prev, [id]: { ...prev[id], preferredWorkingTimes } }))
        }
        onToggleQualification={vi.fn()}
        onReorderQualification={vi.fn()}
        onAddVacation={vi.fn()}
        onUpdateVacation={vi.fn()}
        onRemoveVacation={vi.fn()}
      />
    </>
  );
}

describe("ClinicianEditor switching clinicians", () => {
  it("shows the clinician's own times after switching away and back", async () => {
    render(<SwitchingHost />);
    fireEvent.click(mondayRow().getByRole("button", { name: "Preferred" }));
    pickTime("07:00", "09:00");
    await flushTimers();

    fireEvent.click(screen.getByRole("button", { name: "show B" }));
    expect(mondayRow().getByRole("button", { name: "07:00" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "show A" }));
    expect(mondayRow().getByRole("button", { name: "09:00" })).toBeInTheDocument();
  });
});
