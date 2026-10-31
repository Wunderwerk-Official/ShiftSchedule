import { buttonAssignmentLock } from "../../lib/buttonStyles";
import { cx } from "../../lib/classNames";

/**
 * Closed lock (filled body) or open lock (outline, shackle lifted), drawn
 * for 12 px. Inherits the text color, so it takes the person's ink in a pill.
 */
export function LockGlyph({ locked, className }: { locked: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" className={className} aria-hidden="true">
      {locked ? (
        <>
          <path d="M5.25 7.25V5.5a2.75 2.75 0 0 1 5.5 0v1.75" />
          <rect x="3.25" y="7.25" width="9.5" height="7" rx="1.75" fill="currentColor" stroke="none" />
        </>
      ) : (
        <>
          <path d="M5.25 7.25V5.5a2.75 2.75 0 0 1 5.3-1.05" />
          <rect x="4" y="8" width="8" height="5.5" rx="1.25" />
        </>
      )}
    </svg>
  );
}

/**
 * The one lock of a shift (v1.69): pressed = locked, so replanning and Reset
 * keep it. Hand-placed shifts start locked, planner shifts unlocked. Lives
 * inside a draggable pill, so it never starts a drag or a cell click itself.
 */
export default function AssignmentLockButton({ name, locked, onToggle, className }: {
  name: string; locked: boolean; onToggle: () => void; className?: string;
}) {
  return <button type="button" className={cx(buttonAssignmentLock, locked ? "opacity-80" : "opacity-60", className)}
    aria-label={`Lock assignment for ${name}`} aria-pressed={locked}
    title={locked
      ? "Locked: replanning and Reset keep this shift. Click to unlock."
      : "Unlocked: the planner may change this shift. Click to lock it."}
    draggable={false} onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
    onDragStart={event => { event.preventDefault(); event.stopPropagation(); }}
    onClick={event => { event.stopPropagation(); onToggle(); }}>
    <LockGlyph locked={locked} className="h-3 w-3" />
  </button>;
}
