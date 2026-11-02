import type { PlanScope } from "../../api/client";
import PlanScopeSwitch from "../myPlan/PlanScopeSwitch";

// Calendar card shown while this user's calendar is loading, in both scopes
// and in Settings. Until then the page holds the built-in demo calendar: the
// team plan would show demo people with working controls, and Settings the
// demo people, shifts and rules, whose edits are lost when the real calendar
// arrives; My plan would call the linked person "no longer in the plan".
// Same frame and header position as the plans, so nothing jumps when the
// calendar arrives. The "Team | My plan" switch stays usable (v1.77). It
// shows no initials yet: the linked person is only known once the calendar
// is loaded. When loading fails the card stops waiting and offers a reload
// (the page's error banner says what happened).

const TITLE = { team: "Team plan", me: "My plan", settings: "Settings" } as const;

type CalendarPlaceholderProps = {
  /** What the card stands in for: a plan (its switch shows it as chosen) or Settings. */
  scope: PlanScope | "settings";
  /** Makes the plans' "Team | My plan" switch work (Settings has none). */
  onScopeChange?: (scope: PlanScope) => void;
  isMobile?: boolean;
  /** GET /v1/state failed: no spinner, a reload button instead. */
  loadFailed?: boolean;
  onReload?: () => void;
};

export default function CalendarPlaceholder({
  scope,
  onScopeChange,
  isMobile = false,
  loadFailed = false,
  onReload,
}: CalendarPlaceholderProps) {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 pb-8 sm:px-6 sm:pb-10">
      <section
        aria-label={TITLE[scope]}
        className="relative mt-4 rounded-2xl border-2 border-slate-900/80 bg-white p-[2px] text-slate-900 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 sm:mt-6 sm:rounded-3xl"
      >
        <div className="relative rounded-[calc(1rem-2px)] bg-white dark:bg-slate-900 sm:rounded-[calc(1.5rem-2px)]">
          <div className="relative z-20 px-4 py-3 sm:px-6 sm:py-4">
            {scope === "settings" ? (
              <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
                {TITLE.settings}
              </h2>
            ) : onScopeChange ? (
              <PlanScopeSwitch scope={scope} onChange={onScopeChange} compact={isMobile} />
            ) : null}
          </div>
          <div
            role="status"
            aria-busy={!loadFailed}
            className="flex h-72 flex-col items-center justify-center gap-3 border-t border-slate-200 px-4 text-center text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400"
          >
            {loadFailed ? (
              <>
                <span>The calendar could not be loaded.</span>
                {onReload ? (
                  <button
                    type="button"
                    onClick={onReload}
                    className="rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                  >
                    Reload saved calendar
                  </button>
                ) : null}
              </>
            ) : (
              <span className="inline-flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600 motion-reduce:animate-none dark:border-slate-600 dark:border-t-slate-300"
                />
                Loading calendar…
              </span>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
