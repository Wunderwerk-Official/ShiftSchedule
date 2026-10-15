import { cx } from "../../lib/classNames";

/** On/off switch of the settings page (role="switch", green when on). */
export default function ToggleSwitch({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  /** Accessible name; the visible heading next to the switch. */
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className={cx(
        "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
        checked ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-700",
      )}
    >
      <span
        className={cx(
          "inline-block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition-transform",
          checked && "translate-x-[22px]",
        )}
      />
    </button>
  );
}
