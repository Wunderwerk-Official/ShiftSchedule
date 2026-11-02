import { useState } from "react";
import { checkDatabaseHealth, type DatabaseHealthCheckResult, type DatabaseHealthIssue } from "../../api/client";
import { cx } from "../../lib/classNames";

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ErrorIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
        clipRule="evenodd"
      />
    </svg>
  );
}

type StatKey = "assignments" | "slots" | "clinicians" | "locations" | "blocks" | "poolAssignments";

const STAT_EXPLANATIONS: Record<StatKey, { title: string; description: string }> = {
  assignments: {
    title: "Total Shifts",
    description: "The total number of shifts in your schedule. Each person placed in a slot on a specific date counts as one shift. This includes both shifts placed by hand and those created by the planner.",
  },
  slots: {
    title: "Template Slots",
    description: "The number of unique slot positions defined in your Weekly Calendar Template. Each slot represents a specific section at a specific time on a specific day type (e.g., 'MRI 08:00-12:00 on Monday'). Slots are reused across all weeks.",
  },
  clinicians: {
    title: "People",
    description: "The total number of people in your system. These are the people who can be planned into shifts.",
  },
  locations: {
    title: "Locations",
    description: "The number of locations (e.g., hospitals, clinics, departments) configured in your template. Each location can have its own set of rows and slots.",
  },
  blocks: {
    title: "Sections",
    description: "The number of sections defined in your template (e.g., MRI, CT, Sonography). Sections define what kinds of shifts exist and can be placed into the template grid.",
  },
  poolAssignments: {
    title: "Rest Day & Vacation entries",
    description: "Rest Day and Vacation entries placed by hand. Automatic rest days and vacation periods are not counted.",
  },
};

function StatCard({
  value,
  label,
  statKey,
  onClick,
}: {
  value: number;
  label: string;
  statKey: StatKey;
  onClick: (key: StatKey) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(statKey)}
      className="rounded-lg p-2 text-center transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
    >
      <div className="text-lg font-semibold text-slate-700 dark:text-slate-200">
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </div>
    </button>
  );
}

function StatExplanationPanel({
  statKey,
  onClose,
  poolDetails,
}: {
  statKey: StatKey;
  onClose: () => void;
  poolDetails?: DatabaseHealthIssue | null;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const explanation = STAT_EXPLANATIONS[statKey];

  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 dark:border-indigo-800 dark:bg-indigo-900/20">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <InfoIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-indigo-500" />
          <div className="flex-1">
            <div className="text-sm font-medium text-indigo-700 dark:text-indigo-300">
              {explanation.title}
            </div>
            <p className="mt-1 text-xs text-indigo-600 dark:text-indigo-400">
              {explanation.description}
            </p>
            {statKey === "poolAssignments" && poolDetails && Object.keys(poolDetails.details).length > 0 && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => setShowDetails(!showDetails)}
                  className="text-xs font-medium text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-200"
                >
                  {showDetails ? "Hide details" : "Show saved entries"}
                </button>
                {showDetails && (
                  <pre className="mt-2 max-h-32 overflow-auto rounded bg-white/50 p-2 text-xs text-slate-700 dark:bg-slate-900/50 dark:text-slate-300">
                    {JSON.stringify(poolDetails.details, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-indigo-400 hover:bg-indigo-100 hover:text-indigo-600 dark:hover:bg-indigo-800 dark:hover:text-indigo-300"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
            <path d="M5.28 4.22a.75.75 0 00-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 101.06 1.06L8 9.06l2.72 2.72a.75.75 0 101.06-1.06L9.06 8l2.72-2.72a.75.75 0 00-1.06-1.06L8 6.94 5.28 4.22z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function IssueCard({ issue }: { issue: DatabaseHealthIssue }) {
  const [expanded, setExpanded] = useState(false);

  const typeLabels: Record<string, string> = {
    orphaned_assignment: "Shifts in deleted slots",
    slot_collision: "Two sections in one cell",
    duplicate_assignment: "Double entries",
    colband_explosion: "Too many columns",
    pool_assignment_info: "Rest Day & Vacation entries",
  };

  const isError = issue.severity === "error";
  const isInfo = issue.severity === "info";

  return (
    <div
      className={cx(
        "rounded-lg border p-3",
        isError
          ? "border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-900/20"
          : isInfo
          ? "border-sky-200 bg-sky-50 dark:border-sky-800 dark:bg-sky-900/20"
          : "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20"
      )}
    >
      <div className="flex items-start gap-2">
        {isError ? (
          <ErrorIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-500" />
        ) : isInfo ? (
          <InfoIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-sky-500" />
        ) : (
          <WarningIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={cx(
                "text-xs font-medium uppercase tracking-wide",
                isError
                  ? "text-rose-600 dark:text-rose-400"
                  : isInfo
                  ? "text-sky-600 dark:text-sky-400"
                  : "text-amber-600 dark:text-amber-400"
              )}
            >
              {typeLabels[issue.type] || issue.type}
            </span>
            <span
              className={cx(
                "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                isError
                  ? "bg-rose-100 text-rose-700 dark:bg-rose-900 dark:text-rose-300"
                  : isInfo
                  ? "bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300"
                  : "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300"
              )}
            >
              {isError ? "Error" : isInfo ? "Info" : "Warning"}
            </span>
          </div>
          <p
            className={cx(
              "mt-1 text-sm",
              isError
                ? "text-rose-700 dark:text-rose-300"
                : isInfo
                ? "text-sky-700 dark:text-sky-300"
                : "text-amber-700 dark:text-amber-300"
            )}
          >
            {issue.message}
          </p>
          {Object.keys(issue.details).length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className={cx(
                "mt-2 text-xs font-medium",
                isError
                  ? "text-rose-600 hover:text-rose-800 dark:text-rose-400 dark:hover:text-rose-200"
                  : isInfo
                  ? "text-sky-600 hover:text-sky-800 dark:text-sky-400 dark:hover:text-sky-200"
                  : "text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-200"
              )}
            >
              {expanded ? "Hide Details" : "Show Details"}
            </button>
          )}
          {expanded && (
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-white/50 p-2 text-xs text-slate-700 dark:bg-slate-900/50 dark:text-slate-300">
              {JSON.stringify(issue.details, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DatabaseHealthCheck() {
  const [result, setResult] = useState<DatabaseHealthCheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedStat, setSelectedStat] = useState<StatKey | null>(null);

  const runHealthCheck = async () => {
    setLoading(true);
    setError(null);
    setSelectedStat(null);
    try {
      const res = await checkDatabaseHealth();
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run health check");
    } finally {
      setLoading(false);
    }
  };

  const handleStatClick = (key: StatKey) => {
    setSelectedStat(selectedStat === key ? null : key);
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Database Health Check
        </h3>
        <button
          type="button"
          onClick={runHealthCheck}
          disabled={loading}
          className={cx(
            "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
            loading
              ? "cursor-not-allowed bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500"
              : "bg-indigo-50 text-indigo-600 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-400 dark:hover:bg-indigo-900/50"
          )}
        >
          {loading ? "Checking..." : "Run check"}
        </button>
      </div>

      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        Read-only: looks for shifts in deleted slots, two sections in one template cell, double
        entries and oversized templates. Click a number for an explanation.
      </p>

      {/* Link to full inspector page */}
      <a
        href="/db-inspector"
        className="mb-3 flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-900/20 dark:text-indigo-300 dark:hover:bg-indigo-900/30"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
        <span className="font-medium">Open Database Inspector</span>
        <span className="text-xs text-indigo-500 dark:text-indigo-400">
          Read-only view of all slots and shifts for any week
        </span>
      </a>

      {error && (
        <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-3">
          {/* Status banner */}
          <div
            className={cx(
              "flex items-center gap-2 rounded-lg p-3",
              result.healthy
                ? "bg-emerald-50 dark:bg-emerald-900/20"
                : "bg-slate-100 dark:bg-slate-800"
            )}
          >
            {result.healthy ? (
              <>
                <CheckIcon className="h-5 w-5 text-emerald-500" />
                <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
                  Database is healthy
                </span>
              </>
            ) : (
              <>
                <WarningIcon className="h-5 w-5 text-amber-500" />
                <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  {result.issues.filter(i => i.severity !== "info").length} issue{result.issues.filter(i => i.severity !== "info").length !== 1 ? "s" : ""} found
                </span>
              </>
            )}
          </div>

          {/* Stats - clickable */}
          <div className="rounded-lg bg-slate-50 p-2 dark:bg-slate-800">
            <div className="grid grid-cols-3 gap-1">
              <StatCard
                value={result.stats.totalAssignments}
                label="Shifts"
                statKey="assignments"
                onClick={handleStatClick}
              />
              <StatCard
                value={result.stats.totalSlots}
                label="Slots"
                statKey="slots"
                onClick={handleStatClick}
              />
              <StatCard
                value={result.stats.totalClinicians}
                label="People"
                statKey="clinicians"
                onClick={handleStatClick}
              />
            </div>
            <div className="mt-1 grid grid-cols-3 gap-1">
              <StatCard
                value={result.stats.totalLocations}
                label="Locations"
                statKey="locations"
                onClick={handleStatClick}
              />
              <StatCard
                value={result.stats.totalBlocks}
                label="Sections"
                statKey="blocks"
                onClick={handleStatClick}
              />
              <StatCard
                value={result.stats.poolAssignments ?? 0}
                label="Rest & vacation"
                statKey="poolAssignments"
                onClick={handleStatClick}
              />
            </div>
          </div>

          {/* Stat explanation panel */}
          {selectedStat && (
            <StatExplanationPanel
              statKey={selectedStat}
              onClose={() => setSelectedStat(null)}
              poolDetails={selectedStat === "poolAssignments"
                ? result.issues.find(i => i.type === "pool_assignment_info")
                : null}
            />
          )}

          {/* Issues - filter out pool_assignment_info as it's shown via stat click */}
          {result.issues.filter(i => i.type !== "pool_assignment_info").length > 0 && (
            <div className="space-y-2">
              {result.issues
                .filter(i => i.type !== "pool_assignment_info")
                .map((issue, index) => (
                  <IssueCard key={index} issue={issue} />
                ))}
            </div>
          )}
        </div>
      )}

      {!result && !loading && !error && (
        <div className="rounded-lg bg-slate-50 p-4 text-center text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          Click "Run check" to check your saved data.
        </div>
      )}
    </div>
  );
}
