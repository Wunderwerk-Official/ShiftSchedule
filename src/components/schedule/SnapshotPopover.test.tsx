import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SnapshotPopover from "./SnapshotPopover";
import type { SnapshotMeta } from "../../api/client";

const snapshots: SnapshotMeta[] = [
  {
    id: "snap-1",
    name: "Planung Juli",
    kind: "named",
    created_at: "2026-07-20T10:00:00+00:00",
    updated_at: "2026-07-20T10:00:00+00:00",
    size_bytes: 1234,
  },
  {
    id: "snap-auto",
    name: "Auto-backup before restore",
    kind: "auto_backup",
    created_at: "2026-07-21T09:00:00+00:00",
    updated_at: "2026-07-21T09:00:00+00:00",
    size_bytes: 999,
  },
];

const listSnapshots = vi.fn();
vi.mock("../../api/client", () => ({
  listSnapshots: (...args: unknown[]) => listSnapshots(...args),
  deleteSnapshot: vi.fn(() => Promise.resolve()),
  renameSnapshot: vi.fn(() => Promise.resolve(snapshots[0])),
}));

const setup = (restoreDisabled = false) => {
  const onSaveSnapshot = vi.fn(() => Promise.resolve());
  const onRestoreSnapshot = vi.fn(() => Promise.resolve());
  render(
    <SnapshotPopover
      onSaveSnapshot={onSaveSnapshot}
      onRestoreSnapshot={onRestoreSnapshot}
      restoreDisabled={restoreDisabled}
    />,
  );
  return { onSaveSnapshot, onRestoreSnapshot };
};

describe("SnapshotPopover", () => {
  beforeEach(() => {
    listSnapshots.mockReset();
    listSnapshots.mockResolvedValue(snapshots);
  });

  it("lists snapshots with the automatic badge after opening", async () => {
    setup();
    fireEvent.click(screen.getByLabelText("Calendar snapshots"));
    await waitFor(() => expect(screen.getByText("Planung Juli")).toBeTruthy());
    expect(screen.getByText("Automatic")).toBeTruthy();
    // The auto-backup row must not offer Rename.
    expect(screen.getAllByText("Rename")).toHaveLength(1);
  });

  it("saves the current calendar under the typed name", async () => {
    const { onSaveSnapshot } = setup();
    fireEvent.click(screen.getByLabelText("Calendar snapshots"));
    await waitFor(() => expect(screen.getByText("Planung Juli")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("Snapshot name"), {
      target: { value: "  Vor Urlaubsänderungen " },
    });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(onSaveSnapshot).toHaveBeenCalledWith("Vor Urlaubsänderungen"),
    );
  });

  it("restores only after the inline confirmation", async () => {
    const { onRestoreSnapshot } = setup();
    fireEvent.click(screen.getByLabelText("Calendar snapshots"));
    await waitFor(() => expect(screen.getByText("Planung Juli")).toBeTruthy());
    fireEvent.click(screen.getAllByText("Restore")[0]);
    expect(onRestoreSnapshot).not.toHaveBeenCalled();
    expect(screen.getByText(/Restores the entire calendar/)).toBeTruthy();
    // The row's own action is replaced by the confirm box, whose primary
    // button is now the FIRST "Restore" in DOM order.
    fireEvent.click(screen.getAllByText("Restore")[0]);
    await waitFor(() => expect(onRestoreSnapshot).toHaveBeenCalledWith("snap-1"));
  });

  it("disables restore while the solver runs", async () => {
    setup(true);
    fireEvent.click(screen.getByLabelText("Calendar snapshots"));
    await waitFor(() => expect(screen.getByText("Planung Juli")).toBeTruthy());
    const restoreButtons = screen.getAllByText("Restore") as HTMLButtonElement[];
    expect(restoreButtons.every((button) => button.disabled)).toBe(true);
  });
});
