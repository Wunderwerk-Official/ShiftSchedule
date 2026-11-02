import type { AppState } from "../api/client";

// Saving a shifts file import: the calendar as shown is saved as an
// auto-backup first ("Auto-backup before shifts file import" in Calendar
// snapshots), then the imported calendar replaces it. When the backup cannot
// be saved, nothing is imported.

export const IMPORT_BACKUP_FAILED_MESSAGE =
  "The backup could not be saved, so nothing was imported.";

export type ShiftsFileImportDeps = {
  /** Saves `state` as the auto-backup and returns its name. */
  createBackup: (state: AppState) => Promise<{ name: string }>;
  saveState: (state: AppState) => Promise<unknown>;
};

/**
 * Back up `current`, then save `next`. Returns the backup's name. Throws
 * (without saving `next`) when the backup fails; a failing save is passed on.
 */
export async function saveShiftsFileImport(
  current: AppState,
  next: AppState,
  deps: ShiftsFileImportDeps,
): Promise<{ backupName: string }> {
  let backupName: string;
  try {
    backupName = (await deps.createBackup(current)).name;
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
    throw new Error(`${IMPORT_BACKUP_FAILED_MESSAGE}${detail}`);
  }
  await deps.saveState(next);
  return { backupName };
}
