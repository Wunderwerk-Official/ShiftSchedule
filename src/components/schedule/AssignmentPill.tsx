import AssignmentLockButton from "./AssignmentLockButton";
import { cx } from "../../lib/classNames";
import { memo, useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import type { CSSProperties, DragEventHandler, MouseEventHandler } from "react";
import type { PersonPillStyle } from "./teamColors";

/**
 * Abbreviate a name to fit in limited space.
 * Strategy: "First Last" -> "First L." -> "F. Last" -> "F. L." -> "FL"
 * If disambiguation is needed, adds more characters from first name.
 */
function abbreviateName(
  name: string,
  level: number,
  siblingNames?: string[],
): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    // Single name - truncate if needed
    if (level >= 3) return parts[0].charAt(0);
    return parts[0];
  }

  const firstName = parts[0];
  const lastName = parts[parts.length - 1];

  let result: string;
  if (level === 0) {
    // Full name: "John Smith"
    result = name;
  } else if (level === 1) {
    // "First L.": "John S."
    result = `${firstName} ${lastName.charAt(0)}.`;
  } else if (level === 2) {
    // "F. Last": "J. Smith"
    result = `${firstName.charAt(0)}. ${lastName}`;
  } else if (level === 3) {
    // "F. L.": "J. S."
    result = `${firstName.charAt(0)}. ${lastName.charAt(0)}.`;
  } else {
    // "FL": "JS"
    result = `${firstName.charAt(0)}${lastName.charAt(0)}`;
  }

  // Check for collisions with sibling names and disambiguate if needed
  if (siblingNames && siblingNames.length > 0 && level > 0) {
    const otherAbbreviations = siblingNames
      .filter((n) => n !== name)
      .map((n) => abbreviateName(n, level));

    if (otherAbbreviations.includes(result)) {
      // Collision detected - add more characters to disambiguate
      if (level === 1) {
        // "First L." -> try adding more chars from last name: "John Sm.", "John Smi."
        for (let i = 2; i <= lastName.length; i++) {
          const disambiguated = `${firstName} ${lastName.slice(0, i)}.`;
          const othersWithMoreChars = siblingNames
            .filter((n) => n !== name)
            .map((n) => {
              const p = n.trim().split(/\s+/);
              if (p.length === 1) return n;
              return `${p[0]} ${p[p.length - 1].slice(0, i)}.`;
            });
          if (!othersWithMoreChars.includes(disambiguated)) {
            return disambiguated;
          }
        }
      } else if (level === 2) {
        // "F. Last" -> "Fi. Last" or "Fir. Last"
        for (let i = 2; i <= firstName.length; i++) {
          const disambiguated = `${firstName.slice(0, i)}. ${lastName}`;
          const othersWithMoreChars = siblingNames
            .filter((n) => n !== name)
            .map((n) => {
              const p = n.trim().split(/\s+/);
              if (p.length === 1) return n;
              return `${p[0].slice(0, i)}. ${p[p.length - 1]}`;
            });
          if (!othersWithMoreChars.includes(disambiguated)) {
            return disambiguated;
          }
        }
      } else if (level === 3) {
        // "F. L." -> "Fi. L." or use first 2 chars of last name
        const disambiguated = `${firstName.slice(0, 2)}. ${lastName.charAt(0)}.`;
        const othersDisambiguated = siblingNames
          .filter((n) => n !== name)
          .map((n) => {
            const p = n.trim().split(/\s+/);
            if (p.length === 1) return n.charAt(0);
            return `${p[0].slice(0, 2)}. ${p[p.length - 1].charAt(0)}.`;
          });
        if (!othersDisambiguated.includes(disambiguated)) {
          return disambiguated;
        }
      }
      // level 4 (initials) - not much we can do, fall through
    }
  }

  return result;
}

/**
 * Color by: Person — one order per column: "First Last" → "First L." → the
 * initials circle alone. "F. Last" / "F. L." are skipped: the circle next to
 * the name already carries the initials (and mixing "S. Klein" with "Felix W."
 * in one column reads unevenly).
 */
const PERSON_INITIALS_ONLY_LEVEL = 2;
/**
 * Color by: Person — "First L." that does not fit is cut with an ellipsis
 * ("Sophie…") as long as this much room is left next to the circle (about
 * four letters). Only below it does the circle stand alone: in the narrow
 * team columns many names miss by a few pixels, and a lone circle left most
 * of the pill blank. Known limit: two people in one cell with the same first
 * name and surname initial ("Sophie Mü." / "Sophie Me.") can both read
 * "Sophie…"; the full name on hover (and usually the person color) tells
 * them apart. Still better than the two identical "SM" circles shown before.
 */
const PERSON_MIN_NAME_PX = 30;

// Text widths via a shared canvas: lets "Color by: Person" pick its
// abbreviation in one pass instead of one re-render per level. Null where
// canvas text metrics are unavailable (jsdom): the stepwise check runs then.
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

type AssignmentPillProps = {
  name: string;
  /** Other names in the same cell, used to ensure unique abbreviations */
  siblingNames?: string[];
  /** Unique key for violation line drawing: `${rowId}__${dateISO}__${clinicianId}` */
  assignmentKey?: string;
  showNoEligibilityWarning?: boolean;
  showIneligibleWarning?: boolean;
  isHighlighted?: boolean;
  isViolation?: boolean;
  /** Manually placed (source !== "solver"): shows a small lock — automated
   * planning treats these as fixed and never moves them. */
  isManual?: boolean;
  isLocked?: boolean;
  onToggleLock?: () => void;
  isDragging?: boolean;
  isDragFocus?: boolean;
  className?: string;
  draggable?: boolean;
  onDragStart?: DragEventHandler<HTMLDivElement>;
  onDragEnd?: DragEventHandler<HTMLDivElement>;
  onClick?: MouseEventHandler<HTMLDivElement>;
  /** Team "Color by: Person" (plan §2.9). Absent = the default section look, unchanged. */
  personStyle?: PersonPillStyle;
  /**
   * The person linked to the current account ("That's me"): a 2 px outline in
   * both color modes (SPEC E7). Never set while no account is linked.
   */
  isMe?: boolean;
};

function AssignmentPillImpl({
  name,
  siblingNames,
  assignmentKey,
  showNoEligibilityWarning,
  showIneligibleWarning,
  isHighlighted = false,
  isViolation = false,
  isManual = false,
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
}: AssignmentPillProps) {
  // Abbreviation logic: measure if name fits, progressively abbreviate if not
  const nameRef = useRef<HTMLSpanElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const initialsRef = useRef<HTMLSpanElement>(null);
  const hasInitials = Boolean(personStyle);
  // Color by: Person ends with the initials circle alone (the name is only
  // read out); the section look ends with "FL" initials as text.
  const maxAbbreviationLevel = hasInitials ? PERSON_INITIALS_ONLY_LEVEL : 4;
  const [abbreviationLevel, setAbbreviationLevel] = useState(0);
  // Bumped when the row width changes (person mode): measure again.
  const [layoutVersion, setLayoutVersion] = useState(0);

  const displayName = useMemo(
    () => abbreviateName(name, abbreviationLevel, siblingNames),
    [name, abbreviationLevel, siblingNames],
  );

  // Check if name fits and increase abbreviation level if needed
  useLayoutEffect(() => {
    const nameEl = nameRef.current;
    const containerEl = containerRef.current;
    if (!nameEl || !containerEl) return;

    // Reset to full name first
    setAbbreviationLevel(0);
  }, [name, hasInitials]);

  // Color by: Person — the grid may settle its column widths after the
  // first measurement (scope switch, resize): start over when the row width
  // changes, so names never stay cut off. The default look keeps its
  // one-shot measurement.
  useEffect(() => {
    const containerEl = containerRef.current;
    if (!hasInitials || !containerEl || typeof ResizeObserver === "undefined") return;
    let lastWidth = containerEl.clientWidth;
    const observer = new ResizeObserver(() => {
      if (containerEl.clientWidth === lastWidth) return;
      lastWidth = containerEl.clientWidth;
      setAbbreviationLevel(0);
      setLayoutVersion((version) => version + 1);
    });
    observer.observe(containerEl);
    return () => observer.disconnect();
  }, [hasInitials]);

  // Color by: Person — the first level whose name fits next to the circle,
  // measured in one pass (all pills read layout in the same commit).
  const siblingKey = siblingNames?.join("|");
  const [measuredInOnePass, setMeasuredInOnePass] = useState(false);
  useLayoutEffect(() => {
    const nameEl = nameRef.current;
    const containerEl = containerRef.current;
    if (!hasInitials || !nameEl || !containerEl) return;
    const font = window.getComputedStyle(nameEl).font;
    const available = containerEl.clientWidth - (initialsRef.current?.offsetWidth ?? 0) - 4;
    let level = 0;
    for (; level < PERSON_INITIALS_ONLY_LEVEL; level += 1) {
      const width = measureText(abbreviateName(name, level, siblingNames), font);
      if (width === null) return;
      if (width <= available) break;
    }
    if (level === PERSON_INITIALS_ONLY_LEVEL && available >= PERSON_MIN_NAME_PX) {
      level -= 1; // "First L." with an ellipsis
    }
    setMeasuredInOnePass(true);
    setAbbreviationLevel(level);
    // siblingKey stands for siblingNames (a new array on every grid render).
  }, [name, siblingKey, hasInitials, layoutVersion]);

  useLayoutEffect(() => {
    const nameEl = nameRef.current;
    const containerEl = containerRef.current;
    if (!nameEl || !containerEl || (hasInitials && measuredInOnePass)) return;

    // Use requestAnimationFrame to ensure layout is computed
    const rafId = requestAnimationFrame(() => {
      // The initials circle (Color by: Person) shares the line with the name;
      // the lock badge's room is reserved as pill padding (outside the row).
      const initialsWidth = initialsRef.current ? initialsRef.current.offsetWidth + 4 : 0;
      const isOverflowing = nameEl.scrollWidth + initialsWidth > containerEl.clientWidth;
      // Color by: Person keeps "First L." with an ellipsis while it has room.
      const keepEllipsis =
        hasInitials &&
        abbreviationLevel === PERSON_INITIALS_ONLY_LEVEL - 1 &&
        containerEl.clientWidth - initialsWidth >= PERSON_MIN_NAME_PX;
      if (isOverflowing && abbreviationLevel < maxAbbreviationLevel && !keepEllipsis) {
        setAbbreviationLevel((prev) => prev + 1);
      }
    });

    return () => cancelAnimationFrame(rafId);
    // hasInitials: switching "Color by" changes the room for the name.
  }, [displayName, abbreviationLevel, maxAbbreviationLevel, hasInitials, layoutVersion, measuredInOnePass]);

  const isAbbreviated = abbreviationLevel > 0;
  const initialsOnly = hasInitials && abbreviationLevel >= PERSON_INITIALS_ONLY_LEVEL;
  const showLockBadge = isManual || (isLocked && !onToggleLock);
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
  // Color by: Person — light fill, strong border, ink text. Violation,
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
  // 24 px height as the default pill); room on the right for the lock badge.
  // The default look reserves room for the manual lock badge too, so a long
  // name is abbreviated instead of running under the badge.
  const personPaddingClass = personStyle
    ? cx("py-px pl-0.5", onToggleLock ? null : showLockBadge ? "pr-5" : "pr-1.5")
    : cx("py-0.5 pl-1.5", !onToggleLock && showLockBadge ? "pr-4" : "pr-1.5");
  return (
    <div
      data-assignment-pill="true"
      data-assignment-key={assignmentKey}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      style={personColorStyle}
      // No `select-none` here: Safari/WebKit refuses to start dragstart on an
      // element whose -webkit-user-select is `none` (Chrome ignores that).
      // Text selection on the visible content is still prevented by the inner
      // wrapper's `select-none` below. See index.css for the matching CSS-side
      // safeguards (-webkit-user-drag: element + cursor: grab).
      className={cx(
        "group/pill relative w-full overflow-visible rounded-xl text-[11px] font-normal leading-4",
        // Constant per look (see toneClass): 1 px in person mode (SPEC C5.13).
        personStyle ? "border" : "border-2",
        // The white inner hairline would glow on the deep dark-mode person fills.
        !personColorStyle && "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.7)]",
        personPaddingClass,
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
        onToggleLock && "min-h-7 pr-6",
        isMe && "outline outline-2 outline-offset-1 outline-slate-900 dark:outline-slate-100",
        className,
      )}
    >
      <div className="pointer-events-none relative z-10 select-none overflow-hidden rounded-[inherit]">
        <div className="relative z-10 flex flex-col items-center gap-0.5">
          <div
            ref={containerRef}
            className={cx(
              "flex w-full items-center gap-1 overflow-hidden",
              // Left-aligned in person mode: a centered row clips the initials.
              personStyle ? "min-w-0 justify-start" : "justify-center",
            )}
            title={personStyle && isAbbreviated ? name : undefined}
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
              title={!personStyle && isAbbreviated ? name : undefined}
            >
              {initialsOnly ? name : displayName}
            </span>
          </div>
        </div>
      </div>
      {onToggleLock ? (
        <span className="absolute right-0 top-0 z-[150]">
          <AssignmentLockButton name={name} locked={isLocked} onToggle={onToggleLock} />
        </span>
      ) : null}
      {showLockBadge ? (
        // Lock badge: manual assignment, the planner never moves it. Same
        // circular badge language as the warning dot below, but in a neutral
        // tone (no signal color). Kept fully inside the pill so it can't be
        // painted over by the next pill. pointer-events-none for the same
        // drag-start reason as the warning dot.
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0.5 right-0.5 z-[150] inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-200/90 text-slate-500 shadow-sm dark:bg-slate-600/90 dark:text-slate-200"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-2 w-2">
            <path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3H9z" />
          </svg>
        </span>
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

function arraysShallowEqual<T>(
  a: ReadonlyArray<T> | undefined,
  b: ReadonlyArray<T> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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
    prev.isManual === next.isManual &&
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
    arraysShallowEqual(prev.siblingNames, next.siblingNames)
  );
}

const AssignmentPill = memo(AssignmentPillImpl, arePillPropsEqual);
export default AssignmentPill;
