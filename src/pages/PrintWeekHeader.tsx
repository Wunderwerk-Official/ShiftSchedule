type PrintWeekHeaderProps = {
  rangeLabel: string;
  /** The week is not published: a printout must not pass for the final plan. */
  draft: boolean;
};

/** Header of a printed week (PDF): its dates and, for an unpublished week, a draft marker. */
export default function PrintWeekHeader({ rangeLabel, draft }: PrintWeekHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="text-sm font-semibold text-slate-600 dark:text-slate-300">{rangeLabel}</div>
      {draft ? (
        <div
          data-print-draft="true"
          className="rounded-md border-2 border-amber-600 bg-amber-50 px-2 py-0.5 text-sm font-bold text-amber-800"
        >
          Draft – not published
        </div>
      ) : null}
    </div>
  );
}
