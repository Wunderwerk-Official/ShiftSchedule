import { createImportBackup, savedStateRevision, type AppState, type Assignment } from "../api/client";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { HOLIDAY_BACKUP_FAILED_MESSAGE, holidayChangeConfirmation } from "../lib/holidayChange";

/**
 * Asks before a holiday change removes `dropped`, the shifts that no longer
 * fit their day's plan (see findAssignmentsDroppedByHolidayChange).
 * Resolves to false when the user cancels.
 */
export function useConfirmHolidayChange() {
  const confirm = useConfirm();
  return (dropped: Assignment[]): Promise<boolean> =>
    confirm({
      ...holidayChangeConfirmation(dropped),
      cancelLabel: "Cancel",
      variant: "danger",
    });
}

/**
 * Saves `current` (the calendar as shown) as the automatic backup ("Auto-backup
 * before holiday change") once the change is confirmed. Throws when the backup
 * fails, and then the change must not be applied. Like the shifts file import
 * it sends this tab's saved revision, so a tab whose calendar was changed
 * elsewhere is refused (409) and the previous backup is kept.
 */
export async function backupBeforeHolidayChange(current: AppState): Promise<void> {
  try {
    const expectedRevision = await savedStateRevision();
    await createImportBackup(current, { reason: "holiday_change", expectedRevision });
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
    throw new Error(`${HOLIDAY_BACKUP_FAILED_MESSAGE}${detail}`);
  }
}
