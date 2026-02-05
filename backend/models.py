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
    weightTimeWindow: int = 5  # Respect preferred working time windows
    weightSectionPreference: int = 1  # Assign to preferred sections
    weightWorkingHours: int = 1  # Stay within target working hours


class SolverRule(BaseModel):
    id: str
    name: str
    enabled: bool = True
    ifShiftRowId: str
    dayDelta: Literal[-1, 1]
    thenType: ThenType
    thenShiftRowId: Optional[str] = None


class SolveRangeRequest(BaseModel):
    """Request to solve a date range (can be a single day, week, or any range)."""
    startISO: str
    endISO: Optional[str] = None
    only_fill_required: bool = False
    timeout_seconds: Optional[float] = None  # None means use default (60s)
    use_heuristic: bool = False  # Use heuristic solver instead of CP-SAT


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


class SolverDebugInfo(BaseModel):
    timing: Dict[str, Any]
    solution_times: List[SolverDebugSolutionTime]
    num_variables: int
    num_days: int
    num_slots: int
    solver_status: str
    cpu_workers_used: int
    cpu_cores_available: int
    sub_scores: Optional[SolverSubScores] = None


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
