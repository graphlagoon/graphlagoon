"""Unified case graph on the server: port of frontend/src/utils/unifyGraph.ts and
identityKeys.ts (FA.4), used by the MCP tools and the server analyses (F3.8).
Parity with the browser is pinned by frontend/src/__tests__/fixtures/unify (05 §8).

Each edge carries ``amount`` and ``t`` (epoch ms) read through its own
context's ``edge_semantics`` (F3.1), like the ``__amount``/``__t`` tags of the
browser. Nodes carry ``conflicts`` (values that lost to the first one, per
property; ``node_type`` for a type clash) only when there are any.
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


def _same(a: Any, b: Any) -> bool:
    # JS `===`: a boolean never equals a number.
    return a == b and (type(a) is bool) == (type(b) is bool)


def _add_conflict(node: dict, prop: str, value: Any, source_id: str) -> None:
    conflicts = node.setdefault("conflicts", {}).setdefault(prop, [])
    if not any(_same(c["value"], value) for c in conflicts):
        conflicts.append({"value": value, "source_id": source_id})


def _merge_node(
    nodes: dict[str, dict],
    uid: str,
    entity: Optional[str],
    node_type: Any,
    props: dict,
    origin: dict,
) -> None:
    node = nodes.get(uid)
    if node is None:
        nodes[uid] = {
            "uid": uid,
            "type": node_type,
            "entity": entity,
            "properties": dict(props),
            "sources": [origin],
        }
        return
    if origin not in node["sources"]:
        node["sources"].append(origin)
    if node_type != node["type"]:
        _add_conflict(node, "node_type", node_type, origin["source_id"])
    for k, v in props.items():
        # A missing value is not a disagreement: the other source just fills it.
        if node["properties"].get(k) is None:
            node["properties"][k] = v
        elif v is not None and not _same(node["properties"][k], v):
            _add_conflict(node, k, v, origin["source_id"])


def apply_aliases(graph: dict, pairs: list[tuple[str, str]]) -> dict:
    """Port of ``applyAliases``: each ``(keep, drop)`` pair (an accepted match,
    left = keep) folds ``drop`` into ``keep`` and re-points its edges; chains
    resolve transitively. A pair whose kept side is not loaded leaves the node as is."""
    if not pairs:
        return graph
    parent: dict[str, str] = {}

    def find(u: str) -> str:
        while u in parent:
            u = parent[u]
        return u

    for keep, drop in pairs:
        k, d = find(keep), find(drop)
        if k != d:
            parent[d] = k
    nodes: dict[str, dict] = {}
    dropped: list[dict] = []
    for n in graph["nodes"]:
        if find(n["uid"]) != n["uid"]:
            dropped.append(n)
        else:
            nodes[n["uid"]] = n
    for n in dropped:
        into = nodes.get(find(n["uid"]))
        if into is None:
            nodes[n["uid"]] = n
        else:
            for o in n["sources"]:
                _merge_node(nodes, into["uid"], into["entity"], n["type"], n["properties"], o)

    def uid(u: str) -> str:
        return find(u) if find(u) in nodes else u

    return {
        **graph,
        "nodes": list(nodes.values()),
        "edges": [{**e, "src": uid(e["src"]), "dst": uid(e["dst"])} for e in graph["edges"]],
    }


def unify(
    parts: list[tuple[str, str, list, dict, Optional[dict]]],
    overrides: Optional[list[dict]] = None,
    aliases: Optional[list[tuple[str, str]]] = None,
) -> dict:
    """``parts``: (source_id, context_id, identity_keys, snapshot, edge_semantics)
    per source; ``overrides``: the case's identity keys, replacing a context's key
    for the same node type; ``aliases``: accepted matches as ``(keep, drop)``.
    Returns nodes, edges and the account values to mask."""
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    secrets: set[str] = set()
    for source_id, context_id, keys, snapshot, semantics in parts:
        by_type = {k.get("node_type"): k for k in [*(keys or []), *(overrides or [])]}
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
            _merge_node(nodes, uid, key["entity"] if keyed else None, n.get("type"), props, origin)
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
    graph = {"nodes": list(nodes.values()), "edges": edges, "secrets": frozenset(secrets)}
    return apply_aliases(graph, aliases or [])


async def case_graph(
    investigation_id: UUID, user_email: str, source_id: Optional[str] = None
) -> dict:
    """The unified graph of the sources the caller may read (restricted ones are
    counted, never read), or a single source when ``source_id`` is given. The
    case's identity keys and its accepted matches apply, as in the browser."""
    from graphlagoon.services.investigation_matches import list_matches

    parts, restricted = [], 0
    async with service._session() as session:
        inv = await service.load_case(session, investigation_id, user_email)
        # shortcut: case keys live in state.identity_keys until 016_cases adds settings.
        overrides = (inv.state or {}).get("identity_keys") or []
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
    aliases = [
        (m["left"]["uid"], m["right"]["uid"])
        for m in await list_matches(investigation_id, user_email)
        if m["status"] == "aceito"
    ]
    graph = unify(parts, overrides, aliases)
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
