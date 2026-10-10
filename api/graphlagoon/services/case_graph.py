"""Unified case graph on the server: port of frontend/src/utils/unifyGraph.ts and
identityKeys.ts (FA.4), used by the MCP tools and the server analyses (F3.8).

Each edge carries ``amount`` and ``t`` (epoch ms) read through its own
context's ``edge_semantics`` (F3.1), like the ``__amount``/``__t`` tags of the
browser. shortcut: no per-property conflicts; add them when an analysis needs them.
"""

from __future__ import annotations

import re
from typing import Any, Optional
from uuid import UUID

from graphlagoon.services import investigations as service
from graphlagoon.services.trace import edge_value


def _normalize(value: Any, how: str) -> Optional[str]:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if how == "cpf_cnpj":
        if re.search(r"[*xX]", raw):  # a masked document is never a key
            return None
        digits = re.sub(r"\D", "", raw)
        if not digits or len(digits) > 14:
            return None
        return digits.zfill(11 if len(digits) <= 11 else 14)
    if how == "account":
        parts = [p.lstrip("0") or "0" for p in re.split(r"\D+", raw) if p]
        return "-".join(parts) or None
    if how == "phone":
        digits = re.sub(r"\D", "", raw)
        if len(digits) > 11 and digits.startswith("55"):
            digits = digits[2:]
        return digits or None
    if how in ("email", "lower"):
        return raw.lower()
    return raw


def unify(parts: list[tuple[str, str, list, dict, Optional[dict]]]) -> dict:
    """``parts``: (source_id, context_id, identity_keys, snapshot, edge_semantics)
    per source. Returns nodes, edges and the account values to mask."""
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    secrets: set[str] = set()
    for source_id, context_id, keys, snapshot, semantics in parts:
        by_type = {k.get("node_type"): k for k in keys or []}
        uid_of: dict[str, str] = {}
        for n in snapshot.get("nodes") or []:
            node_id, props = str(n.get("id")), n.get("properties") or {}
            key = by_type.get(n.get("type"))
            keyed = None
            if key:
                src = key.get("source", "node_id")
                raw = node_id if src == "node_id" else props.get(src.get("name"))
                normalized = _normalize(raw, key.get("normalize", "none"))
                if normalized is not None:
                    keyed = f"{key['entity']}:{normalized}"
                    if key.get("normalize") == "account":
                        secrets.update(
                            s for s in (normalized, str(raw)) if len(re.sub(r"\D", "", s)) >= 5
                        )
            uid = keyed or f"{node_id}@{context_id}"
            uid_of[node_id] = uid
            origin = {"source_id": source_id, "node_id": node_id}
            node = nodes.get(uid)
            if node is None:
                nodes[uid] = {
                    "uid": uid,
                    "type": n.get("type"),
                    "entity": key["entity"] if keyed else None,
                    "properties": dict(props),
                    "sources": [origin],
                }
                continue
            if origin not in node["sources"]:
                node["sources"].append(origin)
            for k, v in props.items():
                if node["properties"].get(k) is None:
                    node["properties"][k] = v
        for e in snapshot.get("edges") or []:
            src, dst = uid_of.get(str(e.get("source"))), uid_of.get(str(e.get("target")))
            if src and dst:  # an edge whose endpoint is not in its source would dangle
                props = e.get("properties") or {}
                amount, t = edge_value(props, semantics)
                edges.append(
                    {
                        "id": f"{source_id}:{e.get('id')}",
                        "src": src,
                        "dst": dst,
                        "type": e.get("type"),
                        "properties": props,
                        "source_id": source_id,
                        "amount": amount,
                        "t": t,
                    }
                )
    return {"nodes": list(nodes.values()), "edges": edges, "secrets": frozenset(secrets)}


async def case_graph(
    investigation_id: UUID, user_email: str, source_id: Optional[str] = None
) -> dict:
    """The unified graph of the sources the caller may read (restricted ones are
    counted, never read), or a single source when ``source_id`` is given."""
    parts, restricted = [], 0
    for s in await service.list_sources(investigation_id, user_email):
        if source_id is not None and str(s["id"]) != source_id:
            continue
        if not s["accessible"]:
            restricted += 1
            continue
        payload = await service.source_snapshot(investigation_id, user_email, s["id"])
        async with service._session() as session:
            context = await service._get_row(session, "GraphContext", s["context_id"])
        keys = (context.identity_keys or []) if context else []
        semantics = (context.edge_semantics or None) if context else None
        parts.append(
            (str(s["id"]), str(s["context_id"]), keys, payload.get("snapshot") or {}, semantics)
        )
    graph = unify(parts)
    graph["restricted_sources"] = restricted
    return graph


async def journal_analysis(
    investigation_id: UUID, user_email: str, kind: str, payload: dict
) -> None:
    """Journals a server analysis (``trace.run``, ``path.run``) as the client
    would. Readers and decided cases still analyze; they just leave no event."""
    try:
        await service.post_client_event(investigation_id, user_email, kind, payload)
    except service.InvestigationError as exc:
        if exc.status_code not in (403, 409):
            raise
