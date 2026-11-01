import { useMemo } from "react";
import { createPortal } from "react-dom";
import { highlightCss } from "../../lib/swaps/format";

/**
 * The swap preview outline as one injected stylesheet (SPEC §5.5): pills and
 * clinic sheet names are matched by their keys, so hovering an option
 * re-renders only the drawer, never the grid. Unmounting removes the outline.
 */
export default function SwapHighlightStyle({ keys }: { keys: string[] }) {
  // `keys` is a new array on every drawer render: the joined keys stand for it.
  const signature = keys.join("|");
  const css = useMemo(() => highlightCss(keys), [signature]);
  if (!css) return null;
  return createPortal(<style data-swap-highlight="true">{css}</style>, document.head);
}
