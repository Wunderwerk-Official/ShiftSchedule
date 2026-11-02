import type { PlanScope } from "../../api/client";
import PlanScopeSwitch from "../myPlan/PlanScopeSwitch";

// Calendar card shown while My plan waits for this user's calendar (until
// then the page holds the built-in demo people, and My plan would call the
// linked person "no longer in the plan"). Same frame and header position as
// MyPlanView, so nothing jumps when the plan arrives. The "Team | My plan"
// switch stays usable (v1.77): without it the page had no way back to the
// team plan until loading finished. It shows no initials yet — the linked
// person is only known once the calendar is loaded. The team plan never
// waits: it is shown at once.

type CalendarPlaceholderProps = {
  onScopeChange: (scope: PlanScope) => void;
  isMobile?: boolean;
};

export default function CalendarPlaceholder({
  onScopeChange,
  isMobile = false,
}: CalendarPlaceholderProps) {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 pb-8 sm:px-6 sm:pb-10">
      <section
        aria-label="My plan"
        className="relative mt-4 rounded-2xl border-2 border-slate-900/80 bg-white p-[2px] text-slate-900 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 sm:mt-6 sm:rounded-3xl"
      >
        <div className="relative rounded-[calc(1rem-2px)] bg-white dark:bg-slate-900 sm:rounded-[calc(1.5rem-2px)]">
          <div className="relative z-20 px-4 py-3 sm:px-6 sm:py-4">
            <PlanScopeSwitch scope="me" onChange={onScopeChange} compact={isMobile} />
          </div>
          <div
            role="status"
            aria-busy="true"
            className="flex h-72 items-center justify-center border-t border-slate-200 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400"
          >
            <span className="inline-flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600 motion-reduce:animate-none dark:border-slate-600 dark:border-t-slate-300"
              />
              Loading calendar…
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
