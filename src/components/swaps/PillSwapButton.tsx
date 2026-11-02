import type { KeyboardEvent } from "react";
import { buttonAssignmentLock } from "../../lib/buttonStyles";
import { cx } from "../../lib/classNames";

/**
 * "S" while the lock or ⇄ button of a pill or sheet name has focus. For the
 * root's onKeyDownCapture: capture runs before both buttons stop propagation.
 */
export function findSwapOnKey(onFindSwap: () => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "s" && event.key !== "S") return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    onFindSwap();
  };
}

/** "⇄" drawn for 12–16 px in the current text color (the swap assistant's mark). */
export function SwapGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 5.5h9.5M10 3l2.5 2.5L10 8" />
      <path d="M13 10.5H3.5M6 8l-2.5 2.5L6 13" />
    </svg>
  );
}

/**
 * "Find swap" inside a pill or a clinic sheet name, next to the lock and
 * shaped like it. Lives inside a draggable element, so it never starts a
 * drag or a cell click itself. The caller positions it.
 */
export default function PillSwapButton({ name, onFindSwap, className }: {
  name: string; onFindSwap: () => void; className?: string;
}) {
  return (
    <button
      type="button"
      className={cx(buttonAssignmentLock, "opacity-60", className)}
      aria-label={`Find swap for ${name}`}
      title="Find swap (S)"
      aria-keyshortcuts="S"
      draggable={false}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onDragStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
        onFindSwap();
      }}
    >
      <SwapGlyph className="h-3 w-3" />
    </button>
  );
}
