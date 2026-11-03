import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createImportBackup,
  exportUserState,
  getState,
  savedStateRevision,
  saveState,
  type AppState,
} from "../../api/client";
import { ConfirmDialogProvider } from "../ui/ConfirmDialog";
import AdminUsersPanel from "./AdminUsersPanel";

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  listUsers: vi.fn(() =>
    Promise.resolve([{ username: "dr-meyer", role: "user", active: true }]),
  ),
  adminListRunFeedback: vi.fn(() => Promise.resolve([])),
  exportUserState: vi.fn(),
  savedStateRevision: vi.fn(),
  getState: vi.fn(),
  createImportBackup: vi.fn(),
  saveState: vi.fn(),
}));

const renderPanel = (isAdmin: boolean) => (
  <ConfirmDialogProvider>
    <AdminUsersPanel isAdmin={isAdmin} />
  </ConfirmDialogProvider>
);

describe("AdminUsersPanel", () => {
  it("survives isAdmin toggling on an existing instance (stable hook order)", async () => {
    const { container, rerender } = render(renderPanel(false));
    expect(container).toBeEmptyDOMElement();

    rerender(renderPanel(true));
    expect((await screen.findAllByText("dr-meyer")).length).toBeGreaterThan(0);

    rerender(renderPanel(false));
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Load copy", () => {
  const own = { assignments: [{ id: "mine" }], revision: "own-r4" } as unknown as AppState;
  const copy = { assignments: [{ id: "theirs" }] } as unknown as AppState;
  const reload = vi.fn();
  const originalLocation = window.location;

  beforeEach(() => {
    vi.mocked(exportUserState).mockResolvedValue({
      version: 1, exportedAt: "2026-11-02T23:30:00Z", sourceUser: "dr-meyer", state: copy,
    });
    vi.mocked(savedStateRevision).mockResolvedValue("own-r4");
    vi.mocked(getState).mockResolvedValue(own);
    vi.mocked(createImportBackup).mockResolvedValue({
      id: "auto", name: "Auto-backup before loading a copy", kind: "auto_backup",
      created_at: "", updated_at: "", size_bytes: 1,
    });
    vi.mocked(saveState).mockResolvedValue(copy);
    Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, reload } });
  });

  afterEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  });

  const loadCopy = async () => {
    render(renderPanel(true));
    fireEvent.click((await screen.findAllByRole("button", { name: "Load copy" }))[0]);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(
      "It is saved in Calendar snapshots first; this automatic backup replaces the previous one.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Load copy" }));
  };

  it("backs up the own calendar before loading the copy", async () => {
    await loadCopy();
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(createImportBackup).toHaveBeenCalledWith(own, { reason: "load_copy", expectedRevision: "own-r4" });
    expect(saveState).toHaveBeenCalledWith(copy);
    expect(vi.mocked(createImportBackup).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(saveState).mock.invocationCallOrder[0],
    );
  });

  it("loads nothing when the backup is refused", async () => {
    vi.mocked(createImportBackup).mockRejectedValue(
      new Error("The calendar changed in another tab or operation."),
    );
    await loadCopy();
    expect(
      await screen.findByText(
        "Could not load the user's schedule; your own schedule was not changed. " +
          "(The calendar changed in another tab or operation.)",
      ),
    ).toBeVisible();
    expect(saveState).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
