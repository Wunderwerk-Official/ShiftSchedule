import { cx } from "../../lib/classNames";
import { SWAPS_WAIT_FOR_CALENDAR } from "../../lib/swaps/format";
import { SwapGlyph } from "./PillSwapButton";

/**
 * TopBar entry to the swap history (next to Snapshots), shaped like the
 * snapshot trigger. Pressed while the history drawer is open; the page closes
 * it on a second click. Until this user's calendar has loaded it waits,
 * disabled with the reason as its tooltip, like the snapshot buttons (v1.79).
 */
export default function SwapHistoryButton({
  pressed,
  onClick,
  calendarLoading = false,
}: {
  pressed: boolean;
  onClick: () => void;
  calendarLoading?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label="Swap history"
      title={calendarLoading ? SWAPS_WAIT_FOR_CALENDAR : "Swap history"}
      aria-pressed={pressed}
      disabled={calendarLoading}
      onClick={onClick}
      className={cx(
        "inline-flex items-center rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm",
        "hover:bg-slate-50 active:bg-slate-100",
        "dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-700",
        "disabled:cursor-not-allowed disabled:opacity-40",
        pressed ? "bg-slate-100 dark:bg-slate-700" : "bg-white dark:bg-slate-800",
      )}
    >
      <SwapGlyph className="h-4 w-4" />
    </button>
  );
}
