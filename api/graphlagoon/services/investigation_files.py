"""Case files (03-arquitetura §3.3): raw uploads stored by content hash.

The blob lives at ``{investigation_id}/files/{sha256}`` on the case storage; a
second upload of the same bytes reuses it (never overwritten) and still gets
its own row, since name and role may differ. Roles: ``graph`` (becomes an
exploration, F2.5), ``enrichment`` (joined by key, F2.6) or ``attachment``.
"""

from __future__ import annotations

import mimetypes
from datetime import datetime
from typing import Any, Optional
from uuid import UUID, uuid4

from graphlagoon.db.memory_store import get_memory_store
from graphlagoon.services import investigation_storage as storage
from graphlagoon.services.investigations import (
    InvestigationError,
    _ensure_not_decided,
    _session,
    append_event,
    load_case,
)

_FILES = "investigation_files"
ROLES = ("graph", "enrichment", "attachment")


def _check_filename(name: Optional[str]) -> str:
    name = (name or "").strip()
    if (
        not name
        or len(name) > 255
        or name.startswith(".")
        or any(c in name for c in "/\\")
        or any(ord(c) < 32 for c in name)
    ):
        raise InvestigationError(
            422, "INVALID_FILE_NAME", "Give the file a plain file name"
        )
    return name


def serialize(f: Any) -> dict:
    return {
        "id": f.id,
        "filename": f.filename,
        "role": f.role,
        "sha256": f.sha256,
        "size_bytes": f.size_bytes,
        "content_type": f.content_type,
        "mapping": f.mapping,
        "context_id": f.context_id,
        "uploaded_by": f.uploaded_by,
        "uploaded_at": f.uploaded_at,
    }


async def _rows(session, investigation_id: UUID) -> list:
    if session is None:
        return get_memory_store().list_investigation_children(_FILES, investigation_id)
    from sqlalchemy import select

    from graphlagoon.db.models import InvestigationFile

    result = await session.execute(
        select(InvestigationFile).where(
            InvestigationFile.investigation_id == investigation_id
        )
    )
    return list(result.scalars().all())


async def list_files(investigation_id: UUID, user_email: str) -> list[dict]:
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        rows = await _rows(session, investigation_id)
        return [
            serialize(f)
            for f in sorted(rows, key=lambda f: f.uploaded_at, reverse=True)
        ]


async def upload_file(
    investigation_id: UUID,
    user_email: str,
    received: storage.Received,
    filename: Optional[str],
    role: Optional[str],
) -> dict:
    """Stores ``received`` (consumed) and records the file. The caller checked
    ``investigation.upload``."""
    try:
        filename = _check_filename(filename)
        if role not in ROLES:
            raise InvestigationError(
                422, "INVALID_FILE_ROLE", f"Role must be one of {', '.join(ROLES)}"
            )
        async with _session() as session:
            inv = await load_case(session, investigation_id, user_email, "write")
            _ensure_not_decided(inv)
            key = storage.file_key(investigation_id, received.sha256)
            try:
                await storage.put(key, received)
            except FileExistsError:
                pass  # same bytes already in the case: content-addressed, reuse
            fields = {
                "id": uuid4(),
                "investigation_id": investigation_id,
                "filename": filename,
                "role": role,
                "sha256": received.sha256,
                "size_bytes": received.size_bytes,
                "content_type": mimetypes.guess_type(filename)[0],
                "blob_key": key,
                "uploaded_by": user_email,
                "uploaded_at": datetime.now(),
            }
            if session is None:
                row = get_memory_store().add_investigation_child(_FILES, **fields)
            else:
                from graphlagoon.db.models import InvestigationFile

                row = InvestigationFile(**fields)
                session.add(row)
            await append_event(
                session,
                investigation_id,
                user_email,
                "file.uploaded",
                {
                    "file_id": str(row.id),
                    "filename": filename,
                    "role": role,
                    "sha256": received.sha256,
                    "size_bytes": received.size_bytes,
                },
            )
            if session is not None:
                await session.commit()
            return serialize(row)
    finally:
        received.discard()


async def get_content(
    investigation_id: UUID, user_email: str, file_id: UUID
) -> tuple[bytes, dict]:
    """The file's bytes plus its serialized row."""
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        if session is None:
            row = get_memory_store().get_investigation_child(_FILES, file_id)
        else:
            from graphlagoon.db.models import InvestigationFile

            row = await session.get(InvestigationFile, file_id)
        if row is None or row.investigation_id != investigation_id:
            raise InvestigationError(
                404, "FILE_NOT_FOUND", f"File with id '{file_id}' not found"
            )
        data = await storage.load(row.blob_key)
        if data is None:
            raise InvestigationError(
                404, "FILE_CONTENT_MISSING", "The stored file was not found"
            )
        return data, serialize(row)


# ---------------------------------------------------------------------------
# Mapping and file graphs (F2.5, F2.6)
# ---------------------------------------------------------------------------

# Normalizers that make a node id an entity key (03 §2.1); the rest stay local.
_KEY_NORMALIZERS = ("cpf_cnpj", "account", "phone", "email")


async def _file_row(session, investigation_id: UUID, file_id: UUID) -> Any:
    if session is None:
        row = get_memory_store().get_investigation_child(_FILES, file_id)
    else:
        from graphlagoon.db.models import InvestigationFile

        row = await session.get(InvestigationFile, file_id)
    if row is None or row.investigation_id != investigation_id:
        raise InvestigationError(
            404, "FILE_NOT_FOUND", f"File with id '{file_id}' not found"
        )
    return row


def _invalid_mapping(message: str) -> InvestigationError:
    return InvestigationError(422, "INVALID_MAPPING", message)


def validate_mapping(role: str, mapping: dict) -> dict:
    """A graph file takes a mapping spec (03 §4); an enrichment file takes a
    ``FileEnrichmentSpec``. Returns the mapping to store."""
    from pydantic import ValidationError

    from graphlagoon.models.schemas import FileEnrichmentSpec
    from graphlagoon.services import file_mapping

    if role == "graph":
        try:
            file_mapping.validate(mapping)
        except file_mapping.MappingError as exc:
            raise _invalid_mapping(str(exc))
        return mapping
    if role == "enrichment":
        try:
            return FileEnrichmentSpec.model_validate(mapping).model_dump()
        except ValidationError as exc:
            raise _invalid_mapping(str(exc.errors()[0]["msg"]))
    raise _invalid_mapping("Attachments have no mapping")


async def set_mapping(
    investigation_id: UUID, user_email: str, file_id: UUID, mapping: dict
) -> dict:
    """Stores the file's mapping (enrichment files, F2.6); journaled."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _ensure_not_decided(inv)
        row = await _file_row(session, investigation_id, file_id)
        row.mapping = validate_mapping(row.role, mapping)
        await append_event(
            session,
            investigation_id,
            user_email,
            "file.mapped",
            {"file_id": str(file_id), "filename": row.filename, "name": mapping.get("name")},
        )
        if session is not None:
            await session.commit()
        return serialize(row)


def derived_identity_keys(mapping: dict) -> list[dict]:
    """One identity key per node type whose id the mapping normalizes as a
    document, account, phone or e-mail: the entity is the node type."""
    keys: dict[str, dict] = {}
    for nd in mapping.get("nodes") or []:
        how = nd["id"].get("normalize") if isinstance(nd["id"], dict) else None
        if how in _KEY_NORMALIZERS and nd["type"] not in keys:
            keys[nd["type"]] = {
                "node_type": nd["type"],
                "entity": nd["type"],
                "source": "node_id",
                "normalize": how,
            }
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
    graph["nodes"] = [
        n
        for n in graph["nodes"]
        if n["node_id"] in touched or n["node_id"] not in touched_before
    ]
    graph["edges"] = kept
    graph["truncated"] = True
    return len(edges) - limit


async def generate_context(
    investigation_id: UUID,
    user_email: str,
    file_id: UUID,
    mapping: dict,
    file_ids: list[UUID],
    title: Optional[str] = None,
) -> dict:
    """Builds the file graph on the server (F2.5): applies ``mapping`` to the
    file (plus ``file_ids``), creates the ``file`` context and an exploration
    with the graph as its snapshot, and adds it as a source of the case. The
    caller checked ``investigation.upload``."""
    from graphlagoon.config import get_settings
    from graphlagoon.services import file_mapping
    from graphlagoon.services.datasource.file import save_file_graph, to_snapshot
    from graphlagoon.services.investigations import (
        _SOURCES,
        _list_sources,
        _serialize_source,
    )
    from graphlagoon.services.snapshot import compress_snapshot, get_snapshot_service

    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _ensure_not_decided(inv)
        main = await _file_row(session, investigation_id, file_id)
        if main.role != "graph":
            raise InvestigationError(
                422, "FILE_NOT_GRAPH", "Only files with the graph role become a graph"
            )
        if main.context_id is not None:
            raise InvestigationError(
                409, "FILE_CONTEXT_EXISTS", "This file already has a graph"
            )
        mapping = validate_mapping("graph", mapping)
        picked = [main]
        for fid in dict.fromkeys(file_ids):
            if fid != file_id:
                picked.append(await _file_row(session, investigation_id, fid))
        texts: dict[str, str] = {}
        for row in picked:
            if row.filename in texts:
                raise InvestigationError(
                    422, "DUPLICATE_FILE_NAME", f"Two inputs are named '{row.filename}'"
                )
            data = await storage.load(row.blob_key)
            if data is None:
                raise InvestigationError(
                    404, "FILE_CONTENT_MISSING", "The stored file was not found"
                )
            inp = next(
                (
                    i
                    for i in mapping["inputs"].values()
                    if file_mapping._glob(i["match"], row.filename)
                ),
                {},
            )
            texts[row.filename] = file_mapping.decode(data, inp.get("encoding"))
        try:
            result = file_mapping.interpret(mapping, texts)
        except file_mapping.MappingError as exc:
            raise _invalid_mapping(str(exc))
        graph, report = result["graph"], result["report"]
        if not graph["nodes"]:
            raise InvestigationError(
                422, "EMPTY_FILE_GRAPH", "The mapping produced no node from these files"
            )
        report["truncated_edges"] = cap_edges(
            graph, get_settings().investigation_max_working_edges
        )

        name = (title or main.filename).strip()[:200]
        context_fields = {
            "title": f"{name} (file)",
            "description": f"Generated from case file {main.filename} ({main.sha256[:12]})",
            "datasource_type": "file",
            "edge_table_name": None,
            "node_table_name": None,
            "node_types": sorted({n["node_type"] for n in graph["nodes"]}),
            "relationship_types": sorted({e["relationship_type"] for e in graph["edges"]}),
            "identity_keys": derived_identity_keys(mapping),
            "owner_email": user_email,
        }
        state = {"has_snapshot": True}
        if session is None:
            store = get_memory_store()
            context = store.create_graph_context(**context_fields)
            context.edge_semantics = mapping.get("edge_semantics") or {}
            exploration = store.create_exploration(
                graph_context_id=context.id, title=name, owner_email=user_email, state=state
            )
        else:
            from graphlagoon.db.models import Exploration, GraphContext

            context = GraphContext(
                **context_fields, edge_semantics=mapping.get("edge_semantics") or {}
            )
            session.add(context)
            await session.flush()
            exploration = Exploration(
                graph_context_id=context.id,
                title=name,
                owner_email=user_email,
                state=state,
            )
            session.add(exploration)
            await session.flush()
        await save_file_graph(context.id, graph)
        await get_snapshot_service().save(
            exploration.id, compress_snapshot(to_snapshot(graph))
        )

        existing = await _list_sources(session, investigation_id)
        source_fields = {
            "id": uuid4(),
            "investigation_id": investigation_id,
            "kind": "file",
            "exploration_id": exploration.id,
            "file_id": main.id,
            "context_id": context.id,
            "mode": "live",
            "title_snapshot": name,
            "added_by": user_email,
            "position": len(existing),
        }
        if session is None:
            source = get_memory_store().add_investigation_child(_SOURCES, **source_fields)
        else:
            from graphlagoon.db.models import InvestigationSource

            source = InvestigationSource(**source_fields)
            session.add(source)
        main.mapping = mapping
        main.context_id = context.id
        await append_event(
            session,
            investigation_id,
            user_email,
            "source.added",
            {
                "source_id": str(source_fields["id"]),
                "exploration_id": str(exploration.id),
                "context_id": str(context.id),
                "title": name,
                "mode": "live",
                "mapping": mapping.get("name"),
                "files": [{"filename": r.filename, "sha256": r.sha256} for r in picked],
                "nodes": len(graph["nodes"]),
                "edges": len(graph["edges"]),
                "rows_discarded": report["rows_discarded"],
                "truncated_edges": report["truncated_edges"],
            },
        )
        if session is not None:
            await session.commit()
            await session.refresh(source)
        return {
            "source": await _serialize_source(session, source, user_email),
            "file": serialize(main),
            "context_id": context.id,
            "exploration_id": exploration.id,
            "report": report,
        }
