import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "../../lib/classNames";
import { LOCATION_COLOR_OPTIONS } from "../../lib/colorPalette";

// Location color picker of the weekly template (plan §1.1, v1.71): "Auto"
// plus the presets, each shown in its chip tone with an ink border and named
// (the grounds themselves are too pale to tell apart). "Auto" stores no
// color: the team grid then gives the location the next automatic color in
// location order (lib/locationColors), shown here with a dashed ring. Opens
// directly under the trigger; Escape, an outside click or scrolling closes it.

type PickerOption = { id: string; label: string; color: string | null; chip?: string; ink?: string };

const PRESETS: PickerOption[] = LOCATION_COLOR_OPTIONS.map((option) => ({
  id: option.id,
  label: option.id.charAt(0).toUpperCase() + option.id.slice(1),
  color: option.color,
  chip: option.chip,
  ink: option.ink,
}));

/** Panel width (6 columns of 44 px, gaps, padding, border) for keeping it on screen. */
const PANEL_WIDTH = 304;

function Swatch({ chip, ink, size, auto = false }: { chip?: string; ink?: string; size: string; auto?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "rounded-full",
        size,
        !chip && "border border-dashed border-slate-400 bg-white dark:border-slate-500 dark:bg-slate-900",
        // Auto: the automatic color inside a dashed ring (not chosen, may change).
        auto && chip && "outline-dashed outline-1 outline-offset-2 outline-slate-500 dark:outline-slate-400",
      )}
      style={chip ? { backgroundColor: chip, border: `1px solid ${ink}` } : undefined}
    />
  );
}

type LocationColorPickerProps = {
  value: string | null;
  onChange: (color: string | null) => void;
  /** Accessible name of the trigger ("Location color for MRT"). */
  label: string;
  /**
   * Ground of the color the location gets on "Auto" (lib/locationColors),
   * shown on the Auto option and on the trigger while no color is chosen.
   */
  autoColor?: string | null;
};

export default function LocationColorPicker({ value, onChange, label, autoColor = null }: LocationColorPickerProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const autoPreset = PRESETS.find((option) => option.color === (autoColor?.toUpperCase() ?? null));
  const autoOption: PickerOption = {
    id: "auto",
    label: "Auto",
    color: null,
    chip: autoPreset?.chip,
    ink: autoPreset?.ink,
  };
  const options = [autoOption, ...PRESETS];
  const chosen = value ? PRESETS.find((option) => option.color === value.toUpperCase()) : undefined;
  const current = value ? chosen : autoOption;
  // "Auto (Blue)" names the automatic color; a custom stored color its hex.
  const currentLabel = value
    ? chosen?.label ?? value
    : autoPreset
      ? `Auto (${autoPreset.label})`
      : "Auto";

  // Fixed below the trigger: the template grid scrolls and clips overflow.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPosition({
      top: rect.bottom + 4,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8)),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        aria-label={`${label}: ${currentLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Location color: ${currentLabel}`}
        onClick={() => setOpen((prev) => !prev)}
        className="grid h-6 w-6 place-items-center rounded-full border border-slate-400 bg-white shadow-sm dark:border-slate-500 dark:bg-slate-900"
      >
        <Swatch
          chip={current?.chip ?? value ?? undefined}
          ink={current?.ink ?? "#475569"}
          size="h-3.5 w-3.5"
          auto={!value}
        />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={label}
          className="fixed z-50 rounded-xl border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900"
          style={position ? { top: position.top, left: position.left } : { visibility: "hidden" }}
        >
          <div className="grid grid-cols-6 gap-1">
            {options.map((option) => {
              const selected = option.id === (value ? chosen?.id : "auto");
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={selected}
                  title={
                    option.id === "auto"
                      ? `Automatic color by location order${autoPreset ? ` (now ${autoPreset.label})` : ""}`
                      : option.label
                  }
                  onClick={() => {
                    onChange(option.color);
                    setOpen(false);
                    buttonRef.current?.focus();
                  }}
                  className={cx(
                    "flex w-11 flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-[10px] font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800",
                    selected && "bg-slate-100 ring-2 ring-inset ring-slate-900 dark:bg-slate-800 dark:ring-white",
                  )}
                >
                  <Swatch chip={option.chip} ink={option.ink} size="h-6 w-6" auto={option.id === "auto"} />
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
