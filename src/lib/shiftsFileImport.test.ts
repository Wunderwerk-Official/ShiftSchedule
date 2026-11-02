import { describe, expect, it, vi } from "vitest";
import type { AppState } from "../api/client";
import { IMPORT_BACKUP_FAILED_MESSAGE, saveShiftsFileImport } from "./shiftsFileImport";

const current = { assignments: [{ id: "old" }] } as unknown as AppState;
const next = { assignments: [{ id: "new" }] } as unknown as AppState;

describe("saveShiftsFileImport", () => {
  it("backs up the shown calendar before saving the imported one", async () => {
    const calls: string[] = [];
    const createBackup = vi.fn(async (state: AppState) => {
      calls.push("backup");
      expect(state).toBe(current);
      return { name: "Auto-backup before shifts file import" };
    });
    const saveState = vi.fn(async (state: AppState) => {
      calls.push("save");
      expect(state).toBe(next);
    });

    const result = await saveShiftsFileImport(current, next, { createBackup, saveState });

    expect(calls).toEqual(["backup", "save"]);
    expect(result.backupName).toBe("Auto-backup before shifts file import");
  });

  it("imports nothing when the backup fails", async () => {
    const createBackup = vi.fn(async () => {
      throw new Error("Session expired");
    });
    const saveState = vi.fn(async () => undefined);

    await expect(
      saveShiftsFileImport(current, next, { createBackup, saveState }),
    ).rejects.toThrow(`${IMPORT_BACKUP_FAILED_MESSAGE} (Session expired)`);
    expect(saveState).not.toHaveBeenCalled();
  });

  it("passes on a failing save after the backup", async () => {
    const createBackup = vi.fn(async () => ({ name: "Auto-backup before shifts file import" }));
    const saveState = vi.fn(async () => {
      throw new Error("Failed to save state: 500");
    });

    await expect(
      saveShiftsFileImport(current, next, { createBackup, saveState }),
    ).rejects.toThrow("Failed to save state: 500");
    expect(createBackup).toHaveBeenCalledTimes(1);
  });
});
