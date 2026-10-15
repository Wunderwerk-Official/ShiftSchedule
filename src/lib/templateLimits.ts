import type { WeeklyCalendarTemplate } from "../api/client";

/**
 * Upper bound for column bands summed over all locations of the weekly
 * template. Above it the calendar refuses to save (a sanity check against
 * the historic colBand explosion; 20 per day type x 8 day types x 5
 * locations would be 800).
 */
export const MAX_TOTAL_COLBANDS = 300;

/** Column bands of the weekly template, summed over all locations. */
export function countTemplateColBands(template?: WeeklyCalendarTemplate): number {
  return (
    template?.locations?.reduce((sum, location) => sum + (location.colBands?.length ?? 0), 0) ?? 0
  );
}
