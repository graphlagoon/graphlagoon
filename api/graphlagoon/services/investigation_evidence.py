"""Frozen evidence (03-arquitetura §2.2, §3.5): immutable, gz + sha256.

The blob (``evidence/{eid}.json.gz``) holds the title, kind, parameters (the
method stamp of a trace), the snapshot, the author and the time, as canonical
JSON gzipped with mtime=0, so the sha256 covers all of it and is a pure
function of the content. There is no update or delete: the row and the blob
are written once (``save_new`` refuses an existing key) and every read checks
the hash again. Journaled as ``evidence.created``.
"""

from __future__ import annotations

import gzip
import hashlib
import json
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from graphlagoon.db.memory_store import get_memory_store
from graphlagoon.services import investigation_storage as storage
from graphlagoon.services.investigations import (
    InvestigationError,
    _canonical,
    _ensure_not_decided,
    _session,
    append_event,
    load_case,
)

_EVIDENCE = "investigation_evidence"
KINDS = ("graph_state", "trace", "table", "file")


def _serialize(e: Any) -> dict:
    return {
        "id": e.id,
        "title": e.title,
        "kind": e.kind,
        "sha256": e.sha256,
        "params": e.params or {},
        "created_by": e.created_by,
        "created_at": e.created_at,
    }


def freeze(document: dict) -> bytes:
    """Canonical JSON, gzipped with mtime=0: same content, same bytes, same hash."""
    return gzip.compress(_canonical(document).encode("utf-8"), mtime=0)


async def _rows(session, investigation_id: UUID) -> list:
    if session is None:
        rows = get_memory_store().list_investigation_children(_EVIDENCE, investigation_id)
    else:
        from sqlalchemy import select

        from graphlagoon.db.models import InvestigationEvidence

        result = await session.execute(
            select(InvestigationEvidence).where(
                InvestigationEvidence.investigation_id == investigation_id
            )
        )
        rows = result.scalars().all()
    return sorted(rows, key=lambda e: (e.created_at, str(e.id)))


async def evidence_ids(session, investigation_id: UUID) -> set[str]:
    return {str(e.id) for e in await _rows(session, investigation_id)}


async def create_evidence(
    investigation_id: UUID,
    user_email: str,
    title: str,
    kind: str,
    params: dict,
    snapshot: Any,
) -> dict:
    from graphlagoon.config import get_settings

    if kind not in KINDS:
        raise InvestigationError(422, "INVALID_EVIDENCE_KIND", f"kind must be one of {KINDS}")
    title = (title or "").strip()
    if not title:
        raise InvestigationError(422, "INVALID_BODY", "Give the evidence a title")
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _ensure_not_decided(inv)
        evidence_id = uuid4()
        now = datetime.now()
        data = freeze(
            {
                "id": str(evidence_id),
                "investigation_id": str(investigation_id),
                "title": title,
                "kind": kind,
                "params": params,
                "snapshot": snapshot,
                "created_by": user_email,
                "created_at": now.isoformat(),
            }
        )
        max_bytes = get_settings().artifact_max_bytes
        if len(data) > max_bytes:
            raise InvestigationError(
                413, "EVIDENCE_TOO_LARGE", f"Evidence is limited to {max_bytes} bytes (gz)"
            )
        key = storage.evidence_key(investigation_id, evidence_id)
        await storage.save_new(key, data)
        fields = {
            "id": evidence_id,
            "investigation_id": investigation_id,
            "title": title,
            "kind": kind,
            "blob_key": key,
            "sha256": hashlib.sha256(data).hexdigest(),
            "params": json.loads(_canonical(params)),
            "created_by": user_email,
            "created_at": now,
        }
        await append_event(
            session,
            investigation_id,
            user_email,
            "evidence.created",
            {"evidence_id": str(evidence_id), "title": title, "kind": kind, "sha256": fields["sha256"]},
        )
        if session is None:
            row = get_memory_store().add_investigation_child(_EVIDENCE, **fields)
        else:
            from graphlagoon.db.models import InvestigationEvidence

            row = InvestigationEvidence(**fields)
            session.add(row)
            await session.commit()
        return _serialize(row)


async def list_evidence(investigation_id: UUID, user_email: str) -> list[dict]:
    """Oldest first (the dossier numbers them E1, E2, …)."""
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        return [_serialize(e) for e in await _rows(session, investigation_id)]


async def get_evidence(investigation_id: UUID, user_email: str, evidence_id: UUID) -> dict:
    """The row plus its frozen snapshot, after checking the stored hash."""
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        row = next(
            (e for e in await _rows(session, investigation_id) if e.id == evidence_id), None
        )
        if row is None:
            raise InvestigationError(
                404, "EVIDENCE_NOT_FOUND", f"Evidence with id '{evidence_id}' not found"
            )
        raw = await storage.load(row.blob_key)
        if raw is None:
            raise InvestigationError(404, "EVIDENCE_BLOB_MISSING", "Frozen copy not found")
        if hashlib.sha256(raw).hexdigest() != row.sha256:
            raise InvestigationError(
                500, "EVIDENCE_HASH_MISMATCH", "The frozen copy does not match its sha256"
            )
        document = json.loads(gzip.decompress(raw))
        return {**_serialize(row), "snapshot": document.get("snapshot")}
