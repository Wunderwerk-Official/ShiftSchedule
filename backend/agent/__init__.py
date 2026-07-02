"""LLM-agent-based shift planning.

Propose -> verify -> repair: the heuristic solver v2 produces a seed plan, an
LLM agent inspects it through tools (validation + scoring) and applies
assignment moves on a working copy. Structural guardrails ensure the final
plan is never worse than the seed and never introduces hard-constraint
violations.

Entry point: :func:`backend.agent.harness.agent_solve_range`, wired into the
solver mode switch in ``backend/solver.py``.
"""
