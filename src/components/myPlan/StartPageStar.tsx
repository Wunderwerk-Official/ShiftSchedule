import type { UserPreferences, ViewConfig } from "../../api/client";
import { cx } from "../../lib/classNames";
import { sameViewConfig, type PreferencesUpdate } from "../../lib/userPreferences";
import PlanIcon from "./PlanIcons";
import { toolButtonClass } from "./planChrome";
import type { NotifyFn } from "./Toast";
import { describeView, deviceLabel, startViewKey } from "./viewConfig";

// Star: "Set as start page on this device type" (plan §2.8). Filled when the
// current view is the stored start view of this device class; clicking
// toggles it and confirms with a toast that offers "Undo". Self-contained so
// the team headers can reuse it with the same props.

export type StartPageStarProps = {
  currentView: ViewConfig;
  prefs: UserPreferences;
  onUpdatePrefs: (update: PreferencesUpdate) => void;
  isMobile: boolean;
  onNotify?: NotifyFn;
};

export default function StartPageStar({
  currentView,
  prefs,
  onUpdatePrefs,
  isMobile,
  onNotify,
}: StartPageStarProps) {
  const key = startViewKey(isMobile);
  const stored = prefs[key];
  const isStart = sameViewConfig(stored, currentView);
  const device = deviceLabel(isMobile);

  const toggle = () => {
    const previous = stored;
    const next = isStart ? null : { ...currentView };
    onUpdatePrefs({ [key]: next });
    const message = next
      ? `Start page ${device}: ${describeView(next)}`
      : `Start page ${device} reset to the default (Team)`;
    onNotify?.(message, {
      label: "Undo",
      onAction: () => onUpdatePrefs({ [key]: previous }),
    });
  };

  // Constant name; aria-pressed carries the state (the tooltip says what a click does).
  const label = `Start page ${device}`;
  const title = isStart ? `Start page ${device} (click to reset)` : `Set as start page ${device}`;
  return (
    <button
      type="button"
      aria-pressed={isStart}
      aria-label={label}
      title={title}
      onClick={toggle}
      className={cx(toolButtonClass, isMobile ? "h-10 w-10" : "w-9")}
    >
      <PlanIcon
        name="star"
        filled={isStart}
        className={cx(isMobile ? "h-5 w-5" : "h-4 w-4", isStart && "text-slate-900 dark:text-white")}
      />
    </button>
  );
}
