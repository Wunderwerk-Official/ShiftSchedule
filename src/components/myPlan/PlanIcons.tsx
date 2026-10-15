import type { ReactNode, SVGProps } from "react";

// The one icon set of "My plan" (SPEC C0): 24×24 viewBox, currentColor,
// stroke 1.75, round caps. Decorative unless `title` or `aria-label` is given.
// Size: `size` (px) or a Tailwind size in `className` (default h-4 w-4).

export type PlanIconName =
  | "users"
  | "star"
  | "bookmark"
  | "moon"
  | "sun"
  | "clock"
  | "pin"
  | "suitcase"
  | "lock"
  | "x"
  | "check"
  | "plus"
  | "monitor"
  | "smartphone"
  | "chevronDown"
  | "chevronLeft"
  | "chevronRight"
  | "calendar"
  | "orientTop"
  | "orientLeft"
  | "search"
  | "rest"
  | "continue"
  | "layers";

const PATHS: Record<PlanIconName, (filled: boolean) => ReactNode> = {
  users: () => (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20v-.5A5.5 5.5 0 0 1 8 14h2a5.5 5.5 0 0 1 5.5 5.5v.5" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a5.5 5.5 0 0 1 3.5 5.3v.5" />
    </>
  ),
  star: (filled) => (
    <path
      fill={filled ? "currentColor" : "none"}
      d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"
    />
  ),
  bookmark: () => <path d="M7 3.5h10a1 1 0 0 1 1 1V21l-6-4-6 4V4.5a1 1 0 0 1 1-1z" />,
  moon: () => <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  sun: () => (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" />
    </>
  ),
  clock: () => (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  pin: () => (
    <>
      <path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
  suitcase: () => (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12.5h18" />
    </>
  ),
  lock: () => (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  x: () => <path d="M6 6l12 12M18 6 6 18" />,
  check: () => <path d="M5 12.5l4.5 4.5L19 7.5" />,
  plus: () => <path d="M12 5v14M5 12h14" />,
  monitor: () => (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  smartphone: () => (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  chevronDown: () => <path d="M6 9l6 6 6-6" />,
  chevronLeft: () => <path d="M15 5l-7 7 7 7" />,
  chevronRight: () => <path d="M9 5l7 7-7 7" />,
  calendar: () => (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  orientTop: () => (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M5.5 4.5h13a2 2 0 0 1 2 2V9h-17V6.5a2 2 0 0 1 2-2z" fill="currentColor" stroke="none" />
      <path d="M9.2 9v10.5M14.8 9v10.5" />
    </>
  ),
  orientLeft: () => (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M5.5 4.5H8.5v15h-3a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z" fill="currentColor" stroke="none" />
      <path d="M8.5 9.5h12M8.5 14.5h12" />
    </>
  ),
  search: () => (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  rest: () => (
    <>
      <path d="M17.5 14.5A6.5 6.5 0 1 1 9.5 6.5a5 5 0 0 0 8 8z" />
      <path d="M15 3h4l-4 4h4" />
    </>
  ),
  /** "↳" continuation of a night that started the day before. */
  continue: () => (
    <>
      <path d="M6 4v7a4 4 0 0 0 4 4h9" />
      <path d="M15 11l4 4-4 4" />
    </>
  ),
  layers: () => (
    <>
      <path d="M12 3 3 8l9 5 9-5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </>
  ),
};

type PlanIconProps = Omit<SVGProps<SVGSVGElement>, "name"> & {
  name: PlanIconName;
  /** Filled variant (star). */
  filled?: boolean;
  /** Width/height in px; without it the size comes from className (default h-4 w-4). */
  size?: number;
  /** Accessible name (renders <title>, role img); otherwise the icon is decorative. */
  title?: string;
};

export default function PlanIcon({ name, filled = false, size, title, className, ...props }: PlanIconProps) {
  const labelled = Boolean(title) || typeof props["aria-label"] === "string";
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={labelled ? undefined : true}
      role={labelled ? "img" : undefined}
      focusable="false"
      className={className ?? (size === undefined ? "h-4 w-4" : undefined)}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name](filled)}
    </svg>
  );
}
