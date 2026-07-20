import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/classNames";
import {
  addDays,
  formatRangeLabel,
  listWeekStartsOverlappingMonth,
  toISODate,
} from "../../lib/date";

// Per-week publish control for the clinic sheet header. Publishing stays
// week-based (backend semantics untouched); this simply exposes the weeks
// overlapping the displayed month. The panel portals to document.body —
// the sheet header sits inside an overflow-hidden shell.
type PublishWeeksPopoverProps = {
  monthStart: Date;
  publishedWeekStartISOs: string[];
  onSetWeekPublished: (weekStartISO: string, published: boolean) => void;
  onSetWeeksPublished: (weekStartISOs: string[], published: boolean) => void;
};

export default function PublishWeeksPopover({
  monthStart,
  publishedWeekStartISOs,
  onSetWeekPublished,
  onSetWeeksPublished,
}: PublishWeeksPopoverProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const weeks = useMemo(
    () =>
      listWeekStartsOverlappingMonth(monthStart).map((weekStart) => ({
        weekStart,
        iso: toISODate(weekStart),
        label: formatRangeLabel(weekStart, addDays(weekStart, 6)),
      })),
    [monthStart],
  );
  const publishedSet = useMemo(
    () => new Set(publishedWeekStartISOs),
    [publishedWeekStartISOs],
  );
  const publishedCount = weeks.filter((week) => publishedSet.has(week.iso)).length;
  const allISOs = useMemo(() => weeks.map((week) => week.iso), [weeks]);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      setPosition({ top: rect.bottom + 6, left: Math.max(8, rect.right - 288) });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={cx(
          "inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold text-slate-600 shadow-sm",
          "hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800",
          open && "bg-slate-100 dark:bg-slate-800",
        )}
      >
        <span>Publish</span>
        <span
          className={cx(
            "rounded-full px-1.5 py-0.5 text-[10px] font-bold",
            publishedCount > 0
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300"
              : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
          )}
        >
          {publishedCount}/{weeks.length}
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              className="fixed z-[1000] w-72 rounded-xl border border-slate-200 bg-white p-3 shadow-lg dark:border-slate-700 dark:bg-slate-800"
              style={{ top: position.top, left: position.left }}
            >
              <div className="mb-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
                Published weeks
              </div>
              <div className="flex flex-col gap-1.5">
                {weeks.map((week) => {
                  const published = publishedSet.has(week.iso);
                  return (
                    <div
                      key={week.iso}
                      className="flex items-center justify-between gap-3 rounded-lg px-2 py-1 hover:bg-slate-50 dark:hover:bg-slate-700/50"
                    >
                      <span className="text-xs text-slate-600 dark:text-slate-300">
                        {week.label}
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={published}
                        aria-label={`Publish week ${week.label}`}
                        onClick={() => onSetWeekPublished(week.iso, !published)}
                        className={cx(
                          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
                          published ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-700",
                        )}
                      >
                        <span
                          className={cx(
                            "inline-block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform",
                            published && "translate-x-[18px]",
                          )}
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 flex items-center justify-end gap-2 border-t border-slate-100 pt-2 dark:border-slate-700">
                <button
                  type="button"
                  onClick={() => onSetWeeksPublished(allISOs, true)}
                  className="rounded-full px-2.5 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-900/40"
                >
                  All on
                </button>
                <button
                  type="button"
                  onClick={() => onSetWeeksPublished(allISOs, false)}
                  className="rounded-full px-2.5 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
                >
                  All off
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
