import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Clinician } from "../../api/client";
import { cx } from "../../lib/classNames";
import { personColor } from "../../lib/myPlan";
import PlanIcon from "./PlanIcons";
import { initialsOf, popoverPanelClass, roundIconButtonClass } from "./planChrome";
import { useDismiss } from "./useDismiss";

// Chevron next to the scope switch: open the plan of another person (plan
// §2.2). Viewing someone else is page state only; the container shows the
// "You are viewing the plan of X" banner.

type PersonPickerProps = {
  clinicians: Clinician[];
  /** Person whose plan is shown. */
  viewedId: string | null;
  /** The linked "I am" person (marked "you", listed first). */
  myId: string | null;
  onChange: (clinicianId: string) => void;
  isMobile?: boolean;
};

export default function PersonPicker({ clinicians, viewedId, myId, onChange, isMobile = false }: PersonPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const indexById = useMemo(
    () => new Map(clinicians.map((clinician, index) => [clinician.id, index])),
    [clinicians],
  );
  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const sorted = [...clinicians].sort((a, b) =>
      a.id === myId ? -1 : b.id === myId ? 1 : a.name.localeCompare(b.name),
    );
    return needle ? sorted.filter((c) => c.name.toLowerCase().includes(needle)) : sorted;
  }, [clinicians, myId, query]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  useDismiss(
    open,
    (reason) => {
      setOpen(false);
      if (reason === "escape") buttonRef.current?.focus();
    },
    (target) => Boolean(rootRef.current?.contains(target)),
  );

  const choose = (clinicianId: string) => {
    onChange(clinicianId);
    setOpen(false);
    setQuery("");
    buttonRef.current?.focus();
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Open the plan of another person"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Choose person"
        className={cx(roundIconButtonClass, isMobile && "h-10 w-10")}
      >
        <PlanIcon name="chevronDown" />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Choose person"
          className={cx(
            popoverPanelClass,
            "z-30 p-2",
            isMobile ? "fixed inset-x-4 top-4" : "absolute left-0 top-full mt-2 w-72",
          )}
        >
          <label className="flex h-9 items-center gap-2 rounded-xl border border-slate-200 px-2.5 text-sm focus-within:ring-2 focus-within:ring-sky-300 dark:border-slate-700 dark:focus-within:ring-sky-400/60">
            <PlanIcon name="search" className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" />
            <span className="sr-only">Search person</span>
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && options[0]) choose(options[0].id);
              }}
              placeholder="Search person"
              aria-controls={listId}
              className="min-w-0 flex-1 bg-transparent text-slate-900 outline-none focus-visible:shadow-none placeholder:text-slate-500 dark:text-slate-100 dark:placeholder:text-slate-400"
            />
          </label>
          <ul id={listId} aria-label="People" className="mt-2 max-h-72 overflow-y-auto">
            {options.map((clinician) => {
              const active = clinician.id === viewedId;
              const color = personColor(indexById.get(clinician.id) ?? 0);
              return (
                <li key={clinician.id}>
                  <button
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => choose(clinician.id)}
                    className={cx(
                      "flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm",
                      active
                        ? "bg-sky-50 text-sky-900 dark:bg-sky-900/30 dark:text-sky-100"
                        : "text-slate-800 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold leading-none text-white"
                      style={{ backgroundColor: color.strong }}
                    >
                      {initialsOf(clinician.name)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{clinician.name}</span>
                    {clinician.id === myId ? (
                      <span className="rounded-full bg-slate-100 px-2 text-[11px] font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                        you
                      </span>
                    ) : null}
                    {active ? <PlanIcon name="check" className="h-4 w-4 shrink-0" /> : null}
                  </button>
                </li>
              );
            })}
            {options.length === 0 ? (
              <li className="px-2 py-3 text-sm text-slate-600 dark:text-slate-400">No person found.</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
