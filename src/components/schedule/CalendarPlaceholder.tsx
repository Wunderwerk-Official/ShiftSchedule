// Empty calendar card, shown while My plan waits for this user's calendar
// (until then the page holds the built-in demo people, and My plan would call
// the linked person "no longer in the plan"). Same frame as the grids, no
// content. The team plan never waits: it is shown at once.

export default function CalendarPlaceholder() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 pb-8 sm:px-6 sm:pb-10">
      <div
        role="status"
        aria-busy="true"
        className="relative mt-4 h-72 rounded-2xl border-2 border-slate-900/80 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900 sm:mt-6 sm:rounded-3xl"
      >
        <span className="sr-only">Loading calendar…</span>
      </div>
    </div>
  );
}
