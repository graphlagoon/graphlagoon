"""Unified case graph on the server: port of frontend/src/utils/unifyGraph.ts and
identityKeys.ts (FA.4), used by the MCP tools and the server analyses (F3.8).
Parity with the browser is pinned by frontend/src/__tests__/fixtures/unify (05 §8).

Each edge carries ``amount`` and ``t`` (epoch ms) read through its own
context's ``edge_semantics`` (F3.1), like the ``__amount``/``__t`` tags of the
browser. Nodes carry ``conflicts`` (values that lost to the first one, per
property; ``node_type`` for a type clash) only when there are any.
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional
from uuid import UUID

from graphlagoon.services import cases as service
from graphlagoon.services.trace import edge_value, semantics_for


_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_ADDRESS_WORDS = {
    "r": "rua", "av": "avenida", "al": "alameda", "tv": "travessa", "apto": "ap", "apartamento": "ap",
    "bl": "bloco", "cj": "conj", "conjunto": "conj",
    "n": "", "no": "", "numero": "", "de": "", "da": "", "do": "", "das": "", "dos": "",
}
# Normalizers that make a node id an entity key (03 §2.1, 05 §4b); the rest only clean it.
KEY_NORMALIZERS = ("cpf_cnpj", "account", "phone", "email", "device_id", "ip", "pix_key", "card", "terminal_id", "address")


def _strip_accents(text: str) -> str:
    import unicodedata

    return "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn")


def _cpf_cnpj(raw: str) -> Optional[str]:
    if re.search(r"[*xX]", raw):  # a masked document is never a key
        return None
    digits = re.sub(r"\D", "", raw)
    if not digits or len(digits) > 14:
        return None
    return digits.zfill(11 if len(digits) <= 11 else 14)


def _phone(raw: str) -> Optional[str]:
    digits = re.sub(r"\D", "", raw)
    if len(digits) > 11 and digits.startswith("55"):
        digits = digits[2:]
    return digits or None


def _normalize(value: Any, how: str, pattern: Optional[str] = None) -> Optional[str]:
    """Twin of ``utils/identityKeys.ts::normalizeIdentityValue`` (fixture
    ``unify/generic-normalizers.json``)."""
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if how == "cpf_cnpj":
        return _cpf_cnpj(raw)
    if how == "account":
        parts = [p.lstrip("0") or "0" for p in re.split(r"\D+", raw) if p]
        return "-".join(parts) or None
    if how == "phone":
        return _phone(raw)
    if how == "device_id":
        return re.sub(r"[^a-z0-9]", "", raw.lower()) or None
    if how == "ip":
        s = re.sub(r"^\[|\]$", "", raw).split("%")[0].strip()
        if not s:
            return None
        if re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", s):
            octets = [int(o) for o in s.split(".")]
            return None if any(o > 255 for o in octets) else ".".join(str(o) for o in octets)
        return s.lower()
    if how == "pix_key":
        if "@" in raw:
            return f"email:{raw.lower()}"
        if _UUID.match(raw):
            return f"evp:{raw.lower()}"
        if raw.startswith("+"):
            phone = _phone(raw)
            return f"phone:{phone}" if phone else None
        doc = _cpf_cnpj(raw)
        if not doc:
            return None
        return f"cpf:{doc}" if len(doc) == 11 else f"cnpj:{doc}"
    if how == "card":
        s = re.sub(r"[\s-]", "", raw)
        first = re.match(r"^\d+", s)
        last = re.search(r"\d{4}$", s)
        if not last or not first or len(first.group(0)) < 4:
            return None
        return f"{first.group(0)[:6]}*{last.group(0)}"
    if how == "terminal_id":
        s = re.sub(r"[^A-Z0-9]", "", raw.upper())
        return re.sub(r"(^|\D)0+(?=\d)", r"\1", s) or None
    if how == "address":
        words = re.sub(r"[^a-z0-9]+", " ", _strip_accents(raw).lower()).split()
        words = [w for w in (_ADDRESS_WORDS.get(w, w) for w in words) if w]
        return " ".join(words) or None
    if how == "regex":
        if not pattern:
            return None
        try:
            m = re.search(pattern, raw)
        except re.error:
            return None
        if not m:
            return None
        value = (m.group(1) if m.lastindex else m.group(0)).strip().lower()
        return value or None
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
    parts: list[tuple],
    overrides: Optional[list[dict]] = None,
    aliases: Optional[list[tuple[str, str]]] = None,
    edge_overrides: Optional[dict] = None,
) -> dict:
    """``parts``: (source_id, context_id, identity_keys, snapshot, edge_semantics[, unified])
    per source; ``overrides``: the case's identity keys, replacing a context's key
    for the same node type; ``aliases``: accepted matches as ``(keep, drop)``;
    ``edge_overrides``: the case's edge semantics by relationship type (``*`` = any).
    A ``unified`` source (a derived item) carries unified ids already.
    Returns nodes, edges and the account values to mask."""
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    secrets: set[str] = set()
    for source_id, context_id, keys, snapshot, semantics, *rest in parts:
        unified = bool(rest and rest[0])
        by_type = {k.get("node_type"): k for k in [*(keys or []), *(overrides or [])]}
        uid_of: dict[str, str] = {}
        for n in snapshot.get("nodes") or []:
            node_id, props = str(n.get("id")), n.get("properties") or {}
            key = None if unified else by_type.get(n.get("type"))
            keyed = None
            if key:
                src = key.get("source", "node_id")
                raw = node_id if src == "node_id" else props.get(src.get("name"))
                normalized = _normalize(raw, key.get("normalize", "none"), key.get("pattern"))
                if normalized is not None:
                    keyed = f"{key['entity']}:{normalized}"
                    if key.get("normalize") == "account":
                        secrets.update(
                            s for s in (normalized, str(raw)) if len(re.sub(r"\D", "", s)) >= 5
                        )
            uid = node_id if unified else (keyed or f"{node_id}@{context_id}")
            uid_of[node_id] = uid
            origin = {"source_id": source_id, "node_id": node_id}
            _merge_node(nodes, uid, key["entity"] if keyed else None, n.get("type"), props, origin)
        for e in snapshot.get("edges") or []:
            src, dst = uid_of.get(str(e.get("source"))), uid_of.get(str(e.get("target")))
            if src and dst:  # an edge whose endpoint is not in its source would dangle
                props = e.get("properties") or {}
                amount, t = edge_value(props, semantics_for(e.get("type"), edge_overrides, semantics))
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


# ---------------------------------------------------------------------------
# Graph-bearing items (05 §1): what each one contributes to the canvas
# ---------------------------------------------------------------------------

def derived_identity_keys(spec: dict) -> list[dict]:
    """One identity key per node type whose id the mapping normalizes as an
    entity key (document, account, phone, e-mail, device, …): the entity is the node type."""
    keys: dict[str, dict] = {}
    for nd in spec.get("nodes") or []:
        how = nd["id"].get("normalize") if isinstance(nd["id"], dict) else None
        if how in KEY_NORMALIZERS and nd["type"] not in keys:
            keys[nd["type"]] = {"node_type": nd["type"], "entity": nd["type"], "source": "node_id", "normalize": how}
    return list(keys.values())


def cap_edges(graph: dict, limit: int) -> int:
    """Keeps the first ``limit`` edges (investigation_max_working_edges) and the
    nodes they touch plus the nodes that had no edge at all. Returns how many
    edges were dropped."""
    edges = graph["edges"]
    if len(edges) <= limit:
        return 0
    touched_before = {e["src"] for e in edges} | {e["dst"] for e in edges}
    kept = edges[:limit]
    touched = {e["src"] for e in kept} | {e["dst"] for e in kept}
    graph["nodes"] = [n for n in graph["nodes"] if n["node_id"] in touched or n["node_id"] not in touched_before]
    graph["edges"] = kept
    graph["truncated"] = True
    return len(edges) - limit


def is_graph_item(item: Any) -> bool:
    """Items that put nodes on the canvas (a saved view is chips + layout only)."""
    if item.deleted_at or item.status == "rejected":
        return False
    if item.kind == "graph":
        return item.subkind != "view"
    if item.kind == "table":
        return bool(item.mapping) and item.mapping.get("as") == "graph"
    if item.kind == "query":
        return bool(item.query) and item.query.get("output") == "graph"
    return False


async def _context(session, context_id: Optional[UUID]) -> Any:
    if context_id is None:
        return None
    if session is None:
        from graphlagoon.db.memory_store import get_memory_store

        return get_memory_store().get_graph_context(context_id)
    from graphlagoon.db.models import GraphContext

    return await session.get(GraphContext, context_id)


async def _exploration_snapshot(session, exploration_id: Optional[UUID]) -> tuple[Any, Optional[dict]]:
    from graphlagoon.services.case_items import _exploration
    from graphlagoon.services.snapshot import decompress_snapshot, get_snapshot_service

    exploration = await _exploration(session, exploration_id)
    if exploration is None or not (exploration.state or {}).get("has_snapshot"):
        return exploration, None
    raw = await get_snapshot_service().load(exploration.id)
    return exploration, (decompress_snapshot(raw) if raw else None)


def _as_snapshot(payload: Any) -> Optional[dict]:
    """A stored version in snapshot shape (``{nodes:[{id,type}], edges:[{source,target}]}``),
    GraphResponse shape (``node_id``/``src``) or a pinned exploration payload."""
    if not isinstance(payload, dict):
        return None
    if isinstance(payload.get("snapshot"), dict):
        return payload["snapshot"]
    nodes = payload.get("nodes") or []
    if nodes and "node_id" in nodes[0]:
        from graphlagoon.services.datasource.file import to_snapshot

        return to_snapshot(payload)
    if "nodes" in payload:
        return {"nodes": nodes, "edges": payload.get("edges") or []}
    return None


def is_unified_payload(payload: Any) -> bool:
    """A derived item (Vínculos, a saved selection) stores unified ids: ``{"unified": true}``."""
    return isinstance(payload, dict) and bool(payload.get("unified"))


async def _latest_json(session, investigation_id: UUID, item: Any) -> Any:
    from graphlagoon.services import investigation_storage as storage
    from graphlagoon.services.case_items import version_row

    if not item.current_version:
        return None
    row = await version_row(session, investigation_id, item, None)
    data = await storage.load(row.blob_key)
    return json.loads(data) if data else None


async def _mapped_table(session, investigation_id: UUID, item: Any) -> tuple[dict, dict]:
    """Interprets a ``table`` item (plus ``mapping.extra_item_ids``) through its
    file-mapping spec; returns (snapshot, report)."""
    from graphlagoon.config import get_settings
    from graphlagoon.services import file_mapping
    from graphlagoon.services import investigation_storage as storage
    from graphlagoon.services.case_items import item_row, version_row
    from graphlagoon.services.datasource.file import to_snapshot

    spec = item.mapping["spec"]
    texts: dict[str, str] = {}
    rows = [item] + [
        await item_row(session, investigation_id, UUID(i), deleted_ok=True) for i in item.mapping.get("extra_item_ids") or []
    ]
    for r in rows:
        if not r.current_version:
            continue
        name = (r.provenance or {}).get("filename") or r.title
        version = await version_row(session, investigation_id, r, None)
        data = await storage.load(version.blob_key)
        if data is None:
            continue
        inp = next((i for i in spec["inputs"].values() if file_mapping._glob(i["match"], name)), {})
        if version.content_type.startswith("application/json"):
            # A console result or a run promoted to the graph (05 §3): JSON rows as text.
            from graphlagoon.services.case_tables import parse_table, to_delimited

            texts[name] = to_delimited(*parse_table(data, version.content_type), inp.get("delimiter", "\t"))
        else:
            texts[name] = file_mapping.decode(data, inp.get("encoding"))
    try:
        result = file_mapping.interpret(spec, texts)
    except file_mapping.MappingError as exc:
        raise service.InvestigationError(422, "INVALID_MAPPING", str(exc))
    graph, report = result["graph"], result["report"]
    report["truncated_edges"] = cap_edges(graph, get_settings().investigation_max_working_edges)
    return to_snapshot(graph), report


async def item_snapshot(session, inv: Any, item: Any, user_email: str) -> dict:
    """What one graph item puts on the canvas: ``{snapshot, context_id,
    identity_keys, edge_semantics, title, report?}``. The browser unifies these
    with ``unifyGraph.ts``; ``case_graph`` unifies them here."""
    from graphlagoon.models.schemas import EdgeSemantics

    context = await _context(session, item.context_id)
    keys = list(context.identity_keys or []) if context else []
    semantics = (context.edge_semantics or None) if context else None
    out = {
        "item_id": str(item.id),
        "title": item.title,
        "context_id": str(item.context_id) if item.context_id else None,
        "snapshot": None,
    }
    if item.subkind == "exploration_ref":
        exploration, snapshot = await _exploration_snapshot(session, item.exploration_id)
        out["snapshot"] = snapshot
        out["exploration"] = (
            {"id": str(exploration.id), "title": exploration.title, "state": exploration.state or {}} if exploration else None
        )
    elif item.kind == "table":
        out["snapshot"], out["report"] = await _mapped_table(session, inv.id, item)
        spec = item.mapping["spec"]
        keys = keys or derived_identity_keys(spec)
        semantics = semantics or EdgeSemantics.model_validate(spec.get("edge_semantics") or {}).model_dump()
    else:
        payload = await _latest_json(session, inv.id, item)
        out["snapshot"] = _as_snapshot(payload)
        out["unified"] = is_unified_payload(payload)
        if isinstance(payload, dict):
            keys = keys or list(payload.get("identity_keys") or [])
            semantics = semantics or payload.get("edge_semantics")
    out["identity_keys"] = keys
    out["edge_semantics"] = semantics
    return out


async def case_graph(investigation_id: UUID, user_email: str, item_id: Optional[str] = None) -> dict:
    """The unified graph of the case's graph items the caller may read
    (restricted ones are counted, never read), or a single item when
    ``item_id`` is given. The case's identity keys (``settings.identity_keys``)
    and its confirmed ``same_as`` annotations apply, as in the browser."""
    from graphlagoon.services.case_annotations import aliases_of
    from graphlagoon.services.case_items import ITEMS, _context_readable

    parts, restricted = [], 0
    async with service._session() as session:
        inv = await service.load_case(session, investigation_id, user_email)
        overrides = (inv.settings or {}).get("identity_keys") or []
        readable: dict = {}
        for item in sorted(await service.list_rows(session, ITEMS, investigation_id), key=lambda i: (i.position, i.created_at)):
            if not is_graph_item(item) or (item_id is not None and str(item.id) != item_id):
                continue
            if item.context_id is not None:
                if item.context_id not in readable:
                    readable[item.context_id] = await _context_readable(item.context_id, user_email)
                if not readable[item.context_id]:
                    restricted += 1
                    continue
            part = await item_snapshot(session, inv, item, user_email)
            parts.append(
                (
                    str(item.id),
                    part["context_id"] or str(item.id),
                    part["identity_keys"],
                    part["snapshot"] or {},
                    part["edge_semantics"],
                    part.get("unified", False),
                )
            )
        aliases = await aliases_of(session, investigation_id)
    graph = unify(parts, overrides, aliases, (inv.settings or {}).get("edge_semantics"))
    graph["restricted_sources"] = restricted
    return graph


async def journal_analysis(investigation_id: UUID, user_email: str, kind: str, payload: dict) -> None:
    """Journals a server analysis (``trace.run``, ``path.run``) as the client
    would. Readers and decided cases still analyze; they just leave no event."""
    try:
        await service.post_client_event(investigation_id, user_email, kind, payload)
    except service.InvestigationError as exc:
        if exc.status_code not in (403, 409):
            raise
