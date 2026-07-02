import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/classNames";

function InstantTooltip({ children, content }: { children: ReactNode; content: string }) {
  const [show, setShow] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLSpanElement>(null);

  const handleMouseEnter = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPosition({
        top: rect.top - 4,
        left: rect.left + rect.width / 2,
      });
    }
    setShow(true);
  };

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setShow(false)}
      >
        {children}
      </span>
      {show &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[200] -translate-x-1/2 -translate-y-full rounded bg-slate-800 px-2 py-1 text-xs text-white shadow-lg dark:bg-slate-700"
            style={{ top: position.top, left: position.left }}
          >
            {content}
            <div className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-slate-800 dark:border-t-slate-700" />
          </div>,
          document.body
        )}
    </>
  );
}

export type ClinicianOption = {
  id: string;
  name: string;
  isQualified: boolean;
  isOnVacation: boolean;
  isOnRestDay: boolean;
  hasTimeConflict: boolean;
  hasLocationConflict: boolean;
  alreadyAssigned: boolean;
};

type ClinicianPickerPopoverProps = {
  open: boolean;
  onClose: () => void;
  onSelect: (clinicianId: string) => void;
  clinicians: ClinicianOption[];
  anchorRect: DOMRect | null;
  rowName: string;
  dateLabel: string;
};

export default function ClinicianPickerPopover({
  open,
  onClose,
  onSelect,
  clinicians,
  anchorRect,
  rowName,
  dateLabel,
}: ClinicianPickerPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [popoverHeight, setPopoverHeight] = useState(0);

  useEffect(() => {
    if (!open) {
      setSearchQuery("");
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    const timeoutId = setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearTimeout(timeoutId);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, onClose]);

  // Measure popover height after render
  useEffect(() => {
    if (open && popoverRef.current) {
      setPopoverHeight(popoverRef.current.offsetHeight);
    }
  }, [open, clinicians.length, searchQuery]);

  if (!open || !anchorRect) return null;

  const filteredClinicians = clinicians.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Sort: eligible first, then by name
  const sortedClinicians = [...filteredClinicians].sort((a, b) => {
    const aEligible = a.isQualified && !a.isOnVacation && !a.isOnRestDay && !a.hasTimeConflict && !a.hasLocationConflict && !a.alreadyAssigned;
    const bEligible = b.isQualified && !b.isOnVacation && !b.isOnRestDay && !b.hasTimeConflict && !b.hasLocationConflict && !b.alreadyAssigned;
    if (aEligible && !bEligible) return -1;
    if (!aEligible && bEligible) return 1;
    return a.name.localeCompare(b.name);
  });

  // Calculate available space below and above the anchor
  const viewportHeight = window.innerHeight;
  const spaceBelow = viewportHeight - anchorRect.bottom - 8;
  const spaceAbove = anchorRect.top - 8;
  const estimatedHeight = Math.min(400, popoverHeight || 350);

  // Position above if not enough space below but enough above
  const openAbove = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;

  let top: number;
  let maxHeight: number;

  if (openAbove) {
    // Position above the anchor
    maxHeight = Math.min(400, spaceAbove);
    top = anchorRect.top - 4 - Math.min(estimatedHeight, maxHeight);
  } else {
    // Position below the anchor
    maxHeight = Math.min(400, spaceBelow);
    top = anchorRect.bottom + 4;
  }

  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - 288 - 8));

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed z-[100] flex w-72 flex-col rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
      style={{ top, left, maxHeight }}
    >
      <div className="flex-shrink-0 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
        <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
          {rowName}
        </div>
        <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
          {dateLabel}
        </div>
      </div>
      <div className="flex-shrink-0 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
        <input
          ref={inputRef}
          type="text"
          placeholder="Search clinicians..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-700 placeholder-slate-400 focus:border-slate-400 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:placeholder-slate-500"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {sortedClinicians.length === 0 ? (
          <div className="px-3 py-4 text-center text-sm text-slate-400 dark:text-slate-500">
            No clinicians found
          </div>
        ) : (
          sortedClinicians.map((clinician) => {
            const isEligible =
              clinician.isQualified &&
              !clinician.isOnVacation &&
              !clinician.isOnRestDay &&
              !clinician.hasTimeConflict &&
              !clinician.hasLocationConflict &&
              !clinician.alreadyAssigned;

            // Build all applicable warnings - order determines display priority
            const warnings: string[] = [];
            if (clinician.alreadyAssigned) warnings.push("Already in slot");
            if (!clinician.isQualified) warnings.push("Not qualified");
            if (clinician.isOnVacation) warnings.push("On vacation");
            if (clinician.isOnRestDay) warnings.push("Rest day");
            if (clinician.hasTimeConflict) warnings.push("Time conflict");
            if (clinician.hasLocationConflict) warnings.push("Different location");

            return (
              <button
                key={clinician.id}
                type="button"
                onClick={() => {
                  onSelect(clinician.id);
                  onClose();
                }}
                className={cx(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                  isEligible
                    ? "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
                    : "text-slate-400 hover:bg-slate-50 dark:text-slate-500 dark:hover:bg-slate-800"
                )}
              >
                <span className="flex-1 truncate">{clinician.name}</span>
                {!isEligible && (
                  <InstantTooltip content={warnings.join(" · ")}>
                    <span className="flex items-center gap-1">
                      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-100 text-[10px] font-bold text-amber-600 dark:bg-amber-900/40 dark:text-amber-400">
                        !
                      </span>
                      <span className="text-xs text-slate-400 dark:text-slate-500">
                        {warnings[0]}
                      </span>
                    </span>
                  </InstantTooltip>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>,
    document.body
  );
}
