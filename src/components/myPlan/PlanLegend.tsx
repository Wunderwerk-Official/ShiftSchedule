import { Fragment, type CSSProperties } from "react";
import { cx } from "../../lib/classNames";
import { deriveDarkBlockColors } from "../../lib/myPlan";
import { restBandStyle, vacationBandStyle } from "./absenceStyles";
import type { LegendItem, LegendSwatch } from "./legend";
import PlanIcon from "./PlanIcons";
import { DUTY_COLORS_DARK } from "./viewParts";

// Legend strip of the footer (SPEC C5.14): swatch + label per visible kind,
// groups separated by a thin divider. Colors come from the library (hex).

const HOLIDAY = { light: { fill: "#F3E8FF", border: "#6B21A8" }, dark: { fill: "#2E1F47", border: "#E9D5FF" } };

function swatchStyle(swatch: LegendSwatch, isDark: boolean): CSSProperties {
  switch (swatch.kind) {
    case "block": {
      const { fill, border } = !isDark
        ? swatch
        : swatch.duty
          ? DUTY_COLORS_DARK
          : deriveDarkBlockColors(swatch.fill);
      return { backgroundColor: fill, border: `1px solid ${border}` };
    }
    case "vacation":
      return vacationBandStyle(isDark);
    case "rest":
      return restBandStyle(isDark);
    case "location": {
      // Light: pale ground, dark ink border. Dark (SPEC B7): the deep chip
      // (the deep ground alone is too close to the card), light ink border.
      const { dark } = swatch.tint;
      return isDark
        ? { backgroundColor: dark.chip, border: `1px solid ${dark.ink}` }
        : { backgroundColor: swatch.tint.ground, border: `1px solid ${swatch.tint.ink}` };
    }
    case "holiday": {
      const colors = isDark ? HOLIDAY.dark : HOLIDAY.light;
      return { backgroundColor: colors.fill, border: `1px solid ${colors.border}` };
    }
  }
}

type PlanLegendProps = {
  items: LegendItem[];
  isDark: boolean;
  className?: string;
};

export default function PlanLegend({ items, isDark, className }: PlanLegendProps) {
  if (items.length === 0) return null;
  return (
    <div role="list" aria-label="Legend" className={cx("flex flex-wrap items-center gap-x-3 gap-y-1", className)}>
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {index > 0 && items[index - 1].group !== item.group ? (
            <span aria-hidden="true" className="h-4 w-px bg-slate-200 dark:bg-slate-700" />
          ) : null}
          <span
            role="listitem"
            className="inline-flex h-6 items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300"
            title={item.group === "location" ? `Location: ${item.label}` : undefined}
          >
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-3.5 shrink-0 rounded-[3px]"
              style={swatchStyle(item.swatch, isDark)}
            />
            {/* A location may share its name with a section ("MRT"): the pin tells them apart. */}
            {item.group === "location" ? (
              <>
                <PlanIcon name="pin" size={12} className="-mr-0.5 shrink-0 text-slate-600 dark:text-slate-400" />
                <span className="sr-only">Location: </span>
              </>
            ) : null}
            {item.label}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
