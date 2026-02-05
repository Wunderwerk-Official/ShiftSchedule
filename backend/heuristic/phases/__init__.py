"""
Heuristic Scheduler Phases

Each phase handles a specific aspect of the scheduling problem:
- night_oncall: Night shifts and on-call duties (highest priority)
- coarse_planning: Daily patterns and location assignments
- fine_assignment: Section-level matching within bands
- repair: Fix unfilled required positions
- local_improvement: Optimize solution quality
"""

from .night_oncall import phase_night_oncall
from .coarse_planning import phase_coarse_planning
from .fine_assignment import phase_fine_assignment
from .repair import phase_repair
from .local_improvement import phase_local_improvement

__all__ = [
    "phase_night_oncall",
    "phase_coarse_planning",
    "phase_fine_assignment",
    "phase_repair",
    "phase_local_improvement",
]
