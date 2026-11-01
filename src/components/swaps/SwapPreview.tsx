import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { SwapApiError, type Clinician } from "../../api/client";
import { cx } from "../../lib/classNames";
import { isoWeekNumber, parseISODate, personTone, weekStartISO } from "../../lib/myPlan";
import {
  buildApplyRequest,
  consentLabel,
  dayLabel,
  firstName,
  hoursText,
  noticeHoursLeft,
  previewTitle,
  primaryLabel,
  restDayMoveKey,
  weekHoursLine,
} from "../../lib/swaps/format";
import type {
  SwapApplyRequest,
  SwapCheck,
  SwapFinding,
  SwapMode,
  SwapOption,
  SwapTargetInfo,
  SwapUnit,
  SwapWarning,
} from "../../lib/swaps/types";
import PlanIcon from "../myPlan/PlanIcons";
import {
  MICRO_LABEL,
  TEXT_1,
  TEXT_2,
  TEXT_3,
  outlineButtonClass,
  solidButtonBaseClass,
  solidButtonClass,
} from "../myPlan/planChrome";
import { StaleHint, TargetNotes, swapAlertClass } from "./SwapFinderPanel";

// Preview of one option (SPEC §5.5): both people's weeks, the checks, the
// warnings to acknowledge, notes, Rest Day changes, consent, and the apply.

const APPROVER_STORAGE_KEY = "shiftSchedule.swapApproverName";
const NOTE_MAX = 280;
const APPROVER_MAX = 80;
const HOURS_RULE_HINT =
  "Counted like the weekly-hours rule: whole shifts on their start day, including shifts hidden by vacation.";

const checkboxBaseClass = "h-4 w-4 shrink-0 rounded border-slate-300 text-sky-700 disabled:opacity-60 dark:border-slate-600";
const fieldClass =
  "rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100";
const amberMarkClass =
  "mt-px inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-100 text-[11px] font-bold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
// The shared outline button at phone size (planChrome's carries the desktop size).
const outlinePhoneButtonClass = cx(
  "inline-flex h-12 items-center justify-center rounded-xl border border-slate-200 px-4 text-[15px] text-slate-700",
  "hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800",
);

function readApproverName(): string {
  try {
    return window.localStorage.getItem(APPROVER_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberApproverName(name: string) {
  try {
    window.localStorage.setItem(APPROVER_STORAGE_KEY, name);
  } catch {
    // Storage blocked (private mode): the name is just not remembered.
  }
}

/** The message after a refused apply, and whether the list must be searched again. */
function refusal(err: unknown, partnerName: string): { message: string; research: boolean } {
  if (!(err instanceof SwapApiError)) {
    return { message: err instanceof Error ? err.message : "The swap could not be applied.", research: false };
  }
  switch (err.code) {
    case "state_changed":
      return { message: "The calendar changed in another tab. It was reloaded; check the options again.", research: true };
    case "swap_stale":
      return { message: `${err.message} The list was refreshed.`, research: true };
    case "swap_invalid":
      return { message: `This swap no longer works: ${err.reasons.join(" ") || err.message}`, research: true };
    case "plan_invalid":
      return { message: err.message, research: true };
    case "warnings_unacknowledged":
      return { message: "New warnings came up. Check them and try again.", research: false };
    case "consent_required":
      return { message: `Confirm that ${partnerName} agreed.`, research: false };
    default:
      return { message: err.message, research: false };
  }
}

const shiftName = (unit: SwapUnit) => `${dayLabel(unit.startDateISO)} ${unit.primarySectionName}`;

function publishedWeeksText(weeks: number[]): string {
  const names =
    weeks.length === 1 ? `Week ${weeks[0]} is` : `Weeks ${weeks.slice(0, -1).join(", ")} and ${weeks[weeks.length - 1]} are`;
  return `${names} published: subscribed calendars update on their next refresh.`;
}

export type SwapPreviewProps = {
  mode: SwapMode;
  target: SwapTargetInfo;
  checks: SwapCheck[];
  /** Notes that hold for every option of this target (a hand-over's giver below contract). */
  targetFindings: SwapFinding[];
  option: SwapOption;
  clinicians: Clinician[];
  isMobile: boolean;
  isDark: boolean;
  publishedWeekStartISOs: string[];
  /** The message of the last refused apply (kept while the list is refreshed). */
  notice: string | null;
  /** The plan changed since the options were checked. */
  stale: boolean;
  onRefresh: () => void;
  /** The page saves, applies and closes the drawer; a refusal rejects. */
  onApply: (request: SwapApplyRequest) => Promise<void>;
  onApplyError: (message: string, research: boolean) => void;
  onBack: () => void;
};

export default function SwapPreview(props: SwapPreviewProps) {
  const { mode, target, option, isMobile } = props;
  const ids = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [consent, setConsent] = useState(false);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [overrideNotice, setOverrideNotice] = useState(false);
  // The server found the swap inside the notice period although the list did not.
  const [noticeDemanded, setNoticeDemanded] = useState(false);
  // Rest-day moves start ticked; a refreshed option's new moves do too.
  const [skippedMoves, setSkippedMoves] = useState<string[]>([]);
  const [removeHidden, setRemoveHidden] = useState(true);
  const [note, setNote] = useState("");
  const [approverName, setApproverName] = useState(readApproverName);
  const [busy, setBusy] = useState(false);
  // After warnings_unacknowledged the server's warnings replace the option's, until a search brings a new option.
  const [warningsOverride, setWarningsOverride] = useState<{ base: SwapWarning[]; warnings: SwapWarning[] } | null>(null);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const warnings = warningsOverride?.base === option.warnings ? warningsOverride.warnings : option.warnings;
  const showNotice = option.insideNotice || target.insideNotice || noticeDemanded;
  const hoursLeft = noticeHoursLeft(target, option);
  const noticeStart = hoursLeft === null ? "Apply" : `Starts in ${hoursText(hoursLeft)} h – apply`;
  const ready =
    consent && warnings.every((warning) => acknowledged.includes(warning.id)) && (!showNotice || overrideNotice) && !busy;

  const toneIndex = useMemo(
    () => new Map(props.clinicians.map((clinician, index) => [clinician.id, index])),
    [props.clinicians],
  );
  const names = new Map(props.clinicians.map((clinician) => [clinician.id, clinician.name]));
  if (target.holderId && target.holderName) names.set(target.holderId, target.holderName);
  names.set(option.partnerId, option.partnerName);
  const nameOf = (clinicianId: string) => names.get(clinicianId) ?? clinicianId;

  const given = target.unit ? shiftName(target.unit) : target.sectionName ?? "";
  const taken = option.take ? shiftName(option.take) : "";
  const people =
    mode === "cover"
      ? [{ id: option.partnerId, line: `Takes ${given}` }]
      : [
          { id: target.holderId ?? "", line: mode === "swap" ? `Gives ${given} · takes ${taken}` : `Gives ${given}` },
          { id: option.partnerId, line: mode === "swap" ? `Gives ${taken} · takes ${given}` : `Takes ${given}` },
        ];

  const published = new Set(props.publishedWeekStartISOs);
  const publishedWeeks = [
    ...new Set(
      [...(target.unit?.items ?? []), ...(option.take?.items ?? [])]
        .map((item) => item.dateISO)
        .filter((dateISO) => published.has(weekStartISO(dateISO)))
        .map((dateISO) => isoWeekNumber(parseISODate(dateISO))),
    ),
  ].sort((a, b) => a - b);

  const submit = async () => {
    rememberApproverName(approverName.trim());
    setBusy(true);
    try {
      await props.onApply(
        buildApplyRequest(mode, target, option, {
          consent,
          acknowledgedWarnings: warnings.filter((warning) => acknowledged.includes(warning.id)).map((warning) => warning.id),
          overrideNotice,
          restDayMoves: option.restDayMoves.filter((move) => !skippedMoves.includes(restDayMoveKey(move))),
          removeHidden,
          note,
          approverName,
        }),
      );
    } catch (err) {
      if (err instanceof SwapApiError && err.code === "notice_override_required") setNoticeDemanded(true);
      if (err instanceof SwapApiError && err.code === "warnings_unacknowledged") {
        setWarningsOverride({ base: option.warnings, warnings: err.warnings });
        setAcknowledged([]);
      }
      const { message, research } = refusal(err, option.partnerName);
      props.onApplyError(message, research);
    } finally {
      setBusy(false);
    }
  };

  // Phones: 44 px touch rows. Elsewhere the box sits on the first line of a wrapping label.
  const rowClass = cx("flex gap-2 py-1 text-[13px]", TEXT_2, isMobile ? "min-h-11 items-center" : "items-start");
  const checkboxClass = cx(checkboxBaseClass, !isMobile && "mt-0.5");
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((entry) => entry !== id));

  return (
    <div className="flex flex-col gap-4 pt-3">
      <h3
        ref={headingRef}
        tabIndex={-1}
        className={cx("text-base font-semibold focus:outline-none focus-visible:shadow-none", TEXT_1)}
      >
        {previewTitle(mode, target, option)}
      </h3>
      {props.stale ? <StaleHint onRefresh={props.onRefresh} /> : null}

      <div className={cx("grid gap-2", isMobile ? "grid-cols-1" : "grid-cols-2")}>
        {people.map((person) => {
          const index = toneIndex.get(person.id);
          const weeks = option.hours.find((hours) => hours.clinicianId === person.id)?.weeks ?? [];
          return (
            <div
              key={person.id}
              className="flex flex-col gap-0.5 rounded-lg border border-l-4 border-slate-200 px-3 py-2 dark:border-slate-700"
              style={index === undefined ? undefined : { borderLeftColor: personTone(index, props.isDark).strong }}
            >
              <span className={cx("text-[13px] font-semibold", TEXT_1)}>{nameOf(person.id)}</span>
              <span className={cx("text-xs", TEXT_2)}>{person.line}</span>
              {weeks.map((week) => (
                <span key={week.weekStartISO} title={HOURS_RULE_HINT} className={cx("text-xs tabular-nums", TEXT_3)}>
                  {weekHoursLine(week)}
                </span>
              ))}
            </div>
          );
        })}
      </div>

      <PreviewSection title="Checks">
        <ul className="flex flex-col gap-1.5">
          {props.checks.flatMap((check) => {
            const raised = warnings.filter((warning) => warning.check === check.code);
            if (raised.length > 0) {
              return raised.map((warning) => (
                <CheckLine key={`${check.code}:${warning.id}`} mark="!">
                  {warning.message}
                </CheckLine>
              ));
            }
            if (option.preexisting.includes(check.code)) {
              return [
                <CheckLine key={check.code} mark="–">
                  {check.label}: already broken before this change, not made worse.
                </CheckLine>,
              ];
            }
            return [<CheckLine key={check.code}>{check.label}</CheckLine>];
          })}
        </ul>
        <TargetNotes notes={props.targetFindings} />
      </PreviewSection>

      {warnings.length > 0 ? (
        <PreviewSection title="Warnings">
          {warnings.map((warning, index) => {
            const messageId = `${ids}-warning-${index}`;
            return (
              <div
                key={warning.id}
                className="flex flex-col rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/40"
              >
                <p id={messageId} className="text-[13px] text-amber-800 dark:text-amber-200">
                  {warning.message}
                </p>
                <label className={rowClass}>
                  <input
                    type="checkbox"
                    aria-describedby={messageId}
                    checked={acknowledged.includes(warning.id)}
                    onChange={(event) => setAcknowledged((list) => toggle(list, warning.id, event.target.checked))}
                    className={checkboxClass}
                  />
                  Acknowledge
                </label>
              </div>
            );
          })}
        </PreviewSection>
      ) : null}

      {option.findings.length > 0 ? (
        <PreviewSection title="Notes">
          {option.findings.map((finding, index) => (
            <p key={`${finding.code}-${index}`} className="text-[13px] text-amber-800 dark:text-amber-200">
              {finding.message}
            </p>
          ))}
        </PreviewSection>
      ) : null}

      {option.restDayMoves.length + option.restDayRemovals.length > 0 || option.hiddenRemoval ? (
        <div className="flex flex-col">
          {option.restDayMoves.map((move) => {
            const key = restDayMoveKey(move);
            return (
              <label key={key} className={rowClass}>
                <input
                  type="checkbox"
                  checked={!skippedMoves.includes(key)}
                  onChange={(event) => setSkippedMoves((list) => toggle(list, key, !event.target.checked))}
                  className={checkboxClass}
                />
                Move {nameOf(move.fromClinicianId)}'s Rest Day on {dayLabel(move.dateISO)} to{" "}
                {nameOf(move.toClinicianId)}
              </label>
            );
          })}
          {option.restDayRemovals.map((removal) => (
            <p key={`${removal.clinicianId}@${removal.dateISO}`} className={cx("py-1 text-xs", TEXT_3)}>
              {removal.name}'s Rest Day on {dayLabel(removal.dateISO)} will be removed (works that day).
            </p>
          ))}
          {option.hiddenRemoval ? (
            <>
              <label className={rowClass}>
                <input
                  type="checkbox"
                  checked={option.hiddenRemoval.required || removeHidden}
                  disabled={option.hiddenRemoval.required}
                  onChange={(event) => setRemoveHidden(event.target.checked)}
                  className={checkboxClass}
                />
                Remove {option.hiddenRemoval.name}'s hidden shift (on vacation)
              </label>
              {option.hiddenRemoval.required ? (
                <p className={cx("text-xs", TEXT_3)}>Needed: the slot would be overfilled otherwise.</p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col">
        {showNotice ? (
          <label className={rowClass}>
            <input
              type="checkbox"
              checked={overrideNotice}
              onChange={(event) => setOverrideNotice(event.target.checked)}
              className={checkboxClass}
            />
            {noticeStart} inside the {hoursText(target.noticeHours)} h notice period
          </label>
        ) : null}
        <label className={cx(rowClass, "font-medium")}>
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
            className={checkboxClass}
          />
          {consentLabel(mode, option.partnerName)}
        </label>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-note`} className={cx("text-[13px]", TEXT_2)}>
          Note (optional)
        </label>
        <textarea
          id={`${ids}-note`}
          value={note}
          maxLength={NOTE_MAX}
          rows={2}
          placeholder={`e.g. ${firstName(option.partnerName)} agreed by phone`}
          onChange={(event) => setNote(event.target.value)}
          className={cx(fieldClass, "resize-y")}
        />
        <span className={cx("self-end text-[11px] tabular-nums", TEXT_3)}>
          {note.length}/{NOTE_MAX}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-approver`} className={cx("text-[13px]", TEXT_2)}>
          Approved by (optional)
        </label>
        <input
          id={`${ids}-approver`}
          value={approverName}
          maxLength={APPROVER_MAX}
          aria-describedby={`${ids}-approver-hint`}
          onChange={(event) => setApproverName(event.target.value)}
          className={fieldClass}
        />
        <span id={`${ids}-approver-hint`} className={cx("text-[11px]", TEXT_3)}>
          Remembered on this device
        </span>
      </div>

      <div className={cx("flex flex-col gap-1 text-xs", TEXT_3)}>
        <p>
          {mode === "swap"
            ? "Both shifts will be locked so replanning keeps the swap."
            : "The shift will be locked so replanning keeps it."}
        </p>
        {publishedWeeks.length > 0 ? <p>{publishedWeeksText(publishedWeeks)}</p> : null}
      </div>

      <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t border-slate-200 bg-white px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 dark:border-slate-700 dark:bg-slate-900">
        {props.notice ? (
          <p role="alert" className={swapAlertClass}>
            {props.notice}
          </p>
        ) : null}
        <div className={cx("flex gap-2", !isMobile && "justify-end")}>
          <button
            type="button"
            onClick={props.onBack}
            className={isMobile ? cx(outlinePhoneButtonClass, "flex-1") : outlineButtonClass}
          >
            Back
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => void submit()}
            className={isMobile ? cx(solidButtonBaseClass, "h-12 flex-1 px-4 text-[15px]") : solidButtonClass}
          >
            {busy ? "Applying…" : primaryLabel(mode)}
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className={cx(MICRO_LABEL, TEXT_3)}>{title}</h4>
      {children}
    </section>
  );
}

/** One check: passed (emerald tick), a warning ("!") or already broken before ("–"). */
function CheckLine({ mark, children }: { mark?: "!" | "–"; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-[13px]">
      {mark ? (
        <span aria-hidden="true" className={amberMarkClass}>
          {mark}
        </span>
      ) : (
        <PlanIcon name="check" size={16} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
      )}
      <span className={mark ? "text-amber-800 dark:text-amber-200" : TEXT_2}>{children}</span>
    </li>
  );
}
