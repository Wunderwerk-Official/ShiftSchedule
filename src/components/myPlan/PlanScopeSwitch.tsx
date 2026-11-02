import type { PlanScope } from "../../api/client";
import { cx } from "../../lib/classNames";
import PlanIcon from "./PlanIcons";
import { segmentClass, segmentGroupClass } from "./planChrome";

// "Team | My plan" segmented control (plan §2.1). Exported for the team
// headers too (classic grid, clinic sheet): it only reports the new scope.
// The circle on "My plan" shows the initials of the person the account is
// linked to ("That's me"); `meName` names that person in the tooltip and the
// accessible name, so the initials never stand alone.

export type PlanScopeSwitchProps = {
  scope: PlanScope;
  onChange: (scope: PlanScope) => void;
  /** Initials of the linked person, shown in a small circle on "My plan". */
  meInitials?: string;
  /** Full name behind the initials on the own plan: "My plan · Name" tooltip, "My plan (Name)" accessible name. */
  meName?: string;
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
  meName,
  meColor,
  meLabel = "My plan",
  compact = false,
  className,
}: PlanScopeSwitchProps) {
  const segment = (value: PlanScope) => cx(segmentClass(scope === value), "h-[30px] gap-1.5 text-sm");
  const viewingOther = meLabel !== "My plan";
  // Only the own plan names the person here; another person's plan is already named by its label.
  const ownName = !viewingOther && meInitials && meName ? meName : undefined;
  const meTitle = viewingOther ? `Plan of ${meLabel}` : ownName ? `My plan · ${ownName}` : "My plan";
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
        title={meTitle}
        aria-label={ownName ? `My plan (${ownName})` : undefined}
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
