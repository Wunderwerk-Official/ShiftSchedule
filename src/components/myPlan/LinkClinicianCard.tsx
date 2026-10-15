import { useId, useMemo, useState } from "react";
import type { Clinician } from "../../api/client";
import { solidButtonClass } from "./planChrome";

// Shown instead of the plan while the account is not linked to a person
// (plan §2.2): "Who are you in the plan?" + clinician select + "That's me".

type LinkClinicianCardProps = {
  clinicians: Clinician[];
  onLink: (clinicianId: string) => void;
  /** The stored id pointed to a person that no longer exists. */
  staleLink?: boolean;
};

export default function LinkClinicianCard({ clinicians, onLink, staleLink = false }: LinkClinicianCardProps) {
  const [selected, setSelected] = useState("");
  const selectId = useId();
  const sorted = useMemo(
    () => [...clinicians].sort((a, b) => a.name.localeCompare(b.name)),
    [clinicians],
  );

  return (
    <div className="flex justify-center px-4 py-10 sm:py-16">
      <form
        className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900"
        onSubmit={(event) => {
          event.preventDefault();
          if (selected) onLink(selected);
        }}
      >
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Who are you in the plan?
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {staleLink
              ? "The person linked to your account is no longer in the plan. Choose yourself again to see your shifts."
              : "Link your account to your person in the plan to see your own shifts, hours and next duty. You can change this later."}
          </p>
        </div>
        {sorted.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            There are no people in the plan yet. Add people in the settings first.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <label htmlFor={selectId} className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                I am
              </label>
              <select
                id={selectId}
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
                className="h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
              >
                <option value="">Choose a person…</option>
                {sorted.map((clinician) => (
                  <option key={clinician.id} value={clinician.id}>
                    {clinician.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end">
              <button type="submit" disabled={!selected} className={solidButtonClass}>
                That's me
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
