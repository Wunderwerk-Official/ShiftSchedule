"""Heuristic scheduler package.

The production heuristic is the v2 greedy engine in ``solver_v2.py`` — it
fills day by day, ranking candidates by week-hours percentage, YTD deficit,
and section preference, and never creates hard violations. It serves as the
standalone "heuristic" solver mode and as the seed for the agent solver
(``backend/agent/harness.py``). The old five-phase v1 engine was removed —
nothing imported it anymore.
"""

from .solver_v2 import heuristic_solve_range_v2

__all__ = ["heuristic_solve_range_v2"]
