import type { Orientation, PlanRange } from "../../api/client";
import { cx } from "../../lib/classNames";
import PlanIcon from "./PlanIcons";
import { segmentClass, segmentGroupClass } from "./planChrome";
import { orientationLabel, orientationTooltip } from "./viewConfig";
import { SHORTCUT_KEYS } from "./usePlanShortcuts";

// "Date on top | Date on left" with an axis icon and a second line that
// depends on the range (plan §2.3). Compact (phones): icons only.

const ORIENTATIONS: Orientation[] = ["top", "left"];

type OrientationSwitchProps = {
  range: PlanRange;
  orientation: Orientation;
  onChange: (orientation: Orientation) => void;
  compact?: boolean;
};

export default function OrientationSwitch({
  range,
  orientation,
  onChange,
  compact = false,
}: OrientationSwitchProps) {
  return (
    <div
      role="group"
      aria-label="Arrangement of days"
      className={cx(segmentGroupClass, compact ? "h-11" : "h-10")}
    >
      {ORIENTATIONS.map((value) => {
        const active = orientation === value;
        const { title, subtitle } = orientationLabel(range, value);
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            aria-label={compact ? `${title} – ${subtitle}` : undefined}
            title={`${orientationTooltip(range, value)} Switch with ${SHORTCUT_KEYS.orientation}.`}
            onClick={() => onChange(value)}
            className={cx(
              segmentClass(active),
              compact ? "h-10 w-11 justify-center" : "h-[34px] gap-2 pl-2.5 pr-3.5",
            )}
          >
            <PlanIcon
              name={value === "top" ? "orientTop" : "orientLeft"}
              className={compact ? "h-5 w-5" : "h-4 w-4"}
            />
            {compact ? null : (
              <span className="flex flex-col text-left">
                <span className="text-xs font-semibold leading-[14px]">{title}</span>
                <span className="text-[11px] font-medium leading-[13px]">{subtitle}</span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
