import type { ReactNode } from "react";

// Layout of the My-plan card header (SPEC C2 / C4). Desktop: row 1 "who"
// (scope switch + person chevron, Next up | extras, star, views), row 2
// "when & how" (navigator | range, orientation). Phone: scope row, navigator,
// range + compact orientation, then Next up full width.

type PlanHeaderProps = {
  isMobile: boolean;
  scopeSwitch: ReactNode;
  personPicker?: ReactNode;
  nextUp?: ReactNode;
  /** Page-provided controls (e.g. snapshot/publish), right of row 1. */
  extras?: ReactNode;
  star: ReactNode;
  views: ReactNode;
  navigator: ReactNode;
  rangeSwitch: ReactNode;
  orientationSwitch: ReactNode;
};

export default function PlanHeader({
  isMobile,
  scopeSwitch,
  personPicker,
  nextUp,
  extras,
  star,
  views,
  navigator,
  rangeSwitch,
  orientationSwitch,
}: PlanHeaderProps) {
  if (isMobile) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            {scopeSwitch}
            {personPicker}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {extras}
            {star}
            {views}
          </div>
        </div>
        {navigator}
        <div className="flex items-center gap-2">
          {rangeSwitch}
          {orientationSwitch}
        </div>
        {nextUp}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex shrink-0 items-center gap-1">
            {scopeSwitch}
            {personPicker}
          </div>
          {nextUp ? <div className="flex min-w-0 max-w-full">{nextUp}</div> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {extras}
          {star}
          {views}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {navigator}
        <div className="flex flex-wrap items-center gap-4">
          {rangeSwitch}
          {orientationSwitch}
        </div>
      </div>
    </div>
  );
}

type ViewingBannerProps = { name: string; onBack: () => void };

/** Thin strip under the header while another person's plan is shown (plan §2.2). */
export function ViewingBanner({ name, onBack }: ViewingBannerProps) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-sky-200 bg-sky-50 px-4 py-2 text-[13px] text-sky-900 sm:px-6 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-100"
    >
      <span>
        You are viewing the plan of <strong className="font-semibold">{name}</strong>
      </span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        onClick={onBack}
        className="font-semibold underline underline-offset-2 hover:no-underline"
      >
        Back to my plan
      </button>
    </div>
  );
}
