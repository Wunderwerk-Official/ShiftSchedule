// Run-log building shared between the solver run inbox (SolverInfoModal)
// and the admin's feedback review (AdminUsersPanel): one entry shape, one
// plain-text log format, one download helper.

import type { SolverDebugInfo, SolverRunDetail } from "../api/client";
import type { StatsHistoryEntry } from "../components/schedule/SolverOverlay";
import { APP_BUILD, APP_VERSION } from "../version";

export type SolverHistoryEntry = {
  id: string;
  startISO: string;
  endISO: string;
  startedAt: number;
  endedAt: number;
  status: "success" | "aborted" | "error";
  notes: string[];
  debugInfo?: SolverDebugInfo;
  statsHistory?: StatsHistoryEntry[]; // Stats for each solution found
};

export const formatRunDuration = (ms: number) => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${minutes}m ${secs}s`;
};

// The server run row carries everything the local history entry does —
// so the run log stays downloadable after apply, reloads and on other
// devices.
export const serverRunToHistoryEntry = (run: SolverRunDetail): SolverHistoryEntry => {
  const startedAt = Date.parse(run.created_at) || Date.now();
  const endedAt = run.finished_at ? Date.parse(run.finished_at) : startedAt;
  const status =
    run.status === "failed" || run.status === "crashed"
      ? "error"
      : run.status === "aborted"
        ? "aborted"
        : "success";
  return {
    id: run.id,
    startISO: run.start_iso,
    endISO: run.end_iso,
    startedAt,
    endedAt,
    status,
    notes: [
      ...(run.result?.notes ?? []),
      ...(run.notes ? run.notes.split("\n").filter(Boolean) : []),
      ...(run.error ? [run.error] : []),
    ],
    debugInfo: run.result?.debugInfo,
  };
};

// Plain-text log of one run, made to be pasted into a bug report or an AI
// chat: human-readable header plus the full debugInfo JSON (which includes
// the agent's summary, every accepted move, token counts and timing).
export const buildRunLog = (entry: SolverHistoryEntry): string => {
  const agent = entry.debugInfo?.agent;
  const lines: string[] = [
    `ShiftSchedule run log — app v${APP_VERSION} (${APP_BUILD})`,
    `Range: ${entry.startISO} to ${entry.endISO}`,
    `Started: ${new Date(entry.startedAt).toISOString()} | ` +
      `duration: ${formatRunDuration(entry.endedAt - entry.startedAt)} | status: ${entry.status}`,
  ];
  if (entry.debugInfo) {
    lines.push(`Solver status: ${entry.debugInfo.solver_status}`);
  }
  if (agent) {
    lines.push(
      `Agent: model ${agent.model ?? "?"} | iterations ${agent.iterations ?? "?"} | ` +
        `moves accepted ${agent.moves_accepted ?? 0} / rejected ${agent.moves_rejected ?? 0}`,
      `Tokens: input ${agent.input_tokens ?? 0}, output ${agent.output_tokens ?? 0}, ` +
        `cache read ${agent.cache_read_input_tokens ?? 0}, cache write ${agent.cache_creation_input_tokens ?? 0}`,
    );
  }
  if (entry.notes.length) {
    lines.push("", "Notes:", ...entry.notes.map((n) => `- ${n}`));
  }
  // Pull the long diagnostic arrays out of the JSON dump and print them as
  // readable text sections instead (JSON string-escaping makes multi-line
  // thoughts unreadable and would double the size).
  const {
    open_slots_seed,
    open_slots_final,
    seed_plan,
    final_plan,
    violations_final,
    thoughts,
    moves,
    ...agentRest
  } = agent ?? {};
  const section = (title: string, items: string[] | undefined, empty: string) => {
    lines.push("", `${title}:`);
    if (items?.length) lines.push(...items.map((item) => `- ${item}`));
    else lines.push(`(${empty})`);
  };
  if (agent) {
    section("Open slots at seed", open_slots_seed, "none");
    section("Open slots remaining", open_slots_final, "none — all filled");
    section(
      "Plan before AI changes (date|section|time|clinician|origin)",
      seed_plan,
      "not captured",
    );
    section(
      "Changes in order (#iteration action clinician section date time)",
      moves?.map(
        (m) =>
          `#${m.iteration ?? "?"} ${m.action} ${m.clinician} ${m.section || "shift"} ` +
          `${m.dateISO}${m.start ? ` ${m.start}-${m.end}` : ""}`,
      ),
      "none",
    );
    section("Final plan (date|section|time|clinician|origin)", final_plan, "empty");
    section("Violations in final plan", violations_final, "none");
    lines.push("", "Agent reasoning:");
    if (thoughts?.length) {
      for (const t of thoughts) lines.push("", t);
    } else {
      lines.push("(no reasoning captured)");
    }
  }
  const debugForJson = entry.debugInfo
    ? { ...entry.debugInfo, ...(agent ? { agent: agentRest } : {}) }
    : null;
  lines.push("", "debugInfo JSON:", JSON.stringify(debugForJson, null, 2));
  return lines.join("\n");
};

export const downloadTextFile = (filename: string, text: string) => {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
};
