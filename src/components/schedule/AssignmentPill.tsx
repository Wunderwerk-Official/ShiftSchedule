import { cx } from "../../lib/classNames";
import { useMemo, useRef, useState, useLayoutEffect } from "react";
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
  isDragging?: boolean;
  isDragFocus?: boolean;
  className?: string;
  draggable?: boolean;
  onDragStart?: DragEventHandler<HTMLDivElement>;
  onDragEnd?: DragEventHandler<HTMLDivElement>;
  onClick?: MouseEventHandler<HTMLDivElement>;
};

export default function AssignmentPill({
  name,
  siblingNames,
  assignmentKey,
  timeSegments,
  showNoEligibilityWarning,
  showIneligibleWarning,
  isHighlighted = false,
  isViolation = false,
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
  const toneClass = showViolation || showHighlight
    ? "border-2 border-rose-500 text-rose-900 dark:border-rose-400 dark:text-rose-100"
    : showDragFocus
      ? "border-2 border-slate-900 text-slate-900 dark:border-slate-100 dark:text-sky-50"
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
      className={cx(
        "group/pill relative w-full select-none overflow-visible rounded-xl border px-1.5 py-0.5 text-[11px] font-normal leading-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.7)]",
        "transition-colors hover:z-[500]",
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
      <div className="pointer-events-none relative z-10 overflow-hidden rounded-[inherit]">
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
      {showNoEligibilityWarning ? (
        <span className="group/warn pointer-events-auto absolute right-1 top-0 z-[200] -translate-y-1/2">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-rose-300 text-[10px] font-semibold text-rose-700 shadow-sm">
            !
          </span>
          <span className="pointer-events-none absolute right-0 top-full z-[210] mt-1 w-max rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-600 opacity-0 shadow-sm transition-opacity duration-75 group-hover/warn:opacity-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            No eligible sections defined yet.
          </span>
        </span>
      ) : showIneligibleWarning ? (
        <span className="group/warn pointer-events-auto absolute right-1 top-0 z-[200] -translate-y-1/2">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-200 text-[10px] font-semibold text-amber-700 shadow-sm">
            !
          </span>
          <span className="pointer-events-none absolute right-0 top-full z-[210] mt-1 w-max rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-600 opacity-0 shadow-sm transition-opacity duration-75 group-hover/warn:opacity-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            Not eligible for this slot.
          </span>
        </span>
      ) : null}
    </div>
  );
}
