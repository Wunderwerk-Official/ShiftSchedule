import { cx } from "./classNames";

/**
 * Centralized button styles for consistent UI across the application.
 * Use these classes instead of inline styles to ensure consistency.
 */

// Base disabled styles used by all buttons
const disabledBase = "disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Pill toggle button - used for toggle groups and selection pills
 * Examples: Strategy selection, filter toggles, tab selections
 */
const pillToggle = {
  base: cx(
    "rounded-full border px-3 py-1.5 text-xs font-normal transition-colors",
    disabledBase,
  ),
  active: cx(
    "border-sky-300 bg-sky-50 text-sky-900",
    "dark:border-sky-400/60 dark:bg-sky-900/30 dark:text-sky-100",
  ),
  inactive: cx(
    "border-slate-200 bg-white text-slate-600",
    "hover:bg-slate-50",
    "dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800",
  ),
} as const;

/**
 * Get pill toggle classes based on active state
 */
export function getPillToggleClasses(isActive: boolean): string {
  return cx(pillToggle.base, isActive ? pillToggle.active : pillToggle.inactive);
}

/**
 * Primary action button - used for main actions
 * Examples: "Run automated planning", "Save", "Add"
 */
export const buttonPrimary = {
  base: cx(
    "rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-normal text-slate-900 shadow-sm",
    "hover:bg-slate-50 active:bg-slate-100",
    "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
    disabledBase,
  ),
} as const;

/**
 * Secondary action button - used for secondary actions
 * Examples: "Reset", "Cancel", "Close"
 */
export const buttonSecondary = {
  base: cx(
    "rounded-xl border border-slate-200 px-4 py-2 text-sm font-normal text-slate-700",
    "hover:bg-slate-50 active:bg-slate-100",
    "dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800",
    disabledBase,
  ),
} as const;

/**
 * Small action button - used for inline actions
 * Examples: "Edit", "Remove" buttons in lists
 */
export const buttonSmall = {
  base: cx(
    "rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600",
    "hover:bg-slate-50 hover:text-slate-900",
    "dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100",
    disabledBase,
  ),
} as const;

/**
 * Danger button variant - used for destructive actions
 * Examples: "Delete", "Remove" with warning intent
 */
export const buttonDanger = {
  base: cx(
    "rounded-xl border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-600",
    "hover:bg-rose-50 hover:text-rose-700",
    "dark:border-rose-500/40 dark:text-rose-400 dark:hover:bg-rose-900/20 dark:hover:text-rose-300",
    disabledBase,
  ),
} as const;

/**
 * Icon button - small circular buttons for icons
 * Examples: Navigation arrows, close buttons
 */
/**
 * Add/Create button - dashed border for adding new items
 * Examples: "Add Person", "Add Holiday"
 */
export const buttonAdd = {
  base: cx(
    "w-full rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700",
    "hover:bg-slate-50 active:bg-slate-100",
    "dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800",
    disabledBase,
  ),
} as const;

/**
 * Badge/Label pill - non-interactive label pills
 * Examples: Panel headers, section labels
 */
export const pillLabel = {
  base: cx(
    "rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm font-normal text-slate-600 shadow-sm",
    "dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200",
  ),
} as const;
