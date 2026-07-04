export type RowKind = "class" | "pool";

export type Location = {
  id: string;
  name: string;
};

export type SubShift = {
  id: string;
  name: string;
  order: 1 | 2 | 3;
  startTime: string;
  endTime: string;
  endDayOffset?: number;
  hours?: number;
};

export type WorkplaceRow = {
  id: string;
  name: string;
  kind: RowKind;
  dotColorClass: string;
  blockColor?: string;
  locationId?: string;
  subShifts?: SubShift[];
};

export type VacationRange = {
  id: string;
  startISO: string;
  endISO: string;
};

export type PreferredWorkingTimeRequirement = "none" | "preference" | "mandatory";

export type PreferredWorkingTime = {
  startTime?: string;
  endTime?: string;
  requirement?: PreferredWorkingTimeRequirement;
};

export type PreferredWorkingTimes = Record<
  "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun",
  PreferredWorkingTime
>;

export type Holiday = {
  dateISO: string;
  name: string;
};

export type Clinician = {
  id: string;
  name: string;
  qualifiedClassIds: string[];
  preferredClassIds: string[];
  vacations: VacationRange[];
  preferredWorkingTimes?: PreferredWorkingTimes;
  workingHoursPerWeek?: number;
  workingHoursToleranceHours?: number;
};

export type AssignmentSource = "manual" | "solver";

export type Assignment = {
  id: string;
  rowId: string;
  dateISO: string;
  clinicianId: string;
  source?: AssignmentSource; // "manual" (default) or "solver" - tracks how assignment was created
};

export type MinSlots = { weekday: number; weekend: number };

export type DayType =
  | "mon"
  | "tue"
  | "wed"
  | "thu"
  | "fri"
  | "sat"
  | "sun"
  | "holiday";

export type TemplateRowBand = {
  id: string;
  order: number;
  label?: string;
};

export type TemplateColBand = {
  id: string;
  label?: string;
  order: number;
  dayType: DayType;
};

export type TemplateBlock = {
  id: string;
  sectionId: string;
  label?: string;
  requiredSlots: number;
  color?: string;
};

export type TemplateSlot = {
  id: string;
  locationId: string;
  rowBandId: string;
  colBandId: string;
  blockId: string;
  requiredSlots?: number;
  startTime?: string;
  endTime?: string;
  endDayOffset?: number;
};

export type WeeklyTemplateLocation = {
  locationId: string;
  rowBands: TemplateRowBand[];
  colBands: TemplateColBand[];
  slots: TemplateSlot[];
};

export type WeeklyCalendarTemplate = {
  version: 4;
  blocks: TemplateBlock[];
  locations: WeeklyTemplateLocation[];
};

export type SolverSettings = {
  enforceSameLocationPerDay: boolean;
  onCallRestEnabled: boolean;
  onCallRestClassId?: string;
  onCallRestDaysBefore: number;
  onCallRestDaysAfter: number;
  preferContinuousShifts: boolean;
  // Optimization weights (soft constraints)
  weightCoverage?: number; // Fill required slots (default: 1000)
  weightSlack?: number; // Minimize unfilled required slots (default: 1000)
  weightTotalAssignments?: number; // Maximize total assignments (default: 100)
  weightSlotPriority?: number; // Prefer slots in template order (default: 10)
  weightTimeWindow?: number; // Respect preferred working time windows (default: 20)
  weightSectionPreference?: number; // Assign to preferred sections (default: 10)
  weightWorkingHours?: number; // Stay within target working hours (default: 3)
  weightMinimumDailyHours?: number; // Penalize daily assignments shorter than derived minimum (default: 5)
  weightYtdBalance?: number; // Bias toward clinicians behind on YTD hours (default: 5)
};

export type SolverRule = {
  id: string;
  name: string;
  enabled: boolean;
  ifShiftRowId: string;
  dayDelta: -1 | 1;
  thenType: "shiftRow" | "off";
  thenShiftRowId?: string;
};

export type AppState = {
  locations?: Location[];
  locationsEnabled?: boolean;
  rows: WorkplaceRow[];
  clinicians: Clinician[];
  assignments: Assignment[];
  minSlotsByRowId: Record<string, MinSlots>;
  slotOverridesByKey?: Record<string, number>;
  weeklyTemplate?: WeeklyCalendarTemplate;
  holidayCountry?: string;
  holidayYear?: number;
  holidays?: Holiday[];
  publishedWeekStartISOs?: string[];
  solverSettings?: SolverSettings;
  solverRules?: SolverRule[];
};

export type UserStateExport = {
  version: number;
  exportedAt: string;
  sourceUser: string;
  state: AppState;
};

export type ScheduleSnapshotExport = {
  version: number;
  exportedAt: string;
  sourceUser?: string;
  assignments: Assignment[];
};

export type UserRole = "admin" | "user";

export type AuthUser = {
  username: string;
  role: UserRole;
  active: boolean;
};

export type IcalPublishStatus = {
  published: boolean;
  all?: { subscribeUrl: string };
  clinicians?: Array<{
    clinicianId: string;
    clinicianName: string;
    subscribeUrl: string;
  }>;
};

export type WebPublishStatus = {
  published: boolean;
  token?: string;
};

export type PublicWebWeekResponse = {
  published: boolean;
  weekStartISO: string;
  weekEndISO: string;
  locations?: Location[];
  locationsEnabled?: boolean;
  rows?: WorkplaceRow[];
  clinicians?: Clinician[];
  assignments?: Assignment[];
  minSlotsByRowId?: Record<string, MinSlots>;
  slotOverridesByKey?: Record<string, number>;
  weeklyTemplate?: WeeklyCalendarTemplate;
  holidays?: Holiday[];
  solverSettings?: SolverSettings;
  solverRules?: SolverRule[];
};

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
const TOKEN_STORAGE_KEY = "authToken";
const AUTH_EXPIRED_EVENT = "auth-expired";

function readToken() {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setAuthToken(token: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearAuthToken() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
}

function handleUnauthorized() {
  clearAuthToken();
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
}

function buildHeaders() {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = readToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function login(username: string, password: string): Promise<{
  access_token: string;
  token_type: string;
  user: AuthUser;
}> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ username, password }),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to login: ${res.status}`);
  }
  return res.json();
}

export async function getCurrentUser(): Promise<AuthUser> {
  const res = await fetch(`${API_BASE}/auth/me`, {
    headers: buildHeaders(),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to fetch user: ${res.status}`);
  }
  return res.json();
}

export async function listUsers(): Promise<AuthUser[]> {
  const res = await fetch(`${API_BASE}/auth/users`, {
    headers: buildHeaders(),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to list users: ${res.status}`);
  }
  return res.json();
}

export async function createUser(payload: {
  username: string;
  password: string;
  role?: UserRole;
  importState?: AppState | UserStateExport;
}): Promise<AuthUser> {
  const res = await fetch(`${API_BASE}/auth/users`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(payload),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to create user: ${res.status}`);
  }
  return res.json();
}

export async function exportUserState(username: string): Promise<UserStateExport> {
  const res = await fetch(
    `${API_BASE}/auth/users/${encodeURIComponent(username)}/export`,
    {
      headers: buildHeaders(),
    },
  );
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to export user: ${res.status}`);
  }
  return res.json();
}

export async function updateUser(
  username: string,
  payload: { active?: boolean; role?: UserRole; password?: string },
): Promise<AuthUser> {
  const res = await fetch(`${API_BASE}/auth/users/${encodeURIComponent(username)}`, {
    method: "PATCH",
    headers: buildHeaders(),
    body: JSON.stringify(payload),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to update user: ${res.status}`);
  }
  return res.json();
}

export async function deleteUser(username: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/users/${encodeURIComponent(username)}`, {
    method: "DELETE",
    headers: buildHeaders(),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to delete user: ${res.status}`);
  }
}

export async function getState(): Promise<AppState> {
  const res = await fetch(`${API_BASE}/v1/state`, {
    headers: buildHeaders(),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to fetch state: ${res.status}`);
  }
  return res.json();
}

export async function saveState(state: AppState): Promise<AppState> {
  const res = await fetch(`${API_BASE}/v1/state`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(state),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to save state: ${res.status}`);
  }
  return res.json();
}

export type DatabaseHealthIssue = {
  type: "orphaned_assignment" | "slot_collision" | "duplicate_assignment" | "colband_explosion" | "pool_assignment_info";
  severity: "error" | "warning" | "info";
  message: string;
  details: Record<string, unknown>;
};

export type DatabaseHealthCheckResult = {
  healthy: boolean;
  issues: DatabaseHealthIssue[];
  stats: {
    totalAssignments: number;
    totalSlots: number;
    totalClinicians: number;
    totalLocations: number;
    totalBlocks: number;
    poolAssignments: number;
  };
};

export async function checkDatabaseHealth(): Promise<DatabaseHealthCheckResult> {
  const res = await fetch(`${API_BASE}/v1/state/health`, {
    headers: buildHeaders(),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to check database health: ${res.status}`);
  }
  return res.json();
}

// Weekly slot inspection types
export type SlotInspection = {
  slotId: string;
  locationId: string;
  locationName: string;
  rowBandId: string;
  rowBandLabel: string | null;
  colBandId: string;
  colBandLabel: string | null;
  dayType: string;
  blockId: string;
  sectionId: string | null;
  sectionName: string | null;
  startTime: string | null;
  endTime: string | null;
  dateISO: string;
  dayOfWeek: string;
  status: "open" | "assigned";
  assignments: Array<{
    assignmentId: string;
    clinicianId: string;
    clinicianName: string;
    source: string;
  }>;
};

export type PoolInspection = {
  poolId: string;
  poolName: string;
  dateISO: string;
  dayOfWeek: string;
  assignments: Array<{
    assignmentId: string;
    clinicianId: string;
    clinicianName: string;
    source: string;
  }>;
};

export type WeeklyInspectionResult = {
  weekStartISO: string;
  weekEndISO: string;
  slots: SlotInspection[];
  poolAssignments: PoolInspection[];
  stats: {
    totalSlots: number;
    assignedSlots: number;
    openSlots: number;
    poolAssignments: number;
  };
};

export async function inspectWeek(weekStart: string): Promise<WeeklyInspectionResult> {
  const res = await fetch(`${API_BASE}/v1/state/inspect/week?week_start=${encodeURIComponent(weekStart)}`, {
    headers: buildHeaders(),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to inspect week: ${res.status}`);
  }
  return res.json();
}

export type SolverDebugSolutionTime = {
  solution: number;
  time_ms: number;
  objective: number;
};

export type SolverDebugCheckpoint = {
  name: string;
  duration_ms: number;
};

export type SolverDebugTiming = {
  total_ms: number;
  checkpoints: SolverDebugCheckpoint[];
};

export type SolverSubScores = {
  slots_filled: number;
  slots_unfilled: number;
  total_assignments: number;
  preference_score: number;
  time_window_score: number;
  hours_penalty: number;
};

export type SolverDebugInfo = {
  timing: SolverDebugTiming;
  solution_times: SolverDebugSolutionTime[];
  num_variables: number;
  num_days: number;
  num_slots: number;
  solver_status: string;
  cpu_workers_used: number;
  cpu_cores_available: number;
  sub_scores?: SolverSubScores;
};

export type SolveRangeResult = {
  startISO: string;
  endISO: string;
  assignments: Assignment[];
  notes: string[];
  debugInfo?: SolverDebugInfo;
};

export type SolverMode = "cpsat" | "heuristic" | "agent";

export async function solveRange(
  startISO: string,
  options?: {
    endISO?: string;
    onlyFillRequired?: boolean;
    timeoutSeconds?: number;
    solverMode?: SolverMode;
    signal?: AbortSignal;
  },
): Promise<SolveRangeResult> {
  const res = await fetch(`${API_BASE}/v1/solve/range`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({
      startISO,
      endISO: options?.endISO,
      only_fill_required: options?.onlyFillRequired ?? false,
      timeout_seconds: options?.timeoutSeconds,
      solver_mode: options?.solverMode,
    }),
    signal: options?.signal,
  });
  if (res.status === 401) handleUnauthorized();
  if (res.status === 409) {
    // Backend refused because another solve is still running. Let the caller
    // surface a specific message instead of the generic "not responding".
    let detail = "Another solve is already running.";
    try {
      const body = (await res.json()) as { detail?: string };
      if (typeof body.detail === "string" && body.detail.length > 0) {
        detail = body.detail;
      }
    } catch {
      // Non-JSON 409 body — fall back to the default detail string above.
    }
    const err = new Error(detail);
    err.name = "SolverBusyError";
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Failed to solve range: ${res.status}`);
  }
  return res.json();
}

export async function abortSolver(force = false): Promise<{ status: string; message: string }> {
  const url = force
    ? `${API_BASE}/v1/solve/abort?force=true`
    : `${API_BASE}/v1/solve/abort`;
  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to abort solver: ${res.status}`);
  }
  return res.json();
}

// One humanized assignment change from the agent solver's live feed.
export type AgentMoveItem = {
  action: "assign" | "unassign";
  clinician: string;
  section: string;
  dateISO: string;
  start: string;
  end: string;
};

// Live activity from the agent solver (SSE event type "agent").
export type AgentActivityData = {
  kind: "stage" | "iteration" | "thought" | "moves_applied" | "moves_rejected";
  iteration: number;
  max_iterations: number | null;
  moves_accepted: number;
  time_ms: number;
  stage?: "seed" | "improve" | "finalize";
  text?: string;
  moves?: AgentMoveItem[];
  improved?: boolean;
  score?: number;
  count?: number;
  reason?: string;
};

export type SolverProgressEvent =
  | { event: "connected"; data: Record<string, never> }
  | { event: "start"; data: { startISO: string; endISO: string | null; timeout_seconds: number | null } }
  | { event: "phase"; data: { phase: string; label: string } }
  | { event: "solution"; data: { solution_num: number; time_ms: number; objective: number; assignments?: Assignment[] } }
  | { event: "agent"; data: AgentActivityData }
  | { event: "complete"; data: { startISO: string; endISO: string; status: "success" | "error"; error?: string } };

export function subscribeSolverProgress(
  onEvent: (event: SolverProgressEvent) => void,
  onError?: (error: Event) => void,
): () => void {
  const token = localStorage.getItem("authToken");
  const url = `${API_BASE}/v1/solve/progress?token=${encodeURIComponent(token ?? "")}`;
  const eventSource = new EventSource(url);

  eventSource.onmessage = (e) => {
    try {
      const parsed = JSON.parse(e.data) as SolverProgressEvent;
      onEvent(parsed);
    } catch {
      // Ignore parse errors
    }
  };

  eventSource.onerror = (e) => {
    // Close on terminal failures (e.g. 401 from a bad token) so the browser doesn't
    // silently reconnect in a loop. For transient disconnects the caller can
    // resubscribe.
    if (eventSource.readyState === EventSource.CLOSED) {
      onError?.(e);
      return;
    }
    eventSource.close();
    onError?.(e);
  };

  // Return cleanup function
  return () => {
    eventSource.close();
  };
}

export async function getIcalPublishStatus(): Promise<IcalPublishStatus> {
  const res = await fetch(`${API_BASE}/v1/ical/publish`, {
    headers: buildHeaders(),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to fetch iCal status: ${res.status}`);
  }
  return res.json();
}

export async function publishIcal(): Promise<IcalPublishStatus> {
  const res = await fetch(`${API_BASE}/v1/ical/publish`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({}),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to publish iCal: ${res.status}`);
  }
  return res.json();
}

export async function rotateIcalToken(): Promise<IcalPublishStatus> {
  const res = await fetch(`${API_BASE}/v1/ical/publish/rotate`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({}),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to rotate iCal token: ${res.status}`);
  }
  return res.json();
}

export async function unpublishIcal(): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/ical/publish`, {
    method: "DELETE",
    headers: buildHeaders(),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to unpublish iCal: ${res.status}`);
  }
}

export async function exportWeekPdf(startISO: string): Promise<Blob> {
  const res = await fetch(
    `${API_BASE}/v1/pdf/week?start=${encodeURIComponent(startISO)}`,
    {
      headers: buildHeaders(),
    },
  );
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to export PDF: ${res.status}`);
  }
  return res.blob();
}

export async function getWebPublishStatus(): Promise<WebPublishStatus> {
  const res = await fetch(`${API_BASE}/v1/web/publish`, {
    headers: buildHeaders(),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to fetch web publish status: ${res.status}`);
  }
  return res.json();
}

export async function publishWeb(): Promise<WebPublishStatus> {
  const res = await fetch(`${API_BASE}/v1/web/publish`, {
    method: "POST",
    headers: buildHeaders(),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to publish web link: ${res.status}`);
  }
  return res.json();
}

export async function rotateWeb(): Promise<WebPublishStatus> {
  const res = await fetch(`${API_BASE}/v1/web/publish/rotate`, {
    method: "POST",
    headers: buildHeaders(),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to rotate web link: ${res.status}`);
  }
  return res.json();
}

export async function unpublishWeb(): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/web/publish`, {
    method: "DELETE",
    headers: buildHeaders(),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to unpublish web link: ${res.status}`);
  }
}

export async function getPublicWebWeek(
  token: string,
  weekStartISO: string,
): Promise<PublicWebWeekResponse> {
  const res = await fetch(
    `${API_BASE}/v1/web/${encodeURIComponent(token)}/week?start=${encodeURIComponent(
      weekStartISO,
    )}`,
  );
  if (res.status === 404) {
    const error = new Error("Link not found") as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch public schedule: ${res.status}`);
  }
  return res.json();
}

export async function exportWeeksPdf(startISO: string, weeks: number): Promise<Blob> {
  const res = await fetch(
    `${API_BASE}/v1/pdf/weeks?start=${encodeURIComponent(startISO)}&weeks=${encodeURIComponent(
      String(weeks),
    )}`,
    {
      headers: buildHeaders(),
    },
  );
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    throw new Error(`Failed to export PDF: ${res.status}`);
  }
  return res.blob();
}
