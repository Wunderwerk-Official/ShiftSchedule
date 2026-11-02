import AssignmentLockButton from "./AssignmentLockButton";
import { cx } from "../../lib/classNames";
import { memo, useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import type { CSSProperties, DragEventHandler, MouseEventHandler } from "react";
import type { PersonPillStyle } from "./teamColors";
import { NAME_LABEL_LEVELS, nameLabelsOf, type PersonNameLabels } from "../../lib/personName";

/**
 * Person colors — one order per column: "First Last" → "First L." → the
 * initials circle alone. "F. Last" is skipped: the circle next to the name
 * already carries the initials (and mixing "S. Klein" with "Felix W." in one
 * column reads unevenly). "F. L." stands in only where a cut "First L." could
 * be someone else of the team (see personLevel).
 */
const PERSON_SHORT_LEVEL = 3;
/** Person colors: the circle alone, the name only read out. */
const PERSON_INITIALS_ONLY = NAME_LABEL_LEVELS;
/**
 * Person colors — "First L." that does not fit is cut with an ellipsis
 * ("Sophie…") as long as this much room is left next to the circle (about
 * four letters). Only below it does the circle stand alone: in the narrow
 * team columns many names miss by a few pixels, and a lone circle left most
 * of the pill blank.
 */
const PERSON_MIN_NAME_PX = 30;

// Text widths via a shared canvas: lets the person-colored pill pick its
// abbreviation in one pass instead of one re-render per level. Null where
// canvas text metrics are unavailable (jsdom).
let measureContext: CanvasRenderingContext2D | null | undefined;
function measureText(text: string, font: string): number | null {
  if (measureContext === undefined) {
    const jsdom = typeof navigator !== "undefined" && navigator.userAgent.includes("jsdom");
    measureContext = jsdom ? null : (document.createElement("canvas").getContext("2d") ?? null);
  }
  if (!measureContext) return null;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

/**
 * Person colors — the level that fits `room` px: the name, "First L.", or
 * "First L." cut with an ellipsis while the cut still shows the characters
 * that tell this person apart. Two people of the team whose cut labels would
 * read the same ("Sophie…" for Sophie Wagner and Sophie Weber) show their
 * team-unique "F. L." instead ("S. Wa."). Where not even that fits, the cut
 * "First L." stays (the full name on hover and the person color tell them
 * apart); below PERSON_MIN_NAME_PX the circle stands alone.
 */
function personLevel(labels: PersonNameLabels, room: number, width: (text: string) => number): number {
  const { levels, distinctLength } = labels;
  if (width(levels[0]) <= room) return 0;
  if (width(levels[1]) <= room) return 1;
  if (room < PERSON_MIN_NAME_PX) return PERSON_INITIALS_ONLY;
  // What the ellipsis leaves of "First L.": the longest start that fits with it.
  const chars = Array.from(levels[1]);
  let shown = chars.length - 1;
  while (shown > 0 && width(`${chars.slice(0, shown).join("")}…`) > room) shown -= 1;
  if (shown >= distinctLength) return 1;
  return width(levels[PERSON_SHORT_LEVEL]) <= room ? PERSON_SHORT_LEVEL : 1;
}

type AssignmentPillProps = {
  name: string;
  /**
   * Short forms of the name by abbreviation level ("First L.", "F. Last",
   * "F. L.", "FL"; lib/personName buildNameLabels), unique in the whole team.
   * Absent = the name's own short forms.
   */
  labels?: PersonNameLabels;
  /** Unique key for violation line drawing: `${rowId}__${dateISO}__${clinicianId}` */
  assignmentKey?: string;
  showNoEligibilityWarning?: boolean;
  showIneligibleWarning?: boolean;
  isHighlighted?: boolean;
  isViolation?: boolean;
  /**
   * Locked shift (lib/assignmentPolicy): placed by hand, or a planner shift
   * locked afterwards. Replanning and Reset keep it.
   */
  isLocked?: boolean;
  /**
   * Lock button (editable calendars only; read-only pages show no lock). A
   * locked pill shows its closed lock at the right end; an unlocked one shows
   * the open lock only while pointed at or focused (always on touch screens),
   * with the name fading out under it.
   */
  onToggleLock?: () => void;
  isDragging?: boolean;
  isDragFocus?: boolean;
  className?: string;
  draggable?: boolean;
  onDragStart?: DragEventHandler<HTMLDivElement>;
  onDragEnd?: DragEventHandler<HTMLDivElement>;
  onClick?: MouseEventHandler<HTMLDivElement>;
  /**
   * Person colors (team grid, plan §2.9): light fill, strong border and an
   * initials circle. Absent = the section look of the print and public pages.
   */
  personStyle?: PersonPillStyle;
  /**
   * The person linked to the current account ("That's me"): a 2 px outline in
   * both color modes (SPEC E7). Never set while no account is linked.
   */
  isMe?: boolean;
  /**
   * Compact grid ("Times: Stacked"): columns settle their widths late and can
   * be narrow, so the name is measured again whenever the pill's width changes.
   */
  compact?: boolean;
};

function AssignmentPillImpl({
  name,
  labels,
  assignmentKey,
  showNoEligibilityWarning,
  showIneligibleWarning,
  isHighlighted = false,
  isViolation = false,
  isLocked = false,
  onToggleLock,
  isDragging = false,
  isDragFocus = false,
  className,
  draggable,
  onDragStart,
  onDragEnd,
  onClick,
  personStyle,
  isMe = false,
  compact = false,
}: AssignmentPillProps) {
  // Abbreviation logic: measure if name fits, progressively abbreviate if not
  const nameRef = useRef<HTMLSpanElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const initialsRef = useRef<HTMLSpanElement>(null);
  const hasInitials = Boolean(personStyle);
  // A locked pill's lock takes room in the row (the name abbreviates next to
  // it); an unlocked pill's lock only appears on hover and takes none.
  const lockInRow = !!onToggleLock && isLocked;
  const lockOnHover = !!onToggleLock && !isLocked;
  const [abbreviationLevel, setAbbreviationLevel] = useState(0);
  // Bumped when the row width changes (person mode): measure again.
  const [layoutVersion, setLayoutVersion] = useState(0);

  const nameLabels = useMemo(() => labels ?? nameLabelsOf(name), [labels, name]);
  const { levels } = nameLabels;
  // Person colors end with the initials circle alone (the name is only read
  // out); the section look ends with "FL" initials as text.
  const initialsOnly = hasInitials && abbreviationLevel === PERSON_INITIALS_ONLY;
  const displayName = initialsOnly ? name : levels[abbreviationLevel];

  // Check if name fits and increase abbreviation level if needed
  useLayoutEffect(() => {
    const nameEl = nameRef.current;
    const containerEl = containerRef.current;
    if (!nameEl || !containerEl) return;

    // Reset to full name first
    setAbbreviationLevel(0);
    // lockInRow: locking a pill takes room for its lock, unlocking frees it.
  }, [name, levels, hasInitials, lockInRow]);

  // Person colors and the compact grid — the grid may settle its column
  // widths after the first measurement (scope switch, resize, a lock taking
  // room): start over when the row width changes, so names never stay cut
  // off. The section look elsewhere keeps its one-shot measurement.
  useEffect(() => {
    const containerEl = containerRef.current;
    if ((!hasInitials && !compact) || !containerEl || typeof ResizeObserver === "undefined") return;
    let lastWidth = containerEl.clientWidth;
    const observer = new ResizeObserver(() => {
      if (containerEl.clientWidth === lastWidth) return;
      lastWidth = containerEl.clientWidth;
      setAbbreviationLevel(0);
      setLayoutVersion((version) => version + 1);
    });
    observer.observe(containerEl);
    return () => observer.disconnect();
  }, [hasInitials, compact]);

  // Person colors — the level that fits next to the circle, measured in one
  // pass (all pills read layout in the same commit). A row without width is
  // not laid out yet (hidden); the resize observer measures it once it is.
  useLayoutEffect(() => {
    const nameEl = nameRef.current;
    const containerEl = containerRef.current;
    if (!hasInitials || !nameEl || !containerEl || containerEl.clientWidth === 0) return;
    const font = window.getComputedStyle(nameEl).font;
    const room = containerEl.clientWidth - (initialsRef.current?.offsetWidth ?? 0) - 4;
    // Without canvas metrics (jsdom): the rendered name's width per character.
    const rendered = Array.from(nameEl.textContent ?? "").length;
    const perChar = rendered > 0 ? nameEl.scrollWidth / rendered : 0;
    const width = (text: string) => measureText(text, font) ?? Array.from(text).length * perChar;
    setAbbreviationLevel(personLevel(nameLabels, room, width));
  }, [nameLabels, hasInitials, layoutVersion, lockInRow]);

  // The section look — one level per frame until the name fits.
  useLayoutEffect(() => {
    const nameEl = nameRef.current;
    const containerEl = containerRef.current;
    if (hasInitials || !nameEl || !containerEl) return;

    // Use requestAnimationFrame to ensure layout is computed
    const rafId = requestAnimationFrame(() => {
      // A locked pill's lock sits next to the row, so the row is already narrower.
      const isOverflowing = nameEl.scrollWidth > containerEl.clientWidth;
      if (isOverflowing && abbreviationLevel < NAME_LABEL_LEVELS - 1) {
        setAbbreviationLevel((prev) => prev + 1);
      }
    });

    return () => cancelAnimationFrame(rafId);
    // A lock in the row changes the room for the name (also at level 0, where
    // the reset above changes no state).
  }, [displayName, abbreviationLevel, hasInitials, layoutVersion, lockInRow]);

  const isAbbreviated = abbreviationLevel > 0;
  const showHighlight = isHighlighted && !isDragging;
  const showViolation = isViolation && !isDragging;
  const showDragFocus = isDragFocus;
  const hasWarning = showNoEligibilityWarning || showIneligibleWarning;
  // Border width is kept constant across all states (see className below:
  // `border-2` on the outer div; `border` throughout in person mode). Previously this switched between `border`
  // (default) and `border-2` (violation/drag-focus), and the 1px delta
  // shifted every row underneath when hovering a violating pill.
  const toneClass = showViolation || showHighlight
    ? "border-rose-500 text-rose-900 dark:border-rose-400 dark:text-rose-100"
    : showDragFocus
      ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-sky-50"
      : "border-sky-200 text-sky-800 dark:border-sky-500/40 dark:text-sky-100";
  const toneBgClass = showViolation || showHighlight
    ? "bg-rose-100/80 dark:bg-rose-900/40"
    : showDragFocus
      ? "bg-sky-200 dark:bg-sky-700/60"
      : "bg-sky-50 dark:bg-sky-900/40";
  // Person colors — light fill, strong border, ink text. Violation,
  // highlight and drag focus keep their signal colors; inline styles leave
  // the default classes (and so the default look) untouched.
  const personColorStyle: CSSProperties | undefined =
    personStyle && !showViolation && !showHighlight && !showDragFocus
      ? {
          backgroundColor: personStyle.color.light,
          borderColor: personStyle.color.strong,
          color: personStyle.color.ink,
        }
      : undefined;
  // SPEC C5.13: 1 px border, 20 px initials circle 3 px from the edge (same
  // 24 px height as the section pill). The lock of a locked pill sits in the
  // row and brings its own spacing, so the pill keeps only a small padding.
  const paddingClass = cx(
    personStyle ? "py-px pl-0.5" : "py-0.5 pl-1.5",
    lockInRow ? "pr-px" : "pr-1.5",
    // Touch screens have no hover, so an unlocked pill always shows its lock:
    // keep its room there, and the name is measured beside it, not under it.
    lockOnHover && "[@media(hover:none)]:pr-[22px]",
  );
  return (
    <div
      data-assignment-pill="true"
      data-assignment-key={assignmentKey}
      data-locked={onToggleLock ? String(isLocked) : undefined}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      // The full name of a shortened pill. On the pill itself: its content
      // ignores the pointer (drag start), so a title in there never shows.
      title={isAbbreviated ? name : undefined}
      style={personColorStyle}
      // No `select-none` here: Safari/WebKit refuses to start dragstart on an
      // element whose -webkit-user-select is `none` (Chrome ignores that).
      // Text selection on the visible content is still prevented by the
      // name row's `select-none` below. See index.css for the matching CSS-side
      // safeguards (-webkit-user-drag: element + cursor: grab).
      className={cx(
        "group/pill relative flex w-full items-center overflow-visible rounded-xl text-[11px] font-normal leading-4",
        // Constant per look (see toneClass): 1 px in person mode (SPEC C5.13).
        personStyle ? "border" : "border-2",
        // The white inner hairline would glow on the deep dark-mode person fills.
        !personColorStyle && "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.7)]",
        paddingClass,
        // Hover z must EXCEED the static z of warning pills (500): the
        // eligibility tooltip lives inside this pill's stacking context, so
        // at equal z a warning pill later in the DOM (e.g. directly below)
        // would paint over the hovered pill's tooltip.
        "hover:z-[600]",
        hasWarning ? "z-[500]" : "z-[1]",
        (showViolation || showHighlight) &&
          "ring-2 ring-rose-200/80 dark:ring-rose-500/40",
        toneClass,
        toneBgClass,
        showViolation || showHighlight
          ? "hover:border-rose-300 hover:bg-rose-100/80 dark:hover:border-rose-500/60 dark:hover:bg-rose-900/40"
          : showDragFocus
            ? "hover:border-slate-900 hover:bg-sky-200"
            : "hover:border-sky-300 hover:bg-sky-100 dark:hover:border-sky-400/60 dark:hover:bg-sky-900/60",
        isMe && "outline outline-2 outline-offset-1 outline-slate-900 dark:outline-slate-100",
        className,
      )}
    >
      <div
        ref={containerRef}
        className={cx(
          "pointer-events-none relative z-10 flex min-w-0 flex-1 select-none items-center gap-1 overflow-hidden",
          // Left-aligned in person mode: a centered row clips the initials.
          personStyle ? "justify-start" : "justify-center",
          // The open lock of an unlocked pill appears over the row's end on
          // hover: the name fades out under it (index.css) instead of a box
          // on top. Touch screens keep room for it instead (padding above).
          lockOnHover && "pill-lock-fade",
        )}
      >
        {personStyle ? (
          <span
            ref={initialsRef}
            aria-hidden="true"
            className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold leading-none"
            style={{
              backgroundColor: personStyle.color.strong,
              color: personStyle.color.onStrong,
            }}
          >
            {personStyle.initials}
          </span>
        ) : null}
        <span
          ref={nameRef}
          className={cx(
            personStyle ? "min-w-0 truncate" : "whitespace-nowrap text-center",
            initialsOnly && "sr-only",
          )}
        >
          {displayName}
        </span>
      </div>
      {onToggleLock ? (
        <AssignmentLockButton
          name={name}
          locked={isLocked}
          onToggle={onToggleLock}
          className={cx(
            "z-[150]",
            lockOnHover
              ? cx(
                  "pill-lock-reveal absolute top-1/2 -translate-y-1/2",
                  personStyle ? "right-[3px]" : "right-0.5",
                )
              : "relative -my-px",
          )}
        />
      ) : null}
      {hasWarning ? (
        <>
          {/* Warning dot. pointer-events-none so the ~16px-wide hit target doesn't
              swallow the drag-start event when the user grabs the pill near its
              top edge (the dot is absolute + -translate-y-1/2, so it overlaps
              the pill's upper-right corner). Before this, pills with a warning
              could only be dragged from the lower half, which looked like a
              z-index glitch but was actually HTML5 drag getting intercepted. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-1 top-0 z-[200] -translate-y-1/2"
          >
            <span
              className={cx(
                "inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold shadow-sm",
                showNoEligibilityWarning
                  ? "bg-rose-300 text-rose-700"
                  : "bg-amber-200 text-amber-700",
              )}
            >
              !
            </span>
          </span>
          {/* Tooltip is now gated on hover of the whole pill (group/pill on the
              outer div) instead of the tiny warning dot — so it appears on any
              hover and doesn't require pointer-events on the dot. */}
          <span className="pointer-events-none absolute right-0 top-full z-[210] mt-1 w-max rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-600 opacity-0 shadow-sm transition-opacity duration-75 group-hover/pill:opacity-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            {showNoEligibilityWarning
              ? "No eligible sections defined yet."
              : "Not eligible for this slot."}
          </span>
        </>
      ) : null}
    </div>
  );
}

/**
 * Pills are rendered hundreds at a time in the schedule grid. Any state
 * change in the parent (e.g. the drag state during a drag) would otherwise
 * re-render every single pill, compounded by each pill's own
 * useLayoutEffect → rAF → setState abbreviation loop. Skipping re-renders
 * for pills whose data didn't change is what makes drag feel snappy.
 *
 * We intentionally ignore callback prop identity. The onDragStart /
 * onDragEnd / onClick closures capture per-pill ids (rowId, dateISO,
 * assignmentId, clinicianId) that are stable for the lifetime of that
 * pill, so a new closure with the same behaviour is safe to skip.
 */
function arePillPropsEqual(
  prev: AssignmentPillProps,
  next: AssignmentPillProps,
): boolean {
  return (
    prev.name === next.name &&
    prev.assignmentKey === next.assignmentKey &&
    prev.showNoEligibilityWarning === next.showNoEligibilityWarning &&
    prev.showIneligibleWarning === next.showIneligibleWarning &&
    prev.isHighlighted === next.isHighlighted &&
    prev.isViolation === next.isViolation &&
    prev.isLocked === next.isLocked &&
    Boolean(prev.onToggleLock) === Boolean(next.onToggleLock) &&
    prev.isDragging === next.isDragging &&
    prev.isDragFocus === next.isDragFocus &&
    prev.draggable === next.draggable &&
    prev.className === next.className &&
    prev.personStyle?.color.strong === next.personStyle?.color.strong &&
    prev.personStyle?.color.light === next.personStyle?.color.light &&
    prev.personStyle?.initials === next.personStyle?.initials &&
    prev.isMe === next.isMe &&
    prev.compact === next.compact &&
    prev.labels === next.labels
  );
}

const AssignmentPill = memo(AssignmentPillImpl, arePillPropsEqual);
export default AssignmentPill;
