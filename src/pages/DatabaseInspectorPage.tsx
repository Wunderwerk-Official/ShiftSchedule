import { useState, useEffect, useMemo } from "react";
import {
  inspectWeek,
  type WeeklyInspectionResult,
  type SlotInspection,
} from "../api/client";
import { cx } from "../lib/classNames";
import { toISODate } from "../lib/date";

type DatabaseInspectorPageProps = {
  theme: "light" | "dark";
  onBack: () => void;
};

function formatDate(dateISO: string): string {
  const [year, month, day] = dateISO.split("-");
  return `${day}.${month}.${year}`;
}

function getWeekStart(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  // Serialize the LOCAL date; toISOString converts to UTC and yields a
  // non-Monday whenever local time crosses the UTC date boundary.
  return toISODate(d);
}

function addWeeks(dateISO: string, weeks: number): string {
  // Parse as local midnight so the local setDate arithmetic below cannot
  // drift a day across DST transitions (bare YYYY-MM-DD parses as UTC).
  const d = new Date(`${dateISO}T00:00:00`);
  d.setDate(d.getDate() + weeks * 7);
  return toISODate(d);
}

type GroupedSlots = {
  [dateISO: string]: {
    [locationName: string]: {
      [sectionName: string]: SlotInspection[];
    };
  };
};

export default function DatabaseInspectorPage({
  theme,
  onBack,
}: DatabaseInspectorPageProps) {
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
  const [result, setResult] = useState<WeeklyInspectionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOnlyOpen, setShowOnlyOpen] = useState(false);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await inspectWeek(weekStart);
      setResult(data);
      // Expand all days by default
      setExpandedDays(new Set(data.slots.map((s) => s.dateISO)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [weekStart]);

  const toggleDay = (dateISO: string) => {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(dateISO)) {
        next.delete(dateISO);
      } else {
        next.add(dateISO);
      }
      return next;
    });
  };

  const expandAll = () => {
    if (result) {
      setExpandedDays(new Set(result.slots.map((s) => s.dateISO)));
    }
  };

  const collapseAll = () => {
    setExpandedDays(new Set());
  };

  // Group slots by date -> location -> section
  const groupedSlots = useMemo(() => {
    if (!result) return {};
    const filtered = showOnlyOpen
      ? result.slots.filter((s) => s.status === "open")
      : result.slots;

    const grouped: GroupedSlots = {};
    for (const slot of filtered) {
      if (!grouped[slot.dateISO]) {
        grouped[slot.dateISO] = {};
      }
      if (!grouped[slot.dateISO][slot.locationName]) {
        grouped[slot.dateISO][slot.locationName] = {};
      }
      const sectionKey = slot.sectionName || "Unknown Section";
      if (!grouped[slot.dateISO][slot.locationName][sectionKey]) {
        grouped[slot.dateISO][slot.locationName][sectionKey] = [];
      }
      grouped[slot.dateISO][slot.locationName][sectionKey].push(slot);
    }
    return grouped;
  }, [result, showOnlyOpen]);

  const dates = useMemo(() => {
    if (!result) return [];
    const uniqueDates = [...new Set(result.slots.map((s) => s.dateISO))];
    return uniqueDates.sort();
  }, [result]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white px-6 py-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto max-w-7xl">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={onBack}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Back
              </button>
              <div>
                <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Database Inspector
                </h1>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  View slots and assignments directly from the database
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {/* Week navigation */}
              <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-800">
                <button
                  type="button"
                  onClick={() => setWeekStart(addWeeks(weekStart, -1))}
                  className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                >
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <span className="min-w-[180px] text-center text-sm font-medium text-slate-700 dark:text-slate-200">
                  {result
                    ? `${formatDate(result.weekStartISO)} - ${formatDate(result.weekEndISO)}`
                    : "Loading..."}
                </span>
                <button
                  type="button"
                  onClick={() => setWeekStart(addWeeks(weekStart, 1))}
                  className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                >
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
              <button
                type="button"
                onClick={() => setWeekStart(getWeekStart(new Date()))}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Today
              </button>
              <button
                type="button"
                onClick={loadData}
                disabled={loading}
                className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
              >
                {loading ? "Loading..." : "Refresh"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="mx-auto max-w-7xl px-6 py-6">
        {error && (
          <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
            {error}
          </div>
        )}

        {result && (
          <>
            {/* Stats */}
            <div className="mb-6 grid grid-cols-4 gap-4">
              <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
                <div className="text-2xl font-bold text-slate-900 dark:text-slate-100">
                  {result.stats.totalSlots}
                </div>
                <div className="text-sm text-slate-500 dark:text-slate-400">Total Slots</div>
              </div>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-900/20">
                <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">
                  {result.stats.assignedSlots}
                </div>
                <div className="text-sm text-emerald-600 dark:text-emerald-400">Assigned</div>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
                <div className="text-2xl font-bold text-amber-700 dark:text-amber-300">
                  {result.stats.openSlots}
                </div>
                <div className="text-sm text-amber-600 dark:text-amber-400">Open</div>
              </div>
              <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-900/20">
                <div className="text-2xl font-bold text-indigo-700 dark:text-indigo-300">
                  {result.stats.poolAssignments}
                </div>
                <div className="text-sm text-indigo-600 dark:text-indigo-400">Pool Assigns</div>
              </div>
            </div>

            {/* Controls */}
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={showOnlyOpen}
                    onChange={(e) => setShowOnlyOpen(e.target.checked)}
                    className="rounded border-slate-300 text-sky-500 focus:ring-sky-500 dark:border-slate-600"
                  />
                  <span className="text-slate-700 dark:text-slate-300">Show only open slots</span>
                </label>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={expandAll}
                  className="text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                >
                  Expand All
                </button>
                <span className="text-slate-300 dark:text-slate-600">|</span>
                <button
                  type="button"
                  onClick={collapseAll}
                  className="text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                >
                  Collapse All
                </button>
              </div>
            </div>

            {/* Slots by day */}
            <div className="space-y-4">
              {dates.map((dateISO) => {
                const daySlots = result.slots.filter((s) => s.dateISO === dateISO);
                const dayOfWeek = daySlots[0]?.dayOfWeek || "";
                const isExpanded = expandedDays.has(dateISO);
                const openCount = daySlots.filter((s) => s.status === "open").length;
                const assignedCount = daySlots.filter((s) => s.status === "assigned").length;

                return (
                  <div
                    key={dateISO}
                    className="rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800"
                  >
                    <button
                      type="button"
                      onClick={() => toggleDay(dateISO)}
                      className="flex w-full items-center justify-between px-4 py-3 text-left"
                    >
                      <div className="flex items-center gap-3">
                        <svg
                          className={cx(
                            "h-5 w-5 text-slate-400 transition-transform",
                            isExpanded && "rotate-90"
                          )}
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                        <span className="font-medium text-slate-900 dark:text-slate-100">
                          {dayOfWeek}, {formatDate(dateISO)}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-sm">
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {assignedCount} assigned
                        </span>
                        <span className="text-amber-600 dark:text-amber-400">
                          {openCount} open
                        </span>
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-700">
                        {Object.entries(groupedSlots[dateISO] || {}).map(
                          ([locationName, sections]) => (
                            <div key={locationName} className="mb-4 last:mb-0">
                              <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
                                {locationName}
                              </div>
                              {Object.entries(sections).map(([sectionName, slots]) => (
                                <div key={sectionName} className="mb-3 last:mb-0">
                                  <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                                    {sectionName}
                                  </div>
                                  <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-600">
                                    <table className="w-full text-sm">
                                      <thead>
                                        <tr className="bg-slate-50 dark:bg-slate-700">
                                          <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400">
                                            Time
                                          </th>
                                          <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400">
                                            Row
                                          </th>
                                          <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400">
                                            Column
                                          </th>
                                          <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400">
                                            Status
                                          </th>
                                          <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400">
                                            Assigned To
                                          </th>
                                          <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400">
                                            Source
                                          </th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-slate-200 dark:divide-slate-600">
                                        {slots.map((slot) => (
                                          <tr
                                            key={slot.slotId}
                                            className={cx(
                                              slot.status === "open"
                                                ? "bg-amber-50/50 dark:bg-amber-900/10"
                                                : "bg-white dark:bg-slate-800"
                                            )}
                                          >
                                            <td className="whitespace-nowrap px-3 py-2 text-slate-700 dark:text-slate-300">
                                              {slot.startTime && slot.endTime
                                                ? `${slot.startTime} - ${slot.endTime}`
                                                : "-"}
                                            </td>
                                            <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                                              {slot.rowBandLabel || "-"}
                                            </td>
                                            <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                                              {slot.colBandLabel || "-"}
                                            </td>
                                            <td className="px-3 py-2">
                                              <span
                                                className={cx(
                                                  "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
                                                  slot.status === "assigned"
                                                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                                                    : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                                                )}
                                              >
                                                {slot.status}
                                              </span>
                                            </td>
                                            <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                                              {slot.assignments.length > 0
                                                ? slot.assignments
                                                    .map((a) => a.clinicianName)
                                                    .join(", ")
                                                : "-"}
                                            </td>
                                            <td className="px-3 py-2 text-slate-500 dark:text-slate-400">
                                              {slot.assignments.length > 0
                                                ? slot.assignments.map((a) => a.source).join(", ")
                                                : "-"}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Pool assignments */}
            {result.poolAssignments.length > 0 && (
              <div className="mt-6">
                <h2 className="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Pool Assignments (Persisted)
                </h2>
                <div className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-700">
                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400">
                          Date
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400">
                          Pool
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400">
                          Clinician
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400">
                          Source
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-600">
                      {result.poolAssignments.map((pool, idx) =>
                        pool.assignments.map((a, aIdx) => (
                          <tr key={`${idx}-${aIdx}`} className="bg-white dark:bg-slate-800">
                            <td className="whitespace-nowrap px-4 py-3 text-slate-700 dark:text-slate-300">
                              {pool.dayOfWeek}, {formatDate(pool.dateISO)}
                            </td>
                            <td className="px-4 py-3 text-slate-700 dark:text-slate-300">
                              {pool.poolName}
                            </td>
                            <td className="px-4 py-3 text-slate-700 dark:text-slate-300">
                              {a.clinicianName}
                            </td>
                            <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                              {a.source}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {loading && !result && (
          <div className="py-12 text-center text-slate-500 dark:text-slate-400">
            Loading database inspection...
          </div>
        )}
      </div>
    </div>
  );
}
