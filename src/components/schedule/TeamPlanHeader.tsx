import type { ReactNode } from "react";
import type { ColorBy, PlanScope, UserPreferences, ViewConfig } from "../../api/client";
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
// §2.1/§2.9. Row 1: "Team | My plan" switch on the left, "Color by" (classic
// grid only), start-page star and Views menu on the right — the same places
// as in the My-plan header, so switching scope does not move the controls.
// Row 2: the existing header (navigator, badges, publish), unchanged.

type TeamPlanHeaderProps = {
  isMobile: boolean;
  prefs: UserPreferences;
  onUpdatePrefs: (update: PreferencesUpdate) => void;
  onScopeChange: (scope: PlanScope) => void;
  /** Apply a saved view (scope + range/orientation/colorBy). */
  onApplyView: (view: ViewConfig) => void;
  /** Person linked to the account and their clinician list index (initials on "My plan"). */
  me?: { name: string; index: number } | null;
  /** "Color by: Section | Person" — classic grid only; the clinic sheet keeps its look. */
  showColorBy?: boolean;
  /** The existing header row. */
  children: ReactNode;
};

const COLOR_BY_OPTIONS: Array<{ value: ColorBy; label: string }> = [
  { value: "section", label: "Section" },
  { value: "person", label: "Person" },
];

function ColorBySwitch({
  value,
  onChange,
  compact,
}: {
  value: ColorBy;
  onChange: (value: ColorBy) => void;
  compact: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={cx("text-xs", TEXT_3)}>Color by</span>
      <div role="group" aria-label="Color by" className={cx(segmentGroupClass, compact ? "h-8" : "h-9")}>
        {COLOR_BY_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
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
  showColorBy = false,
  children,
}: TeamPlanHeaderProps) {
  const { toast, show: notify, dismiss } = useToast();
  const teamView = currentViewConfig(prefs, "team");
  // The monthly sheet ignores "Color by": its views keep the section look.
  const currentView = showColorBy ? teamView : { ...teamView, colorBy: "section" as const };
  const scopeSwitch = (
    <PlanScopeSwitch
      scope="team"
      onChange={onScopeChange}
      meInitials={me ? initialsOf(me.name) : undefined}
      meColor={me ? personColor(me.index).strong : undefined}
      compact={isMobile}
    />
  );
  const colorBy = showColorBy ? (
    <ColorBySwitch
      value={prefs.teamColorBy}
      onChange={(teamColorBy) => onUpdatePrefs({ teamColorBy })}
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
          {colorBy}
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {scopeSwitch}
          <div className="flex flex-wrap items-center gap-2">
            {colorBy}
            {tools}
          </div>
        </div>
      )}
      {children}
      <Toast toast={toast} onDismiss={dismiss} isMobile={isMobile} />
    </div>
  );
}
