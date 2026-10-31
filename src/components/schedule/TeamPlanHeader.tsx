import type { ReactNode } from "react";
import type { PlanScope, TeamTimeLayout, UserPreferences, ViewConfig } from "../../api/client";
import { cx } from "../../lib/classNames";
import { personColor } from "../../lib/myPlan";
import type { PreferencesUpdate } from "../../lib/userPreferences";
import PlanScopeSwitch from "../myPlan/PlanScopeSwitch";
import { TEXT_3, initialsOf, segmentClass, segmentGroupClass } from "../myPlan/planChrome";
import SavedViewsMenu from "../myPlan/SavedViewsMenu";
import StartPageStar from "../myPlan/StartPageStar";
import Toast, { useToast } from "../myPlan/Toast";
import { currentViewConfig } from "../myPlan/viewConfig";

// Card header of the team calendars (classic grid and clinic sheet), plan
// §2.1/§2.9. Row 1: "Team | My plan" switch on the left, "Times" (classic
// grid only), start-page star and Views menu on the right — the same places
// as in the My-plan header, so switching scope does not move the controls.
// Row 2: the existing header (navigator, badges, publish), unchanged. The
// classic grid always colors people (the "Color by" switch is gone).

type TeamPlanHeaderProps = {
  isMobile: boolean;
  prefs: UserPreferences;
  onUpdatePrefs: (update: PreferencesUpdate) => void;
  onScopeChange: (scope: PlanScope) => void;
  /** Apply a saved view (scope + range/orientation). */
  onApplyView: (view: ViewConfig) => void;
  /** Person linked to the account and their clinician list index (initials on "My plan"). */
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
  onApplyView,
  me,
  showTimeLayout = false,
  children,
}: TeamPlanHeaderProps) {
  const { toast, show: notify, dismiss } = useToast();
  const currentView = currentViewConfig(prefs, "team");
  const scopeSwitch = (
    <PlanScopeSwitch
      scope="team"
      onChange={onScopeChange}
      meInitials={me ? initialsOf(me.name) : undefined}
      meColor={me ? personColor(me.index).strong : undefined}
      compact={isMobile}
    />
  );
  const displaySwitches = showTimeLayout ? (
    <SegmentSwitch
      label="Times"
      options={TIME_LAYOUT_OPTIONS}
      value={prefs.teamTimeLayout}
      onChange={(teamTimeLayout) => onUpdatePrefs({ teamTimeLayout })}
      compact={isMobile}
    />
  ) : null;
  const tools = (
    <>
      <StartPageStar
        currentView={currentView}
        prefs={prefs}
        onUpdatePrefs={onUpdatePrefs}
        isMobile={isMobile}
        onNotify={notify}
      />
      <SavedViewsMenu
        currentView={currentView}
        prefs={prefs}
        onUpdatePrefs={onUpdatePrefs}
        onApplyView={onApplyView}
        isMobile={isMobile}
        onNotify={notify}
      />
    </>
  );

  return (
    <div className={cx("flex flex-col", isMobile ? "gap-2" : "gap-3")}>
      {isMobile ? (
        <>
          <div className="flex items-center justify-between gap-2">
            {scopeSwitch}
            <div className="flex shrink-0 items-center gap-1">{tools}</div>
          </div>
          {displaySwitches ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">{displaySwitches}</div>
          ) : null}
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {scopeSwitch}
          <div className="flex flex-wrap items-center gap-2">
            {displaySwitches ? (
              <div className="mr-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                {displaySwitches}
              </div>
            ) : null}
            {tools}
          </div>
        </div>
      )}
      {children}
      <Toast toast={toast} onDismiss={dismiss} isMobile={isMobile} />
    </div>
  );
}
