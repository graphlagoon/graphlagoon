"""Entity seen in other cases (06 P7).

A keyed entity has the same uid in every case (``Account:12345``, from the
identity keys), so "where else did this account show up?" is a lookup by uid
over two layers, both limited to the cases the caller reads (a case-scoped
token: its cases; other cases never leak, 03 §7):

- **interest:** the uid is a target of the case's confirmed annotations (role,
  tag, group, same_as, task) or of its decisions;
- **presence:** the uid is a node of the case's unified graph. ``case_entities``
  keeps one row per node, rewritten whenever the server builds the full graph
  of a case (``case_graph``); a ``stamp`` of the graph's inputs (graph items and
  their versions, identity keys, accepted same_as) says when the rows are stale,
  and the lookup rebuilds only those cases. A caller who cannot read every
  source of a case gets an answer from their partial graph, never stored.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from graphlagoon.services import cases as service

TABLE = "case_entities"
NAME_KEYS = ("name", "display_name", "full_name", "legal_name", "title", "label")


def stamp_of(items: list, settings: Optional[dict], aliases: list) -> str:
    """sha256 of what the unified graph is made of."""
    from graphlagoon.services.case_graph import is_graph_item

    doc = {
        "items": sorted(
            [str(i.id), i.current_version, str(i.updated_at), i.mapping, str(i.exploration_id)]
            for i in items
            if is_graph_item(i)
        ),
        "keys": (settings or {}).get("identity_keys") or [],
        "aliases": sorted([list(a) for a in aliases]),
    }
    return hashlib.sha256(json.dumps(doc, sort_keys=True, default=str).encode()).hexdigest()


def _label(node: dict) -> Optional[str]:
    props = node.get("properties") or {}
    name = next((props[k] for k in NAME_KEYS if props.get(k)), None)
    return str(name)[:255] if name else None


async def _current_stamp(session, inv: Any) -> str:
    from graphlagoon.services.case_annotations import aliases_of
    from graphlagoon.services.case_items import ITEMS

    items = await service.list_rows(session, ITEMS, inv.id)
    return stamp_of(items, inv.settings, await aliases_of(session, inv.id))


async def store(investigation_id: UUID, graph: dict, stamp: str) -> None:
    """Replaces the case's presence rows with the nodes of its full graph."""
    async with service._session() as session:
        for row in await service.list_rows(session, TABLE, investigation_id):
            await service.delete_row(session, TABLE, row)
        now = datetime.now()
        for n in graph.get("nodes") or []:
            await service.add_row(
                session, TABLE, investigation_id=investigation_id, uid=str(n["uid"])[:512], entity=n.get("entity"),
                node_type=n.get("type"), label=_label(n), stamp=stamp, updated_at=now,
            )
        await service.commit(session)


async def _presence(inv: Any, user_email: str) -> dict[str, dict]:
    """``{uid: {label, node_type}}`` of the case, rebuilding it when stale."""
    from graphlagoon.services.case_graph import case_graph

    async with service._session() as session:
        rows = await service.list_rows(session, TABLE, inv.id)
        fresh = await _current_stamp(session, inv)
    if rows and rows[0].stamp == fresh:
        return {r.uid: {"label": r.label, "node_type": r.node_type} for r in rows}
    graph = await case_graph(inv.id, user_email)  # stores itself when the caller sees every source
    return {n["uid"]: {"label": _label(n), "node_type": n.get("type")} for n in graph["nodes"]}


async def find_cases(uid: str, user_email: str) -> list[dict]:
    """The cases the caller reads where ``uid`` is present or of interest,
    most recently updated first, each with what the case says about it."""
    from graphlagoon.services import case_types
    from graphlagoon.services.case_annotations import TABLE as ANNOTATIONS

    async with service._session() as session:
        readable = await service._readable_cases(session, user_email, None)
    labels = {t["slug"]: t["label"] for t in await case_types.list_case_types()}
    out = []
    for inv in readable:
        async with service._session() as session:
            notes = [
                a for a in await service.list_rows(session, ANNOTATIONS, inv.id)
                if a.status == "confirmed" and uid in (a.targets or [])
            ]
        presence = await _presence(inv, user_email)
        decisions = [
            {"id": d["id"], "outcome_label": d["outcome_label"], "decided_at": d["decided_at"], "review": d.get("review"),
             "closes_case": d["closes_case"]}
            for d in inv.decisions or []
            if uid in (d.get("targets") or [])
        ]
        if uid not in presence and not notes and not decisions:
            continue
        values = lambda kind, key: sorted({str((a.value or {}).get(key)) for a in notes if a.kind == kind})  # noqa: E731
        out.append({
            "investigation_id": inv.id,
            "title": inv.title,
            "status": inv.status,
            "case_type": inv.case_type,
            "case_type_label": labels.get(inv.case_type, inv.case_type),
            "updated_at": inv.updated_at,
            "present": uid in presence,
            "label": (presence.get(uid) or {}).get("label"),
            "node_type": (presence.get(uid) or {}).get("node_type"),
            "roles": values("role", "role"),
            "tags": values("tag", "tag"),
            "groups": values("group", "name"),
            "tasks": [(a.value or {}).get("title") for a in notes if a.kind == "task"],
            "decisions": decisions,
        })
    out.sort(key=lambda c: str(c["updated_at"] or ""), reverse=True)
    return out
