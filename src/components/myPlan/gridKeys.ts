import type { KeyboardEvent } from "react";

// Roving arrow-key focus between shift blocks (SPEC A4/R16). Blocks carry
// data-plan-block, data-col (day or lane index) and data-pos (start minute).
// "top": ←/→ = neighbour column (day/lane), ↑/↓ = previous/next block in it.
// "left": the same with the axes swapped. Handled keys stop propagating, so
// page-level ←/→ paging only runs while no block is focused.

type Orientation = "top" | "left";

type BlockInfo = { el: HTMLElement; col: number; pos: number };

function readBlocks(container: HTMLElement): BlockInfo[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-plan-block]")).map((el) => ({
    el,
    col: Number(el.dataset.col ?? 0),
    pos: Number(el.dataset.pos ?? 0),
  }));
}

export function handleBlockArrowKeys(event: KeyboardEvent<HTMLElement>, orientation: Orientation) {
  const key = event.key;
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-plan-block]");
  if (!target) return;
  const blocks = readBlocks(event.currentTarget);
  const current = blocks.find((block) => block.el === target);
  if (!current) return;

  const acrossKeys = orientation === "top" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  const forward = key === "ArrowRight" || key === "ArrowDown";
  let next: BlockInfo | undefined;
  if (acrossKeys.includes(key)) {
    // Nearest column in that direction that has blocks; closest start time there.
    const cols = [...new Set(blocks.map((block) => block.col))].sort((a, b) => a - b);
    const candidates = cols.filter((col) => (forward ? col > current.col : col < current.col));
    const col = forward ? candidates[0] : candidates[candidates.length - 1];
    if (col !== undefined) {
      next = blocks
        .filter((block) => block.col === col)
        .sort((a, b) => Math.abs(a.pos - current.pos) - Math.abs(b.pos - current.pos))[0];
    }
  } else {
    const sameCol = blocks
      .filter((block) => block.col === current.col)
      .sort((a, b) => a.pos - b.pos);
    const index = sameCol.findIndex((block) => block.el === target);
    next = sameCol[index + (forward ? 1 : -1)];
  }
  event.preventDefault();
  event.stopPropagation();
  next?.el.focus();
}
