"""Admin-controlled agent settings (model choice) and per-user AI budgets.

The model the planning agent runs on is a GLOBAL, admin-only setting: regular
users cannot pick their own (the per-user ``solverSettings.agentModel`` key is
ignored since this module exists). Every user shares one spending cap
(``budget_usd``, default $5) tracked cumulatively per account in the
``agent_spend`` table; once reached, agent runs degrade to the heuristic
draft until an admin raises the budget.

Pricing mirrors ``src/lib/llmPricing.ts`` (USD per million tokens, cache
reads at 0.1x and cache writes at 1.25x the input rate) — update both tables
together when Anthropic prices change. Anthropic bills in USD, so the budget
is stored in USD too.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .auth import UserPublic, _get_current_user, _require_admin
from .db import _get_connection

DEFAULT_AGENT_MODEL = "claude-sonnet-5"
DEFAULT_BUDGET_USD = 5.0

# model id -> (input USD/MTok, output USD/MTok)
MODEL_PRICES: Dict[str, tuple] = {
    "claude-opus-4-8": (5.0, 25.0),
    "claude-sonnet-5": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
}

_SETTING_MODEL = "agent_model"
_SETTING_BUDGET = "budget_usd"


def get_agent_admin_settings() -> Dict[str, Any]:
    with _get_connection() as conn:
        rows = conn.execute("SELECT key, value FROM agent_settings").fetchall()
    values = {row["key"]: row["value"] for row in rows}
    model = values.get(_SETTING_MODEL) or DEFAULT_AGENT_MODEL
    try:
        budget = float(values.get(_SETTING_BUDGET, DEFAULT_BUDGET_USD))
    except (TypeError, ValueError):
        budget = DEFAULT_BUDGET_USD
    return {"model": model, "budget_usd": budget}


def _set_setting(key: str, value: str) -> None:
    with _get_connection() as conn:
        conn.execute(
            "INSERT INTO agent_settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        conn.commit()


def get_spend_usd(username: str) -> float:
    with _get_connection() as conn:
        row = conn.execute(
            "SELECT total_cost_usd FROM agent_spend WHERE username = ?", (username,)
        ).fetchone()
    return float(row["total_cost_usd"]) if row else 0.0


def add_spend_usd(username: str, cost_usd: float) -> None:
    if cost_usd <= 0:
        return
    now = datetime.now(timezone.utc).isoformat()
    with _get_connection() as conn:
        conn.execute(
            "INSERT INTO agent_spend (username, total_cost_usd, updated_at) "
            "VALUES (?, ?, ?) "
            "ON CONFLICT(username) DO UPDATE SET "
            "total_cost_usd = total_cost_usd + excluded.total_cost_usd, "
            "updated_at = excluded.updated_at",
            (username, cost_usd, now),
        )
        conn.commit()


def all_spend_usd() -> List[Dict[str, Any]]:
    with _get_connection() as conn:
        rows = conn.execute(
            "SELECT username, total_cost_usd FROM agent_spend "
            "ORDER BY total_cost_usd DESC"
        ).fetchall()
    return [
        {"username": row["username"], "spent_usd": round(float(row["total_cost_usd"]), 4)}
        for row in rows
    ]


def estimate_cost_usd(model: Optional[str], usage: Optional[Dict[str, Any]]) -> float:
    """Run cost from token counts; 0 for unknown models (an admin can only
    pick priced models, so unknown means a custom AGENT_MODEL env override —
    those installs manage cost themselves)."""
    if not usage or not model:
        return 0.0
    prices = MODEL_PRICES.get(model)
    if prices is None:
        return 0.0
    per_in = prices[0] / 1_000_000
    per_out = prices[1] / 1_000_000

    def _tok(key: str) -> int:
        value = usage.get(key)
        return int(value) if isinstance(value, (int, float)) else 0

    return (
        _tok("input_tokens") * per_in
        + _tok("cache_read_input_tokens") * per_in * 0.1
        + _tok("cache_creation_input_tokens") * per_in * 1.25
        + _tok("output_tokens") * per_out
    )


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

router = APIRouter()


class AgentSettingsUpdate(BaseModel):
    model: Optional[str] = None
    budget_usd: Optional[float] = None


@router.get("/v1/agent/settings")
def read_agent_settings(current_user: UserPublic = Depends(_get_current_user)) -> dict:
    settings = get_agent_admin_settings()
    spent = get_spend_usd(current_user.username)
    out = {
        "model": settings["model"],
        "budget_usd": settings["budget_usd"],
        "spent_usd": round(spent, 4),
        "remaining_usd": round(max(0.0, settings["budget_usd"] - spent), 4),
    }
    if current_user.role == "admin":
        out["usage"] = all_spend_usd()
    return out


@router.put("/v1/agent/settings")
def update_agent_settings(
    payload: AgentSettingsUpdate,
    _: UserPublic = Depends(_require_admin),
) -> dict:
    if payload.model is not None:
        if payload.model not in MODEL_PRICES:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown model. Choose one of: {', '.join(sorted(MODEL_PRICES))}",
            )
        _set_setting(_SETTING_MODEL, payload.model)
    if payload.budget_usd is not None:
        if not (0 <= payload.budget_usd <= 10_000):
            raise HTTPException(status_code=400, detail="Budget must be between 0 and 10000 USD.")
        _set_setting(_SETTING_BUDGET, str(float(payload.budget_usd)))
    return get_agent_admin_settings()
