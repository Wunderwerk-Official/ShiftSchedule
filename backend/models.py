from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

RowKind = Literal["class", "pool"]
Role = Literal["admin", "user"]
ThenType = Literal["shiftRow", "off"]
DayType = Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun", "holiday"]
WorkingTimeRequirement = Literal["none", "preference", "mandatory"]


class UserPublic(BaseModel):
    username: str
    role: Role
    active: bool


class UserCreateRequest(BaseModel):
    username: str
    password: str
    role: Role = "user"
    importState: Optional[Dict[str, Any]] = None


class UserUpdateRequest(BaseModel):
    active: Optional[bool] = None
    role: Optional[Role] = None
    password: Optional[str] = None


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserPublic


class Location(BaseModel):
    id: str
    name: str


class SubShift(BaseModel):
    id: str
    name: str
    order: Literal[1, 2, 3]
    startTime: Optional[str] = None
    endTime: Optional[str] = None
    endDayOffset: Optional[int] = None
    hours: Optional[float] = None


class WorkplaceRow(BaseModel):
    id: str
    name: str
    kind: RowKind
    dotColorClass: str
    blockColor: Optional[str] = None
    locationId: Optional[str] = None
    subShifts: List[SubShift] = Field(default_factory=list)


class VacationRange(BaseModel):
    id: str
    startISO: str
    endISO: str


class Holiday(BaseModel):
    dateISO: str
    name: str


class Clinician(BaseModel):
    id: str
    name: str
    qualifiedClassIds: List[str]
    preferredClassIds: List[str] = []
    vacations: List[VacationRange]
    preferredWorkingTimes: Dict[str, "PreferredWorkingTime"] = Field(
        default_factory=dict
    )
    workingHoursPerWeek: Optional[float] = None
    workingHoursToleranceHours: int = 5
    # Free-text wishes the AI planning agent reads as SOFT preferences
    # (never overriding hard constraints). Must be declared here: pydantic
    # defaults to extra="ignore", an undeclared field would be silently
    # dropped on every save round-trip.
    planningWishes: Optional[str] = None


class PreferredWorkingTime(BaseModel):
    startTime: Optional[str] = None
    endTime: Optional[str] = None
    requirement: WorkingTimeRequirement = "none"


class Assignment(BaseModel):
    id: str
    rowId: str
    dateISO: str
    clinicianId: str
    source: Optional[Literal["manual", "solver"]] = None  # tracks how assignment was created


class MinSlots(BaseModel):
    weekday: int
    weekend: int


class TemplateRowBand(BaseModel):
    id: str
    order: int
    label: Optional[str] = None


class TemplateColBand(BaseModel):
    id: str
    label: Optional[str] = None
    order: int
    dayType: DayType


class TemplateBlock(BaseModel):
    id: str
    sectionId: str
    label: Optional[str] = None
    requiredSlots: int = 0
    color: Optional[str] = None


class TemplateSlot(BaseModel):
    id: str
    locationId: str
    rowBandId: str
    colBandId: str
    blockId: str
    requiredSlots: int = 0
    startTime: Optional[str] = None
    endTime: Optional[str] = None
    endDayOffset: Optional[int] = None


class WeeklyTemplateLocation(BaseModel):
    locationId: str
    rowBands: List[TemplateRowBand] = Field(default_factory=list)
    colBands: List[TemplateColBand] = Field(default_factory=list)
    slots: List[TemplateSlot] = Field(default_factory=list)


class WeeklyCalendarTemplate(BaseModel):
    version: int = 4
    blocks: List[TemplateBlock] = Field(default_factory=list)
    locations: List[WeeklyTemplateLocation] = Field(default_factory=list)


class AppState(BaseModel):
    locations: List[Location] = Field(default_factory=list)
    locationsEnabled: bool = True
    rows: List[WorkplaceRow]
    clinicians: List[Clinician]
    assignments: List[Assignment]
    minSlotsByRowId: Dict[str, MinSlots]
    slotOverridesByKey: Dict[str, int] = Field(default_factory=dict)
    weeklyTemplate: Optional[WeeklyCalendarTemplate] = None
    holidayCountry: Optional[str] = None
    holidayYear: Optional[int] = None
    holidays: List[Holiday] = Field(default_factory=list)
    publishedWeekStartISOs: List[str] = Field(default_factory=list)
    solverSettings: Dict[str, Any] = Field(default_factory=dict)
    solverRules: List[Dict[str, Any]] = Field(default_factory=list)


class UserStateExport(BaseModel):
    version: int = 1
    exportedAt: str
    sourceUser: str
    state: AppState


class SolverSettings(BaseModel):
    enforceSameLocationPerDay: bool = True
    onCallRestEnabled: bool = False
    onCallRestClassId: Optional[str] = None
    onCallRestDaysBefore: int = 1
    onCallRestDaysAfter: int = 1
    preferContinuousShifts: bool = True
    # Optimization weights (soft constraints)
    weightCoverage: int = 1000  # Fill required slots (highest priority)
    weightSlack: int = 1000  # Minimize unfilled required slots
    weightTotalAssignments: int = 100  # Maximize total assignments
    weightSlotPriority: int = 10  # Prefer slots in template order
    weightTimeWindow: int = 20  # Respect preferred working time windows
    weightSectionPreference: int = 10  # Assign to preferred sections
    weightWorkingHours: int = 3  # Stay within target working hours (per minute of deviation)
    weightMinimumDailyHours: int = 5  # Penalize daily assignments shorter than derived minimum
    weightYtdBalance: int = 5  # Bias toward clinicians behind on YTD hours
    # Agent solver: Anthropic model id override (None -> AGENT_MODEL env / default)
    agentModel: Optional[str] = None
    # Agent solver: free-text admin instructions appended (pseudonymized) to
    # the problem digest. None -> DEFAULT_AGENT_INSTRUCTIONS; "" -> none.
    agentInstructions: Optional[str] = None


class SolverRule(BaseModel):
    id: str
    name: str
    enabled: bool = True
    ifShiftRowId: str
    dayDelta: Literal[-1, 1]
    thenType: ThenType
    thenShiftRowId: Optional[str] = None


SolverMode = Literal["cpsat", "heuristic", "agent"]

# How the agent solver approaches the problem:
# - "repair" (default): heuristic drafts the whole range, the LLM improves it.
# - "day_by_day": no draft; the LLM builds each day like a human planner —
#   scarcest slots first, each clinician placed with a contiguous block.
AgentStrategy = Literal["repair", "day_by_day"]


class SolveRangeRequest(BaseModel):
    """Request to solve a date range (can be a single day, week, or any range)."""
    startISO: str
    endISO: Optional[str] = None
    only_fill_required: bool = False
    timeout_seconds: Optional[float] = None  # None means use default (60s)
    use_heuristic: bool = False  # Legacy switch, superseded by solver_mode
    solver_mode: Optional[SolverMode] = None  # Wins over use_heuristic when set
    agent_strategy: Optional[AgentStrategy] = None  # None = "repair"
    # Client-generated id echoed on every SSE progress event of this run, so
    # the frontend can ignore stragglers from a previous or foreign run.
    run_token: Optional[str] = None
    # SERVER-INJECTED fields (the endpoint overwrites whatever a client sends
    # before dispatching, so they cannot be spoofed): the admin-chosen agent
    # model and whether this user's AI budget is already used up.
    agent_model: Optional[str] = None
    agent_budget_exhausted: bool = False

    def resolved_mode(self) -> SolverMode:
        if self.solver_mode is not None:
            return self.solver_mode
        return "heuristic" if self.use_heuristic else "cpsat"


class SolverDebugCheckpoint(BaseModel):
    name: str
    duration_ms: float


class SolverDebugSolutionTime(BaseModel):
    solution: int
    time_ms: float
    objective: float


class SolverSubScores(BaseModel):
    """Breakdown of the objective into individual components."""
    slots_filled: int = 0  # Number of slots filled
    slots_unfilled: int = 0  # Number of required slots not filled (slack)
    total_assignments: int = 0  # Total assignments made
    preference_score: int = 0  # Clinician section preferences satisfied
    time_window_score: int = 0  # Preferred working hours satisfied
    hours_penalty: int = 0  # Working hours violations
    ytd_balance_bonus: int = 0  # YTD balance bonus


class SolverDebugInfo(BaseModel):
    timing: Dict[str, Any]
    solution_times: List[SolverDebugSolutionTime] = []
    num_variables: int = 0
    num_days: int = 0
    num_slots: int = 0
    solver_status: str = ""
    cpu_workers_used: int = 0
    cpu_cores_available: int = 0
    sub_scores: Optional[SolverSubScores] = None
    agent: Optional[Dict[str, Any]] = None  # agent-solver run stats


class SolveRangeResponse(BaseModel):
    """Response from the solver containing assignments for the requested date range."""
    startISO: str
    endISO: str
    assignments: List[Assignment]
    notes: List[str]
    debugInfo: Optional[SolverDebugInfo] = None


class IcalPublishRequest(BaseModel):
    pass


class IcalPublishAllLink(BaseModel):
    subscribeUrl: str


class IcalPublishClinicianLink(BaseModel):
    clinicianId: str
    clinicianName: str
    subscribeUrl: str


class IcalPublishStatus(BaseModel):
    published: bool
    all: Optional[IcalPublishAllLink] = None
    clinicians: List[IcalPublishClinicianLink] = Field(default_factory=list)


class WebPublishStatus(BaseModel):
    published: bool
    token: Optional[str] = None
