import type { TeamPlanTarget } from "../components/myPlan/MyPlanView";

// "Show in team plan" (SPEC R18): once the team grid has rendered, bring the
// person's pill into view and pulse it. Grids without one pill per
// assignment (clinic sheet) pulse the cell. Polls via requestAnimationFrame
// like the page's other scroll helpers: the grid only mounts after the scope
// switch.
//
// The grid scrolls sideways in its own container and the page scrolls
// vertically; in the classic grid neither the row labels nor the day header
// row stick to the window. Centring the pill on both axes scrolled both out
// of view, so each axis scrolls only as far as needed:
// - sideways inside the grid's scroll container: the pill's whole day (all
//   its columns) right of the label column when it fits, else the pill;
// - vertically on the page: the day header row together with the pill when
//   both fit on screen, else the pill centred. If the day header is still
//   off screen then, a small tag next to the pill names the day.
// The pulse starts once the smooth scroll has settled and rings OUTSIDE the
// pill (own pills already carry a 2 px outline in the same color).

const MARGIN = 16;
const PULSE_MS = 700;
const PULSE_COUNT = 3;
/** Wait for a smooth scroll without the "scrollend" event (and the upper bound with it). */
const SCROLL_SETTLE_MS = 600;
const SCROLL_SETTLE_MAX_MS = 1200;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A stretch on one axis, in viewport pixels. */
export type AxisRange = { start: number; end: number };

/**
 * Scroll offset change that shows `target` inside `view` (with a margin),
 * together with `context` (a range around the target: day header + pill, the
 * pill's whole day) when both fit. Otherwise the target alone: "nearest"
 * scrolls as little as possible, "center" centres it. 0 = nothing to do.
 */
export function axisScrollDelta(
  target: AxisRange,
  view: AxisRange,
  options: { context?: AxisRange | null; fallback?: "nearest" | "center"; margin?: number } = {},
): number {
  const margin = options.margin ?? MARGIN;
  const room = view.end - view.start - 2 * margin;
  const context = options.context;
  const withContext = context
    ? { start: Math.min(context.start, target.start), end: Math.max(context.end, target.end) }
    : null;
  const range = withContext && withContext.end - withContext.start <= room ? withContext : target;
  const lowest = view.start + margin;
  const highest = view.end - margin;
  if (range.start >= lowest && range.end <= highest) return 0;
  if (range === target && options.fallback === "center") {
    return (target.start + target.end) / 2 - (view.start + view.end) / 2;
  }
  if (range.end - range.start > room || range.start < lowest) return range.start - lowest;
  return range.end - highest;
}

function horizontalScroller(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
    const { overflowX } = window.getComputedStyle(node);
    if ((overflowX === "auto" || overflowX === "scroll") && node.scrollWidth > node.clientWidth) return node;
  }
  return null;
}

/** Horizontal extent of all cells of the day (its columns), null when none are found. */
function dayExtent(grid: Element, dateISO: string): AxisRange | null {
  let start = Infinity;
  let end = -Infinity;
  grid.querySelectorAll(`[data-schedule-cell="true"][data-date-iso="${dateISO}"]`).forEach((cell) => {
    const rect = cell.getBoundingClientRect();
    start = Math.min(start, rect.left);
    end = Math.max(end, rect.right);
  });
  return end > start ? { start, end } : null;
}

/** Scrolls the grid container and the page; returns what was scrolled. */
function scrollIntoContext(element: HTMLElement, dateISO: string): EventTarget[] {
  const scrolled: EventTarget[] = [];
  const grid = element.closest("[data-schedule-grid]");
  // The grid's first cell is the top-left corner: label column width, header row height.
  const corner = grid?.firstElementChild?.getBoundingClientRect() ?? null;
  const pill = element.getBoundingClientRect();
  const scroller = horizontalScroller(element);
  if (scroller) {
    const box = scroller.getBoundingClientRect();
    const dx = axisScrollDelta(
      { start: pill.left, end: pill.right },
      { start: box.left + (corner?.width ?? 0), end: box.right },
      { context: grid ? dayExtent(grid, dateISO) : null },
    );
    if (Math.abs(dx) >= 1) {
      scroller.scrollBy({ left: dx, behavior: "smooth" });
      scrolled.push(scroller);
    }
  }
  const dy = axisScrollDelta(
    { start: pill.top, end: pill.bottom },
    { start: 0, end: window.innerHeight },
    { context: corner ? { start: corner.top, end: corner.bottom } : null, fallback: "center" },
  );
  if (Math.abs(dy) >= 1) {
    window.scrollBy({ top: dy, behavior: "smooth" });
    scrolled.push(window);
  }
  return scrolled;
}

/** Runs `done` once every target's smooth scroll has ended (bounded wait). */
function afterScroll(targets: EventTarget[], done: () => void): void {
  if (targets.length === 0) {
    done();
    return;
  }
  let pending = targets.length;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    targets.forEach((target) => target.removeEventListener("scrollend", onEnd));
    window.clearTimeout(timer);
    done();
  };
  const onEnd = () => {
    pending -= 1;
    if (pending <= 0) finish();
  };
  const supportsScrollEnd = "onscrollend" in window;
  if (supportsScrollEnd) targets.forEach((target) => target.addEventListener("scrollend", onEnd));
  const timer = window.setTimeout(finish, supportsScrollEnd ? SCROLL_SETTLE_MAX_MS : SCROLL_SETTLE_MS);
}

function pulse(element: HTMLElement): void {
  // jsdom and old browsers lack the Web Animations API: scrolling suffices.
  if (typeof element.animate !== "function") return;
  const ring = document.documentElement.classList.contains("dark") ? "248 250 252" : "15 23 42";
  // From just outside the own-pill outline (offset 1 + width 2) outwards,
  // fading; above the neighbouring pills while it rings (hover uses z 600).
  // Animated, not set inline, so the pill's style attribute stays untouched.
  element.animate(
    [
      { boxShadow: `0 0 0 3px rgb(${ring} / 0.55)`, zIndex: 650 },
      { boxShadow: `0 0 0 12px rgb(${ring} / 0)`, zIndex: 650 },
    ],
    { duration: PULSE_MS, iterations: PULSE_COUNT, easing: "ease-out" },
  );
}

/** "Fri 16 Oct" next to the pill while the day header row is off screen. */
function showDayTag(element: HTMLElement, dateISO: string): void {
  const header = element.closest("[data-schedule-grid]")?.firstElementChild?.getBoundingClientRect();
  if (!header || (header.bottom > 0 && header.top < window.innerHeight)) return;
  const [year, month, day] = dateISO.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const rect = element.getBoundingClientRect();
  const below = rect.top < 40;
  const tag = document.createElement("div");
  tag.setAttribute("aria-hidden", "true");
  tag.textContent = `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
  tag.className = [
    "pointer-events-none absolute z-[700] -translate-x-1/2 whitespace-nowrap rounded-md px-2 py-0.5",
    "text-[11px] font-semibold leading-4 shadow-md transition-opacity duration-300",
    "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900",
    below ? "" : "-translate-y-full",
  ].join(" ");
  tag.style.left = `${rect.left + rect.width / 2 + window.scrollX}px`;
  tag.style.top = `${(below ? rect.bottom + 6 : rect.top - 6) + window.scrollY}px`;
  document.body.appendChild(tag);
  window.setTimeout(() => {
    tag.style.opacity = "0";
    window.setTimeout(() => tag.remove(), 300);
  }, PULSE_MS * PULSE_COUNT);
}

export function scrollToTeamAssignment(target: TeamPlanTarget, maxWaitMs = 1500): void {
  const key = `${target.rowId}__${target.dateISO}__${target.clinicianId}`;
  const pillSelector = `[data-assignment-key="${CSS.escape(key)}"]`;
  const cellSelector = `[data-schedule-cell="true"][data-row-id="${CSS.escape(target.rowId)}"][data-date-iso="${target.dateISO}"]`;
  const startedAt = performance.now();
  const tick = () => {
    const element =
      document.querySelector<HTMLElement>(pillSelector) ??
      document.querySelector<HTMLElement>(cellSelector);
    if (element) {
      afterScroll(scrollIntoContext(element, target.dateISO), () => {
        pulse(element);
        showDayTag(element, target.dateISO);
      });
      return;
    }
    if (performance.now() - startedAt > maxWaitMs) return;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
