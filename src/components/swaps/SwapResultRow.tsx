import { cx } from "../../lib/classNames";
import type { PersonTone } from "../../lib/myPlan";
import { unitLine, weekChange } from "../../lib/swaps/format";
import type { SwapChip, SwapMode, SwapOption } from "../../lib/swaps/types";
import { TEXT_1, TEXT_2, outlineButtonClass } from "../myPlan/planChrome";
import { Avatar } from "../myPlan/viewParts";

// One option of the swap list (SPEC §5.5): the partner, their shift or their
// week, chips, and "Preview". A blocked option names its one reason instead.

const chipClass = "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold";
const CHIP_TONES: Record<SwapChip["tone"], string> = {
  positive: "bg-emerald-50 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  neutral: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
};
const amberChipClass = "bg-amber-50 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";

const PREVIEW_LABELS: Record<SwapMode, (name: string) => string> = {
  swap: (name) => `Preview swap with ${name}`,
  handover: (name) => `Preview hand over to ${name}`,
  cover: (name) => `Preview ${name} covering`,
};

/** Swap: the partner's shift. Hand-over and cover: the partner's first touched week. */
function detailLine(option: SwapOption, mode: SwapMode): string | null {
  if (mode === "swap") return option.take ? unitLine(option.take) : null;
  const week = option.hours.find((person) => person.clinicianId === option.partnerId)?.weeks[0];
  return week ? weekChange(week) : null;
}

type SwapResultRowProps = {
  option: SwapOption;
  mode: SwapMode;
  /** The partner's person color (clinician list order). */
  tone?: PersonTone;
  onPreview: (key: string) => void;
  /** Hover or focus on the row: the drawer outlines the partner's shift. */
  onHover: (key: string | null) => void;
};

export default function SwapResultRow({ option, mode, tone, onPreview, onHover }: SwapResultRowProps) {
  const blocked = option.group === "blocked";
  const line = detailLine(option, mode);
  const notes = [...option.warnings, ...option.findings].map((entry) => entry.short).slice(0, 2);
  return (
    <li
      data-swap-option={option.key}
      className="flex min-h-14 items-center gap-3 py-2"
      onMouseEnter={() => onHover(option.key)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(option.key)}
      onBlur={() => onHover(null)}
    >
      <Avatar name={option.partnerName} tone={tone} size="l" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cx("truncate text-[13px] font-semibold leading-4", TEXT_1)}>{option.partnerName}</span>
        {line ? <span className={cx("truncate text-xs tabular-nums", TEXT_2)}>{line}</span> : null}
        {blocked ? (
          <span className="text-xs text-rose-700 dark:text-rose-300">{option.reason?.message}</span>
        ) : option.chips.length + notes.length > 0 ? (
          <span className="mt-0.5 flex flex-wrap gap-1">
            {option.chips.map((chip) => (
              <span key={chip.code} className={cx(chipClass, CHIP_TONES[chip.tone])}>
                {chip.label}
              </span>
            ))}
            {notes.map((short, index) => (
              <span key={`note-${index}`} className={cx(chipClass, amberChipClass)}>
                {short}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      {blocked ? null : (
        <button
          type="button"
          data-swap-preview="true"
          aria-label={PREVIEW_LABELS[mode](option.partnerName)}
          onClick={() => onPreview(option.key)}
          className={cx(outlineButtonClass, "shrink-0")}
        >
          Preview
        </button>
      )}
    </li>
  );
}
