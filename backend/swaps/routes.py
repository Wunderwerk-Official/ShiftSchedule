"""HTTP endpoints of the swap assistant: candidates, apply, undo and history.

Only the calendar owner uses them (JWT login, calendar = username); they are
never reachable through web or iCal publication tokens.
"""

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query

from ..account_lifecycle import authenticated_account_connection
from ..auth import _get_current_user
from ..models import UserPublic
from ..state import _load_state
from . import apply, labels, matching, policy, store
from .schemas import ApplyRequest, CandidatesRequest, UndoRequest

router = APIRouter()


@router.post("/v1/swaps/candidates")
def swap_candidates(payload: CandidatesRequest,
                    current_user: UserPublic = Depends(_get_current_user)) -> Dict[str, Any]:
    # Loading can normalize and save the calendar, so this needs a write transaction.
    with authenticated_account_connection(current_user) as conn:
        state = _load_state(current_user.username, connection=conn)
        rules = policy.load_rules(conn, current_user.username)
    if payload.expectedRevision and payload.expectedRevision != state.revision:
        raise matching.swap_error(409, "state_changed", labels.STATE_CHANGED, revision=state.revision)
    # The search is pure computation on the loaded copy: it runs outside the account lock.
    ctx = matching.SwapContext(state, rules, policy.utc_now())
    return matching.find_candidates(ctx, payload)


@router.post("/v1/swaps/apply")
def swap_apply(payload: ApplyRequest,
               current_user: UserPublic = Depends(_get_current_user)) -> Dict[str, Any]:
    if not payload.consent:
        raise matching.swap_error(400, "consent_required", labels.CONSENT_REQUIRED)
    with authenticated_account_connection(current_user) as conn:
        record, state = apply.apply_swap(conn, current_user.username, payload, policy.utc_now())
    return {"swap": record, "state": state.model_dump()}


@router.post("/v1/swaps/{swap_id}/undo")
def swap_undo(swap_id: str, payload: UndoRequest,
              current_user: UserPublic = Depends(_get_current_user)) -> Dict[str, Any]:
    with authenticated_account_connection(current_user) as conn:
        record, state = apply.undo_swap(conn, current_user.username, swap_id, payload.expectedRevision,
                                        policy.utc_now())
    return {"swap": record, "state": state.model_dump()}


@router.get("/v1/swaps/history")
def swap_history(
    limit: int = Query(50, ge=1, le=200),
    before: Optional[str] = None,
    beforeId: Optional[str] = None,
    current_user: UserPublic = Depends(_get_current_user),
) -> Dict[str, Any]:
    with authenticated_account_connection(current_user) as conn:
        state = _load_state(current_user.username, connection=conn)
        rules = policy.load_rules(conn, current_user.username)
        rows = store.list_swaps(conn, current_user.username, limit=limit, before=before, before_id=beforeId)
    now = policy.utc_now()
    return {"swaps": [apply.serialize_swap(row, state, rules, now) for row in rows]}
