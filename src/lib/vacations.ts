export type VacationRange = { id: string; startISO: string; endISO: string };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function shiftISODate(dateISO: string, delta: number): string {
  const [year, month, day] = dateISO.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) + delta * MS_PER_DAY);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Inserts an inclusive date range into a vacation list, merging adjacent and
// overlapping ranges into one. Returns the input array unchanged (same
// reference) when the range is already fully covered, so callers can skip
// state updates.
export function insertVacationRange(
  vacations: VacationRange[],
  range: { startISO: string; endISO: string },
  makeId: () => string,
): VacationRange[] {
  if (
    vacations.some(
      (vacation) => vacation.startISO <= range.startISO && range.endISO <= vacation.endISO,
    )
  ) {
    return vacations;
  }
  const next = [...vacations, { id: makeId(), startISO: range.startISO, endISO: range.endISO }].sort(
    (a, b) => a.startISO.localeCompare(b.startISO),
  );
  const merged: VacationRange[] = [];
  for (const vacation of next) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push(vacation);
      continue;
    }
    if (vacation.startISO <= shiftISODate(last.endISO, 1)) {
      merged[merged.length - 1] = {
        ...last,
        endISO: vacation.endISO > last.endISO ? vacation.endISO : last.endISO,
      };
    } else {
      merged.push(vacation);
    }
  }
  return merged;
}
