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
