"""Case items (05 §1): everything in a case is an item of kind graph | table |
query | document | note with N immutable versions on the case storage
(``BlobStore``, sha256, never overwritten). A pinned version is the evidence.

Replaces investigation_{files,artifacts,evidence,sources}: an upload is a
``table/csv`` or ``document/upload`` item, a saved exploration a
``graph/exploration_ref`` (live reference), a frozen graph a ``graph/snapshot``,
the brief the single ``document/brief`` item.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from graphlagoon.services import investigation_storage as storage
from graphlagoon.services import text_extract
from graphlagoon.services.cases import (
    InvestigationError,
    _session,
    add_row,
    append_event,
    author_fields,
    canonical,
    commit,
    delete_row,
    ensure_not_decided,
    get_row,
    list_rows,
    load_case,
    update_row,
    write_status,
)

ITEMS = "case_items"
VERSIONS = "case_item_versions"

SUBKINDS: dict[str, tuple[str, ...]] = {
    "graph": ("exploration_ref", "snapshot", "selection", "derived", "view"),
    "table": ("result", "csv", "enrichment", "metrics"),
    "query": ("sql", "cypher"),
    "document": ("upload", "markdown", "link", "brief"),
    "note": ("free", "anchored"),
}
DEFAULT_CONTENT_TYPES = {
    "document/markdown": "text/markdown",
    "document/brief": "text/markdown",
    "document/link": "text/plain",
    "note/free": "text/markdown",
    "note/anchored": "text/markdown",
    "table/csv": "text/csv",
}
TEXT_LIKE = ("text/", "application/json")


def _invalid(message: str) -> InvestigationError:
    return InvestigationError(422, "INVALID_ITEM", message)


def check_kind(kind: str, subkind: str) -> None:
    if subkind not in SUBKINDS.get(kind, ()):
        raise _invalid(f"Unknown item kind {kind}/{subkind}")


def check_filename(name: Optional[str]) -> str:
    name = (name or "").strip()
    if (
        not name
        or len(name) > 255
        or name.startswith(".")
        or any(c in name for c in "/\\")
        or any(ord(c) < 32 for c in name)
    ):
        raise InvestigationError(422, "INVALID_FILE_NAME", "Give the file a plain file name")
    return name


def validate_mapping(mapping: Optional[dict]) -> Optional[dict]:
    """``{as: graph, spec, extra_item_ids?}`` (a file-mapping spec, 03 §4) or
    ``{as: enrichment, spec}`` (a ``FileEnrichmentSpec``). Of the case, never a context."""
    if mapping is None:
        return None
    from pydantic import ValidationError

    from graphlagoon.models.schemas import FileEnrichmentSpec
    from graphlagoon.services import file_mapping

    how, spec = mapping.get("as"), mapping.get("spec")
    if how == "graph":
        try:
            file_mapping.validate(spec)
        except file_mapping.MappingError as exc:
            raise InvestigationError(422, "INVALID_MAPPING", str(exc))
        extra = [str(i) for i in mapping.get("extra_item_ids") or []]
        return {"as": "graph", "spec": spec, "extra_item_ids": extra}
    if how == "enrichment":
        try:
            return {"as": "enrichment", "spec": FileEnrichmentSpec.model_validate(spec).model_dump()}
        except ValidationError as exc:
            raise InvestigationError(422, "INVALID_MAPPING", str(exc.errors()[0]["msg"]))
    raise InvestigationError(422, "INVALID_MAPPING", 'mapping.as must be "graph" or "enrichment"')


def validate_query(query: Optional[dict]) -> Optional[dict]:
    if query is None:
        return None
    from pydantic import ValidationError

    from graphlagoon.models.schemas import CaseQuerySpec

    try:
        return CaseQuerySpec.model_validate(query).model_dump()
    except ValidationError as exc:
        raise InvestigationError(422, "INVALID_QUERY", str(exc.errors()[0]["msg"]))


def serialize_version(v: Any) -> dict:
    return {
        "id": v.id,
        "item_id": v.item_id,
        "version": v.version,
        "sha256": v.sha256,
        "size_bytes": v.size_bytes,
        "content_type": v.content_type,
        "has_text": v.text_blob_key is not None,
        "run": v.run,
        "created_by": v.created_by,
        "author_kind": v.author_kind,
        "created_at": v.created_at,
        "pinned_at": v.pinned_at,
        "pinned_by": v.pinned_by,
        "pin_label": v.pin_label,
    }


def serialize_item(item: Any, versions: list, accessible: bool = True) -> dict:
    latest = versions[-1] if versions else None
    return {
        "id": item.id,
        "kind": item.kind,
        "subkind": item.subkind,
        "title": item.title,
        "description": item.description,
        "tags": item.tags or [],
        "status": item.status,
        "author_kind": item.author_kind,
        "author_email": item.author_email,
        "agent_token_id": item.agent_token_id,
        "provenance": item.provenance or {},
        "exploration_id": item.exploration_id,
        "context_id": item.context_id,
        "query": item.query,
        "mapping": item.mapping,
        "anchor": item.anchor,
        "current_version": item.current_version,
        "position": item.position,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
        "deleted_at": item.deleted_at,
        "accessible": accessible,
        "latest": serialize_version(latest) if latest else None,
        "pinned": [serialize_version(v) for v in versions if v.pinned_at is not None],
    }


async def _versions_by_item(session, investigation_id: UUID) -> dict[UUID, list]:
    out: dict[UUID, list] = {}
    for v in sorted(await list_rows(session, VERSIONS, investigation_id), key=lambda v: v.version):
        out.setdefault(v.item_id, []).append(v)
    return out


async def _context_readable(context_id: Optional[UUID], user_email: str) -> bool:
    from fastapi import HTTPException

    from graphlagoon.utils.context_access import get_context_with_access

    if context_id is None:
        return True
    try:
        await get_context_with_access(context_id, user_email)
        return True
    except HTTPException:
        return False


async def item_row(session, investigation_id: UUID, item_id: UUID, *, deleted_ok: bool = False) -> Any:
    item = await get_row(session, ITEMS, item_id)
    if item is None or item.investigation_id != investigation_id or (item.deleted_at and not deleted_ok):
        raise InvestigationError(404, "ITEM_NOT_FOUND", f"Item with id '{item_id}' not found")
    return item


async def _serialize(session, item: Any, user_email: str, versions: Optional[list] = None) -> dict:
    if versions is None:
        versions = sorted(
            [v for v in await list_rows(session, VERSIONS, item.investigation_id) if v.item_id == item.id],
            key=lambda v: v.version,
        )
    accessible = await _context_readable(item.context_id, user_email) if item.kind == "graph" else True
    return serialize_item(item, versions, accessible)


async def list_items(
    investigation_id: UUID,
    user_email: str,
    kind: Optional[str] = None,
    status: Optional[str] = None,
    include_deleted: bool = False,
) -> list[dict]:
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        rows = await list_rows(session, ITEMS, investigation_id)
        versions = await _versions_by_item(session, investigation_id)
        readable: dict = {}
        out = []
        for item in sorted(rows, key=lambda i: (i.position, i.created_at, str(i.id))):
            if (item.deleted_at and not include_deleted) or (kind and item.kind != kind):
                continue
            if status and item.status != status:
                continue
            accessible = True
            if item.kind == "graph" and item.context_id is not None:
                if item.context_id not in readable:
                    readable[item.context_id] = await _context_readable(item.context_id, user_email)
                accessible = readable[item.context_id]
            out.append(serialize_item(item, versions.get(item.id, []), accessible))
        return out


async def get_item(investigation_id: UUID, user_email: str, item_id: UUID) -> dict:
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        return await _serialize(session, await item_row(session, investigation_id, item_id), user_email)


# ---------------------------------------------------------------------------
# Versions: the bytes live on the case storage, content-addressed per item
# ---------------------------------------------------------------------------


def _name_of(item: Any) -> str:
    return (item.provenance or {}).get("filename") or f"{item.title}.{'json' if item.kind in ('graph', 'table') and item.subkind != 'csv' else 'md'}"


async def _write_version(
    session,
    inv: Any,
    item: Any,
    user_email: str,
    data: bytes,
    content_type: Optional[str],
    run: Optional[dict] = None,
    received: Optional[storage.Received] = None,
) -> Any:
    """Stores ``data`` (or the spooled ``received`` upload) as the next version.
    The blob key is the sha256: the same bytes in the same item share a blob."""
    sha = received.sha256 if received else hashlib.sha256(data).hexdigest()
    size = received.size_bytes if received else len(data)
    key = storage.version_key(inv.id, item.id, sha)
    name = _name_of(item)
    content_type = content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
    try:
        if received is not None:
            await storage.put(key, received)
        else:
            await storage.save_new(key, data)
    except FileExistsError:
        pass  # content-addressed: the bytes are already there
    text = text_extract.extract(data, name, content_type)
    text_blob_key = None
    if text is not None:
        text_blob_key = storage.text_key(inv.id, item.id, sha)
        await storage.save_bytes(text_blob_key, text.encode("utf-8"))
    author = author_fields(user_email)
    version = await add_row(
        session,
        VERSIONS,
        investigation_id=inv.id,
        item_id=item.id,
        version=item.current_version + 1,
        sha256=sha,
        blob_key=key,
        size_bytes=size,
        content_type=content_type,
        text_blob_key=text_blob_key,
        run=run,
        created_by=user_email,
        author_kind=author["author_kind"],
        created_at=datetime.now(),
    )
    await update_row(session, ITEMS, item, current_version=version.version)
    await append_event(
        session,
        inv.id,
        user_email,
        "item.version_added",
        {
            "item_id": str(item.id),
            "kind": item.kind,
            "title": item.title,
            "version": version.version,
            "sha256": sha,
            "size_bytes": size,
            **({"run": {k: run[k] for k in ("statement_id", "row_count", "duration_ms") if k in run}} if run else {}),
        },
    )
    return version


def encode_content(content: Optional[str], content_json: Any) -> tuple[Optional[bytes], Optional[str]]:
    """JSON bodies carry text (``content``) or JSON (``content_json``)."""
    if content_json is not None:
        return canonical(content_json).encode("utf-8"), "application/json"
    if content is not None:
        return content.encode("utf-8"), None
    return None, None


async def create_item(
    investigation_id: UUID,
    user_email: str,
    data: dict,
    content: Optional[bytes] = None,
    content_type: Optional[str] = None,
    received: Optional[storage.Received] = None,
) -> dict:
    """Creates the item and, when there is content, its version 1. ``data`` is
    an ``ItemCreate`` dump; uploads come spooled in ``received``."""
    kind, subkind = data["kind"], data["subkind"]
    check_kind(kind, subkind)
    provenance = dict(data.get("provenance") or {})
    if received is not None:
        provenance["filename"] = check_filename(data.get("filename") or data.get("title"))
    mapping = validate_mapping(data.get("mapping"))
    query = validate_query(data.get("query")) if kind == "query" else None
    if kind == "query" and query is None:
        raise _invalid("A query item needs its query")
    try:
        async with _session() as session:
            inv = await load_case(session, investigation_id, user_email, "write")
            ensure_not_decided(inv)
            context_id = data.get("context_id")
            exploration_id = data.get("exploration_id")
            title = (data.get("title") or "").strip()
            if subkind == "exploration_ref":
                exploration = await _exploration(session, exploration_id)
                if exploration is None:
                    raise InvestigationError(404, "EXPLORATION_NOT_FOUND", f"Exploration '{exploration_id}' not found")
                context_id = exploration.graph_context_id
                title = title or exploration.title
                if any(
                    i.exploration_id == exploration.id and i.deleted_at is None
                    for i in await list_rows(session, ITEMS, investigation_id)
                ):
                    raise InvestigationError(409, "ITEM_EXISTS", "This exploration is already in the case")
            if context_id is not None and not await _context_readable(context_id, user_email):
                raise InvestigationError(403, "FORBIDDEN", "You need read access to that graph context")
            if subkind == "brief":
                existing = next(
                    (i for i in await list_rows(session, ITEMS, investigation_id) if i.subkind == "brief" and not i.deleted_at),
                    None,
                )
                if existing is not None:
                    raise InvestigationError(409, "ITEM_EXISTS", "The case already has its brief")
            if not title:
                title = provenance.get("filename") or f"{kind}/{subkind}"
            siblings = await list_rows(session, ITEMS, investigation_id)
            item = await add_row(
                session,
                ITEMS,
                investigation_id=investigation_id,
                kind=kind,
                subkind=subkind,
                title=title[:255],
                description=data.get("description"),
                tags=data.get("tags") or [],
                status=write_status(inv, kind),
                provenance=provenance,
                exploration_id=exploration_id if subkind == "exploration_ref" else None,
                context_id=context_id,
                query=query,
                mapping=mapping,
                anchor=data.get("anchor"),
                position=len(siblings),
                created_at=datetime.now(),
                updated_at=datetime.now(),
                **author_fields(user_email),
            )
            await append_event(
                session,
                investigation_id,
                user_email,
                "item.created",
                {
                    "item_id": str(item.id),
                    "kind": kind,
                    "subkind": subkind,
                    "title": item.title,
                    "status": item.status,
                    **({"exploration_id": str(exploration_id)} if exploration_id else {}),
                },
            )
            if content is not None or received is not None:
                if content is None:
                    with open(received.path, "rb") as f:
                        content = f.read()
                await _write_version(
                    session, inv, item, user_email, content,
                    content_type or DEFAULT_CONTENT_TYPES.get(f"{kind}/{subkind}"), received=received,
                )
                received = None
            await commit(session)
            return await _serialize(session, item, user_email)
    finally:
        if received is not None:
            received.discard()


async def _exploration(session, exploration_id: Optional[UUID]) -> Any:
    if exploration_id is None:
        return None
    if session is None:
        from graphlagoon.db.memory_store import get_memory_store

        return get_memory_store().get_exploration(exploration_id)
    from graphlagoon.db.models import Exploration

    return await session.get(Exploration, exploration_id)


async def add_version(
    investigation_id: UUID,
    user_email: str,
    item_id: UUID,
    content: Optional[bytes],
    content_type: Optional[str] = None,
    received: Optional[storage.Received] = None,
    run: Optional[dict] = None,
) -> dict:
    try:
        async with _session() as session:
            inv = await load_case(session, investigation_id, user_email, "write")
            ensure_not_decided(inv)
            item = await item_row(session, investigation_id, item_id)
            if item.subkind == "exploration_ref":
                raise _invalid("A live exploration reference has no versions; pin it instead")
            if content is None:
                with open(received.path, "rb") as f:
                    content = f.read()
            await _write_version(
                session, inv, item, user_email, content,
                content_type or DEFAULT_CONTENT_TYPES.get(f"{item.kind}/{item.subkind}"), run=run, received=received,
            )
            received = None
            await commit(session)
            return await _serialize(session, item, user_email)
    finally:
        if received is not None:
            received.discard()


_EDITABLE = ("title", "description", "tags", "mapping", "query", "anchor", "position")


async def update_item(investigation_id: UUID, user_email: str, item_id: UUID, changes: dict) -> dict:
    changes = {k: v for k, v in changes.items() if k in _EDITABLE}
    if "mapping" in changes:
        changes["mapping"] = validate_mapping(changes["mapping"])
    if "query" in changes:
        changes["query"] = validate_query(changes["query"])
    if "title" in changes:
        changes["title"] = (changes["title"] or "").strip()[:255]
        if not changes["title"]:
            raise _invalid("Give the item a title")
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        ensure_not_decided(inv)
        item = await item_row(session, investigation_id, item_id)
        if item.kind != "query" and "query" in changes:
            changes.pop("query")
        if item.kind != "table" and "mapping" in changes:
            changes.pop("mapping")
        await update_row(session, ITEMS, item, **changes)
        await append_event(
            session,
            investigation_id,
            user_email,
            "item.updated",
            {"item_id": str(item_id), "title": item.title, "fields": sorted(changes)},
        )
        await commit(session)
        return await _serialize(session, item, user_email)


async def delete_item(investigation_id: UUID, user_email: str, item_id: UUID) -> dict:
    """Soft delete: the versions (and the journal) stay; the item leaves the material list."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        ensure_not_decided(inv)
        item = await item_row(session, investigation_id, item_id)
        await update_row(session, ITEMS, item, deleted_at=datetime.now())
        await append_event(
            session, investigation_id, user_email, "item.deleted",
            {"item_id": str(item_id), "kind": item.kind, "title": item.title},
        )
        await commit(session)
        return {"title": item.title, "kind": item.kind}


async def list_versions(investigation_id: UUID, user_email: str, item_id: UUID) -> list[dict]:
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        item = await item_row(session, investigation_id, item_id, deleted_ok=True)
        rows = [v for v in await list_rows(session, VERSIONS, investigation_id) if v.item_id == item.id]
        return [serialize_version(v) for v in sorted(rows, key=lambda v: v.version)]


async def version_row(session, investigation_id: UUID, item: Any, version: Optional[int]) -> Any:
    rows = [v for v in await list_rows(session, VERSIONS, investigation_id) if v.item_id == item.id]
    wanted = version or item.current_version
    row = next((v for v in rows if v.version == wanted), None)
    if row is None:
        raise InvestigationError(404, "VERSION_NOT_FOUND", f"Item '{item.id}' has no version {wanted}")
    return row


async def get_content(
    investigation_id: UUID, user_email: str, item_id: UUID, version: Optional[int] = None
) -> tuple[bytes, dict, dict]:
    """(bytes, version, item) of a version (the current one by default); the
    sha256 is checked on read."""
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        item = await item_row(session, investigation_id, item_id, deleted_ok=True)
        row = await version_row(session, investigation_id, item, version)
        data = await storage.load(row.blob_key)
        if data is None:
            raise InvestigationError(404, "CONTENT_MISSING", "The stored content was not found")
        if hashlib.sha256(data).hexdigest() != row.sha256:
            raise InvestigationError(500, "CONTENT_HASH_MISMATCH", "The stored content does not match its sha256")
        return data, serialize_version(row), await _serialize(session, item, user_email)


async def get_text(
    investigation_id: UUID, user_email: str, item_id: UUID, version: Optional[int] = None
) -> tuple[Optional[str], dict]:
    """The text extraction of a version (None when the format has none)."""
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        item = await item_row(session, investigation_id, item_id, deleted_ok=True)
        row = await version_row(session, investigation_id, item, version)
        if row.text_blob_key is None:
            return None, serialize_version(row)
        data = await storage.load(row.text_blob_key)
        return (data.decode("utf-8") if data is not None else None), serialize_version(row)


async def pin_version(
    investigation_id: UUID, user_email: str, item_id: UUID, version: Optional[int], label: Optional[str]
) -> dict:
    """Pins a version as evidence (immutable: a pin is never undone). A live
    exploration reference is frozen first: its snapshot becomes version n."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        ensure_not_decided(inv)
        item = await item_row(session, investigation_id, item_id)
        if item.subkind == "exploration_ref" and version is None:
            from graphlagoon.services.case_graph import item_snapshot

            payload = await item_snapshot(session, inv, item, user_email)
            await _write_version(session, inv, item, user_email, canonical(payload).encode("utf-8"), "application/json")
        row = await version_row(session, investigation_id, item, version)
        if row.pinned_at is not None:
            raise InvestigationError(409, "ALREADY_PINNED", f"Version {row.version} is already pinned")
        await update_row(
            session, VERSIONS, row, pinned_at=datetime.now(), pinned_by=user_email, pin_label=(label or "").strip() or None
        )
        await append_event(
            session,
            investigation_id,
            user_email,
            "item.pinned",
            {"item_id": str(item_id), "title": item.title, "version": row.version, "sha256": row.sha256, "label": row.pin_label},
        )
        await commit(session)
        return serialize_version(row)


async def set_status(investigation_id: UUID, user_email: str, item_id: UUID, status: str) -> dict:
    """confirm | reject a suggested item (people only; the route forbids agents)."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        ensure_not_decided(inv)
        item = await item_row(session, investigation_id, item_id)
        if item.status != "suggested":
            raise InvestigationError(409, "NOT_SUGGESTED", "Only a suggested item is confirmed or rejected")
        await update_row(session, ITEMS, item, status=status)
        await append_event(
            session, investigation_id, user_email, f"item.{status}",
            {"item_id": str(item_id), "title": item.title, "author_email": item.author_email},
        )
        await commit(session)
        return await _serialize(session, item, user_email)


# ---------------------------------------------------------------------------
# Brief: the single document/brief item (05 §6)
# ---------------------------------------------------------------------------


async def get_brief(investigation_id: UUID, user_email: str) -> dict:
    """``{item, text}``; a case without a brief answers item None, text ""."""
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        item = next(
            (i for i in await list_rows(session, ITEMS, investigation_id) if i.subkind == "brief" and not i.deleted_at),
            None,
        )
        if item is None:
            return {"item": None, "text": ""}
        text = ""
        if item.current_version:
            row = await version_row(session, investigation_id, item, None)
            data = await storage.load(row.blob_key)
            text = data.decode("utf-8") if data else ""
        return {"item": await _serialize(session, item, user_email), "text": text}


async def put_brief(investigation_id: UUID, user_email: str, text: str) -> dict:
    """Creates the brief or adds a version to it; unchanged text adds nothing."""
    current = await get_brief(investigation_id, user_email)
    if current["item"] is None:
        item = await create_item(
            investigation_id, user_email,
            {"kind": "document", "subkind": "brief", "title": "Brief"}, text.encode("utf-8"), "text/markdown",
        )
        return {"item": item, "text": text}
    if current["text"] == text:
        return current
    item = await add_version(investigation_id, user_email, current["item"]["id"], text.encode("utf-8"), "text/markdown")
    return {"item": item, "text": text}


# ---------------------------------------------------------------------------
# Search (05 §6): titles, descriptions, tags and the text of the latest version
# ---------------------------------------------------------------------------


async def search(investigation_id: UUID, user_email: str, q: str, limit: int = 50) -> list[dict]:
    """shortcut: Python ``in`` over the latest text blobs; FTS/ILIKE in Postgres is F5."""
    needle = (q or "").strip().lower()
    if not needle:
        return []
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        versions = await _versions_by_item(session, investigation_id)
        hits = []
        for item in await list_rows(session, ITEMS, investigation_id):
            if item.deleted_at:
                continue
            fields = [item.title, item.description or "", " ".join(map(str, item.tags or []))]
            if item.query:
                fields.append(item.query.get("text") or "")
            where = "title" if any(needle in f.lower() for f in fields) else None
            snippet = None
            latest = versions.get(item.id, [])[-1:] or [None]
            if where is None and latest[0] is not None and latest[0].text_blob_key:
                data = await storage.load(latest[0].text_blob_key)
                text = data.decode("utf-8") if data else ""
                at = text.lower().find(needle)
                if at >= 0:
                    start, end = max(0, at - 60), min(len(text), at + 100)
                    while start > 0 and not text[start - 1].isspace():  # whole tokens: never half a CPF
                        start -= 1
                    while end < len(text) and not text[end].isspace():
                        end += 1
                    where, snippet = "text", text[start:end]
            if where is not None:
                hits.append({**serialize_item(item, versions.get(item.id, [])), "match": where, "snippet": snippet})
                if len(hits) >= limit:
                    break
        return hits
