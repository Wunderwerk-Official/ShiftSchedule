import { cx } from "../../lib/classNames";
import { memo, useMemo, useRef, useState, useLayoutEffect } from "react";
import type { DragEventHandler, MouseEventHandler } from "react";
import type { AvailabilitySegment } from "../../lib/schedule";

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

type AssignmentPillProps = {
  name: string;
  /** Other names in the same cell, used to ensure unique abbreviations */
  siblingNames?: string[];
  /** Unique key for violation line drawing: `${rowId}__${dateISO}__${clinicianId}` */
  assignmentKey?: string;
  timeLabel?: string;
  timeSegments?: AvailabilitySegment[];
  showNoEligibilityWarning?: boolean;
  showIneligibleWarning?: boolean;
  isHighlighted?: boolean;
  isViolation?: boolean;
  /** Manually placed (source !== "solver"): shows a small lock — automated
   * planning treats these as fixed and never moves them. */
  isManual?: boolean;
  isDragging?: boolean;
  isDragFocus?: boolean;
  className?: string;
  draggable?: boolean;
  onDragStart?: DragEventHandler<HTMLDivElement>;
  onDragEnd?: DragEventHandler<HTMLDivElement>;
  onClick?: MouseEventHandler<HTMLDivElement>;
};

function AssignmentPillImpl({
  name,
  siblingNames,
  assignmentKey,
  timeSegments,
  showNoEligibilityWarning,
  showIneligibleWarning,
  isHighlighted = false,
  isViolation = false,
  isManual = false,
  isDragging = false,
  isDragFocus = false,
  className,
  draggable,
  onDragStart,
  onDragEnd,
  onClick,
}: AssignmentPillProps) {
  // Abbreviation logic: measure if name fits, progressively abbreviate if not
  const nameRef = useRef<HTMLSpanElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [abbreviationLevel, setAbbreviationLevel] = useState(0);

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
  }, [name]);

  useLayoutEffect(() => {
    const nameEl = nameRef.current;
    const containerEl = containerRef.current;
    if (!nameEl || !containerEl) return;

    // Use requestAnimationFrame to ensure layout is computed
    const rafId = requestAnimationFrame(() => {
      const isOverflowing = nameEl.scrollWidth > containerEl.clientWidth;
      if (isOverflowing && abbreviationLevel < 4) {
        setAbbreviationLevel((prev) => prev + 1);
      }
    });

    return () => cancelAnimationFrame(rafId);
  }, [displayName, abbreviationLevel]);

  const isAbbreviated = abbreviationLevel > 0;
  const showHighlight = isHighlighted && !isDragging;
  const showViolation = isViolation && !isDragging;
  const showDragFocus = isDragFocus;
  const hasWarning = showNoEligibilityWarning || showIneligibleWarning;
  const hasSegments = Boolean(timeSegments?.length);
  const segmentFreeClass = showViolation || showHighlight
    ? "bg-rose-100/80 dark:bg-rose-900/40"
    : showDragFocus
      ? "bg-sky-200 dark:bg-sky-700/60"
      : "bg-sky-50 dark:bg-sky-900/40";
  const segmentTakenClass = "bg-white dark:bg-slate-900";
  // Border width is kept constant across all states (see className below:
  // `border-2` on the outer div). Previously this switched between `border`
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
  return (
    <div
      data-assignment-pill="true"
      data-assignment-key={assignmentKey}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      // No `select-none` here: Safari/WebKit refuses to start dragstart on an
      // element whose -webkit-user-select is `none` (Chrome ignores that).
      // Text selection on the visible content is still prevented by the inner
      // wrapper's `select-none` below. See index.css for the matching CSS-side
      // safeguards (-webkit-user-drag: element + cursor: grab).
      className={cx(
        "group/pill relative w-full overflow-visible rounded-xl border-2 px-1.5 py-0.5 text-[11px] font-normal leading-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.7)]",
        // Hover z must EXCEED the static z of warning pills (500): the
        // eligibility tooltip lives inside this pill's stacking context, so
        // at equal z a warning pill later in the DOM (e.g. directly below)
        // would paint over the hovered pill's tooltip.
        "hover:z-[600]",
        hasWarning ? "z-[500]" : "z-[1]",
        (showViolation || showHighlight) &&
          "ring-2 ring-rose-200/80 dark:ring-rose-500/40",
        toneClass,
        hasSegments ? "bg-transparent" : toneBgClass,
        !hasSegments &&
          (showViolation || showHighlight
            ? "hover:border-rose-300 hover:bg-rose-100/80 dark:hover:border-rose-500/60 dark:hover:bg-rose-900/40"
            : showDragFocus
              ? "hover:border-slate-900 hover:bg-sky-200"
              : "hover:border-sky-300 hover:bg-sky-100 dark:hover:border-sky-400/60 dark:hover:bg-sky-900/60"),
        className,
      )}
    >
      <div className="pointer-events-none relative z-10 select-none overflow-hidden rounded-[inherit]">
        {hasSegments ? (
          <div className="pointer-events-none absolute inset-0 z-0 flex divide-x divide-slate-200/80 dark:divide-slate-700/80">
            {timeSegments?.map((segment, index) => (
              <div
                key={`${segment.label}-${index}`}
                className={cx(
                  "flex-1",
                  segment.kind === "taken" ? segmentTakenClass : segmentFreeClass,
                )}
              />
            ))}
          </div>
        ) : null}
        <div className="relative z-10 flex flex-col items-center gap-0.5">
          <div
            ref={containerRef}
            className="flex w-full items-center justify-center gap-1 overflow-hidden"
          >
            <span
              ref={nameRef}
              className="whitespace-nowrap text-center"
              title={isAbbreviated ? name : undefined}
            >
              {displayName}
            </span>
          </div>
        </div>
      </div>
      {isManual ? (
        // Lock badge: manual assignment, the planner never moves it.
        // pointer-events-none for the same drag-start reason as the warning
        // dot below.
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 right-0.5 z-[150] opacity-60"
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

function segmentsEqual(
  a: AvailabilitySegment[] | undefined,
  b: AvailabilitySegment[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].kind !== b[i].kind || a[i].label !== b[i].label) return false;
  }
  return true;
}

/**
 * Pills are rendered hundreds at a time in the schedule grid. Any state
 * change in the parent (e.g. setDragState during a drag) would otherwise
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
    prev.isDragging === next.isDragging &&
    prev.isDragFocus === next.isDragFocus &&
    prev.draggable === next.draggable &&
    prev.className === next.className &&
    arraysShallowEqual(prev.siblingNames, next.siblingNames) &&
    segmentsEqual(prev.timeSegments, next.timeSegments)
  );
}

const AssignmentPill = memo(AssignmentPillImpl, arePillPropsEqual);
export default AssignmentPill;
