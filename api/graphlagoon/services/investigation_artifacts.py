"""Case space (03-arquitetura §8.5): versioned artifacts on the case storage.

Every version is a new blob (``artifacts/{aid}/v{n}/{name}``) with its sha256,
author (person or agent) and the evidence it used; nothing is overwritten.
Versions start as drafts; approving is a human action (the route forbids
agents). A decided case is read-only.
"""

from __future__ import annotations

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

_ARTIFACTS = "investigation_artifacts"
_VERSIONS = "investigation_artifact_versions"

# extension -> (content type, default kind)
TYPES: dict[str, tuple[str, str]] = {
    "md": ("text/markdown", "doc"),
    "txt": ("text/plain", "doc"),
    "pdf": ("application/pdf", "doc"),
    "png": ("image/png", "image"),
    "jpg": ("image/jpeg", "image"),
    "jpeg": ("image/jpeg", "image"),
    "pptx": (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "slides",
    ),
    "docx": (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "doc",
    ),
    "xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "data"),
    "csv": ("text/csv", "data"),
    "json": ("application/json", "data"),
    "html": ("text/html", "report"),
    "svg": ("image/svg+xml", "image"),
}
# Never rendered inline (XSS): served only as attachments.
DOWNLOAD_ONLY = frozenset({"html", "svg"})
KINDS = ("slides", "doc", "report", "image", "data", "other")


def extension(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def _check_name(name: Optional[str]) -> str:
    name = (name or "").strip()
    if (
        not name
        or len(name) > 200
        or name.startswith(".")
        or any(c in name for c in '/\\\x00')
        or any(ord(c) < 32 for c in name)
    ):
        raise InvestigationError(
            422, "INVALID_ARTIFACT_NAME", "Give the artifact a plain file name"
        )
    if extension(name) not in TYPES:
        raise InvestigationError(
            422,
            "ARTIFACT_TYPE_NOT_ALLOWED",
            f"Accepted types: {', '.join(sorted(TYPES))}",
        )
    return name


def _actor(user_email: str) -> dict:
    from graphlagoon.middleware.auth import get_current_actor

    agent = get_current_actor()
    if agent:
        return {
            "kind": "agent",
            "email": user_email,
            "agent_name": agent["name"],
            "token_id": str(agent["token_id"]),
        }
    return {"kind": "human", "email": user_email}


def _serialize_version(v: Any) -> dict:
    return {
        "version": v.version,
        "sha256": v.sha256,
        "size_bytes": v.size_bytes,
        "content_type": v.content_type,
        "status": v.status,
        "actor": v.actor or {},
        "source_evidence_ids": v.source_evidence_ids or [],
        "note": v.note,
        "created_at": v.created_at,
        "approved_by": v.approved_by,
        "approved_at": v.approved_at,
    }


def _serialize(a: Any, versions: list) -> dict:
    return {
        "id": a.id,
        "name": a.name,
        "kind": a.kind,
        "current_version": a.current_version,
        "created_at": a.created_at,
        "download_only": extension(a.name) in DOWNLOAD_ONLY,
        "versions": [
            _serialize_version(v)
            for v in sorted(versions, key=lambda v: v.version, reverse=True)
        ],
    }


async def _rows(session, table: str, investigation_id: UUID) -> list:
    if session is None:
        return get_memory_store().list_investigation_children(table, investigation_id)
    from sqlalchemy import select

    from graphlagoon.db import models

    model = (
        models.InvestigationArtifact
        if table == _ARTIFACTS
        else models.InvestigationArtifactVersion
    )
    result = await session.execute(
        select(model).where(model.investigation_id == investigation_id)
    )
    return list(result.scalars().all())


async def _get_artifact(session, investigation_id: UUID, artifact_id: UUID) -> Any:
    if session is None:
        artifact = get_memory_store().get_investigation_child(_ARTIFACTS, artifact_id)
    else:
        from graphlagoon.db.models import InvestigationArtifact

        artifact = await session.get(InvestigationArtifact, artifact_id)
    if artifact is None or artifact.investigation_id != investigation_id:
        raise InvestigationError(
            404, "ARTIFACT_NOT_FOUND", f"Artifact with id '{artifact_id}' not found"
        )
    return artifact


async def _versions(session, investigation_id: UUID, artifact_id: UUID) -> list:
    return [
        v
        for v in await _rows(session, _VERSIONS, investigation_id)
        if v.artifact_id == artifact_id
    ]


async def _get_version(
    session, investigation_id: UUID, artifact_id: UUID, version: int
) -> Any:
    found = next(
        (
            v
            for v in await _versions(session, investigation_id, artifact_id)
            if v.version == version
        ),
        None,
    )
    if found is None:
        raise InvestigationError(
            404, "ARTIFACT_VERSION_NOT_FOUND", f"Version {version} not found"
        )
    return found


async def _add(session, table: str, fields: dict) -> Any:
    if session is None:
        return get_memory_store().add_investigation_child(table, **fields)
    from graphlagoon.db import models

    model = (
        models.InvestigationArtifact
        if table == _ARTIFACTS
        else models.InvestigationArtifactVersion
    )
    row = model(**fields)
    session.add(row)
    return row


async def list_artifacts(investigation_id: UUID, user_email: str) -> list[dict]:
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        versions = await _rows(session, _VERSIONS, investigation_id)
        artifacts = await _rows(session, _ARTIFACTS, investigation_id)
        return [
            _serialize(a, [v for v in versions if v.artifact_id == a.id])
            for a in sorted(artifacts, key=lambda a: a.created_at, reverse=True)
        ]


async def _store_version(
    session,
    investigation_id: UUID,
    artifact: Any,
    version: int,
    received: storage.Received,
    user_email: str,
    note: Optional[str],
    source_evidence_ids: list[str],
) -> Any:
    key = storage.artifact_key(investigation_id, artifact.id, version, artifact.name)
    try:
        await storage.put(key, received)
    except FileExistsError:
        raise InvestigationError(
            409, "ARTIFACT_VERSION_EXISTS", "Another version was saved first; retry"
        )
    return await _add(
        session,
        _VERSIONS,
        {
            "id": uuid4(),
            "investigation_id": investigation_id,
            "artifact_id": artifact.id,
            "version": version,
            "blob_key": key,
            "sha256": received.sha256,
            "size_bytes": received.size_bytes,
            "content_type": TYPES[extension(artifact.name)][0],
            "status": "draft",
            "actor": _actor(user_email),
            "source_evidence_ids": source_evidence_ids,
            "note": note,
            "created_at": datetime.now(),
        },
    )


async def create_artifact(
    investigation_id: UUID,
    user_email: str,
    received: storage.Received,
    name: Optional[str],
    kind: Optional[str] = None,
    note: Optional[str] = None,
    source_evidence_ids: Optional[list[str]] = None,
) -> dict:
    """Creates the artifact and its v1 (a draft). Consumes ``received``."""
    try:
        name = _check_name(name)
        if kind is not None and kind not in KINDS:
            raise InvestigationError(
                422, "INVALID_ARTIFACT_KIND", f"Kind must be one of {', '.join(KINDS)}"
            )
        async with _session() as session:
            inv = await load_case(session, investigation_id, user_email, "write")
            _ensure_not_decided(inv)
            artifact = await _add(
                session,
                _ARTIFACTS,
                {
                    "id": uuid4(),
                    "investigation_id": investigation_id,
                    "name": name,
                    "kind": kind or TYPES[extension(name)][1],
                    "current_version": 1,
                    "created_at": datetime.now(),
                },
            )
            version = await _store_version(
                session,
                investigation_id,
                artifact,
                1,
                received,
                user_email,
                note,
                source_evidence_ids or [],
            )
            await append_event(
                session,
                investigation_id,
                user_email,
                "artifact.created",
                {
                    "artifact_id": str(artifact.id),
                    "name": name,
                    "version": 1,
                    "sha256": received.sha256,
                    "size_bytes": received.size_bytes,
                },
            )
            if session is not None:
                await session.commit()
            return _serialize(artifact, [version])
    finally:
        received.discard()


async def add_version(
    investigation_id: UUID,
    user_email: str,
    artifact_id: UUID,
    received: storage.Received,
    name: Optional[str] = None,
    note: Optional[str] = None,
    source_evidence_ids: Optional[list[str]] = None,
) -> dict:
    """A new draft version; the file type must match the artifact's."""
    try:
        async with _session() as session:
            inv = await load_case(session, investigation_id, user_email, "write")
            _ensure_not_decided(inv)
            artifact = await _get_artifact(session, investigation_id, artifact_id)
            if name and extension(name) != extension(artifact.name):
                raise InvestigationError(
                    422,
                    "ARTIFACT_TYPE_MISMATCH",
                    f"A new version of {artifact.name} must be a "
                    f".{extension(artifact.name)} file",
                )
            number = artifact.current_version + 1
            await _store_version(
                session,
                investigation_id,
                artifact,
                number,
                received,
                user_email,
                note,
                source_evidence_ids or [],
            )
            artifact.current_version = number
            await append_event(
                session,
                investigation_id,
                user_email,
                "artifact.version_added",
                {
                    "artifact_id": str(artifact_id),
                    "name": artifact.name,
                    "version": number,
                    "sha256": received.sha256,
                    "size_bytes": received.size_bytes,
                },
            )
            if session is not None:
                await session.commit()
            return _serialize(
                artifact, await _versions(session, investigation_id, artifact_id)
            )
    finally:
        received.discard()


async def get_content(
    investigation_id: UUID, user_email: str, artifact_id: UUID, version: int
) -> tuple[bytes, dict]:
    """The version's bytes plus {name, content_type, download_only, sha256}."""
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        artifact = await _get_artifact(session, investigation_id, artifact_id)
        v = await _get_version(session, investigation_id, artifact_id, version)
        data = await storage.load(v.blob_key)
        if data is None:
            raise InvestigationError(
                404, "ARTIFACT_CONTENT_MISSING", "The stored file was not found"
            )
        return data, {
            "name": artifact.name,
            "content_type": v.content_type,
            "download_only": extension(artifact.name) in DOWNLOAD_ONLY,
            "sha256": v.sha256,
        }


async def approve_version(
    investigation_id: UUID, user_email: str, artifact_id: UUID, version: int
) -> dict:
    """Human only (the route forbids agents): draft → approved, journaled."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _ensure_not_decided(inv)
        artifact = await _get_artifact(session, investigation_id, artifact_id)
        v = await _get_version(session, investigation_id, artifact_id, version)
        if v.status == "approved":
            raise InvestigationError(
                409, "ARTIFACT_ALREADY_APPROVED", "This version is already approved"
            )
        v.status = "approved"
        v.approved_by = user_email
        v.approved_at = datetime.now()
        await append_event(
            session,
            investigation_id,
            user_email,
            "artifact.approved",
            {
                "artifact_id": str(artifact_id),
                "name": artifact.name,
                "version": version,
                "sha256": v.sha256,
            },
        )
        if session is not None:
            await session.commit()
        return _serialize(
            artifact, await _versions(session, investigation_id, artifact_id)
        )
