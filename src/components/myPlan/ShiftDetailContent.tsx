import { useMemo, useState } from "react";
import type { Location } from "../../api/client";
import { cx } from "../../lib/classNames";
import {
  findCoworkers,
  formatHours,
  formatShiftTimeRange,
  formatShiftWhen,
  formatWeekday,
  nextAfter,
  personTone,
  restBefore,
  type Coworker,
  type PersonPlan,
  type PersonTone,
  type PlanShift,
  type PlanSource,
} from "../../lib/myPlan";
import PlanIcon from "./PlanIcons";
import { Avatar, LocationChip, blockColorsOf } from "./viewParts";
import { draftBadgeClass, MICRO_LABEL, TEXT_1, TEXT_2, TEXT_3 } from "./planChrome";

// Content of the shift detail (SPEC C5.9 / plan §2.6): title + kind, when,
// location, section, "Working with you", rest before / next, status and
// actions. Shared by the popover, the bottom sheet and the inline card.

export type ShiftDetailContentProps = {
  shift: PlanShift;
  plan: PersonPlan;
  source: PlanSource;
  isMe: boolean;
  isMobile: boolean;
  isDark?: boolean;
  locationsById: Map<string, Location>;
  /** "Show in team plan": the team grid jumps to this shift's row and pulses the pill. */
  onShowInTeam: (shift: PlanShift) => void;
  /** Close button + "Close" action; omitted for the static inline card. */
  onClose?: () => void;
  headingId: string;
  /** Rows per coworker group before "+N more" (popover 3, inline card 2). */
  maxPerGroup?: number;
  /** "columns": wide inline card in three columns (shift | with you, before & after | actions). */
  layout?: "stack" | "columns";
};

const chipClass =
  "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-semibold";

type ToneOf = (clinicianId: string) => PersonTone | undefined;

function CoworkerRow({ coworker, shift, toneOf }: { coworker: Coworker; shift: PlanShift; toneOf: ToneOf }) {
  const range = formatShiftTimeRange(coworker.shift);
  const time = coworker.shift.dateISO === shift.dateISO ? range : `${formatWeekday(coworker.shift.dateISO)} ${range}`;
  const role = coworker.shift.role ? ` · ${coworker.shift.role}` : "";
  return (
    <li className="flex min-h-8 items-center gap-2">
      <Avatar name={coworker.name} tone={toneOf(coworker.clinicianId)} />
      <span className="flex min-w-0 flex-col">
        <span className={cx("truncate text-[13px] font-medium leading-4", TEXT_1)}>{coworker.name}</span>
        <span className={cx("truncate text-[11px] leading-[14px]", TEXT_3)}>
          {coworker.shift.title}
          {role}
        </span>
      </span>
      <span className={cx("ml-auto shrink-0 text-xs tabular-nums", TEXT_2)}>{time}</span>
    </li>
  );
}

function CoworkerGroup({
  label,
  coworkers,
  shift,
  max,
  toneOf,
  collapsed = false,
}: {
  label: string;
  coworkers: Coworker[];
  shift: PlanShift;
  max: number;
  toneOf: ToneOf;
  /** Hidden behind a toggle ("Others at location (6) ▸"). */
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(!collapsed);
  const [showAll, setShowAll] = useState(false);
  if (coworkers.length === 0) return null;
  const visible = showAll ? coworkers : coworkers.slice(0, max);
  const moreButton = cx(
    "inline-flex h-7 items-center gap-1 self-start rounded-lg px-2 text-xs hover:bg-slate-100 dark:hover:bg-slate-800",
    TEXT_2,
  );
  if (!open) {
    return (
      <button type="button" aria-expanded={false} className={moreButton} onClick={() => setOpen(true)}>
        {label} ({coworkers.length})
        <PlanIcon name="chevronDown" size={14} className="-rotate-90" />
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <span className={cx(MICRO_LABEL, TEXT_3)}>
        {label} ({coworkers.length})
      </span>
      <ul className="flex flex-col gap-1">
        {visible.map((coworker) => (
          <CoworkerRow key={coworker.clinicianId} coworker={coworker} shift={shift} toneOf={toneOf} />
        ))}
      </ul>
      {coworkers.length > max ? (
        <button type="button" aria-expanded={showAll} className={moreButton} onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show less" : `+${coworkers.length - max} more`}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Section line of the detail: "Klinikum Mitte · MRT · Arbeitsplatz 1", or
 * "Section: MRT" without locations. Parts equal to the location (or to each
 * other) are dropped; null when only the location (already a chip) is left.
 */
export function sectionLine(shift: Pick<PlanShift, "title" | "role" | "slotLabel" | "locationName">): string | null {
  const seen = new Set<string>();
  const unique = (part?: string) => {
    const key = part?.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const location = shift.locationName?.trim();
  if (location) seen.add(location.toLowerCase());
  const facts = [shift.title, shift.role, shift.slotLabel].filter(unique);
  if (facts.length === 0) return null;
  return location ? `${location} · ${facts.join(" · ")}` : `Section: ${facts.join(" · ")}`;
}

/** "Wed 14 Oct, 17:00 → Thu 15 Oct, 08:00 · 15.0 h" → [when, hours]. */
function splitWhen(shift: PlanShift): [string, string] {
  const text = formatShiftWhen(shift);
  const index = text.lastIndexOf(" · ");
  return index < 0 ? [text, formatHours(shift.hours)] : [text.slice(0, index), text.slice(index + 3)];
}

export default function ShiftDetailContent(props: ShiftDetailContentProps) {
  const { shift, plan, source, isMe, isMobile, onClose } = props;
  const max = props.maxPerGroup ?? 3;
  const coworkers = useMemo(() => findCoworkers(source, shift), [source, shift]);
  const rest = useMemo(() => (isMe ? restBefore(plan, shift) : null), [isMe, plan, shift]);
  const next = useMemo(() => (isMe ? nextAfter(plan, shift) : null), [isMe, plan, shift]);
  const isDark = props.isDark ?? false;
  const colors = blockColorsOf(shift, isDark);
  const [when, hours] = splitWhen(shift);
  const location = shift.locationId ? props.locationsById.get(shift.locationId) : undefined;
  // Avatars in person colors, as in the team plan (clinician list order).
  const toneOf = useMemo<ToneOf>(() => {
    const indexById = new Map(source.clinicians.map((clinician, index) => [clinician.id, index]));
    return (clinicianId) => {
      const index = indexById.get(clinicianId);
      return index === undefined ? undefined : personTone(index, isDark);
    };
  }, [source.clinicians, isDark]);
  // SPEC C5.9: "<location> · <section>" (+ the slot's own section and block
  // label), without repeats: a section named like its location ("MRT" at the
  // MRT location) is not listed twice. Nothing new beyond the chip → no line.
  const factsLine = sectionLine(shift);
  const columns = props.layout === "columns" && !isMobile;
  const nobody = coworkers.sameDuty.length + coworkers.sameTimeAtLocation.length + coworkers.otherAtLocation.length === 0;
  const actionClass = cx(
    "inline-flex items-center justify-center gap-1.5 rounded-xl border px-3 shadow-sm",
    isMobile ? "h-12 text-[15px]" : "h-9 text-sm",
  );

  const headBlock = (
    <div className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 rounded"
        style={{ backgroundColor: colors.fill, border: `1px solid ${colors.border}` }}
      />
      <h3 id={props.headingId} className={cx("min-w-0 truncate font-semibold", isMobile ? "text-[17px]" : "text-base", TEXT_1)}>
        {shift.title}
      </h3>
      <span className={cx(chipClass, "gap-1 bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200")}>
        {shift.kind === "duty" ? <PlanIcon name="moon" size={12} /> : null}
        {shift.kind === "duty" ? "Duty" : "Shift"}
      </span>
      <span className="flex-1" />
      {onClose ? (
        <button
          type="button"
          aria-label="Close detail"
          onClick={onClose}
          className={cx(
            "grid shrink-0 place-items-center rounded-full hover:bg-slate-100 focus-visible:rounded-full dark:hover:bg-slate-800",
            isMobile ? "h-11 w-11" : "h-8 w-8",
            TEXT_3,
          )}
        >
          <PlanIcon name="x" size={isMobile ? 20 : 16} />
        </button>
      ) : null}
    </div>
  );
  const factsBlock = (
    <div className={cx("flex flex-col gap-1.5 text-[13px] leading-[18px]", TEXT_2)}>
      <div className="flex items-center gap-2">
        <PlanIcon name="clock" size={16} className={cx("shrink-0", TEXT_3)} />
        <span className="tabular-nums">
          {when} · <strong className={cx("whitespace-nowrap font-semibold", TEXT_1)}>{hours}</strong>
        </span>
      </div>
      {shift.locationName ? (
        <div className="flex min-w-0 items-center gap-2">
          <PlanIcon name="pin" size={16} className={cx("shrink-0", TEXT_3)} />
          <LocationChip location={location} name={shift.locationName} />
        </div>
      ) : null}
      {factsLine ? (
        <div className="flex min-w-0 items-center gap-2">
          <PlanIcon name="layers" size={16} className={cx("shrink-0", TEXT_3)} />
          <span className="truncate">{factsLine}</span>
        </div>
      ) : null}
    </div>
  );
  const withYouBlock = (
    <section aria-label={isMe ? "Working with you" : "Working at the same time"} className="flex flex-col gap-2">
      <CoworkerGroup label="Same duty" coworkers={coworkers.sameDuty} shift={shift} max={max} toneOf={toneOf} />
      <CoworkerGroup
        label="Same time at location"
        coworkers={coworkers.sameTimeAtLocation}
        shift={shift}
        max={max}
        toneOf={toneOf}
      />
      <CoworkerGroup
        label="Others at location"
        coworkers={coworkers.otherAtLocation}
        shift={shift}
        max={max}
        toneOf={toneOf}
        collapsed
      />
      {nobody ? <span className={cx("text-xs", TEXT_3)}>Nobody else is planned at this location then.</span> : null}
    </section>
  );
  const beforeAfterBlock =
    rest || next ? (
      <>
        {columns ? null : <div className="h-px bg-slate-200 dark:bg-slate-700" />}
        <div className={cx("flex flex-col gap-1 text-xs leading-4", TEXT_2)}>
          {rest ? (
            <span className="tabular-nums">
              Rest before:{" "}
              {rest.direct ? (
                <>
                  <strong className={cx("font-semibold", TEXT_1)}>none</strong> (directly after {rest.previous.title},{" "}
                  {rest.fromLabel})
                </>
              ) : (
                <>
                  <strong className={cx("font-semibold", TEXT_1)}>{formatHours(rest.hours)}</strong> ({rest.fromLabel} →{" "}
                  {rest.toLabel})
                </>
              )}
            </span>
          ) : null}
          {next ? <span className="tabular-nums">Next: {next}</span> : null}
        </div>
      </>
    ) : null;
  const statusBlock = (
    <div className="flex items-center gap-1.5">
      {shift.published ? (
        <span className={cx(chipClass, "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200")}>Published</span>
      ) : (
        <span className={draftBadgeClass}>Draft – not published</span>
      )}
      {shift.locked ? (
        <span className={cx(chipClass, "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200")}>Fixed</span>
      ) : null}
    </div>
  );
  const actionsBlock = (
    <div className={cx("grid gap-2", onClose && !isMobile ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-1")}>
      <button
        type="button"
        onClick={() => props.onShowInTeam(shift)}
        className={cx(
          actionClass,
          "border-slate-300 bg-white text-slate-900 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
        )}
      >
        <PlanIcon name="users" size={16} />
        Show in team plan
      </button>
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          className={cx(
            actionClass,
            "border-slate-200 text-slate-700 shadow-none hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800",
          )}
        >
          Close
        </button>
      ) : null}
    </div>
  );

  if (columns) {
    // SPEC E4: selected shift | working with you, before & after | actions.
    return (
      <div data-layout="columns" className="grid grid-cols-3 gap-6">
        <div className="flex min-w-0 flex-col gap-3">
          {headBlock}
          {factsBlock}
          {statusBlock}
        </div>
        <div className="flex min-w-0 flex-col gap-3">{withYouBlock}</div>
        <div className="flex min-w-0 flex-col gap-3">
          {beforeAfterBlock}
          {actionsBlock}
        </div>
      </div>
    );
  }
  return (
    <div data-layout="stack" className="flex flex-col gap-3">
      {headBlock}
      {factsBlock}
      {withYouBlock}
      {beforeAfterBlock}
      {statusBlock}
      {actionsBlock}
    </div>
  );
}
