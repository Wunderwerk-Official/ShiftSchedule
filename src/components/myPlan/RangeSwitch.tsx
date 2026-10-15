import type { PlanRange } from "../../api/client";
import { cx } from "../../lib/classNames";
import { segmentClass, segmentGroupClass } from "./planChrome";
import { SHORTCUT_KEYS } from "./usePlanShortcuts";
import { RANGE_LABELS } from "./viewConfig";

// Day | Week | Month segmented control (plan §2.3).

const RANGES: PlanRange[] = ["day", "week", "month"];

type RangeSwitchProps = {
  range: PlanRange;
  onChange: (range: PlanRange) => void;
  isMobile?: boolean;
};

export default function RangeSwitch({ range, onChange, isMobile = false }: RangeSwitchProps) {
  return (
    <div
      role="group"
      aria-label="Period"
      className={cx(segmentGroupClass, isMobile ? "h-11 flex-1" : "h-10")}
    >
      {RANGES.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={range === value}
          onClick={() => onChange(value)}
          title={`${RANGE_LABELS[value]} (${SHORTCUT_KEYS[value]})`}
          className={cx(
            segmentClass(range === value),
            "justify-center px-3.5",
            isMobile ? "h-10 flex-1 text-[15px]" : "h-[34px] text-[13px]",
          )}
        >
          {RANGE_LABELS[value]}
        </button>
      ))}
    </div>
  );
}
