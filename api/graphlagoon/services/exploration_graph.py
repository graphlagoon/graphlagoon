"""An exploration's graph as the server keeps it, edited in place by an agent.

The graph of a saved exploration is its **snapshot** file (the browser loads it
whenever ``state.has_snapshot``) plus the user's **layer** (BYOD-2, folded on
top by ``fold_overlay``). Editing reads both, applies one batch of changes and
writes them back under the same id: title, view state and shares stay. Removing
is real deletion from the snapshot and from the layer; ``replace`` starts the
graph over. Every write bumps ``state.revision`` (server-owned, like
``has_overlay``) and stamps ``state.last_change``, which is what the live
refresh of an open page polls and what a stale writer is refused on.

``apply_edit`` is pure; ``load``/``save`` do access, files and the revision
check for both the database and the in-memory store.
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

MAX_NODES = 5000
MAX_EDGES = 20000


class ExplorationEditError(Exception):
    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def empty_snapshot() -> dict:
    return {"nodes": [], "edges": [], "snapshot_version": 1}


def response_to_snapshot(graph: Any) -> dict:
    """A datasource ``GraphResponse`` (``node_id``/``src``…) in snapshot shape."""
    return {
        "nodes": [{"id": str(n.node_id), "type": n.node_type, "properties": dict(n.properties or {})} for n in graph.nodes],
        "edges": [
            {"id": str(e.edge_id), "source": str(e.src), "target": str(e.dst), "type": e.relationship_type,
             "properties": dict(e.properties or {})}
            for e in graph.edges
        ],
        "snapshot_version": 1,
    }


# ---------------------------------------------------------------------------
# The pure edit
# ---------------------------------------------------------------------------


class _Ids:
    """Exact id first, then a case-insensitive match when it is unambiguous."""

    def __init__(self, ids):
        self.exact = set(ids)
        self.lower: dict[str, Optional[str]] = {}
        for i in self.exact:
            key = i.lower()
            self.lower[key] = None if key in self.lower and self.lower[key] != i else i

    def find(self, given: Any) -> Optional[str]:
        given = str(given)
        if given in self.exact:
            return given
        return self.lower.get(given.lower())

    def add(self, i: str) -> None:
        self.exact.add(i)
        self.lower.setdefault(i.lower(), i)


def _props(value: Any, where: str) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ExplorationEditError("INVALID_PROPERTIES", f"{where}: properties must be an object")
    return dict(value)


def _need(obj: Any, key: str, where: str) -> str:
    value = obj.get(key) if isinstance(obj, dict) else None
    if value is None or str(value).strip() == "":
        raise ExplorationEditError("INVALID_BODY", f"{where} needs '{key}'")
    return str(value)


def apply_edit(snapshot: Optional[dict], overlay: Optional[dict], ops: dict) -> tuple[dict, Optional[dict], dict]:
    """One batch on ``snapshot`` (+ the layer ``overlay``): ``replace`` (start over),
    ``remove_node_ids`` (with their edges), ``remove_edge_ids``, ``add_nodes``
    (an existing id is updated: type and properties overwritten), ``add_edges``
    (both ends must exist after the batch; ``id`` defaults to
    ``source->target:type``), ``set_properties`` (``[{id, kind, properties,
    unset}]``); ``skip_existing`` leaves ids already there as they are (a
    context's answer merged in: expand, query). Atomic: any error raises before anything is returned, and the
    inputs are never changed. Returns ``(snapshot, overlay or None when the layer
    is untouched, report)``."""
    snap = copy.deepcopy(snapshot) if snapshot else empty_snapshot()
    snap.setdefault("nodes", [])
    snap.setdefault("edges", [])
    layer = copy.deepcopy(overlay) if overlay else None
    layer_changed = False
    report = {"added_nodes": 0, "added_edges": 0, "updated_nodes": 0, "updated_edges": 0,
              "removed_nodes": 0, "removed_edges": 0}

    if ops.get("replace"):
        snap = {**snap, "nodes": [], "edges": []}
        if layer and (layer.get("nodes") or layer.get("edges") or layer.get("enrichments") or layer.get("imports")):
            layer, layer_changed = {"version": 1, "nodes": [], "edges": [], "enrichments": [], "imports": []}, True

    def all_nodes() -> list[dict]:
        return snap["nodes"] + ((layer or {}).get("nodes") or [])

    def all_edges() -> list[dict]:
        return snap["edges"] + ((layer or {}).get("edges") or [])

    node_ids = _Ids(str(n.get("id")) for n in all_nodes())
    edge_ids = _Ids(str(e.get("id")) for e in all_edges())

    # -- removals ----------------------------------------------------------------
    gone_nodes: set[str] = set()
    for given in ops.get("remove_node_ids") or []:
        real = node_ids.find(given)
        if real is None:
            raise ExplorationEditError("NODE_NOT_FOUND", f"No node '{given}' in this exploration")
        gone_nodes.add(real)
    gone_edges: set[str] = set()
    for given in ops.get("remove_edge_ids") or []:
        real = edge_ids.find(given)
        if real is None:
            raise ExplorationEditError("EDGE_NOT_FOUND", f"No edge '{given}' in this exploration")
        gone_edges.add(real)

    def keep_edge(e: dict) -> bool:
        return str(e.get("id")) not in gone_edges and str(e.get("source")) not in gone_nodes and str(e.get("target")) not in gone_nodes

    if gone_nodes or gone_edges:
        before_nodes = {str(n.get("id")) for n in all_nodes()}
        before_edges = {str(e.get("id")) for e in all_edges()}
        snap["nodes"] = [n for n in snap["nodes"] if str(n.get("id")) not in gone_nodes]
        snap["edges"] = [e for e in snap["edges"] if keep_edge(e)]
        if layer:
            nodes = [n for n in layer.get("nodes") or [] if str(n.get("id")) not in gone_nodes]
            edges = [e for e in layer.get("edges") or [] if keep_edge(e)]
            left = {str(e.get("id")) for e in edges}
            imports = [
                {**i, "node_ids": [x for x in i.get("node_ids") or [] if x not in gone_nodes],
                 "edge_ids": [x for x in i.get("edge_ids") or [] if x in left]}
                for i in layer.get("imports") or []
            ]
            if nodes != layer.get("nodes") or edges != layer.get("edges") or imports != (layer.get("imports") or []):
                layer, layer_changed = {**layer, "nodes": nodes, "edges": edges, "imports": imports}, True
        report["removed_nodes"] = len(before_nodes - {str(n.get("id")) for n in all_nodes()})
        report["removed_edges"] = len(before_edges - {str(e.get("id")) for e in all_edges()})
        node_ids = _Ids(str(n.get("id")) for n in all_nodes())
        edge_ids = _Ids(str(e.get("id")) for e in all_edges())

    # -- additions ---------------------------------------------------------------
    def located(collection: str, real: str) -> tuple[Optional[dict], bool]:
        """The object with id ``real`` and whether it lives in the layer."""
        for obj in snap[collection]:
            if str(obj.get("id")) == real:
                return obj, False
        for obj in (layer or {}).get(collection) or []:
            if str(obj.get("id")) == real:
                return obj, True
        return None, False

    for i, raw in enumerate(ops.get("add_nodes") or []):
        where = f"add_nodes[{i}]"
        nid, ntype = _need(raw, "id", where), _need(raw, "type", where)
        props = _props(raw.get("properties"), where)
        real = node_ids.find(nid)
        if real is not None and ops.get("skip_existing"):
            continue
        if real is None:
            snap["nodes"].append({"id": nid, "type": ntype, "properties": props})
            node_ids.add(nid)
            report["added_nodes"] += 1
            continue
        obj, in_layer = located("nodes", real)
        obj["type"] = ntype
        obj["properties"] = {**(obj.get("properties") or {}), **props}
        layer_changed |= in_layer
        report["updated_nodes"] += 1

    for i, raw in enumerate(ops.get("add_edges") or []):
        where = f"add_edges[{i}]"
        etype = _need(raw, "type", where)
        ends = []
        for side in ("source", "target"):
            given = _need(raw, side, where)
            real = node_ids.find(given)
            if real is None:
                raise ExplorationEditError(
                    "INVALID_EDGE", f"{where}: {side} '{given}' is not a node of the exploration (add it in add_nodes)"
                )
            ends.append(real)
        eid = str(raw.get("id") or f"{ends[0]}->{ends[1]}:{etype}")
        props = _props(raw.get("properties"), where)
        real = edge_ids.find(eid)
        if real is not None and ops.get("skip_existing"):
            continue
        if real is None:
            snap["edges"].append({"id": eid, "source": ends[0], "target": ends[1], "type": etype, "properties": props})
            edge_ids.add(eid)
            report["added_edges"] += 1
            continue
        obj, in_layer = located("edges", real)
        obj.update(source=ends[0], target=ends[1], type=etype, properties={**(obj.get("properties") or {}), **props})
        layer_changed |= in_layer
        report["updated_edges"] += 1

    # -- properties --------------------------------------------------------------
    for i, raw in enumerate(ops.get("set_properties") or []):
        where = f"set_properties[{i}]"
        kind = (raw or {}).get("kind", "node")
        if kind not in ("node", "edge"):
            raise ExplorationEditError("INVALID_BODY", f"{where}: kind is node or edge")
        given = _need(raw, "id", where)
        collection, ids = ("nodes", node_ids) if kind == "node" else ("edges", edge_ids)
        real = ids.find(given)
        if real is None:
            raise ExplorationEditError(f"{kind.upper()}_NOT_FOUND", f"No {kind} '{given}' in this exploration")
        props = _props(raw.get("properties"), where)
        unset = [str(k) for k in raw.get("unset") or []]
        # The snapshot copy carries the value; a layer copy of the same id would
        # fill it back (the layer fills missing properties), so it loses the keys.
        touched = False
        for obj in snap[collection]:
            if str(obj.get("id")) == real:
                obj["properties"] = {k: v for k, v in {**(obj.get("properties") or {}), **props}.items() if k not in unset}
                touched = True
        for obj in (layer or {}).get(collection) or []:
            if str(obj.get("id")) == real:
                keys = set(unset) | (set(props) if touched else set())
                before = obj.get("properties") or {}
                after = {k: v for k, v in ({**before, **props} if not touched else before).items() if k not in keys}
                if after != before:
                    obj["properties"] = after
                    layer_changed = True
        report["updated_nodes" if kind == "node" else "updated_edges"] += 1

    nodes, edges = len(node_ids.exact), len(edge_ids.exact)
    if nodes > MAX_NODES or edges > MAX_EDGES:
        raise ExplorationEditError(
            "GRAPH_TOO_LARGE",
            f"The exploration would have {nodes} nodes and {edges} edges; an agent edit keeps at most "
            f"{MAX_NODES} nodes and {MAX_EDGES} edges",
        )
    report.update(node_count=nodes, edge_count=edges)
    return snap, (layer if layer_changed else None), report


def summary(report: dict) -> dict:
    """The counts of a report that describe the change (what ``last_change`` keeps)."""
    keys = ("added_nodes", "added_edges", "updated_nodes", "updated_edges", "removed_nodes", "removed_edges")
    return {k: report.get(k, 0) for k in keys}


def effective_graph(snapshot: Optional[dict], overlay: Optional[dict]) -> dict:
    """What the owner sees (snapshot ⊕ layer), each node and edge with ``origin``."""
    from graphlagoon.services.enrichment_files import fold_overlay

    base = snapshot or empty_snapshot()
    snap_nodes = {str(n.get("id")) for n in base.get("nodes") or []}
    snap_edges = {str(e.get("id")) for e in base.get("edges") or []}
    graph = fold_overlay(base, overlay) if overlay else copy.deepcopy(base)
    for n in graph.get("nodes") or []:
        n.pop("conflicts", None)
        n["origin"] = "snapshot" if str(n.get("id")) in snap_nodes else "layer"
    for e in graph.get("edges") or []:
        e["origin"] = "snapshot" if str(e.get("id")) in snap_edges else "layer"
    return graph


# ---------------------------------------------------------------------------
# Running against the exploration's context
# ---------------------------------------------------------------------------


def _query_error(exc: Exception) -> ExplorationEditError:
    from fastapi import HTTPException

    if isinstance(exc, HTTPException):
        detail = exc.detail
        error = detail.get("error", detail) if isinstance(detail, dict) else {}
        code = error.get("code") if isinstance(error, dict) else None
        message = error.get("message") if isinstance(error, dict) else None
        return ExplorationEditError(code or "QUERY_FAILED", message or str(detail), exc.status_code)
    return ExplorationEditError(getattr(exc, "code", None) or "QUERY_FAILED", getattr(exc, "message", None) or str(exc), 400)


async def run_graph_query(context_id: UUID, user_email: str, query: str) -> tuple[dict, dict]:
    """Runs a graph query of the context as the Query Console does (Cypher when it
    starts with MATCH or the context runs Cypher natively, else SQL) and returns
    ``(snapshot, info)``."""
    from fastapi import HTTPException

    from graphlagoon.models.schemas import CypherQueryRequest, GraphQueryRequest
    from graphlagoon.routers import graph as graph_router
    from graphlagoon.services.datasource.base import GraphExecutionFailure, require_capability
    from graphlagoon.services.graph_operations import QueryExecutionError
    from graphlagoon.utils.context_access import get_context_with_access

    text = (query or "").strip()
    if not text:
        raise ExplorationEditError("INVALID_BODY", "The query is empty")
    try:
        context = await get_context_with_access(context_id, user_email)
        datasource = graph_router.resolve_datasource_or_400(context)
        caps = getattr(datasource, "capabilities", None)
        native = caps is not None and not getattr(caps, "supports_sql", True)
        if native or text.upper().startswith("MATCH"):
            prepared = datasource.prepare_cypher(context, CypherQueryRequest(query=text, use_external_links=False))
        else:
            require_capability(datasource, "supports_sql", "Raw SQL graph queries")
            prepared = datasource.prepare_sql(context, GraphQueryRequest(query=text, use_external_links=False))
        await graph_router.enforce_query_scope(context, user_email, prepared.statement, None, datasource)
        graph = await datasource.execute_prepared(context, prepared, use_external_links=False)
    except (HTTPException, QueryExecutionError, GraphExecutionFailure) as exc:
        raise _query_error(exc) from exc
    return response_to_snapshot(graph), {"truncated": graph.truncated, "properties_deferred": graph.properties_deferred}


async def expand_nodes(context_id: UUID, user_email: str, node_ids: list[str], **options: Any) -> tuple[dict, dict]:
    """Neighbours of each node in the context (the browser's Expand), merged."""
    from fastapi import HTTPException

    from graphlagoon.models.schemas import ExpandRequest
    from graphlagoon.routers import graph as graph_router
    from graphlagoon.services.datasource.base import GraphExecutionFailure
    from graphlagoon.services.graph_operations import QueryExecutionError
    from graphlagoon.utils.context_access import get_context_with_access

    out, seen_n, seen_e, truncated, deferred = empty_snapshot(), set(), set(), False, False
    try:
        context = await get_context_with_access(context_id, user_email)
        datasource = graph_router.resolve_datasource_or_400(context)
        for node_id in node_ids:
            try:
                request = ExpandRequest(node_id=node_id, **options)
            except ValueError as exc:
                raise ExplorationEditError("INVALID_BODY", str(exc)) from exc
            part = response_to_snapshot(result := await datasource.expand(context, request))
            truncated |= bool(result.truncated)
            deferred |= bool(result.properties_deferred)
            out["nodes"] += [n for n in part["nodes"] if n["id"] not in seen_n and not seen_n.add(n["id"])]
            out["edges"] += [e for e in part["edges"] if e["id"] not in seen_e and not seen_e.add(e["id"])]
    except (HTTPException, QueryExecutionError, GraphExecutionFailure) as exc:
        raise _query_error(exc) from exc
    return out, {"truncated": truncated, "properties_deferred": deferred}


def additions(graph: dict) -> dict:
    """``apply_edit`` ops that add a whole graph (nodes before edges)."""
    return {"add_nodes": graph.get("nodes") or [], "add_edges": graph.get("edges") or []}


# ---------------------------------------------------------------------------
# Loading and saving
# ---------------------------------------------------------------------------


@dataclass
class Loaded:
    id: UUID
    context_id: UUID
    title: str
    owner_email: str
    state: dict
    snapshot: Optional[dict]
    overlay: Optional[dict]

    @property
    def revision(self) -> int:
        return int(self.state.get("revision") or 0)


def _error_of(exc) -> ExplorationEditError:
    detail = exc.detail if isinstance(exc.detail, str) else json.dumps(exc.detail)
    code = {404: "EXPLORATION_NOT_FOUND", 403: "FORBIDDEN"}.get(exc.status_code, "EXPLORATION_FAILED")
    return ExplorationEditError(code, detail, exc.status_code)


async def _row(session, exploration_id: UUID):
    if session is None:
        from graphlagoon.db.memory_store import get_memory_store

        return get_memory_store().get_exploration(exploration_id)
    from sqlalchemy import select
    from sqlalchemy.orm import selectinload

    from graphlagoon.db.models import Exploration

    result = await session.execute(
        select(Exploration).options(selectinload(Exploration.shares)).where(Exploration.id == exploration_id)
    )
    return result.scalar_one_or_none()


async def _check_access(session, row, user_email: str, write: bool) -> None:
    from fastapi import HTTPException

    from graphlagoon.routers.explorations import check_context_access_db, check_context_access_memory
    from graphlagoon.utils.authz import can_read, can_write

    if row is None:
        raise ExplorationEditError("EXPLORATION_NOT_FOUND", "Exploration not found", 404)
    if write:
        if not can_write(row.owner_email, row.shares, user_email):
            raise ExplorationEditError("FORBIDDEN", "No write access to this exploration", 403)
        return
    if can_read(row.owner_email, row.shares, user_email):
        return
    try:
        if session is None:
            check_context_access_memory(row.graph_context_id, user_email)
        else:
            await check_context_access_db(session, row.graph_context_id, user_email)
    except HTTPException as exc:
        raise _error_of(exc) from exc


async def _load_file(exploration_id: UUID, kind: str) -> Optional[dict]:
    from graphlagoon.services.snapshot import decompress_snapshot, get_snapshot_service

    raw = await (get_snapshot_service().load(exploration_id) if kind == "snapshot"
                 else get_snapshot_service().load(exploration_id, kind=kind))
    return decompress_snapshot(raw) if raw else None


async def load(exploration_id: UUID, user_email: str, *, write: bool = False) -> Loaded:
    """The exploration with its snapshot and layer, for a reader (or a writer)."""
    from graphlagoon.services.cases import _session

    async with _session() as session:
        row = await _row(session, exploration_id)
        await _check_access(session, row, user_email, write)
        state = dict(row.state or {})
        loaded = Loaded(row.id, row.graph_context_id, row.title, row.owner_email, state, None, None)
    if state.get("has_snapshot"):
        loaded.snapshot = await _load_file(exploration_id, "snapshot")
    if state.get("has_overlay"):
        loaded.overlay = await _load_file(exploration_id, "overlay")
    return loaded


async def save(
    loaded: Loaded,
    user_email: str,
    *,
    snapshot: dict,
    overlay: Optional[dict],
    last_change: dict,
    state_changes: Optional[dict] = None,
    title: Optional[str] = None,
):
    """Writes the graph back under the same id when nobody saved in between
    (``state.revision`` still the loaded one), else ``EXPLORATION_CHANGED``.
    ``overlay`` None keeps the layer as it is; an empty layer removes it."""
    from fastapi import HTTPException

    from graphlagoon.config import get_settings
    from graphlagoon.models.schemas import GraphOverlay, GraphSnapshot
    from graphlagoon.routers.explorations import _persist_snapshot, exploration_to_response
    from graphlagoon.services.cases import _session

    try:
        snap_model = GraphSnapshot.model_validate({**snapshot, "snapshot_version": snapshot.get("snapshot_version", 1)})
        layer_model = GraphOverlay.model_validate(overlay) if overlay is not None else None
    except ValueError as exc:
        raise ExplorationEditError("INVALID_BODY", str(exc)) from exc
    if layer_model is not None:
        limit = get_settings().exploration_overlay_max_bytes
        if len(json.dumps(layer_model.model_dump(), separators=(",", ":"))) > limit:
            raise ExplorationEditError("LAYER_TOO_LARGE", f"The layer would be over {limit} bytes", 413)

    async with _session() as session:
        row = await _row(session, loaded.id)
        await _check_access(session, row, user_email, write=True)
        current = dict(row.state or {})
        if int(current.get("revision") or 0) != loaded.revision:
            raise ExplorationEditError(
                "EXPLORATION_CHANGED",
                "The exploration was saved by someone else while this ran; read it again and retry",
                409,
            )
        if title is not None and title != row.title:
            await _check_title(session, row, title)
        try:
            await _persist_snapshot(row.id, snap_model)
            if layer_model is not None:
                if layer_model.is_empty():
                    if current.get("has_overlay"):
                        from graphlagoon.services.snapshot import get_snapshot_service

                        await get_snapshot_service().delete(row.id, kind="overlay")
                else:
                    await _persist_snapshot(row.id, layer_model, kind="overlay")
        except HTTPException as exc:
            raise ExplorationEditError("STORAGE_FAILED", str(exc.detail), exc.status_code) from exc
        state = {
            **current,
            **(state_changes or {}),
            "has_snapshot": True,
            "revision": loaded.revision + 1,
            "last_change": {**last_change, "at": datetime.now().isoformat()},
        }
        if layer_model is not None:
            state["has_overlay"] = not layer_model.is_empty()
        if session is None:
            from graphlagoon.db.memory_store import get_memory_store

            row = get_memory_store().update_exploration(row.id, state=state, title=title)
        else:
            row.state = state
            if title is not None:
                row.title = title
            await session.commit()
            await session.refresh(row)
            await session.refresh(row, ["shares"])
        return exploration_to_response(row, user_email)


async def _check_title(session, row, title: str) -> None:
    others = []
    if session is None:
        from graphlagoon.db.memory_store import get_memory_store

        others = [e for e in get_memory_store().explorations.values() if e.graph_context_id == row.graph_context_id]
    else:
        from sqlalchemy import select

        from graphlagoon.db.models import Exploration

        result = await session.execute(select(Exploration).where(Exploration.graph_context_id == row.graph_context_id))
        others = list(result.scalars().all())
    if any(e.title == title and e.id != row.id for e in others):
        raise ExplorationEditError("TITLE_TAKEN", f"An exploration named '{title}' already exists in this context", 409)
