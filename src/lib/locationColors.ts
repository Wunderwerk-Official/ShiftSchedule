import type { Location } from "../api/client";
import { AUTO_LOCATION_COLOR_IDS, LOCATION_COLOR_OPTIONS } from "./colorPalette";

// Location colors of the team grid (v1.71): every location has a color, so
// the label column can say where a row belongs. A location keeps the color
// chosen for it in the weekly template; one without a color gets the next
// automatic color in location order. Presentation only: nothing is stored.

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** The automatic colors ("#RRGGBB" grounds of the presets), most distinct first. */
export const AUTO_LOCATION_COLORS: string[] = AUTO_LOCATION_COLOR_IDS.map(
  (id) => LOCATION_COLOR_OPTIONS.find((option) => option.id === id)!.color,
);

/** A valid own color ("#RRGGBB", uppercased) or null, like normalizeLocationColor. */
export function ownLocationColor(location: Pick<Location, "color">): string | null {
  const color = location.color;
  return typeof color === "string" && HEX_COLOR.test(color) ? color.toUpperCase() : null;
}

/**
 * Color of every location by id: its own color, or else the next automatic
 * color in location order that no location chose for itself. So two
 * locations only share a color when one was chosen twice or the automatic
 * colors run out (then they repeat).
 */
export function resolveLocationColors(
  locations: Array<Pick<Location, "id" | "color">>,
): Map<string, string> {
  const chosen = new Set(locations.map(ownLocationColor).filter((color): color is string => !!color));
  const free = AUTO_LOCATION_COLORS.filter((color) => !chosen.has(color));
  const pool = free.length > 0 ? free : AUTO_LOCATION_COLORS;
  const colors = new Map<string, string>();
  let next = 0;
  for (const location of locations) {
    const own = ownLocationColor(location);
    if (own) {
      colors.set(location.id, own);
      continue;
    }
    colors.set(location.id, pool[next % pool.length]);
    next += 1;
  }
  return colors;
}

/** The color a location gets without its own one ("Auto" in the template). */
export function autoLocationColor(
  locations: Array<Pick<Location, "id" | "color">>,
  locationId: string,
): string {
  const withoutOwn = locations.map((location) =>
    location.id === locationId ? { id: location.id } : location,
  );
  return resolveLocationColors(withoutOwn).get(locationId) ?? AUTO_LOCATION_COLORS[0];
}
