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
import logging
import re
from typing import Any, Optional
from uuid import UUID

from graphlagoon.services import cases as service
from graphlagoon.services.trace import edge_value, semantics_for

logger = logging.getLogger(__name__)


# Normalizers that make a node id an entity key (03 §2.1, 05 §4b); the rest only clean it.
KEY_NORMALIZERS = ("digits", "account", "phone", "email", "device_id", "ip", "card", "terminal_id", "address")


def _strip_accents(text: str) -> str:
    import unicodedata

    return "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn")


def _digits(raw: str) -> Optional[str]:
    if "*" in raw:  # a redacted value (***-**-1120) is never a key
        return None
    return re.sub(r"\D", "", raw) or None


def _normalize(value: Any, how: str, pattern: Optional[str] = None) -> Optional[str]:
    """Twin of ``utils/identityKeys.ts::normalizeIdentityValue`` (fixture
    ``unify/generic-normalizers.json``)."""
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if how == "digits":
        return _digits(raw)
    if how == "account":
        parts = [p.lstrip("0") or "0" for p in re.split(r"\D+", raw) if p]
        return "-".join(parts) or None
    if how == "phone":
        return re.sub(r"\D", "", raw) or None
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
        return " ".join(re.sub(r"[^a-z0-9]+", " ", _strip_accents(raw).lower()).split()) or None
    if how == "regex":
        if not pattern:
            return None
        from graphlagoon.utils.safe_regex import search

        m = search(pattern, raw)  # vetted pattern, bounded id: never backtracks for minutes
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
    merge_props(node, props, origin["source_id"])


def merge_props(target: dict, props: dict, source_id: str, overwrite: bool = False) -> int:
    """The one merge rule (nodes, edges, enrichment files): a missing or null value
    is filled; a different non-null value loses to the one already there and is
    recorded in ``target["conflicts"]`` — unless ``overwrite``, when it replaces it.
    Returns how many properties changed."""
    current = target.setdefault("properties", {})
    changed = 0
    for k, v in props.items():
        # A missing value is not a disagreement: the other source just fills it.
        if current.get(k) is None:
            current[k] = v
            changed += v is not None
        elif v is not None and not _same(current[k], v):
            if overwrite:
                current[k] = v
                changed += 1
            else:
                _add_conflict(target, k, v, source_id)
    return changed


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
    Returns nodes and edges."""
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
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
    graph = {"nodes": list(nodes.values()), "edges": edges}
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
    state = (exploration.state or {}) if exploration is not None else {}
    snapshot = None
    if state.get("has_snapshot"):
        raw = await get_snapshot_service().load(exploration.id)
        snapshot = decompress_snapshot(raw) if raw else None
    if state.get("has_overlay"):
        # The user's layer (BYOD-2): the case sees the exploration as its owner does.
        from graphlagoon.services.enrichment_files import fold_overlay

        raw = await get_snapshot_service().load(exploration.id, kind="overlay")
        if raw:
            snapshot = fold_overlay(snapshot, decompress_snapshot(raw))
    return exploration, snapshot


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
    """A derived item (links, a saved selection) stores unified ids: ``{"unified": true}``."""
    return isinstance(payload, dict) and bool(payload.get("unified"))


async def _latest_json(session, investigation_id: UUID, item: Any) -> Any:
    from graphlagoon.services import investigation_storage as storage
    from graphlagoon.services.case_items import version_row

    if not item.current_version:
        return None
    row = await version_row(session, investigation_id, item, None)
    data = await storage.load(row.blob_key)
    return json.loads(data) if data else None


async def _extras_readable(session, investigation_id: UUID, item: Any, user_email: str, cache: dict) -> bool:
    """A mapped table also reads the files of ``mapping.extra_item_ids``."""
    from graphlagoon.services.case_items import item_row, sources_readable

    extras = ((item.mapping or {}).get("extra_item_ids") or []) if item.kind == "table" else []
    for extra in extras:
        try:
            row = await item_row(session, investigation_id, UUID(str(extra)), deleted_ok=True)
        except (ValueError, service.InvestigationError):
            continue
        if not await sources_readable(row, user_email, cache):
            return False
    return True


async def _mapped_table(session, investigation_id: UUID, item: Any, user_email: str) -> tuple[dict, dict]:
    """Interprets a ``table`` item (plus ``mapping.extra_item_ids``) through its
    file-mapping spec; returns (snapshot, report)."""
    from graphlagoon.config import get_settings
    from graphlagoon.services import file_mapping
    from graphlagoon.services import investigation_storage as storage
    from graphlagoon.services.case_items import ensure_sources_readable, item_row, version_row
    from graphlagoon.services.datasource.file import to_snapshot

    spec = item.mapping["spec"]
    texts: dict[str, str] = {}
    rows = [item] + [
        await item_row(session, investigation_id, UUID(i), deleted_ok=True) for i in item.mapping.get("extra_item_ids") or []
    ]
    for r in rows:
        if not r.current_version:
            continue
        # An extra file from a source the caller cannot read keeps the whole mapping out.
        await ensure_sources_readable(r, user_email)
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
        out["snapshot"], out["report"] = await _mapped_table(session, inv.id, item, user_email)
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


def _sane_snapshot(snapshot: Any) -> dict:
    """A snapshot ``unify`` can read: nodes and edges are lists of objects (an
    item's JSON is whatever was uploaded)."""
    if snapshot is None:
        return {}
    if not isinstance(snapshot, dict):
        raise ValueError("the content is not a graph snapshot")
    nodes, edges = snapshot.get("nodes") or [], snapshot.get("edges") or []
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise ValueError("nodes and edges must be lists")
    keep = lambda rows: [r for r in rows if isinstance(r, dict) and isinstance(r.get("properties") or {}, dict)]  # noqa: E731
    return {**snapshot, "nodes": keep(nodes), "edges": keep(edges)}


def _error_text(exc: Exception) -> str:
    return exc.message if isinstance(exc, service.InvestigationError) else (str(exc) or type(exc).__name__)[:300]


def _unreadable(item: Any, exc: Exception) -> "service.InvestigationError":
    if isinstance(exc, service.InvestigationError):
        return exc
    return service.InvestigationError(422, "ITEM_UNREADABLE", f"“{item.title}” cannot be read as a graph: {_error_text(exc)}")


async def item_snapshot_or_error(session, inv: Any, item: Any, user_email: str) -> dict:
    """``item_snapshot`` for one item, as 422 ``ITEM_UNREADABLE`` when its content is not readable."""
    try:
        out = await item_snapshot(session, inv, item, user_email)
        out["snapshot"] = _sane_snapshot(out["snapshot"]) if out["snapshot"] is not None else None
        return out
    except (service.InvestigationError, ValueError, LookupError, TypeError, AttributeError) as exc:
        raise _unreadable(item, exc) from exc


async def case_graph(investigation_id: UUID, user_email: str, item_id: Optional[str] = None) -> dict:
    """The unified graph of the case's graph items the caller may read
    (restricted ones are counted, never read), or a single item when
    ``item_id`` is given. The case's identity keys (``settings.identity_keys``)
    and its confirmed ``same_as`` annotations apply, as in the browser. The full
    graph, seen by someone who reads every source, refreshes the case's entity
    presence (``case_entities``, 06 P7)."""
    from graphlagoon.services import case_entities, enrichment_files
    from graphlagoon.services.case_annotations import aliases_of
    from graphlagoon.services.case_items import ITEMS, sources_readable

    parts, restricted, broken = [], 0, []
    async with service._session() as session:
        inv = await service.load_case(session, investigation_id, user_email)
        overrides = (inv.settings or {}).get("identity_keys") or []
        readable: dict = {}
        all_items = await service.list_rows(session, ITEMS, investigation_id)
        for item in sorted(all_items, key=lambda i: (i.position, i.created_at)):
            if not is_graph_item(item) or (item_id is not None and str(item.id) != item_id):
                continue
            if not await sources_readable(item, user_email, readable) or not await _extras_readable(
                session, investigation_id, item, user_email, readable
            ):
                restricted += 1
                continue
            try:
                part = await item_snapshot(session, inv, item, user_email)
                snapshot = _sane_snapshot(part["snapshot"])
            except (service.InvestigationError, ValueError, LookupError, TypeError, AttributeError) as exc:
                # One unreadable item (bad JSON, a broken mapping) never takes the case's graph down.
                if item_id is not None:
                    raise _unreadable(item, exc) from exc
                logger.warning("case %s: item %s left out of the graph: %s", investigation_id, item.id, exc)
                broken.append({"item_id": str(item.id), "title": item.title, "error": _error_text(exc)})
                continue
            part["snapshot"] = snapshot
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
        # Enrichment files add properties to what is already there (BYOD-2); the
        # whole graph only: a single item is one source as it stands.
        enrichments = []
        for item in sorted(all_items, key=lambda i: (i.position, i.created_at)) if item_id is None else []:
            if not enrichment_files.is_enrichment_item(item):
                continue
            if not await sources_readable(item, user_email, readable):
                restricted += 1
                continue
            try:
                enrichments.append((str(item.id), item.mapping["spec"], await enrichment_files.item_rows(session, investigation_id, item)))
            except (service.InvestigationError, ValueError, LookupError, TypeError, AttributeError) as exc:
                logger.warning("case %s: enrichment %s left out: %s", investigation_id, item.id, exc)
                broken.append({"item_id": str(item.id), "title": item.title, "error": _error_text(exc)})
    graph = unify(parts, overrides, aliases, (inv.settings or {}).get("edge_semantics"))
    for source_id, spec, rows in enrichments:
        enrichment_files.enrich_graph(graph, spec, rows, source_id)
    graph["restricted_sources"] = restricted
    graph["broken_sources"] = broken
    if item_id is None and not restricted and not broken:
        await case_entities.store(investigation_id, graph, case_entities.stamp_of(all_items, inv.settings, aliases))
    return graph


async def journal_analysis(investigation_id: UUID, user_email: str, kind: str, payload: dict) -> None:
    """Journals a server analysis (``trace.run``, ``path.run``) as the client
    would. Readers and decided cases still analyze; they just leave no event."""
    try:
        await service.post_client_event(investigation_id, user_email, kind, payload)
    except service.InvestigationError as exc:
        if exc.status_code not in (403, 409):
            raise
