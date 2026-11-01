import { cx } from "../../lib/classNames";
import { SwapGlyph } from "./PillSwapButton";

/**
 * TopBar entry to the swap history (next to Snapshots), shaped like the
 * snapshot trigger. Pressed while the history drawer is open; the page closes
 * it on a second click.
 */
export default function SwapHistoryButton({ pressed, onClick }: { pressed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Swap history"
      title="Swap history"
      aria-pressed={pressed}
      onClick={onClick}
      className={cx(
        "inline-flex items-center rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm",
        "hover:bg-slate-50 active:bg-slate-100",
        "dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-700",
        pressed ? "bg-slate-100 dark:bg-slate-700" : "bg-white dark:bg-slate-800",
      )}
    >
      <SwapGlyph className="h-4 w-4" />
    </button>
  );
}
