import type { ReactNode } from "react";
import { cx } from "../../lib/classNames";
import type { LegendItem } from "./legend";
import PlanLegend from "./PlanLegend";
import { HOURS_RULE_HINT, draftBadgeClass } from "./planChrome";

// Card footer (SPEC C3): hours summary ("Week 42: 53.0 h planned · target
// 40 h") on the left, the legend of what is visible on the right, and an
// amber "Draft – not published" badge for unpublished weeks.

type PlanFooterProps = {
  /** Hours text; omitted in the month views (sums live in the week cells). */
  summary?: ReactNode;
  legendItems: LegendItem[];
  hasDraft: boolean;
  isDark: boolean;
};

export default function PlanFooter({ summary, legendItems, hasDraft, isDark }: PlanFooterProps) {
  if (!summary && legendItems.length === 0 && !hasDraft) return null;
  return (
    <div
      className={cx(
        "flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-slate-200 px-4 py-3 sm:px-6",
        "dark:border-slate-700",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {summary ? (
          <p
            className="text-[13px] leading-[18px] tabular-nums text-slate-700 dark:text-slate-300"
            title={HOURS_RULE_HINT}
          >
            {summary}
          </p>
        ) : null}
        {hasDraft ? <span className={draftBadgeClass}>Draft – not published</span> : null}
      </div>
      <PlanLegend items={legendItems} isDark={isDark} />
    </div>
  );
}
