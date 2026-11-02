import { act, fireEvent, renderHook, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createImportBackup, type AppState, type Assignment } from "../api/client";
import { ConfirmDialogProvider } from "../components/ui/ConfirmDialog";
import { useConfirmHolidayChange } from "./useConfirmHolidayChange";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  createImportBackup: vi.fn(),
}));

const current = { assignments: [], holidays: [] } as unknown as AppState;
const dropped: Assignment[] = [
  { id: "a1", rowId: "slot-thu", dateISO: "2026-12-24", clinicianId: "c1", source: "solver" },
  { id: "a2", rowId: "slot-thu", dateISO: "2026-12-24", clinicianId: "c2", source: "solver", locked: true },
];

function start() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ConfirmDialogProvider>{children}</ConfirmDialogProvider>
  );
  const { result } = renderHook(() => useConfirmHolidayChange(), { wrapper });
  let outcome!: Promise<boolean>;
  act(() => {
    outcome = result.current(current, dropped);
  });
  return outcome;
}

beforeEach(() => {
  vi.mocked(createImportBackup).mockReset();
});

describe("useConfirmHolidayChange", () => {
  it("says what is removed, then backs up the calendar before it confirms", async () => {
    vi.mocked(createImportBackup).mockResolvedValue({
      id: "b1", name: "Auto-backup before holiday change", kind: "auto_backup",
      created_at: "", updated_at: "", size_bytes: 1,
    });
    const outcome = start();

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Remove 2 shifts?");
    expect(dialog).toHaveTextContent(
      "2 shifts, 1 of them locked, no longer fit their day's plan and will be removed: Thu 24.12.2026 (2 shifts).",
    );
    expect(dialog).toHaveTextContent("An automatic backup of the calendar is saved in Calendar snapshots first.");
    expect(createImportBackup).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove 2 shifts" }));
    await expect(outcome).resolves.toBe(true);
    expect(createImportBackup).toHaveBeenCalledWith(current, { reason: "holiday_change" });
  });

  it("changes nothing when cancelled", async () => {
    const outcome = start();
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await expect(outcome).resolves.toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(createImportBackup).not.toHaveBeenCalled();
  });

  it("refuses the change when the backup cannot be saved", async () => {
    vi.mocked(createImportBackup).mockRejectedValue(new Error("Failed to save the backup: 500"));
    const outcome = start();
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove 2 shifts" }));
    await expect(outcome).rejects.toThrow(
      "The backup could not be saved, so the holidays were not changed. (Failed to save the backup: 500)",
    );
  });
});
