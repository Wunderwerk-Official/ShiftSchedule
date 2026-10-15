import type { PlanScope } from "../../api/client";
import { cx } from "../../lib/classNames";
import PlanIcon from "./PlanIcons";
import { segmentClass, segmentGroupClass } from "./planChrome";

// "Team | My plan" segmented control (plan §2.1). Exported for the team
// headers too (classic grid, clinic sheet): it only reports the new scope.

export type PlanScopeSwitchProps = {
  scope: PlanScope;
  onChange: (scope: PlanScope) => void;
  /** Initials of the linked person, shown in a small circle on "My plan". */
  meInitials?: string;
  /** Circle color (person color "strong"); defaults to slate-700. */
  meColor?: string;
  /** Label of the second segment; e.g. the viewed person's name. Default "My plan". */
  meLabel?: string;
  /** Phones: no Team icon, tighter padding. */
  compact?: boolean;
  className?: string;
};

export default function PlanScopeSwitch({
  scope,
  onChange,
  meInitials,
  meColor,
  meLabel = "My plan",
  compact = false,
  className,
}: PlanScopeSwitchProps) {
  const segment = (value: PlanScope) => cx(segmentClass(scope === value), "h-[30px] gap-1.5 text-sm");
  return (
    <div role="group" aria-label="Choose plan" className={cx(segmentGroupClass, "h-9", className)}>
      <button
        type="button"
        aria-pressed={scope === "team"}
        onClick={() => onChange("team")}
        className={cx(segment("team"), compact ? "px-3" : "px-3.5")}
        title="Team plan"
      >
        {compact ? null : <PlanIcon name="users" />}
        Team
      </button>
      <button
        type="button"
        aria-pressed={scope === "me"}
        onClick={() => onChange("me")}
        className={cx(segment("me"), meInitials ? (compact ? "pl-1 pr-3" : "pl-1 pr-3.5") : compact ? "px-3" : "px-3.5")}
        title={meLabel === "My plan" ? "My plan" : `Plan of ${meLabel}`}
      >
        {meInitials ? (
          <span
            aria-hidden="true"
            className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold leading-none text-white"
            style={{ backgroundColor: meColor ?? "#334155" }}
          >
            {meInitials}
          </span>
        ) : (
          <PlanIcon name="calendar" />
        )}
        <span className="max-w-[7rem] truncate sm:max-w-[10rem]">{meLabel}</span>
      </button>
    </div>
  );
}
