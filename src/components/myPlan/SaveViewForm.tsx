import { useEffect, useId, useRef, useState } from "react";
import type { ViewConfig, ViewStartAt } from "../../api/client";
import PlanIcon from "./PlanIcons";
import { outlineButtonClass, solidButtonClass } from "./planChrome";
import { START_AT_LABELS, defaultViewName, describeView } from "./viewConfig";

// "Save current view" step of the Views menu (SPEC E8 form): name, what the
// view contains, where it opens (relative), optional start pages. Never
// stores a date.

export type SaveViewOptions = {
  name: string;
  startAt: ViewStartAt;
  startDesktop: boolean;
  startMobile: boolean;
};

const START_ATS: ViewStartAt[] = ["today", "nextShift", "weekStart"];

type SaveViewFormProps = {
  currentView: ViewConfig;
  isMobile: boolean;
  onBack: () => void;
  onSave: (options: SaveViewOptions) => void;
};

const NAME_MAX = 60;

export default function SaveViewForm({ currentView, isMobile, onBack, onSave }: SaveViewFormProps) {
  const [name, setName] = useState(() => defaultViewName(currentView));
  const [startDesktop, setStartDesktop] = useState(false);
  const [startMobile, setStartMobile] = useState(false);
  const [startAt, setStartAt] = useState<ViewStartAt>("today");
  const startAtName = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const trimmed = name.trim();

  // focus() first: select() alone does not reliably move focus into the input.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const chips = describeView(currentView).split(" · ");
  const checkboxClass = "h-4 w-4 rounded border-slate-300 text-sky-700 dark:border-slate-600";

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed) onSave({ name: trimmed, startAt, startDesktop, startMobile });
      }}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to views"
          className="grid h-8 w-8 place-items-center rounded-full text-slate-600 focus-visible:rounded-full hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <PlanIcon name="chevronLeft" />
        </button>
        <h3 className="text-[15px] font-semibold">Save current view</h3>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="text-xs font-semibold text-slate-700 dark:text-slate-300">
          Name
        </label>
        <input
          ref={inputRef}
          id={nameId}
          value={name}
          maxLength={NAME_MAX}
          required
          onChange={(event) => setName(event.target.value)}
          className="h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300">
        <span className="mr-1 font-semibold">Includes</span>
        {chips.map((chip) => (
          <span
            key={chip}
            className="inline-flex h-6 items-center rounded-full border border-slate-300 bg-white px-2.5 dark:border-slate-600 dark:bg-slate-900"
          >
            {chip}
          </span>
        ))}
      </div>
      <fieldset className="flex flex-col gap-1.5 text-[13px] text-slate-800 dark:text-slate-200">
        <legend className="mb-1 text-xs font-semibold text-slate-700 dark:text-slate-300">Open at</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {START_ATS.map((value) => (
            <label key={value} className="flex items-center gap-2">
              <input
                type="radio"
                name={startAtName}
                value={value}
                checked={startAt === value}
                onChange={() => setStartAt(value)}
                className="h-4 w-4 border-slate-300 text-sky-700 dark:border-slate-600"
              />
              {START_AT_LABELS[value]}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-1.5 text-[13px] text-slate-800 dark:text-slate-200">
        <legend className="mb-1 text-xs font-semibold text-slate-700 dark:text-slate-300">
          Also use as start page
        </legend>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={startDesktop}
            onChange={(event) => setStartDesktop(event.target.checked)}
            className={checkboxClass}
          />
          On computers{isMobile ? "" : " (this device)"}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={startMobile}
            onChange={(event) => setStartMobile(event.target.checked)}
            className={checkboxClass}
          />
          On phones{isMobile ? " (this device)" : ""}
        </label>
      </fieldset>
      <p className="text-xs text-slate-600 dark:text-slate-400">
        A view never stores a date: it opens relative to today.
      </p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onBack} className={outlineButtonClass}>
          Cancel
        </button>
        <button type="submit" disabled={!trimmed} className={solidButtonClass}>
          Save
        </button>
      </div>
    </form>
  );
}
