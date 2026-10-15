import type { CSSProperties, ReactNode } from "react";
import { cx } from "../../lib/classNames";
import {
  MINUTES_PER_DAY,
  blockDetailLevel,
  formatHours,
  formatSegmentHint,
  formatShiftTimeRange,
  formatTime,
  formatWeekdayTime,
  parseISODate,
  type BlockDetailLevel,
  type LocationTint,
  type PlanSegment,
  type PlanShift,
} from "../../lib/myPlan";
import type { SelectShift } from "./types";
import PlanIcon from "./PlanIcons";
import { LocationTag, PASSEPARTOUT, blockColorsOf } from "./viewParts";
import { continuationTimeText, formatLongDay } from "./planChrome";

// One shift block on a time axis (SPEC C5.5 vertical / C5.6 horizontal).
// Both halves of a split night are separate ShiftBlocks sharing shift.id:
// selection/hover come from the view, so they highlight together.

export type ShiftBlockProps = {
  shift: PlanShift;
  /** The part drawn here: lanes and cut (flat) edges. Day views pass a pseudo segment. */
  segment: PlanSegment;
  axis: "vertical" | "horizontal";
  /** Position/size along the time axis in px (from segmentBox), before the 1 px insets. */
  offsetPx: number;
  sizePx: number;
  /** Distance to the column/row edges across the axis (default 6 vertical, 10 horizontal). */
  crossInsetPx?: number;
  /** compact: mobile week (short label + start time) / single-line horizontal rows. */
  variant?: "regular" | "compact";
  selected: boolean;
  /** Dark mode: duties use the light indigo palette. */
  isDark?: boolean;
  /**
   * Selecting opens a dialog (popover / sheet): aria-haspopup + aria-expanded.
   * False where the detail renders inline (desktop day views): aria-pressed.
   */
  opensDialog?: boolean;
  hovered?: boolean;
  onHoverChange?: (shiftId: string | null) => void;
  onSelect: SelectShift;
  /** Tab stop; false for the 2nd half of a night whose 1st half is visible. */
  focusable?: boolean;
  /** "→ until Thu 08:00" captions of split nights (week views); day views pass false. */
  edgeCaptions?: boolean;
  /** Show the location tag (always shown on continuations). */
  showLocation?: boolean;
  locationTint?: LocationTint | null;
  /** Horizontal blocks < 24 px: "FB 07:30" left of the block (caller checks the free space). */
  outsideLabel?: boolean;
  /** Arrow-key navigation: column (day/lane index). */
  navCol?: number;
  /**
   * Too narrow for long titles (short label, no wrapping). Default: a
   * half-width overlap lane; wide lanes (day view, own lane) pass false.
   */
  narrow?: boolean;
  /**
   * Extra content of the "full" level: bottom line of a vertical block,
   * right end of the time line of a horizontal one ("with" + avatars).
   */
  footer?: ReactNode;
};

/** Full screen-reader label: title, date, times, location, hours, kind, status. */
export function shiftAriaLabel(shift: PlanShift): string {
  const end =
    shift.endMin > MINUTES_PER_DAY
      ? formatWeekdayTime(shift.dateISO, shift.endMin)
      : formatTime(shift.endMin);
  return [
    shift.slotLabel ? `${shift.title} (${shift.slotLabel})` : shift.title,
    formatLongDay(parseISODate(shift.dateISO)),
    `${formatTime(shift.startMin)} to ${end}`,
    ...shiftAriaTail(shift),
  ].join(", ");
}

/** End of the screen-reader labels: location, hours, kind, status ("Klinikum Mitte", "8.5 hours", "duty"). */
export function shiftAriaTail(shift: PlanShift): string[] {
  const parts = [
    shift.locationName,
    `${shift.hours.toFixed(1)} hours`,
    shift.kind === "duty" ? "duty" : undefined,
    shift.published ? undefined : "draft, not published",
  ];
  return parts.filter((part): part is string => Boolean(part));
}

function KindIcon({ shift, segment, size }: { shift: PlanShift; segment: PlanSegment; size: number }) {
  if (segment.cutStart && segment.dateISO !== shift.dateISO) {
    return <PlanIcon name="continue" size={size} className="shrink-0" />;
  }
  if (shift.kind === "duty") return <PlanIcon name="moon" size={size} className="shrink-0" />;
  return null;
}

/** Time line: "08:00–16:30" / "17:00 → Thu 08:00"; continuation "until 08:00 · since Wed 17:00". */
function timeText(shift: PlanShift, segment: PlanSegment): string {
  if (segment.cutStart && segment.dateISO !== shift.dateISO) {
    if (segment.cutEnd) return formatSegmentHint(segment, shift) ?? formatShiftTimeRange(shift);
    return continuationTimeText(shift);
  }
  return formatShiftTimeRange(shift);
}

const isContinuation = (shift: PlanShift, segment: PlanSegment) =>
  segment.cutStart && segment.dateISO !== shift.dateISO;

/**
 * Time line of a half-width lane: a continuation gets the phone-style
 * "–08:00" (no wrapping; "since Wed 17:00" stays in the tooltip and label).
 */
function narrowTimeText(shift: PlanShift, segment: PlanSegment): string {
  if (!isContinuation(shift, segment)) return timeText(shift, segment);
  return `–${segment.cutEnd ? formatWeekdayTime(shift.dateISO, shift.endMin) : formatTime(shift.endMin)}`;
}

export default function ShiftBlock(props: ShiftBlockProps) {
  const {
    shift,
    segment,
    axis,
    offsetPx,
    sizePx,
    variant = "regular",
    selected,
    hovered = false,
    onHoverChange,
    onSelect,
    focusable = true,
    navCol,
    opensDialog = true,
  } = props;
  const colors = blockColorsOf(shift, props.isDark ?? false);
  const vertical = axis === "vertical";
  const inset = props.crossInsetPx ?? (vertical ? 6 : 10);
  const startInset = segment.cutStart ? 0 : 1;
  const endInset = segment.cutEnd ? 0 : 1;
  const drawnSize = Math.max(0, sizePx - startInset - endInset);
  const radius = variant === "compact" ? 6 : 8;
  const rs = segment.cutStart ? 0 : radius;
  const re = segment.cutEnd ? 0 : radius;
  const half = "calc(50% + 1px)";
  const cross =
    segment.lanes === 2
      ? segment.lane === 0
        ? { a: inset, b: half }
        : { a: half, b: inset }
      : { a: inset, b: inset };
  const style: CSSProperties = vertical
    ? {
        top: offsetPx + startInset,
        height: drawnSize,
        left: cross.a,
        right: cross.b,
        borderRadius: `${rs}px ${rs}px ${re}px ${re}px`,
      }
    : {
        left: offsetPx + startInset,
        width: drawnSize,
        top: cross.a,
        bottom: cross.b,
        borderRadius: `${rs}px ${re}px ${re}px ${rs}px`,
      };
  style.backgroundColor = colors.fill;
  style.borderColor = colors.border;
  style.color = colors.text;
  style.borderStyle = shift.published ? "solid" : "dashed";
  style.borderWidth = shift.published ? 1 : 1.5;

  const level = blockDetailLevel(sizePx, axis);
  const compact = variant === "compact" || (!vertical && segment.lanes === 2);
  const label = shiftAriaLabel(shift);

  return (
    <button
      type="button"
      data-plan-block=""
      data-shift-id={shift.id}
      data-col={navCol}
      data-pos={segment.startMin}
      aria-label={label}
      aria-haspopup={opensDialog ? "dialog" : undefined}
      aria-expanded={opensDialog ? selected : undefined}
      aria-pressed={opensDialog ? undefined : selected}
      title={`${shift.title} · ${formatShiftTimeRange(shift)}`}
      tabIndex={focusable ? 0 : -1}
      onClick={(event) => onSelect(selected ? null : shift.id, selected ? null : event.currentTarget)}
      onMouseEnter={onHoverChange ? () => onHoverChange(shift.id) : undefined}
      onMouseLeave={onHoverChange ? () => onHoverChange(null) : undefined}
      className={cx(
        "absolute cursor-pointer text-left transition-[filter] hover:brightness-95",
        PASSEPARTOUT,
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600",
        selected ? "z-[4] outline outline-2 outline-offset-2 outline-slate-900 dark:outline-white" : "z-[2]",
        hovered && "brightness-95",
      )}
      style={style}
    >
      {vertical ? (
        <VerticalContent {...props} level={level} compact={variant === "compact"} drawnSize={drawnSize} secondaryColor={colors.secondaryText} />
      ) : (
        <HorizontalContent {...props} level={level} compact={compact} secondaryColor={colors.secondaryText} />
      )}
    </button>
  );
}

type ContentProps = ShiftBlockProps & { level: BlockDetailLevel; compact: boolean; secondaryColor: string };

function VerticalContent(props: ContentProps & { drawnSize: number }) {
  const { shift, segment, level, compact, drawnSize, edgeCaptions = true } = props;
  const continuation = isContinuation(shift, segment);
  const secondary = { color: props.secondaryColor };
  // Half-width overlap lane: long titles would break mid-word, so short labels.
  const narrow = props.narrow ?? segment.lanes === 2;
  if (level === "tiny") return null;

  if (compact) {
    const sub = continuation ? `–${formatTime(shift.endMin)}` : formatTime(shift.startMin);
    if (narrow) {
      // A half lane of a ~45 px phone column (≈ 20 px): tall blocks run their
      // label vertically ("↳ Nacht –08:00", SPEC E11); short ones stay bare
      // (aria-label/title keep the text).
      if (drawnSize < 56) return null;
      return (
        <span className="flex h-full w-full flex-col items-center gap-0.5 overflow-hidden py-1">
          {continuation ? <PlanIcon name="continue" size={11} className="shrink-0" /> : null}
          <span className="min-h-0 truncate text-[11px] font-semibold leading-[14px] [writing-mode:vertical-rl]">
            {shift.compactLabel}
            {drawnSize >= 112 ? (
              <span className="font-normal tabular-nums" style={secondary}>
                {" "}
                {sub}
              </span>
            ) : null}
          </span>
        </span>
      );
    }
    return (
      <span className="flex h-full w-full flex-col overflow-hidden px-0.5 py-[3px]">
        {/* No icon: mobile columns are ~45 px; the duty fill already marks duties. */}
        <span className="truncate text-[11px] font-semibold leading-[14px]">{shift.compactLabel}</span>
        {drawnSize >= 34 ? (
          <span className="truncate text-[10px] leading-[14px] tabular-nums" style={secondary}>
            {sub}
          </span>
        ) : null}
      </span>
    );
  }

  const name = narrow ? shift.shortLabel : shift.title;
  if (level === "line") {
    const text = continuation
      ? formatSegmentHint(segment, shift) ?? shift.title
      : `${formatTime(shift.startMin)} ${name}`;
    return (
      <span className="block h-full w-full truncate px-1.5 py-px text-[11px] font-medium leading-[14px] tabular-nums">
        {text}
      </span>
    );
  }

  if (level === "medium") {
    return (
      <span className="flex h-full w-full flex-col overflow-hidden px-2 py-1">
        <span className="flex min-w-0 items-center gap-1 text-xs font-semibold leading-4">
          <KindIcon shift={shift} segment={segment} size={12} />
          <span className="truncate">{name}</span>
        </span>
        <span className="truncate text-[11px] leading-[14px] tabular-nums" style={secondary}>
          {narrow ? narrowTimeText(shift, segment) : timeText(shift, segment)}
        </span>
      </span>
    );
  }

  const caption =
    edgeCaptions && segment.cutEnd && !segment.cutStart ? formatSegmentHint(segment, shift, "vertical") : null;
  const showLocation = (continuation || props.showLocation) && shift.locationName;
  return (
    <span className="flex h-full w-full flex-col items-start gap-0.5 overflow-hidden px-2 py-1.5">
      <span className="flex min-w-0 max-w-full items-center gap-1 text-[13px] font-semibold leading-4">
        <KindIcon shift={shift} segment={segment} size={14} />
        <span className={narrow ? "truncate" : "line-clamp-2 break-words"}>{name}</span>
      </span>
      {narrow && continuation ? (
        <span className="max-w-full truncate text-xs leading-4 tabular-nums">{narrowTimeText(shift, segment)}</span>
      ) : (
        <span className="line-clamp-2 max-w-full text-xs leading-4 tabular-nums">{timeText(shift, segment)}</span>
      )}
      {!continuation && drawnSize >= 96 ? (
        <span className="text-xs leading-4 tabular-nums" style={secondary}>
          {formatHours(shift.hours)}
        </span>
      ) : null}
      {showLocation && drawnSize >= 80 ? (
        <span className="mt-0.5 max-w-full">
          <LocationTag name={shift.locationName ?? ""} tint={props.locationTint ?? null} />
        </span>
      ) : null}
      {props.footer ? <span className="mt-auto max-w-full">{props.footer}</span> : null}
      {caption ? (
        <span
          className={cx("max-w-full truncate text-[11px] leading-[14px] tabular-nums", !props.footer && "mt-auto")}
          style={secondary}
        >
          {caption}
        </span>
      ) : null}
    </span>
  );
}

function HorizontalContent(props: ContentProps) {
  const { shift, segment, level, compact, edgeCaptions = true } = props;
  const continuation = isContinuation(shift, segment);
  const secondary = { color: props.secondaryColor };

  if (level === "tiny") {
    if (!props.outsideLabel) return null;
    return (
      <span className="pointer-events-none absolute right-[calc(100%+4px)] top-1/2 -translate-y-1/2 whitespace-nowrap text-[11px] tabular-nums text-slate-700 dark:text-slate-300">
        {shift.shortLabel} {formatTime(shift.startMin)}
      </span>
    );
  }

  if (level === "line") {
    return (
      <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-[inherit] px-1">
        <span className="truncate text-[11px] font-semibold leading-[14px]">{shift.shortLabel}</span>
      </span>
    );
  }

  if (compact) {
    return (
      <span className="flex h-full w-full items-center gap-1.5 overflow-hidden px-2">
        <KindIcon shift={shift} segment={segment} size={12} />
        <span className="truncate text-xs font-semibold leading-4">
          {level === "full" ? shift.title : shift.shortLabel}
        </span>
        {level === "full" ? (
          <span className="truncate text-[11px] leading-[14px] tabular-nums" style={secondary}>
            {timeText(shift, segment)}
          </span>
        ) : null}
      </span>
    );
  }

  if (level === "medium") {
    const sub = continuation ? `until ${formatTime(shift.endMin)}` : `from ${formatTime(shift.startMin)}`;
    return (
      <span className="flex h-full w-full flex-col justify-center overflow-hidden px-2">
        <span className="flex min-w-0 items-center gap-1 text-xs font-semibold leading-4">
          <KindIcon shift={shift} segment={segment} size={12} />
          <span className="truncate">{shift.shortLabel}</span>
        </span>
        <span className="truncate text-[11px] leading-[14px] tabular-nums" style={secondary}>
          {sub}
        </span>
      </span>
    );
  }

  const caption = edgeCaptions && segment.cutEnd && !segment.cutStart ? formatSegmentHint(segment, shift) : null;
  const showLocation = (continuation || props.showLocation) && shift.locationName;
  return (
    <span className="flex h-full w-full flex-col justify-center gap-0.5 overflow-hidden px-2.5">
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 text-[13px] font-semibold leading-4">
          <KindIcon shift={shift} segment={segment} size={14} />
          <span className="truncate">{shift.title}</span>
        </span>
        {!continuation ? (
          <span className="shrink-0 text-xs leading-4 tabular-nums" style={secondary}>
            {formatHours(shift.hours)}
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-xs leading-4 tabular-nums">
          {caption ? formatTime(shift.startMin) : timeText(shift, segment)}
        </span>
        {caption ? (
          <span className="shrink-0 text-[11px] leading-[14px] tabular-nums" style={secondary}>
            {caption}
          </span>
        ) : showLocation ? (
          <LocationTag name={shift.locationName ?? ""} tint={props.locationTint ?? null} />
        ) : props.footer ? (
          <span className="shrink-0">{props.footer}</span>
        ) : null}
      </span>
    </span>
  );
}
