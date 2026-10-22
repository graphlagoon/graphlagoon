"""Case annotations (05 §1, §5, §6): role | tag | group | same_as | hypothesis |
hypothesis_status | status_change over entities (unified ids) or
items. A person's are ``confirmed``; an agent's are ``suggested`` for the kinds
in ``settings.agent_suggest_kinds`` and confirmed or rejected in place.

Values by kind:
- role        targets=[entity], value={"role": "suspect"}
- tag         targets=[entity…], value={"tag": "…"}
- group       targets=[entity…], value={"name", "color"?, "closed"?}
- same_as     targets=[keep, drop], value={"score"?, "reasons"?}
- hypothesis  targets=[], value={"text", "status": open|supported|refuted, "evidence_for"?: [item ids], "evidence_against"?: […]}
- hypothesis_status  targets=[hypothesis annotation id], value={"status"}
- status_change (written by cases.update_investigation for agents) value={"from", "to"}
- decision_proposal  targets=[entity…]?, value={"outcome"? (the type's catalog) | "outcome_label" + "closes_case"?,
              "rationale", "tasks"?: [{action? | title, …}], "evidence"?: [{item_id, version}]}: a draft
              (06 P8, A4); always suggested, taken up by the decision that names it, or rejected
- task        targets=[entity…]?, value={"title", "state": open|done|cancelled, "assignee_kind": human|agent,
              "assignee"?: email, "agent_name"?: the agent token's name, "due_at"?: ISO datetime,
              "action"?: the case type's action, "decision_id"?: the decision that set it in motion}

Tasks are how people and agents coordinate (06 §1): they stay outside the freeze
(a closed case still gets its follow-ups done) and an agent edits only the tasks it
wrote or that are assigned to agents (its own name, or any agent when unnamed).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from graphlagoon.services.cases import (
    InvestigationError,
    _session,
    add_row,
    append_event,
    author_fields,
    commit,
    delete_row,
    get_current_actor,
    ensure_not_closed,
    get_row,
    list_rows,
    load_case,
    update_row,
    write_status,
)

TABLE = "case_annotations"
KINDS = ("role", "tag", "group", "same_as", "hypothesis", "hypothesis_status", "status_change", "task",
         "decision_proposal")
HYPOTHESIS_STATUSES = ("open", "supported", "refuted")
TASK_STATES = ("open", "done", "cancelled")
# Kinds a closed case still takes: follow-ups outlive the decision.
FREEZE_EXEMPT = frozenset({"task"})


def _invalid(message: str) -> InvestigationError:
    return InvestigationError(422, "INVALID_ANNOTATION", message)


async def _replace_roles(session, inv: Any, investigation_id: UUID, targets: list, role: str, keep: Any = None) -> None:
    """One confirmed role per entity: a new one replaces the previous; with the
    case type's ``roles_multi`` an entity keeps several (only the same role is replaced)."""
    from graphlagoon.services.case_types import get_case_type

    multi = bool((await get_case_type(inv.case_type) or {}).get("roles_multi"))
    for old in await list_rows(session, TABLE, investigation_id):
        if old.kind != "role" or old.status != "confirmed" or old.targets != targets or old.id == keep:
            continue
        if not multi or (old.value or {}).get("role") == role:
            await delete_row(session, TABLE, old)


def validate(kind: str, targets: list, value: dict) -> None:
    if kind not in KINDS:
        raise _invalid(f"Unknown annotation kind '{kind}'")
    if kind == "role" and (len(targets) != 1 or not value.get("role")):
        raise _invalid("A role annotation targets one entity and names the role")
    if kind == "tag" and (not targets or not value.get("tag")):
        raise _invalid("A tag annotation targets entities and names the tag")
    if kind == "group" and (not targets or not value.get("name")):
        raise _invalid("A group targets entities and has a name")
    if kind == "same_as" and (len(targets) != 2 or targets[0] == targets[1]):
        raise _invalid("same_as targets exactly two different entities (keep, drop)")
    if kind == "hypothesis":
        if not (value.get("text") or "").strip():
            raise _invalid("A hypothesis needs its text")
        if value.get("status", "open") not in HYPOTHESIS_STATUSES:
            raise _invalid(f"hypothesis status must be one of {HYPOTHESIS_STATUSES}")
    if kind == "hypothesis_status" and (len(targets) != 1 or value.get("status") not in HYPOTHESIS_STATUSES):
        raise _invalid("hypothesis_status targets one hypothesis and gives open|supported|refuted")
    if kind == "task":
        _validate_task(value)
    if kind == "decision_proposal":
        if not str(value.get("rationale") or "").strip():
            raise _invalid("A decision proposal needs its rationale")
        if not value.get("outcome") and not str(value.get("outcome_label") or "").strip():
            raise _invalid("A decision proposal names an outcome of the case type or an outcome_label")
        if not isinstance(value.get("tasks", []), list) or not isinstance(value.get("evidence", []), list):
            raise _invalid("tasks and evidence are lists")


def _validate_task(value: dict) -> None:
    if not str(value.get("title") or "").strip():
        raise _invalid("A task needs its title")
    if value.get("state") not in TASK_STATES:
        raise _invalid(f"task state must be one of {TASK_STATES}")
    if value.get("assignee_kind") not in ("human", "agent"):
        raise _invalid("task assignee_kind is human or agent")
    if value.get("due_at"):
        try:
            datetime.fromisoformat(str(value["due_at"]).replace("Z", "+00:00"))
        except ValueError:
            raise _invalid("task due_at is an ISO datetime")


async def _check_proposal(inv: Any, value: dict) -> None:
    """The outcome and the actions must exist in the case type, as the decision route checks."""
    from graphlagoon.services import case_types

    kind = await case_types.require_case_type(inv.case_type)
    if kind["outcomes"] and value.get("outcome") not in {o["id"] for o in kind["outcomes"]}:
        ids = ", ".join(o["id"] for o in kind["outcomes"])
        raise InvestigationError(422, "UNKNOWN_OUTCOME", f"The {kind['label']} type decides one of: {ids}")
    actions = {a["id"] for a in kind["actions"]}
    for t in value.get("tasks") or []:
        if isinstance(t, dict) and t.get("action") and t["action"] not in actions:
            raise InvestigationError(422, "UNKNOWN_ACTION", f"No action '{t['action']}' in the {kind['label']} type")


def _task_defaults(value: dict) -> dict:
    value = {"state": "open", "assignee_kind": "human", **value}
    value["title"] = str(value.get("title") or "").strip()
    if value["assignee_kind"] == "human":
        value.pop("agent_name", None)
    return value


def _guard(inv: Any, kind: str) -> None:
    """The freeze (409 on a closed case), except for the exempt kinds."""
    if kind not in FREEZE_EXEMPT:
        ensure_not_closed(inv)


def _agent_may_edit_task(row: Any) -> bool:
    actor = get_current_actor()
    if not actor:
        return True
    value = row.value or {}
    if row.author_kind == "agent" and str(row.agent_token_id) == str(actor["token_id"]):
        return True
    return value.get("assignee_kind") == "agent" and value.get("agent_name") in (None, "", actor.get("name"))


def serialize(a: Any) -> dict:
    return {
        "id": a.id,
        "kind": a.kind,
        "targets": a.targets or [],
        "value": a.value or {},
        "reason": a.reason,
        "status": a.status,
        "author_kind": a.author_kind,
        "author_email": a.author_email,
        "agent_token_id": a.agent_token_id,
        "confirmed_by": a.confirmed_by,
        "confirmed_at": a.confirmed_at,
        "created_at": a.created_at,
    }


async def _row(session, investigation_id: UUID, annotation_id: UUID) -> Any:
    row = await get_row(session, TABLE, annotation_id)
    if row is None or row.investigation_id != investigation_id:
        raise InvestigationError(404, "ANNOTATION_NOT_FOUND", f"Annotation '{annotation_id}' not found")
    return row


async def list_annotations(
    investigation_id: UUID,
    user_email: str,
    kind: Optional[str] = None,
    status: Optional[str] = None,
    target: Optional[str] = None,
) -> list[dict]:
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        rows = await list_rows(session, TABLE, investigation_id)
        return [
            serialize(a)
            for a in sorted(rows, key=lambda a: (a.created_at, str(a.id)))
            if (kind is None or a.kind == kind)
            and (status is None or a.status == status)
            and (target is None or target in (a.targets or []))
        ]


async def create_annotation(
    investigation_id: UUID,
    user_email: str,
    kind: str,
    targets: list,
    value: dict,
    reason: Optional[str] = None,
) -> dict:
    targets = [str(t) for t in targets or []]
    value = dict(value or {})
    if kind == "hypothesis":
        value.setdefault("status", "open")
    if kind == "task":
        value = _task_defaults(value)
    validate(kind, targets, value)
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _guard(inv, kind)
        if kind == "hypothesis_status":
            target = await _row(session, investigation_id, UUID(targets[0]))
            if target.kind != "hypothesis":
                raise _invalid("hypothesis_status must target a hypothesis")
        if kind == "decision_proposal":
            await _check_proposal(inv, value)
        # A proposal is always a draft for a person, whoever writes it.
        status = "suggested" if kind == "decision_proposal" else write_status(inv, kind)
        if kind == "role" and status == "confirmed":
            await _replace_roles(session, inv, investigation_id, targets, value["role"])
        row = await add_row(
            session,
            TABLE,
            investigation_id=investigation_id,
            kind=kind,
            targets=targets,
            value=value,
            reason=(reason or "").strip() or None,
            status=status,
            created_at=datetime.now(),
            **author_fields(user_email),
        )
        if kind == "hypothesis_status" and status == "confirmed":
            await _apply_hypothesis_status(session, investigation_id, row)
        await append_event(
            session,
            investigation_id,
            user_email,
            f"{kind}.{'suggested' if status == 'suggested' else 'set'}",
            {"annotation_id": str(row.id), "targets": targets, "value": value, **({"reason": row.reason} if row.reason else {})},
        )
        await commit(session)
        return serialize(row)


async def _apply_hypothesis_status(session, investigation_id: UUID, row: Any) -> None:
    hypothesis = await _row(session, investigation_id, UUID(row.targets[0]))
    await update_row(session, TABLE, hypothesis, value={**(hypothesis.value or {}), "status": row.value["status"]})


def _agent_may_edit(row: Any) -> bool:
    """An agent edits only what an agent wrote (a person's annotation, confirmed
    or not, is the person's); tasks follow ``_agent_may_edit_task``."""
    actor = get_current_actor()
    if not actor:
        return True
    if row.kind == "task":
        return _agent_may_edit_task(row)
    return row.author_kind == "agent"


async def update_annotation(
    investigation_id: UUID, user_email: str, annotation_id: UUID, changes: dict, kind: Optional[str] = None
) -> dict:
    """Edits value/targets/reason; the author, or an editor of the case. A task
    stays editable on a closed case. An agent edits only what agents wrote and
    the tasks assigned to it; its edit of a suggest kind is a suggestion again,
    and it moves a hypothesis only through ``hypothesis_status``. ``kind``: the
    kind the caller expects (``update_task``)."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        row = await _row(session, investigation_id, annotation_id)
        if kind is not None and row.kind != kind:
            raise InvestigationError(404, "ANNOTATION_NOT_FOUND", f"No {kind} with id '{annotation_id}'")
        _guard(inv, row.kind)
        if not _agent_may_edit(row):
            if row.kind == "task":
                raise InvestigationError(403, "TASK_NOT_YOURS", "An agent edits the tasks it wrote or that are assigned to it")
            raise InvestigationError(403, "ANNOTATION_NOT_YOURS", "An agent edits only what agents wrote; propose a change instead")
        targets = [str(t) for t in changes.get("targets", row.targets) or []]
        value = {**(row.value or {}), **(changes.get("value") or {})}
        if row.kind == "task":
            value = _task_defaults(value)
        agent = get_current_actor()
        if agent and row.kind == "hypothesis" and value.get("status") != (row.value or {}).get("status"):
            raise InvestigationError(
                403, "USE_HYPOTHESIS_STATUS", "An agent moves a hypothesis by writing a hypothesis_status (a person confirms it)"
            )
        validate(row.kind, targets, value)
        extra = {}
        if agent and row.kind != "task":
            extra["status"] = "suggested" if row.kind == "decision_proposal" else write_status(inv, row.kind)
        await update_row(
            session, TABLE, row, targets=targets, value=value, reason=changes.get("reason", row.reason), **extra
        )
        await append_event(
            session, investigation_id, user_email, f"{row.kind}.updated",
            {"annotation_id": str(annotation_id), "targets": targets, "value": value},
        )
        await commit(session)
        return serialize(row)


async def delete_annotation(investigation_id: UUID, user_email: str, annotation_id: UUID) -> dict:
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        row = await _row(session, investigation_id, annotation_id)
        _guard(inv, row.kind)
        if row.kind == "task" and not _agent_may_edit_task(row):
            raise InvestigationError(403, "TASK_NOT_YOURS", "An agent removes only the tasks it wrote or that are assigned to it")
        await delete_row(session, TABLE, row)
        await append_event(
            session, investigation_id, user_email, f"{row.kind}.removed",
            {"annotation_id": str(annotation_id), "targets": row.targets, "value": row.value},
        )
        await commit(session)
        return {"kind": row.kind}


async def set_status(investigation_id: UUID, user_email: str, annotation_id: UUID, status: str) -> dict:
    """confirm | reject a suggestion (people only; the route forbids agents).
    Confirming applies it: a role replaces the entity's previous one, a
    hypothesis_status moves its hypothesis, a status_change moves the case."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        row = await _row(session, investigation_id, annotation_id)
        await _apply_status(session, inv, investigation_id, user_email, row, status)
        await commit(session)
        return serialize(row)


async def set_status_many(investigation_id: UUID, user_email: str, annotation_ids: list[UUID], status: str) -> dict:
    """Confirm or reject several suggestions in one go (UX-1: "Confirm all"). Each is checked
    before any is applied, then all are applied in one transaction: an unknown id or a forbidden
    kind fails the whole call. Ones no longer suggested are skipped and listed."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        rows = [await _row(session, investigation_id, a) for a in dict.fromkeys(annotation_ids)]
        for row in rows:
            _guard(inv, row.kind)
            if row.kind == "decision_proposal" and status == "confirmed":
                raise InvestigationError(
                    409, "PROPOSAL_NEEDS_DECISION", "A proposal is taken up by recording the decision (proposal_id); reject it otherwise"
                )
        applied, skipped = [], []
        for row in rows:
            if row.status != "suggested":
                skipped.append(str(row.id))
                continue
            await _apply_status(session, inv, investigation_id, user_email, row, status)
            applied.append(serialize(row))
        await commit(session)
        return {"applied": applied, "skipped": skipped}


async def reopen(investigation_id: UUID, user_email: str, annotation_id: UUID) -> dict:
    """A rejected suggestion becomes a suggestion again (UX-1). Nothing was applied when it was
    rejected, so nothing is undone; only a rejected annotation reopens (409 ``NOT_REJECTED``)."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        row = await _row(session, investigation_id, annotation_id)
        _guard(inv, row.kind)
        if row.status != "rejected":
            raise InvestigationError(409, "NOT_REJECTED", "Only a rejected suggestion is reopened")
        await update_row(session, TABLE, row, status="suggested", confirmed_by=None, confirmed_at=None)
        await append_event(
            session, investigation_id, user_email, f"{row.kind}.reopened",
            {"annotation_id": str(annotation_id), "targets": row.targets, "value": row.value, "author_email": row.author_email},
        )
        await commit(session)
        return serialize(row)


async def _apply_status(session, inv, investigation_id: UUID, user_email: str, row, status: str) -> None:
    """One suggestion confirmed or rejected, with its effects and journal line (no commit)."""
    annotation_id = row.id
    _guard(inv, row.kind)
    if row.status != "suggested":
        raise InvestigationError(409, "NOT_SUGGESTED", "Only a suggestion is confirmed or rejected")
    if row.kind == "decision_proposal" and status == "confirmed":
        raise InvestigationError(
            409, "PROPOSAL_NEEDS_DECISION", "A proposal is taken up by recording the decision (proposal_id); reject it otherwise"
        )
    now = datetime.now()
    await update_row(session, TABLE, row, status=status, confirmed_by=user_email, confirmed_at=now)
    if status == "confirmed":
        if row.kind == "role":
            await _replace_roles(session, inv, investigation_id, row.targets, row.value["role"], keep=row.id)
        elif row.kind == "hypothesis_status":
            await _apply_hypothesis_status(session, investigation_id, row)
        elif row.kind == "status_change":
            from graphlagoon.services.cases import check_transition

            check_transition(inv, row.value["to"])
            if session is None:
                from graphlagoon.db.memory_store import get_memory_store

                get_memory_store().update_investigation(investigation_id, status=row.value["to"])
            else:
                inv.status = row.value["to"]
    await append_event(
        session, investigation_id, user_email, f"{row.kind}.{status}",
        {"annotation_id": str(annotation_id), "targets": row.targets, "value": row.value, "author_email": row.author_email},
    )


# ---------------------------------------------------------------------------
# Views used by the graph, the exports and the MCP tools
# ---------------------------------------------------------------------------


async def confirmed(session, investigation_id: UUID, kind: str) -> list:
    return [a for a in await list_rows(session, TABLE, investigation_id) if a.kind == kind and a.status == "confirmed"]


async def roles_of(session, investigation_id: UUID) -> dict[str, str]:
    """{entity: role} from the confirmed role annotations."""
    return {a.targets[0]: a.value["role"] for a in await confirmed(session, investigation_id, "role") if a.targets}


async def aliases_of(session, investigation_id: UUID) -> list[tuple[str, str]]:
    """Confirmed same_as pairs as (keep, drop) for ``case_graph.apply_aliases``."""
    return [(a.targets[0], a.targets[1]) for a in await confirmed(session, investigation_id, "same_as")]


# ---------------------------------------------------------------------------
# Tasks (06 §1): the follow-ups people and agents share
# ---------------------------------------------------------------------------


async def add_task(session, inv: Any, user_email: str, targets: list[str], value: dict) -> Any:
    """A confirmed task inside an open session (a decision's follow-ups);
    journaled as ``task.set`` like any other annotation."""
    value = _task_defaults(value)
    validate("task", targets, value)
    row = await add_row(
        session, TABLE, investigation_id=inv.id, kind="task", targets=targets, value=value, reason=None,
        status="confirmed", created_at=datetime.now(), **author_fields(user_email),
    )
    await append_event(session, inv.id, user_email, "task.set", {"annotation_id": str(row.id), "targets": targets, "value": value})
    return row


def _is_mine(task: Any, user_email: str) -> bool:
    """An agent's: assigned to agents under its name (or unnamed); a person's: assigned to them."""
    value = task.value or {}
    actor = get_current_actor()
    if actor:
        return value.get("assignee_kind") == "agent" and value.get("agent_name") in (None, "", actor.get("name"))
    return value.get("assignee_kind", "human") == "human" and value.get("assignee") == user_email


def _overdue(task: Any, now: datetime) -> bool:
    value = task.value or {}
    if value.get("state") != "open" or not value.get("due_at"):
        return False
    due = datetime.fromisoformat(str(value["due_at"]).replace("Z", "+00:00"))
    return (due.replace(tzinfo=None) if due.tzinfo else due) < now


async def list_tasks(
    user_email: str,
    mine: bool = False,
    state: Optional[str] = None,
    overdue: Optional[bool] = None,
    limit: int = 200,
) -> list[dict]:
    """Tasks across the cases the caller reads (a case-scoped token: its cases),
    oldest due first, each with its case's id, title and status. ``mine``: see
    ``_is_mine``; rejected suggestions never show."""
    from graphlagoon.services.cases import _readable_cases

    now = datetime.now()
    out = []
    async with _session() as session:
        for inv in await _readable_cases(session, user_email, None):
            for a in await list_rows(session, TABLE, inv.id):
                if a.kind != "task" or a.status == "rejected":
                    continue
                if (mine and not _is_mine(a, user_email)) or (state and (a.value or {}).get("state") != state):
                    continue
                if overdue is not None and _overdue(a, now) != overdue:
                    continue
                out.append({**serialize(a), "investigation_id": inv.id, "case_title": inv.title, "case_status": inv.status,
                            "overdue": _overdue(a, now)})
    out.sort(key=lambda t: (t["value"].get("due_at") is None, str(t["value"].get("due_at") or ""), str(t["created_at"])))
    return out[:limit]
