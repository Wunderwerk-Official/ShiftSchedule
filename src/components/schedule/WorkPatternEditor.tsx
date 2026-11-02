import type { WorkPattern } from "../../api/client";
import { normalizeWorkPattern } from "../../lib/clinicianPreferences";

const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export default function WorkPatternEditor({ value, onChange, contractHours }: {
  value?: WorkPattern;
  contractHours?: number;
  onChange: (value?: WorkPattern) => void;
}) {
  const update = (patch: Partial<WorkPattern>) => onChange(normalizeWorkPattern({ ...value, ...patch }));
  return (
    <fieldset className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm dark:border-slate-700 dark:bg-slate-900">
      <legend className="px-2 font-semibold">Preferred work pattern (optional)</legend>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        Soft targets for AI planning, not limits. Day length counts in both planning goals; workdays
        per week, long days and days off only in Balanced.
      </p>
      <div className="flex flex-wrap gap-4">
        {([
          ["daysPerWeek", "Workdays per week", 7, 1, "Also sets day length: contract ÷ days."],
          ["dailyHours", "Hours per working day", 24, 1, "Overrides contract ÷ days."],
          ["dailyHoursTolerance", "Daily hours tolerance (±)", 24, 0,
            "A day counts as short or long outside target ± this. Empty: short below half the target, long above target + 1 h."],
        ] as const).map(([field, label, max, min, helper]) => (
          // The helper sits outside the <label> so the label text stays the accessible name.
          <div key={field} className="flex w-44 flex-col gap-1">
            <label className="flex flex-col gap-1">
              {label}
              <input type="number" min={min} max={max} step={0.5}
                value={value?.[field] ?? ""} placeholder="Automatic"
                onChange={event => update({ [field]: event.target.value === "" ? undefined : Number(event.target.value) })}
                className="w-36 rounded-lg border border-slate-200 bg-transparent px-2 py-1 dark:border-slate-700" />
            </label>
            <p className="text-xs text-slate-500 dark:text-slate-400">{helper}</p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">Night shifts count as one workday on their start date. Locked shifts count toward hours and days.</p>
      {value?.daysPerWeek && value.dailyHours && contractHours && Math.abs(value.daysPerWeek * value.dailyHours - contractHours) >= 1 ? (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          This pattern totals {value.daysPerWeek * value.dailyHours} h/week; the contract is {contractHours} h/week.
          Consider adjusting the pattern. Locked shifts also count toward the weekly total.
        </p>
      ) : null}
      <div className="mt-3">Preferred days off</div>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Soft wish: the Balanced planning goal counts it; Classic passes it to the AI as a hint.
      </p>
      <div className="mt-2 flex flex-wrap gap-3">
        {days.map(day => (
          <label key={day} className="flex items-center gap-1">
            <input type="checkbox" checked={value?.preferredDaysOff?.includes(day) ?? false}
              onChange={event => update({ preferredDaysOff: event.target.checked
                ? [...(value?.preferredDaysOff ?? []), day]
                : value?.preferredDaysOff?.filter(item => item !== day) })} />
            {day[0].toUpperCase() + day.slice(1)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
