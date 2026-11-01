import type { ReactNode } from "react";
import type { PlanScope, TeamTimeLayout, UserPreferences } from "../../api/client";
import { cx } from "../../lib/classNames";
import { personColor } from "../../lib/myPlan";
import type { PreferencesUpdate } from "../../lib/userPreferences";
import PlanScopeSwitch from "../myPlan/PlanScopeSwitch";
import { TEXT_3, initialsOf, segmentClass, segmentGroupClass } from "../myPlan/planChrome";

// Card header of the team calendars (classic grid and clinic sheet), plan
// §2.1/§2.9. Row 1: "Team | My plan" switch on the left — the same place as
// in the My-plan header, so switching scope does not move it — and "Times"
// on the right (classic grid only; on phones it wraps below the switch when
// the row is too narrow). Row 2: the existing header (navigator, badges,
// publish), unchanged. The classic grid always colors people (the "Color by"
// switch is gone). The start-page star and the saved "Views" menu were
// removed in v1.74.

type TeamPlanHeaderProps = {
  isMobile: boolean;
  prefs: UserPreferences;
  onUpdatePrefs: (update: PreferencesUpdate) => void;
  onScopeChange: (scope: PlanScope) => void;
  /** Person linked to the account and their clinician list index (initials and name on "My plan"). */
  me?: { name: string; index: number } | null;
  /** "Times: Side by side | Stacked" — classic grid only; the clinic sheet keeps its look. */
  showTimeLayout?: boolean;
  /** The existing header row. */
  children: ReactNode;
};

const TIME_LAYOUT_OPTIONS: Array<{ value: TeamTimeLayout; label: string; title: string }> = [
  { value: "columns", label: "Side by side", title: "A day's times as columns next to each other" },
  { value: "stacked", label: "Stacked", title: "A day's times as rows below each other: the whole week at a glance" },
];

/** Labeled segmented control ("Times"). */
function SegmentSwitch<T extends string>({
  label,
  options,
  value,
  onChange,
  compact,
}: {
  label: string;
  options: Array<{ value: T; label: string; title?: string }>;
  value: T;
  onChange: (value: T) => void;
  compact: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={cx("text-xs", TEXT_3)}>{label}</span>
      <div role="group" aria-label={label} className={cx(segmentGroupClass, compact ? "h-8" : "h-9")}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            title={option.title}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cx(
              segmentClass(value === option.value),
              compact ? "h-[26px] px-2.5 text-xs" : "h-[30px] px-3 text-[13px]",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function TeamPlanHeader({
  isMobile,
  prefs,
  onUpdatePrefs,
  onScopeChange,
  me,
  showTimeLayout = false,
  children,
}: TeamPlanHeaderProps) {
  return (
    <div className={cx("flex flex-col", isMobile ? "gap-2" : "gap-3")}>
      <div className={cx("flex flex-wrap items-center justify-between", isMobile ? "gap-2" : "gap-x-4 gap-y-2")}>
        <PlanScopeSwitch
          scope="team"
          onChange={onScopeChange}
          meInitials={me ? initialsOf(me.name) : undefined}
          meColor={me ? personColor(me.index).strong : undefined}
          meName={me?.name}
          compact={isMobile}
        />
        {showTimeLayout ? (
          <SegmentSwitch
            label="Times"
            options={TIME_LAYOUT_OPTIONS}
            value={prefs.teamTimeLayout}
            onChange={(teamTimeLayout) => onUpdatePrefs({ teamTimeLayout })}
            compact={isMobile}
          />
        ) : null}
      </div>
      {children}
    </div>
  );
}
