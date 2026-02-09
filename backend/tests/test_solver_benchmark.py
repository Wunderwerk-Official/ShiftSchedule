"""
Benchmark Tests: CP-SAT vs Heuristic Solver Performance Comparison

This module compares execution time between the two solver engines
for various time ranges (1 day, 7 days, 4 weeks, 8 weeks).

Run with: python -m pytest backend/tests/test_solver_benchmark.py -v -s
"""

import threading
import time
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Dict, List, Optional, Set

import pytest

from backend.models import SolveRangeRequest, AppState, Assignment
from backend.solver import _solve_range_impl
from backend.heuristic.solver_v2 import heuristic_solve_range_v2
from backend.tests.fixtures_martin_like import make_martin_like_state


# Test user mock
class MockUser:
    username = "benchmark_user"


TEST_USER = MockUser()

# Day type mapping
DAY_TYPE_MAP = {
    0: "mon", 1: "tue", 2: "wed", 3: "thu", 4: "fri", 5: "sat", 6: "sun"
}


def _count_required_slots_for_range(state: AppState, start_iso: str, end_iso: str) -> int:
    """
    Count total required slots for a date range based on the weekly template.

    This calculates the actual staffing requirement that both solvers should try to fill.
    """
    if not state.weeklyTemplate:
        return 0

    # Build lookup: day_type -> list of (slot, required_count)
    required_by_day_type: Dict[str, int] = {}

    for location in state.weeklyTemplate.locations:
        for slot in location.slots:
            if slot.requiredSlots <= 0:
                continue

            # Find the col band to get the day type
            col_band = next((cb for cb in location.colBands if cb.id == slot.colBandId), None)
            if not col_band:
                continue

            day_type = col_band.dayType
            required_by_day_type[day_type] = required_by_day_type.get(day_type, 0) + slot.requiredSlots

    # Count days in range by type
    total_required = 0
    current = date.fromisoformat(start_iso)
    end = date.fromisoformat(end_iso)

    while current <= end:
        day_type = DAY_TYPE_MAP.get(current.weekday(), "mon")
        total_required += required_by_day_type.get(day_type, 0)
        current += timedelta(days=1)

    return total_required


def _count_filled_slots(assignments: List[Assignment], state: AppState) -> int:
    """
    Count how many required slot positions are filled by the assignments.

    Note: The rowId in assignments is the slot ID (e.g., "mri-neuro-mc-morning__mon"),
    not the section ID. We count all assignments that are not to pool rows.
    """
    # Get pool row IDs to exclude
    pool_ids = {row.id for row in state.rows if row.kind == "pool"}

    # Count assignments that are not to pools
    # The rowId is a slot ID, which won't match pool IDs directly
    count = 0
    for a in assignments:
        # Pool assignments would have rowId matching a pool row ID
        if a.rowId not in pool_ids:
            count += 1

    return count


@dataclass
class BenchmarkResult:
    """Results from a solver benchmark run."""
    duration_ms: float
    num_assignments: int
    slots_filled: int  # How many required slots were filled
    slots_required: int  # Total required slots from template
    notes: List[str]

    @property
    def coverage_pct(self) -> float:
        """Percentage of required slots that were filled."""
        if self.slots_required == 0:
            return 100.0
        return (self.slots_filled / self.slots_required) * 100


def _run_cpsat_solver(state: AppState, start_iso: str, end_iso: str) -> BenchmarkResult:
    """Run CP-SAT solver and return benchmark results."""
    import backend.solver
    original_load = backend.solver._load_state
    backend.solver._load_state = lambda _: state

    # Calculate required slots from template
    total_required = _count_required_slots_for_range(state, start_iso, end_iso)

    try:
        start = time.perf_counter()
        result = _solve_range_impl(
            SolveRangeRequest(
                startISO=start_iso,
                endISO=end_iso,
                only_fill_required=True,
                timeout_seconds=300,
            ),
            current_user=TEST_USER,
        )
        duration_ms = (time.perf_counter() - start) * 1000

        # Count actual slot fills (assignments to sections, not pools)
        slots_filled = _count_filled_slots(result.assignments, state)

        return BenchmarkResult(
            duration_ms=duration_ms,
            num_assignments=len(result.assignments),
            slots_filled=slots_filled,
            slots_required=total_required,
            notes=result.notes,
        )
    finally:
        backend.solver._load_state = original_load


def _run_heuristic_solver(state: AppState, start_iso: str, end_iso: str) -> BenchmarkResult:
    """Run heuristic solver v2 and return benchmark results."""
    cancel_event = threading.Event()

    # Calculate required slots from template
    total_required = _count_required_slots_for_range(state, start_iso, end_iso)

    def noop_progress(event_type, data):
        pass

    start = time.perf_counter()
    result = heuristic_solve_range_v2(
        SolveRangeRequest(
            startISO=start_iso,
            endISO=end_iso,
            only_fill_required=True,
            use_heuristic=True,
        ),
        state=state,
        cancel_event=cancel_event,
        on_progress=noop_progress,
        start_time=start,
    )
    duration_ms = (time.perf_counter() - start) * 1000

    # Convert result assignments to Assignment objects for counting
    assignments = [
        Assignment(**a) for a in result.get("assignments", [])
    ]
    slots_filled = _count_filled_slots(assignments, state)

    return BenchmarkResult(
        duration_ms=duration_ms,
        num_assignments=len(result["assignments"]),
        slots_filled=slots_filled,
        slots_required=total_required,
        notes=result.get("notes", []),
    )


class TestSolverBenchmark:
    """Performance comparison between CP-SAT and Heuristic solvers."""

    def _format_results(
        self,
        label: str,
        cpsat: BenchmarkResult,
        heur: BenchmarkResult,
    ) -> str:
        """Format benchmark results for display."""
        speedup = cpsat.duration_ms / heur.duration_ms if heur.duration_ms > 0 else float("inf")

        return (
            f"\n{'=' * 70}\n"
            f"  {label}\n"
            f"{'=' * 70}\n"
            f"  {'Metric':<20} | {'CP-SAT':<20} | {'Heuristic':<20}\n"
            f"  {'-' * 66}\n"
            f"  {'Time':<20} | {cpsat.duration_ms:>17.1f} ms | {heur.duration_ms:>17.1f} ms\n"
            f"  {'Assignments':<20} | {cpsat.num_assignments:>20} | {heur.num_assignments:>20}\n"
            f"  {'Required Slots':<20} | {cpsat.slots_required:>20} | {heur.slots_required:>20}\n"
            f"  {'Slots Filled':<20} | {cpsat.slots_filled:>20} | {heur.slots_filled:>20}\n"
            f"  {'Slot Coverage':<20} | {cpsat.coverage_pct:>19.1f}% | {heur.coverage_pct:>19.1f}%\n"
            f"  {'-' * 66}\n"
            f"  Speedup: {speedup:.1f}x faster\n"
            f"{'=' * 70}"
        )

    def test_benchmark_1_day(self) -> None:
        """Benchmark: 1 day (Monday)."""
        state = make_martin_like_state(day_types=["mon"])
        start_iso = "2026-01-05"
        end_iso = "2026-01-05"

        cpsat = _run_cpsat_solver(state, start_iso, end_iso)
        heur = _run_heuristic_solver(state, start_iso, end_iso)

        print(self._format_results("1 DAY (Monday)", cpsat, heur))

        assert cpsat.num_assignments > 0, "CP-SAT should produce assignments"
        assert heur.num_assignments > 0, "Heuristic should produce assignments"

    def test_benchmark_7_days(self) -> None:
        """Benchmark: 7 days (full work week Mon-Fri + weekend placeholder)."""
        state = make_martin_like_state(day_types=["mon", "tue", "wed", "thu", "fri"])
        start_iso = "2026-01-05"
        end_iso = "2026-01-11"

        cpsat = _run_cpsat_solver(state, start_iso, end_iso)
        heur = _run_heuristic_solver(state, start_iso, end_iso)

        print(self._format_results("7 DAYS (1 week)", cpsat, heur))

        assert cpsat.num_assignments > 0, "CP-SAT should produce assignments"
        assert heur.num_assignments > 0, "Heuristic should produce assignments"

    def test_benchmark_4_weeks(self) -> None:
        """Benchmark: 4 weeks (28 days)."""
        state = make_martin_like_state(day_types=["mon", "tue", "wed", "thu", "fri"])
        start_iso = "2026-01-05"
        end_date = date(2026, 1, 5) + timedelta(days=27)
        end_iso = end_date.isoformat()

        cpsat = _run_cpsat_solver(state, start_iso, end_iso)
        heur = _run_heuristic_solver(state, start_iso, end_iso)

        print(self._format_results("4 WEEKS (28 days)", cpsat, heur))

        assert cpsat.num_assignments > 0, "CP-SAT should produce assignments"
        assert heur.num_assignments > 0, "Heuristic should produce assignments"

    def test_benchmark_8_weeks(self) -> None:
        """Benchmark: 8 weeks (56 days)."""
        state = make_martin_like_state(day_types=["mon", "tue", "wed", "thu", "fri"])
        start_iso = "2026-01-05"
        end_date = date(2026, 1, 5) + timedelta(days=55)
        end_iso = end_date.isoformat()

        cpsat = _run_cpsat_solver(state, start_iso, end_iso)
        heur = _run_heuristic_solver(state, start_iso, end_iso)

        print(self._format_results("8 WEEKS (56 days)", cpsat, heur))

        assert cpsat.num_assignments > 0, "CP-SAT should produce assignments"
        assert heur.num_assignments > 0, "Heuristic should produce assignments"

    def test_benchmark_summary(self) -> None:
        """Run all benchmarks and print summary table."""
        state = make_martin_like_state(day_types=["mon", "tue", "wed", "thu", "fri"])

        benchmarks = [
            ("1 day", "2026-01-05", "2026-01-05"),
            ("7 days", "2026-01-05", "2026-01-11"),
            ("4 weeks", "2026-01-05", "2026-02-01"),
            ("8 weeks", "2026-01-05", "2026-03-01"),
        ]

        results = []
        for label, start_iso, end_iso in benchmarks:
            cpsat = _run_cpsat_solver(state, start_iso, end_iso)
            heur = _run_heuristic_solver(state, start_iso, end_iso)
            speedup = cpsat.duration_ms / heur.duration_ms if heur.duration_ms > 0 else float("inf")
            results.append((label, cpsat, heur, speedup))

        # Print summary table
        print("\n")
        print("=" * 110)
        print("  SOLVER BENCHMARK SUMMARY")
        print("=" * 110)
        print(f"  {'Range':<10} | {'CP-SAT':<12} | {'Heuristic':<12} | {'Speedup':<8} | {'Required':<10} | {'CP-SAT':<12} | {'Heuristic':<12}")
        print(f"  {'':<10} | {'(time)':<12} | {'(time)':<12} | {'':<8} | {'Slots':<10} | {'Coverage':<12} | {'Coverage':<12}")
        print("-" * 110)
        for label, cpsat, heur, speedup in results:
            cpsat_cov = f"{cpsat.slots_filled}/{cpsat.slots_required} ({cpsat.coverage_pct:.0f}%)"
            heur_cov = f"{heur.slots_filled}/{heur.slots_required} ({heur.coverage_pct:.0f}%)"
            print(f"  {label:<10} | {cpsat.duration_ms:>10.0f}ms | {heur.duration_ms:>10.0f}ms | {speedup:>6.1f}x  | {cpsat.slots_required:>10} | {cpsat_cov:>12} | {heur_cov:>12}")
        print("=" * 110)
        print("  Coverage = Slots Filled / Required Slots (actual staffing coverage from template)")
        print("=" * 110)
