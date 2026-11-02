import { createImportBackup, type AppState, type Assignment } from "../api/client";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { HOLIDAY_BACKUP_FAILED_MESSAGE, holidayChangeConfirmation } from "../lib/holidayChange";

/**
 * Asks before a holiday change removes `dropped`, the shifts of `current`
 * (the calendar as shown) that no longer fit their day's plan (see
 * findAssignmentsDroppedByHolidayChange). On confirm, `current` is saved as
 * the automatic backup ("Auto-backup before holiday change") first.
 * Resolves to false when the user cancels; throws when the backup fails,
 * and then the change must not be applied.
 */
export function useConfirmHolidayChange() {
  const confirm = useConfirm();
  return async (current: AppState, dropped: Assignment[]): Promise<boolean> => {
    const confirmed = await confirm({
      ...holidayChangeConfirmation(dropped),
      cancelLabel: "Cancel",
      variant: "danger",
    });
    if (!confirmed) return false;
    try {
      await createImportBackup(current, { reason: "holiday_change" });
    } catch (error) {
      const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
      throw new Error(`${HOLIDAY_BACKUP_FAILED_MESSAGE}${detail}`);
    }
    return true;
  };
}
