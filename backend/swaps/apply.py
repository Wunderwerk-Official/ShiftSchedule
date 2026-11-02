"""Apply and undo a swap inside the caller's account transaction.

Both re-derive everything from the stored calendar, as run apply does
(run_apply.apply_stored_run): the request only names what the preview showed,
and anything that changed since then is a 409. Neither commits; the route's
authenticated_account_connection commits on success and rolls back on any
HTTPException. No auto-backup is written: the single reserved backup slot
belongs to run apply, snapshot restore and the shifts file import, and undo
restores a swap exactly.
"""

import sqlite3
from dataclasses import asdict
from datetime import datetime
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Sequence, Set, Tuple

from fastapi import HTTPException

from .. import schedule_changes
from ..assignment_policy import REST_DAY_ROW_ID
from ..constraint_policy import baseline_index, is_new_or_worsened, new_violations
from ..models import AppState, Assignment
from ..state import _load_state, _normalize_state, _save_state
from ..validation import VIOLATION_REST_DAY, Violation, _build_slot_lookup
from . import labels, matching, store
from .blocks import SwapUnit, abs_minute, instance_unit, is_hidden, local_iso, slot_fingerprint, unit_for
from .matching import MovePlan, RestDayMove, SwapContext, swap_error
from .policy import OpenSlotInfo, StartStatus, SwapRules, load_rules, open_slot, start_status
from .schemas import ApplyRequest, ItemRefIn


def _state_changed(state: AppState) -> HTTPException:
    return swap_error(409, "state_changed", labels.STATE_CHANGED, revision=state.revision)


def _stale(message: str) -> HTTPException:
    return swap_error(409, "swap_stale", message)


def _invalid_request(message: str) -> HTTPException:
    return swap_error(400, "invalid_request", message)


def _check_people(ctx: SwapContext, req: ApplyRequest) -> None:
    """A request that cannot describe one swap of this calendar's people is a
    400. A holder that changed since the preview is not: its lookup by value
    fails later and gives swap_stale."""
    clinicians = ctx.vctx.clinicians_by_id
    if req.partnerId not in clinicians:
        raise _invalid_request(labels.INVALID_UNKNOWN_PERSON)
    givers = {ref.clinicianId for ref in req.give}
    if len(givers) > 1 or any(ref.clinicianId != req.partnerId for ref in req.take or []):
        raise _invalid_request(labels.INVALID_ITEMS)
    if givers and next(iter(givers)) not in clinicians:
        raise _invalid_request(labels.INVALID_UNKNOWN_PERSON)
    if req.partnerId in givers:
        raise _invalid_request(labels.INVALID_SAME_PERSON)


def _find(ctx: SwapContext, ref: ItemRefIn) -> Optional[Assignment]:
    return next((a for a in ctx.by_person.get(ref.clinicianId, [])
                 if a.rowId == ref.rowId and a.dateISO == ref.dateISO), None)


def _resolve_unit(ctx: SwapContext, refs: Sequence[ItemRefIn], *, whole_day: bool) -> SwapUnit:
    """The unit the refs name, re-derived from the stored plan: every item
    must still exist, be visible and keep its times, place and section, and
    the unit must still consist of exactly these items."""
    holder_id = refs[0].clinicianId
    name = ctx.name(holder_id)
    stored: List[Assignment] = []
    for ref in refs:
        a = _find(ctx, ref)
        if a is None or ref.fp != slot_fingerprint(ctx.vctx, ref.rowId):
            raise _stale(labels.stale_item(name, ref.dateISO))
        if is_hidden(ctx.vctx, a):
            raise _stale(labels.stale_now_hidden(name, ref.dateISO))
        stored.append(a)
    unit = unit_for(ctx.vctx, ctx.by_person[holder_id], stored[0], whole_day=whole_day)
    if {(i.slot_id, i.date_iso, i.clinician_id) for i in unit.items} != {
            (ref.rowId, ref.dateISO, ref.clinicianId) for ref in refs}:
        raise _stale(labels.stale_item(name, refs[0].dateISO))
    return unit


def _resolve_cover(
    ctx: SwapContext,
    req: ApplyRequest,
) -> Tuple[SwapUnit, OpenSlotInfo, Optional[Assignment]]:
    ref = req.slot
    unit = instance_unit(ctx.vctx, ref.rowId, ref.dateISO)
    # The preview's hours and acknowledged warnings assumed these times and this place.
    if unit is None or ref.fp != slot_fingerprint(ctx.vctx, ref.rowId):
        raise _stale(labels.STALE_SLOT_TIMES)
    slot = open_slot(ctx.vctx, ctx.by_instance, ref.rowId, ref.dateISO)
    if not slot.is_open:
        raise _stale(labels.STALE_SLOT)
    if any(a.clinicianId == req.partnerId for a in slot.stored):
        raise _stale(labels.stale_partner_in_slot(ctx.name(req.partnerId)))
    hidden = None
    if req.removeHidden is not None:
        if not slot.hidden or slot.hidden[0].clinicianId != req.removeHidden.clinicianId:
            raise _stale(labels.STALE_HIDDEN)
        hidden = slot.hidden[0]
    return unit, slot, hidden


def _requested_moves(req: ApplyRequest, detected: Sequence[RestDayMove]) -> List[RestDayMove]:
    """The requested subset of the rest-day moves detected now."""
    by_key = {(m.from_id, m.to_id, m.date_iso): m for m in detected}
    moves: Dict[Tuple[str, str, str], RestDayMove] = {}
    for requested in req.restDayMoves:
        key = (requested.fromClinicianId, requested.toClinicianId, requested.dateISO)
        if key not in by_key:
            raise _stale(labels.STALE_REST_DAY)
        moves[key] = by_key[key]
    return list(moves.values())


def _check_timing(req: ApplyRequest, statuses: Sequence[StartStatus], rules: SwapRules) -> bool:
    """409 when a moved unit started, or starts inside the notice period without
    the override. Returns whether the override was needed."""
    if any(status.started for status in statuses):
        raise swap_error(409, "swap_started", labels.STARTED)
    inside = any(status.inside_notice for status in statuses)
    if inside and not req.overrideNotice:
        hours_left = min(status.hours_until for status in statuses)
        raise swap_error(409, "notice_override_required", labels.notice(hours_left, rules.notice_hours),
                         hoursLeft=hours_left)
    return inside


def _check_normalized(state: AppState, candidate: List[Assignment]) -> None:
    """Refuse a change the next load would silently alter (template or holiday drift)."""
    candidate_state = state.model_copy(deep=True)  # _normalize_state mutates its argument
    candidate_state.assignments = candidate
    normalized, _ = _normalize_state(candidate_state)
    if normalized.assignments != candidate:
        raise swap_error(409, "plan_invalid", labels.PLAN_INVALID)


def _swap_invalid(
    ctx: SwapContext,
    violations: Sequence[Violation],
    *,
    partner_id: Optional[str],
    new_items: Sequence[Assignment],
    describe: Callable[[Sequence[str]], str] = labels.swap_invalid,
) -> HTTPException:
    reasons = [message for _code, message in matching.ranked_reasons(
        ctx, violations, partner_id=partner_id, new_items=matching.new_item_keys(new_items))]
    return swap_error(409, "swap_invalid", describe(reasons),
                      violations=[asdict(v) for v in violations], reasons=reasons)


Entry = Tuple[str, str, str]  # (clinicianId, dateISO, rowId)


def _rest_work_pairs(entries: Sequence[Entry]) -> Set[Entry]:
    """The REST_DAY pairs of ``entries``: every shift dated on a day its person
    holds a Rest Day entry. Any non-pool entry is a shift, as for
    validate_rest_days, one hidden by a vacation too."""
    resting = {(clinician_id, date_iso) for clinician_id, date_iso, row_id in entries
               if row_id == REST_DAY_ROW_ID}
    return {(clinician_id, date_iso, row_id) for clinician_id, date_iso, row_id in entries
            if not row_id.startswith("pool-") and (clinician_id, date_iso) in resting}


def _item_refs(ctx: SwapContext, unit: SwapUnit) -> List[Dict[str, Any]]:
    return [{"assignmentId": item.assignment.id if item.assignment is not None else None,
             "rowId": item.slot_id, "dateISO": item.date_iso, "clinicianId": item.clinician_id,
             "fp": slot_fingerprint(ctx.vctx, item.slot_id)} for item in unit.items]


def _summary_items(ctx: SwapContext, unit: Optional[SwapUnit]) -> List[Dict[str, Any]]:
    if unit is None:
        return []
    return [{"rowId": item.slot_id, "dateISO": item.date_iso,
             "sectionName": ctx.section_name(item.section_id),
             "start": local_iso(item.abs_start), "end": local_iso(item.abs_end)} for item in unit.items]


def _summary(ctx: SwapContext, plan: MovePlan) -> Dict[str, Any]:
    """Names and labels at apply time, so History survives renames and deletions."""
    hidden = plan.hidden_removal
    return {
        "requesterName": ctx.name(plan.giver_id) if plan.giver_id is not None else None,
        "partnerName": ctx.name(plan.partner_id),
        "give": _summary_items(ctx, plan.give),
        "take": _summary_items(ctx, plan.take),
        "restDayMoves": [{"fromClinicianId": m.from_id, "toClinicianId": m.to_id, "dateISO": m.date_iso}
                         for m in plan.rest_day_moves],
        "restDaysRemoved": matching.rest_day_removal_days(ctx, plan),
        "hiddenRemoved": ({"clinicianId": hidden.clinicianId, "name": ctx.name(hidden.clinicianId)}
                          if hidden is not None else None),
    }


def _clean(text: Optional[str]) -> Optional[str]:
    stripped = (text or "").strip()
    return stripped or None


def apply_swap(conn: sqlite3.Connection, username: str, req: ApplyRequest,
               now: datetime) -> Tuple[Dict[str, Any], AppState]:
    """Validate and commit one swap, handover or cover; returns (SwapRecord, saved state)."""
    state = _load_state(username, connection=conn)
    rules = load_rules(conn, username)
    if req.expectedRevision != state.revision:
        raise _state_changed(state)
    ctx = SwapContext(state, rules, now)
    _check_people(ctx, req)
    cover = hidden = take = None
    if req.mode == "cover":
        give, cover, hidden = _resolve_cover(ctx, req)
    else:
        give = _resolve_unit(ctx, req.give, whole_day=req.wholeDay)
        if req.mode == "swap":
            take = _resolve_unit(ctx, req.take, whole_day=False)
            # The search never pairs blocks that share a slot instance: such a
            # "swap" would really be a handover of the other items, or nothing.
            if give.instance_keys & take.instance_keys:
                raise _invalid_request(labels.INVALID_SHARED_SLOT)
    work = matching.build_move_plan(ctx, req.mode, give, req.partnerId, take=take, cover=cover,
                                    hidden_removal=hidden)
    moves = _requested_moves(req, matching.detected_rest_day_moves(ctx, work))
    statuses = [start_status(unit.abs_start, rules, now) for unit in (give, take) if unit is not None]
    inside_notice = _check_timing(req, statuses, rules)

    swap_id = store.new_swap_id()
    plan = matching.build_move_plan(ctx, req.mode, give, req.partnerId, take=take, cover=cover,
                                    rest_day_moves=moves, hidden_removal=hidden, id_prefix=swap_id)
    candidate = matching.apply_plan(state.assignments, plan)
    _check_normalized(state, candidate)
    violations, resolved = matching.full_gate(state, plan)
    if violations:
        raise _swap_invalid(ctx, violations, partner_id=plan.partner_id, new_items=plan.added)
    warnings = matching.plan_warnings(ctx, plan, scope="full")
    if any(w.id not in req.acknowledgedWarnings for w in warnings):
        raise swap_error(409, "warnings_unacknowledged", labels.WARNINGS_UNACK,
                         warnings=[w.as_json() for w in warnings])

    old_blob = state.model_dump(exclude={"revision"})
    state.assignments = candidate
    _save_state(state, username, connection=conn)
    now_iso = store.iso_utc(now)
    actor = f"user:{username}"
    change_id = schedule_changes.record_swap_change(
        username, "swap_applied", swap_id, req.mode, old_blob, state.model_dump(exclude={"revision"}),
        connection=conn)
    acknowledged = [{"id": w.id, "code": w.code, "message": w.message} for w in warnings]
    approver = _clean(req.approverName)
    row: Dict[str, Any] = {
        "id": swap_id,
        "username": username,
        "kind": req.mode,
        "status": "applied",
        "requester_id": plan.giver_id,
        "partner_id": plan.partner_id,
        "give_items": _item_refs(ctx, plan.give),
        "take_items": _item_refs(ctx, plan.take) if plan.take is not None else None,
        "summary": _summary(ctx, plan),
        "note": _clean(req.note),
        "consent": "confirmed_by_planner",
        "created_via": "planner",
        "created_by": actor,
        "approver_name": approver,
        "notice_override": 1 if req.overrideNotice and inside_notice else 0,
        "acknowledged_warnings": acknowledged,
        "starts_at": store.iso_utc(min(status.starts_at for status in statuses)),
        "expires_at": None,
        "client_request_id": None,
        "created_at": now_iso,
        "updated_at": now_iso,
        "decided_at": now_iso,
        "decided_by": actor,
        "applied_at": now_iso,
        "applied_revision": state.revision,
        "applied_patch": {"removed": [a.model_dump() for a in plan.removed],
                          "added": [a.model_dump() for a in plan.added],
                          "resolved": [asdict(v) for v in resolved]},
        "change_id": change_id,
        "reverted_at": None,
        "reverted_by": None,
        "reverted_revision": None,
        "revert_change_id": None,
    }
    store.insert_swap(conn, row)
    store.add_event(conn, username, swap_id, actor, "applied", {
        "revision": state.revision,
        "noticeOverride": bool(row["notice_override"]),
        "acknowledgedWarnings": [w.id for w in warnings],
        "approverName": approver,
    }, now_iso)
    store.prune(conn, username, now)
    return serialize_swap(row, state, rules, now), state


class UndoBlock(NamedTuple):
    """Why a swap can no longer be undone: the 409 code and message of the
    undo, and the shorter History reason."""

    code: str
    message: str
    reason: str


def _conflict(reason: str, message: str = labels.UNDO_CONFLICT) -> UndoBlock:
    return UndoBlock("undo_conflict", message, reason)


def _names_at_apply(row: Dict[str, Any]) -> Dict[str, str]:
    """clinicianId -> name of everyone a swap touched, from its summary."""
    summary = row["summary"]
    names = {entry["clinicianId"]: entry["name"] for entry in summary.get("restDaysRemoved") or []}
    hidden = summary.get("hiddenRemoved")
    if hidden:
        names[hidden["clinicianId"]] = hidden["name"]
    if row["requester_id"]:
        names[row["requester_id"]] = summary["requesterName"]
    names[row["partner_id"]] = summary["partnerName"]
    return names


def _undo_check(
    row: Dict[str, Any],
    state: AppState,
    rules: SwapRules,
    now: datetime,
) -> Tuple[List[Assignment], Optional[UndoBlock]]:
    """(the stored objects of the patch's added assignments, None), or ([], why)
    when the swap can no longer be undone. Added assignments match by (id,
    rowId, dateISO, clinicianId): a lock toggle or another source is no change."""
    patch = row["applied_patch"]
    clinicians = {c.id: c for c in state.clinicians}
    gone = next((dump["clinicianId"] for dump in patch["removed"] + patch["added"]
                 if dump["clinicianId"] not in clinicians), None)
    if gone is not None:
        name = _names_at_apply(row).get(gone)
        return [], _conflict(labels.undo_person_gone(name), labels.undo_person_gone_conflict(name))
    # History checks every row against the whole calendar: one cheap pass each.
    wanted = {dump["id"]: (dump["rowId"], dump["dateISO"], dump["clinicianId"]) for dump in patch["added"]}
    removed = {(dump["rowId"], dump["dateISO"], dump["clinicianId"]) for dump in patch["removed"]}
    removed_dates = {date_iso for _row, date_iso, _clinician in removed}
    # The person-days undo restores entries to: dropping an entry never pairs
    # a Rest Day with a shift, so only on these days can undo create a pair.
    restored_days = {(clinician_id, date_iso) for _row, date_iso, clinician_id in removed}
    found: Dict[str, Assignment] = {}
    recreated = False
    on_restored_days: List[Assignment] = []
    for a in state.assignments:
        if wanted.get(a.id) == (a.rowId, a.dateISO, a.clinicianId):
            found.setdefault(a.id, a)
        if a.dateISO in removed_dates:
            if (a.rowId, a.dateISO, a.clinicianId) in removed:
                recreated = True
            if (a.clinicianId, a.dateISO) in restored_days:
                on_restored_days.append(a)
    if len(found) < len(wanted):
        return [], _conflict(labels.UNDO_NOT_IN_PLAN)
    if recreated:
        return [], _conflict(labels.UNDO_CHANGED)
    # Apply never leaves a person resting and working on one day; undo must
    # not either, whether the Rest Day or the shift is the one it restores.
    # A pair the calendar holds now, or one that existed before the swap (the
    # swap resolved it), may come back: exactly the undo gate's REST_DAY rule,
    # so this dedicated text, not the gate's, explains every such refusal.
    current = [(a.clinicianId, a.dateISO, a.rowId) for a in on_restored_days]
    after_undo = [entry for a, entry in zip(on_restored_days, current) if found.get(a.id) is not a]
    after_undo += [(dump["clinicianId"], dump["dateISO"], dump["rowId"]) for dump in patch["removed"]]
    before_swap = {(v["clinician_id"], v["date_iso"], v["slot_id"])
                   for v in patch.get("resolved", []) if v["code"] == VIOLATION_REST_DAY}
    clashes = sorted(_rest_work_pairs(after_undo) - _rest_work_pairs(current) - before_swap,
                     key=lambda pair: (pair[1], pair[0], pair[2]))
    if clashes:
        clinician_id, date_iso, _row_id = clashes[0]
        name = clinicians[clinician_id].name
        return [], _conflict(labels.undo_rest_and_work(name, date_iso),
                             labels.undo_rest_and_work_conflict(name, date_iso))
    lookup = _build_slot_lookup(state)
    for dump in patch["added"] + patch["removed"]:
        interval = lookup.get(dump["rowId"])
        if dump["rowId"].startswith("pool-") or interval is None:
            continue
        if start_status(abs_minute(dump["dateISO"], interval[0]), rules, now).started:
            return [], UndoBlock("swap_started", labels.UNDO_STARTED, labels.UNDO_ALREADY_STARTED)
    return [found[dump["id"]] for dump in patch["added"]], None


def undo_status(
    row: Dict[str, Any],
    state: AppState,
    rules: SwapRules,
    now: datetime,
) -> Tuple[bool, Optional[str]]:
    """Whether an applied swap can still be undone, else the History reason."""
    block = _undo_check(row, state, rules, now)[1]
    return block is None, block.reason if block is not None else None


def undo_swap(conn: sqlite3.Connection, username: str, swap_id: str, expected_revision: str,
              now: datetime) -> Tuple[Dict[str, Any], AppState]:
    """Put back exactly what the swap removed and drop what it added. No
    acknowledgement or notice override: undo restores the planner's own
    earlier arrangement, but it must still be untouched, unstarted and valid."""
    row = store.get_swap(conn, username, swap_id)
    if row is None:
        raise swap_error(404, "swap_not_found", labels.NOT_FOUND)
    if row["status"] == "reverted":
        raise swap_error(409, "already_reverted", labels.ALREADY_REVERTED)
    state = _load_state(username, connection=conn)
    rules = load_rules(conn, username)
    if expected_revision != state.revision:
        raise _state_changed(state)
    added, block = _undo_check(row, state, rules, now)
    if block is not None:
        raise swap_error(409, block.code, block.message)
    dropped = {id(a) for a in added}
    # The dumps restore the original ids, sources and locks.
    restored = [Assignment.model_validate(dump) for dump in row["applied_patch"]["removed"]]
    candidate = [a for a in state.assignments if id(a) not in dropped] + restored
    _check_normalized(state, candidate)
    # What the swap resolved existed before it (a vacation-hidden shift it
    # removed, a week it brought under the limit): undo may bring that back,
    # no worse than it was. Anything else new or worse blocks, as at apply.
    before_swap = baseline_index(Violation(**v) for v in row["applied_patch"].get("resolved", []))
    violations = [v for v in new_violations(state, state.assignments, candidate, only_fill_required=True,
                                            own_rest_days=True)
                  if is_new_or_worsened(v, before_swap)]
    if violations:
        raise _swap_invalid(SwapContext(state, rules, now), violations, partner_id=row["partner_id"],
                            new_items=restored, describe=labels.undo_invalid)

    old_blob = state.model_dump(exclude={"revision"})
    state.assignments = candidate
    _save_state(state, username, connection=conn)
    now_iso = store.iso_utc(now)
    actor = f"user:{username}"
    change_id = schedule_changes.record_swap_change(
        username, "swap_reverted", swap_id, row["kind"], old_blob, state.model_dump(exclude={"revision"}),
        connection=conn)
    store.mark_reverted(conn, username, swap_id, reverted_at=now_iso, reverted_by=actor,
                        revision=state.revision, change_id=change_id)
    store.add_event(conn, username, swap_id, actor, "reverted", {"revision": state.revision}, now_iso)
    store.prune(conn, username, now)
    reverted = {**row, "status": "reverted", "reverted_at": now_iso, "reverted_by": actor,
                "reverted_revision": state.revision, "revert_change_id": change_id, "updated_at": now_iso}
    return serialize_swap(reverted, state, rules, now), state


def serialize_swap(row: Dict[str, Any], state: AppState, rules: SwapRules, now: datetime) -> Dict[str, Any]:
    """The API's SwapRecord; canUndo is computed live for applied rows."""
    can_undo, reason = undo_status(row, state, rules, now) if row["status"] == "applied" else (False, None)
    summary = row["summary"]
    return {
        "id": row["id"],
        "kind": row["kind"],
        "status": row["status"],
        "requesterId": row["requester_id"],
        "requesterName": summary["requesterName"],
        "partnerId": row["partner_id"],
        "partnerName": summary["partnerName"],
        "give": summary["give"],
        "take": summary["take"],
        "restDayMoves": summary["restDayMoves"],
        "restDaysRemoved": summary["restDaysRemoved"],
        "hiddenRemoved": summary["hiddenRemoved"],
        "note": row["note"],
        "approverName": row["approver_name"],
        "consent": row["consent"],
        "noticeOverride": bool(row["notice_override"]),
        "acknowledgedWarnings": row["acknowledged_warnings"],
        "createdAt": row["created_at"],
        "appliedAt": row["applied_at"],
        "revertedAt": row["reverted_at"],
        "canUndo": can_undo,
        "undoBlockedReason": reason,
    }
