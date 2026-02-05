"""
Data models for the heuristic scheduler.

These models represent the intermediate state during scheduling:
- Band: Time bands within a day (Early, Late, Afternoon, Night)
- Pattern: Work patterns (combinations of bands)
- SlotInstance: A template slot expanded for a specific date
- Position: A single position to fill (one per requiredSlots)
- ClinicianDayState: A clinician's state for a specific day
- EligibilityInfo: Whether a clinician can fill a position
"""

from enum import Enum
from typing import Dict, List, Optional, Set

from pydantic import BaseModel, Field


class Band(str, Enum):
    """Time band within a day.

    Bands are used for coarse planning to determine which part
    of the day a clinician should work.
    """
    EARLY = "F"       # Früh: typically 06:00-12:00
    LATE = "S"        # Spät: typically 12:00-16:00
    AFTERNOON = "A"   # Nachmittag: typically 14:00-20:00
    NIGHT = "N"       # Nacht: typically 18:00-06:00+1 (cross-day)


class Pattern(str, Enum):
    """Work pattern for a clinician on a specific day.

    Patterns represent continuous work blocks. The heuristic
    prefers patterns that don't have gaps (continuity).
    """
    OFF = "OFF"       # Not working
    F = "F"           # Early only
    S = "S"           # Late only
    A = "A"           # Afternoon only
    N = "N"           # Night only (cross-day)
    FS = "FS"         # Early + Late (continuous)
    SA = "SA"         # Late + Afternoon (continuous)
    FA = "FA"         # Early + Afternoon (gap - avoid if possible)
    FSA = "FSA"       # Full day (Early + Late + Afternoon)


# Pattern to bands mapping
PATTERN_BANDS: Dict[Pattern, Set[Band]] = {
    Pattern.OFF: set(),
    Pattern.F: {Band.EARLY},
    Pattern.S: {Band.LATE},
    Pattern.A: {Band.AFTERNOON},
    Pattern.N: {Band.NIGHT},
    Pattern.FS: {Band.EARLY, Band.LATE},
    Pattern.SA: {Band.LATE, Band.AFTERNOON},
    Pattern.FA: {Band.EARLY, Band.AFTERNOON},
    Pattern.FSA: {Band.EARLY, Band.LATE, Band.AFTERNOON},
}

# Pattern upgrade paths (for repair phase)
PATTERN_UPGRADES: Dict[Pattern, List[Pattern]] = {
    Pattern.OFF: [Pattern.F, Pattern.S, Pattern.A, Pattern.N],
    Pattern.F: [Pattern.FS, Pattern.FA],
    Pattern.S: [Pattern.FS, Pattern.SA],
    Pattern.A: [Pattern.SA, Pattern.FA],
    Pattern.FS: [Pattern.FSA],
    Pattern.SA: [Pattern.FSA],
    Pattern.FA: [Pattern.FSA],
    Pattern.N: [],  # Night is exclusive
    Pattern.FSA: [],  # Already full day
}


class SlotInstance(BaseModel):
    """A template slot expanded for a specific date.

    This represents a concrete shift that needs to be filled on a
    specific day. Created by expanding the weekly template.
    """
    id: str  # Format: "{slot_id}__{date_iso}"
    slot_id: str  # Reference to TemplateSlot.id
    date_iso: str  # ISO date string (YYYY-MM-DD)
    location_id: str
    section_id: str  # The section (e.g., "MRI", "CT")
    band: Band
    start_minutes: int  # Minutes from midnight
    end_minutes: int  # Minutes from midnight (may exceed 24h for night)
    end_day_offset: int = 0  # 0-3, for multi-day slots
    required_count: int = 0  # How many clinicians needed


class Position(BaseModel):
    """A single position to be filled.

    When a SlotInstance has requiredSlots > 1, we create multiple
    Position objects (one per required clinician). This makes
    matching cleaner.
    """
    id: str  # Format: "{slot_instance_id}__pos{index}"
    slot_instance_id: str
    position_index: int  # 0, 1, 2, ... for multiple required
    assigned_clinician_id: Optional[str] = None
    is_manual: bool = False  # True if this was a pre-existing assignment
    assignment_source: Optional[str] = None  # "manual" or "solver"


class ClinicianDayState(BaseModel):
    """State of a clinician on a specific day.

    Tracks what pattern they're working, which location, and
    which positions they're assigned to.
    """
    clinician_id: str
    date_iso: str
    pattern: Pattern = Pattern.OFF
    location_id: Optional[str] = None
    assigned_positions: List[str] = Field(default_factory=list)
    is_on_vacation: bool = False
    is_rest_day: bool = False  # Blocked due to on-call rest rules
    hours_assigned: float = 0.0  # Total hours assigned this day


class EligibilityInfo(BaseModel):
    """Information about whether a clinician can fill a position.

    Used for building the eligibility matrix and scoring candidates.
    """
    clinician_id: str
    position_id: str
    is_qualified: bool  # Has the required section qualification
    is_preferred: bool  # Section is in their preferred list
    preference_rank: int = 999  # Lower is better (0 = most preferred)
    fits_time_window: bool = True  # Matches preferred working hours
    would_violate_location: bool = False  # Would mix locations on same day
    would_create_gap: bool = False  # Would create non-continuous pattern

    def score(self) -> int:
        """Calculate a score for sorting (lower is better)."""
        score = 0
        if self.would_violate_location:
            score += 10000  # Major penalty
        if self.would_create_gap:
            score += 1000  # Continuity penalty
        if not self.fits_time_window:
            score += 100  # Time preference penalty
        score += self.preference_rank  # Preference ranking
        return score


class UnfilledReason(str, Enum):
    """Reason why a position could not be filled."""
    NO_ELIGIBLE = "no_eligible"  # No qualified clinicians available
    ALL_ON_VACATION = "all_on_vacation"  # All qualified are on vacation
    REST_DAY_BLOCKED = "rest_day_blocked"  # All qualified blocked by rest rules
    LOCATION_CONFLICT = "location_conflict"  # All qualified at other location
    OVERLAP_CONFLICT = "overlap_conflict"  # All qualified have time conflicts
    HOURS_EXCEEDED = "hours_exceeded"  # All qualified would exceed hours
    REPAIR_FAILED = "repair_failed"  # Repair phase couldn't find solution


class UnfilledPosition(BaseModel):
    """Information about a position that couldn't be filled."""
    position_id: str
    slot_instance_id: str
    date_iso: str
    section_id: str
    location_id: str
    reason: UnfilledReason
    eligible_count: int = 0  # How many were initially eligible
    details: Optional[str] = None  # Additional context


class HeuristicSolverStats(BaseModel):
    """Statistics from a heuristic solver run."""
    total_positions: int = 0
    required_positions: int = 0
    filled_positions: int = 0
    manual_positions: int = 0
    unfilled_positions: int = 0

    phase_times_ms: Dict[str, float] = Field(default_factory=dict)
    total_time_ms: float = 0.0

    # Per-phase stats
    night_oncall_assigned: int = 0
    coarse_patterns_set: int = 0
    fine_assigned: int = 0
    repair_fixed: int = 0
    improvement_swaps: int = 0

    # Quality metrics
    continuity_violations: int = 0  # Gaps in work patterns
    location_violations: int = 0  # Mixed locations on same day
    hours_deviations: Dict[str, float] = Field(default_factory=dict)  # Per clinician


def pattern_contains_band(pattern: Pattern, band: Band) -> bool:
    """Check if a pattern includes the specified band."""
    return band in PATTERN_BANDS.get(pattern, set())


def get_pattern_bands(pattern: Pattern) -> Set[Band]:
    """Get all bands included in a pattern."""
    return PATTERN_BANDS.get(pattern, set())


def can_upgrade_pattern(current: Pattern, target_band: Band) -> Optional[Pattern]:
    """Find a pattern upgrade that includes the target band.

    Returns the upgraded pattern if possible, None otherwise.
    """
    for upgraded in PATTERN_UPGRADES.get(current, []):
        if target_band in PATTERN_BANDS.get(upgraded, set()):
            return upgraded
    return None


def bands_to_pattern(bands: Set[Band]) -> Pattern:
    """Convert a set of bands to the appropriate pattern."""
    if not bands:
        return Pattern.OFF
    if bands == {Band.NIGHT}:
        return Pattern.N
    if bands == {Band.EARLY}:
        return Pattern.F
    if bands == {Band.LATE}:
        return Pattern.S
    if bands == {Band.AFTERNOON}:
        return Pattern.A
    if bands == {Band.EARLY, Band.LATE}:
        return Pattern.FS
    if bands == {Band.LATE, Band.AFTERNOON}:
        return Pattern.SA
    if bands == {Band.EARLY, Band.AFTERNOON}:
        return Pattern.FA
    if bands == {Band.EARLY, Band.LATE, Band.AFTERNOON}:
        return Pattern.FSA
    # Default: return most specific single band
    if Band.EARLY in bands:
        return Pattern.F
    if Band.LATE in bands:
        return Pattern.S
    if Band.AFTERNOON in bands:
        return Pattern.A
    return Pattern.OFF
