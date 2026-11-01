import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Clinician } from "../../api/client";
import { cx } from "../../lib/classNames";
import { addDaysISO, parseISODate, personTone, weekStartISO } from "../../lib/myPlan";
import { dayLabel, hoursText, targetSummary } from "../../lib/swaps/format";
import type {
  SwapCandidatesResponse,
  SwapFinding,
  SwapMode,
  SwapOption,
  SwapRange,
  SwapTargetInfo,
} from "../../lib/swaps/types";
import PlanIcon from "../myPlan/PlanIcons";
import {
  MICRO_LABEL,
  TEXT_1,
  TEXT_2,
  TEXT_3,
  outlineButtonClass,
  segmentClass,
  segmentGroupClass,
} from "../myPlan/planChrome";
import SwapResultRow from "./SwapResultRow";

// Find tab of the swap drawer (SPEC §5.5): what is being swapped, the mode and
// filters, and the options grouped by verdict. The drawer owns all state.

export type SwapFilters = { partnerId: string | null; range: SwapRange; dates: string[]; sameTypeOnly: boolean };

const RANGE_OPTIONS: Array<{ value: SwapRange; label: string }> = [
  { value: "sameWeek", label: "Same week" },
  { value: "fourWeeks", label: "Next 4 weeks" },
  { value: "dates", label: "Pick dates…" },
];
const WEEKDAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];
const PICKABLE_DAYS = 28;

const selectClass =
  "h-9 min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100";
const checkboxClass = "h-4 w-4 shrink-0 rounded border-slate-300 text-sky-700 dark:border-slate-600";
export const swapAlertClass =
  "rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-800 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200";

type SwapFinderPanelProps = {
  response: SwapCandidatesResponse | null;
  loading: boolean;
  /** The failed search, worded for the planner; the list is replaced by it. */
  errorMessage: string | null;
  /** Message of a refused apply after the list was refreshed. */
  notice: string | null;
  /** The plan changed since this list was made. */
  stale: boolean;
  isMobile: boolean;
  isDark: boolean;
  mode: SwapMode;
  wholeDay: boolean;
  filters: SwapFilters;
  clinicians: Clinician[];
  onModeChange: (mode: SwapMode) => void;
  onWholeDayChange: (wholeDay: boolean) => void;
  onFiltersChange: (filters: SwapFilters) => void;
  /** "Refresh" and "Search again". */
  onRefresh: () => void;
  onPreview: (key: string) => void;
  onHover: (key: string | null) => void;
};

export default function SwapFinderPanel(props: SwapFinderPanelProps) {
  const { response, mode, filters, isMobile } = props;
  const target = response?.target ?? null;
  // Notes on the change itself (a hand-over's giver below contract): while the
  // answer for another mode loads, the shown ones would describe the wrong change.
  const targetNotes = response && response.target.mode === mode ? response.targetFindings : [];
  const rowClass = cx("flex items-center gap-2 text-[13px]", TEXT_2, isMobile ? "min-h-11" : "min-h-8");
  return (
    <div className="flex flex-col gap-3 pb-4 pt-3">
      {target ? <TargetSummary target={target} notes={targetNotes} /> : null}
      {target?.blocked ? (
        <p className="text-[13px] text-rose-700 dark:text-rose-300">{target.blocked.message}</p>
      ) : (
        <>
          {target && target.blocksOnDate > 1 ? (
            <label className={rowClass}>
              <input
                type="checkbox"
                checked={props.wholeDay}
                onChange={(event) => props.onWholeDayChange(event.target.checked)}
                className={checkboxClass}
              />
              Whole day ({target.blocksOnDate} blocks)
            </label>
          ) : null}
          {target?.insideNotice && target.hoursUntilStart !== null ? (
            <p className="text-[13px] text-amber-800 dark:text-amber-200">
              Starts in {hoursText(target.hoursUntilStart)} h – inside the {hoursText(target.noticeHours)} h notice
              period.
            </p>
          ) : null}
          {target && mode !== "cover" ? (
            <div role="group" aria-label="Mode" className={cx(segmentGroupClass, "self-start")}>
              {(["swap", "handover"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => props.onModeChange(value)}
                  className={cx(
                    segmentClass(mode === value),
                    "justify-center px-3.5",
                    isMobile ? "h-10 text-[15px]" : "h-8 text-[13px]",
                  )}
                >
                  {value === "swap" ? "Swap" : "Hand over"}
                </button>
              ))}
            </div>
          ) : null}
          {target ? <Filters {...props} target={target} rowClass={rowClass} /> : null}
          {props.stale ? <StaleHint onRefresh={props.onRefresh} /> : null}
          {props.notice ? (
            <p role="alert" className={swapAlertClass}>
              {props.notice}
            </p>
          ) : null}
          <Results {...props} />
        </>
      )}
    </div>
  );
}

/** The plan changed since the options were checked (also shown in the preview). */
export function StaleHint({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className={cx("flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-[13px] dark:bg-slate-800", TEXT_2)}>
      <span className="flex-1">The plan changed since this list was made.</span>
      <button type="button" onClick={onRefresh} className={cx(outlineButtonClass, "shrink-0 bg-white dark:bg-slate-900")}>
        Refresh
      </button>
    </div>
  );
}

/** The shift (or open slot), and the notes that hold for every option, once. */
function TargetSummary({ target, notes }: { target: SwapTargetInfo; notes: SwapFinding[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className={cx("text-[13px] font-medium tabular-nums", TEXT_1)}>{targetSummary(target)}</p>
      {target.mode === "cover" && target.hiddenHolder ? (
        <p className={cx("text-xs", TEXT_3)}>{target.hiddenHolder.name} is on vacation, so this shift is hidden.</p>
      ) : null}
      <TargetNotes notes={notes} />
    </div>
  );
}

/** Amber notes on the target (also listed beside the preview's checks). */
export function TargetNotes({ notes }: { notes: SwapFinding[] }) {
  return (
    <>
      {notes.map((note, index) => (
        <p key={`${note.code}-${index}`} className="text-[13px] text-amber-800 dark:text-amber-200">
          {note.message}
        </p>
      ))}
    </>
  );
}

function Filters(props: SwapFinderPanelProps & { target: SwapTargetInfo; rowClass: string }) {
  const { filters, target, mode, onFiltersChange } = props;
  // Never offered as partners (the holder; for cover every holder of the slot).
  const partners = useMemo(() => {
    const excluded = new Set(target.excludedPartnerIds);
    return props.clinicians
      .filter((clinician) => !excluded.has(clinician.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [props.clinicians, target.excludedPartnerIds]);
  const update = (patch: Partial<SwapFilters>) => onFiltersChange({ ...filters, ...patch });
  const ids = useId();
  const fieldRowClass = cx("flex items-center gap-2 text-[13px]", TEXT_2);
  return (
    <div className="flex flex-col gap-2">
      <div className={fieldRowClass}>
        <label htmlFor={`${ids}-partner`} className="w-[72px] shrink-0">
          With
        </label>
        <select
          id={`${ids}-partner`}
          value={filters.partnerId ?? ""}
          onChange={(event) => update({ partnerId: event.target.value || null })}
          className={selectClass}
        >
          <option value="">Anyone</option>
          {partners.map((clinician) => (
            <option key={clinician.id} value={clinician.id}>
              {clinician.name}
            </option>
          ))}
        </select>
      </div>
      {mode === "swap" ? (
        <>
          <div className={fieldRowClass}>
            <label htmlFor={`${ids}-range`} className="w-[72px] shrink-0">
              Their shift
            </label>
            <select
              id={`${ids}-range`}
              value={filters.range}
              onChange={(event) => update({ range: event.target.value as SwapRange })}
              className={selectClass}
            >
              {RANGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {filters.range === "dates" ? (
            <DatePicker
              fromISO={weekStartISO(target.unit?.startDateISO ?? target.dateISO)}
              selected={filters.dates}
              onChange={(dates) => update({ dates })}
            />
          ) : null}
          <label className={props.rowClass}>
            <input
              type="checkbox"
              checked={filters.sameTypeOnly}
              onChange={(event) => update({ sameTypeOnly: event.target.checked })}
              className={checkboxClass}
            />
            Same shift type only
          </label>
        </>
      ) : null}
    </div>
  );
}

/** The 28 days from X's week Monday; their shifts are searched on the ticked days. */
function DatePicker({ fromISO, selected, onChange }: {
  fromISO: string; selected: string[]; onChange: (dates: string[]) => void;
}) {
  const days = Array.from({ length: PICKABLE_DAYS }, (_, index) => addDaysISO(fromISO, index));
  const toggle = (dateISO: string) =>
    onChange(
      selected.includes(dateISO) ? selected.filter((date) => date !== dateISO) : [...selected, dateISO].sort(),
    );
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-7 gap-1">
        {WEEKDAY_INITIALS.map((initial, index) => (
          <span key={index} aria-hidden="true" className={cx("text-center text-[11px] font-semibold", TEXT_3)}>
            {initial}
          </span>
        ))}
        {days.map((dateISO) => {
          const pressed = selected.includes(dateISO);
          return (
            <button
              key={dateISO}
              type="button"
              aria-pressed={pressed}
              aria-label={dayLabel(dateISO)}
              onClick={() => toggle(dateISO)}
              className={cx(
                "h-8 rounded-lg text-[13px] tabular-nums",
                pressed
                  ? "bg-sky-700 font-semibold text-white"
                  : "border border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800",
              )}
            >
              {parseISODate(dateISO).getDate()}
            </button>
          );
        })}
      </div>
      <p className={cx("text-xs", TEXT_3)}>Pick the dates of their shifts (up to 31).</p>
    </div>
  );
}

function Results(props: SwapFinderPanelProps) {
  const { response, filters, mode } = props;
  const [showBlocked, setShowBlocked] = useState(false);
  const toneIndex = useMemo(
    () => new Map(props.clinicians.map((clinician, index) => [clinician.id, index])),
    [props.clinicians],
  );
  if (props.errorMessage) {
    return (
      <div role="alert" className={cx(swapAlertClass, "flex flex-col items-start gap-2")}>
        <span>{props.errorMessage}</span>
        <button type="button" onClick={props.onRefresh} className={cx(outlineButtonClass, "bg-white dark:bg-slate-900")}>
          Search again
        </button>
      </div>
    );
  }
  if (mode === "swap" && filters.range === "dates" && filters.dates.length === 0) {
    return <p className={cx("text-[13px]", TEXT_3)}>Pick at least one date.</p>;
  }
  if (props.loading || !response) {
    return (
      <div className="flex flex-col gap-2">
        <span className="sr-only">Checking options…</span>
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            aria-hidden="true"
            className="h-14 animate-pulse rounded-lg bg-slate-100 motion-reduce:animate-none dark:bg-slate-800"
          />
        ))}
      </div>
    );
  }
  const { totals, checked } = response;
  const row = (option: SwapOption) => {
    const index = toneIndex.get(option.partnerId);
    return (
      <SwapResultRow
        key={option.key}
        option={option}
        mode={mode}
        tone={index === undefined ? undefined : personTone(index, props.isDark)}
        onPreview={props.onPreview}
        onHover={props.onHover}
      />
    );
  };
  // ArrowDown / ArrowUp move between the "Preview" buttons (blocked rows have none).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-swap-preview]"));
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
  };
  const nothingPossible = totals.best + totals.possible === 0;
  return (
    <div className="flex flex-col gap-4" onKeyDown={onKeyDown}>
      {checked === 0 ? (
        <p className={cx("text-[13px]", TEXT_2)}>{noCandidatesText(props)}</p>
      ) : (
        <>
          {totals.best > 0 ? (
            <OptionGroup label={`Best matches (${totals.best})`} total={totals.best} shown={response.best.length}>
              {response.best.map(row)}
            </OptionGroup>
          ) : null}
          {totals.possible > 0 ? (
            <OptionGroup
              label={`Also possible (${totals.possible})`}
              total={totals.possible}
              shown={response.possible.length}
            >
              {response.possible.map(row)}
            </OptionGroup>
          ) : null}
          {nothingPossible ? (
            <div className="flex flex-col gap-1">
              <p className={cx("text-[13px]", TEXT_2)}>Nobody can take this shift without breaking a rule.</p>
              {response.closest.length > 0 ? (
                <OptionGroup label="Closest options" total={response.closest.length} shown={response.closest.length}>
                  {response.closest.map(row)}
                </OptionGroup>
              ) : null}
            </div>
          ) : null}
          {totals.blocked > 0 ? (
            <section className="flex flex-col">
              <button
                type="button"
                aria-expanded={showBlocked}
                onClick={() => setShowBlocked((open) => !open)}
                className={cx(MICRO_LABEL, TEXT_3, "inline-flex items-center gap-1 self-start rounded-md py-1")}
              >
                Not possible ({totals.blocked})
                <PlanIcon name="chevronDown" size={14} className={showBlocked ? undefined : "-rotate-90"} />
              </button>
              {showBlocked ? (
                <>
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800">{response.blocked.map(row)}</ul>
                  <ShownOfTotal shown={response.blocked.length} total={totals.blocked} />
                </>
              ) : null}
            </section>
          ) : null}
        </>
      )}
      <p className={cx("text-xs", TEXT_3)}>
        Checked {checked} options against all planning rules.
        {response.truncated ? " Narrow the search to check more." : ""}
      </p>
    </div>
  );
}

function noCandidatesText({ filters, mode, clinicians }: SwapFinderPanelProps): string {
  const partner = filters.partnerId ? clinicians.find((clinician) => clinician.id === filters.partnerId) : undefined;
  if (!partner) return "No one to check.";
  return mode === "swap"
    ? `${partner.name} has no shift to swap in this range.`
    : `${partner.name} can't take this shift here.`;
}

function OptionGroup({ label, total, shown, children }: {
  label: string; total: number; shown: number; children: ReactNode;
}) {
  return (
    <section className="flex flex-col">
      <h3 className={cx(MICRO_LABEL, TEXT_3, "py-1")}>{label}</h3>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">{children}</ul>
      <ShownOfTotal shown={shown} total={total} />
    </section>
  );
}

function ShownOfTotal({ shown, total }: { shown: number; total: number }) {
  return total > shown ? <p className={cx("text-xs", TEXT_3)}>Showing {shown} of {total}</p> : null;
}
