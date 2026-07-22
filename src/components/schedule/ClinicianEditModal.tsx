import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import type { PreferredWorkingTimes } from "../../api/client";
import { buttonPrimary } from "../../lib/buttonStyles";
import { cx } from "../../lib/classNames";
import ClinicianEditor from "./ClinicianEditor";

type ClinicianEditModalProps = {
  open: boolean;
  onClose: () => void;
  clinician: {
    id: string;
    name: string;
    qualifiedClassIds: string[];
    vacations: Array<{ id: string; startISO: string; endISO: string }>;
    preferredWorkingTimes?: PreferredWorkingTimes;
    workingHoursPerWeek?: number;
    workingHoursToleranceHours?: number;
    planningWishes?: string;
  } | null;
  classRows: Array<{ id: string; name: string }>;
  onToggleQualification: (clinicianId: string, classId: string) => void;
  onReorderQualification: (
    clinicianId: string,
    fromClassId: string,
    toClassId: string,
  ) => void;
  onUpdateWorkingHours: (clinicianId: string, workingHoursPerWeek?: number) => void;
  onUpdateWorkingHoursTolerance: (clinicianId: string, toleranceHours?: number) => void;
  onUpdatePlanningWishes: (clinicianId: string, planningWishes?: string) => void;
  onUpdatePreferredWorkingTimes: (
    clinicianId: string,
    preferredWorkingTimes: PreferredWorkingTimes,
  ) => void;
  onAddVacation: (clinicianId: string) => void;
  onUpdateVacation: (
    clinicianId: string,
    vacationId: string,
    updates: { startISO?: string; endISO?: string },
  ) => void;
  onRemoveVacation: (clinicianId: string, vacationId: string) => void;
  onUpdateName: (clinicianId: string, name: string) => void;
  initialSection?: "vacations";
  vacationOnly?: boolean;
};

export default function ClinicianEditModal({
  open,
  onClose,
  clinician,
  classRows,
  onToggleQualification,
  onReorderQualification,
  onUpdateWorkingHours,
  onUpdateWorkingHoursTolerance,
  onUpdatePlanningWishes,
  onUpdatePreferredWorkingTimes,
  onAddVacation,
  onUpdateVacation,
  onRemoveVacation,
  onUpdateName,
  initialSection,
  vacationOnly = false,
}: ClinicianEditModalProps) {
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (clinician) {
      setNameValue(clinician.name);
    }
  }, [clinician?.id, clinician?.name]);

  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [isEditingName]);

  const handleSaveName = () => {
    const trimmed = nameValue.trim();
    if (trimmed && clinician && trimmed !== clinician.name) {
      onUpdateName(clinician.id, trimmed);
    }
    setIsEditingName(false);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSaveName();
    } else if (e.key === "Escape") {
      setNameValue(clinician?.name ?? "");
      setIsEditingName(false);
    }
  };

  if (!open || !clinician) return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-slate-900/30 backdrop-blur-[1px] dark:bg-slate-950/50"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="relative mx-auto mt-24 w-full max-w-2xl px-6">
        <div className="flex max-h-[80vh] flex-col rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5 dark:border-slate-800">
            <div>
              <div className="flex items-center gap-2">
                {isEditingName ? (
                  <input
                    ref={nameInputRef}
                    type="text"
                    value={nameValue}
                    onChange={(e) => setNameValue(e.target.value)}
                    onBlur={handleSaveName}
                    onKeyDown={handleNameKeyDown}
                    className={cx(
                      "rounded-lg border border-slate-300 px-2 py-1 text-lg font-semibold tracking-tight text-slate-900",
                      "focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400",
                      "dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100",
                    )}
                  />
                ) : (
                  <>
                    <span className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                      {clinician.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => setIsEditingName(true)}
                      className={cx(
                        "rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600",
                        "dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-300",
                      )}
                      aria-label="Edit name"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className="h-4 w-4"
                      >
                        <path d="M2.695 14.763l-1.262 3.154a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
              <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                {vacationOnly ? "Update vacations." : "Update eligible sections and vacations."}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className={buttonPrimary.base}
            >
              Close
            </button>
          </div>
          <div className="min-h-0 overflow-y-auto px-6 py-5">
            <ClinicianEditor
              clinician={clinician}
              classRows={classRows}
              initialSection={initialSection}
              vacationOnly={vacationOnly}
              onUpdateWorkingHours={onUpdateWorkingHours}
              onUpdateWorkingHoursTolerance={onUpdateWorkingHoursTolerance}
              onUpdatePlanningWishes={onUpdatePlanningWishes}
              onUpdatePreferredWorkingTimes={onUpdatePreferredWorkingTimes}
              onToggleQualification={onToggleQualification}
              onReorderQualification={onReorderQualification}
              onAddVacation={onAddVacation}
              onUpdateVacation={onUpdateVacation}
              onRemoveVacation={onRemoveVacation}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
