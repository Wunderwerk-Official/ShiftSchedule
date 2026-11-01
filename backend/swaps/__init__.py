"""Swap assistant for the rota planner: find, apply and undo a swap, a handover
or a cover of one calendar's shifts.

The package imports nothing on purpose, so the pure modules (blocks, policy,
worktime, labels) load without the FastAPI routes. No module imports the
solver, so a search or an apply never loads ortools.
"""
