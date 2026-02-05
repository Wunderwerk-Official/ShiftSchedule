"""
Heuristic Scheduler Module

A human-like scheduling engine that works in phases:
1. Night/On-Call first (cross-day constraints)
2. Coarse planning (location + pattern per day)
3. Fine assignment (section matching per band)
4. Repair loops (fix unfilled positions)
5. Local improvement (swaps for optimization)
"""

from .solver import heuristic_solve_range

__all__ = ["heuristic_solve_range"]
