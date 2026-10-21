"""Org-wide reads for everyone signed in (05 §6, 06 §1): the playbooks of the
library and the case types. Superusers write them in ``routers/admin.py``;
agents read the same data as ``org://`` MCP resources."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException

from graphlagoon.models.schemas import CaseTypeResponse, OrgLibraryDoc
from graphlagoon.services import authoring, case_types, org_library

router = APIRouter(prefix="/api/org", tags=["org"])


def _not_found(code: str, message: str) -> HTTPException:
    return HTTPException(status_code=404, detail={"error": {"code": code, "message": message, "details": {}}})


@router.get("/authoring")
async def get_authoring():
    """What writing case types and library docs needs (06): the case type
    schema, the report placeholders, the mapping operators, the suggestible
    kinds and the agent's tools. The admin area's help is built from it."""
    return await authoring.catalog()


@router.get("/library", response_model=list[OrgLibraryDoc])
async def list_library(kind: Optional[str] = None):
    """The org library: playbooks, report templates and file mappings (`kind` filters). Built-in
    playbooks are marked `seeded`."""
    return await org_library.list_docs(kind)


@router.get("/library/{slug}", response_model=OrgLibraryDoc)
async def get_library_doc(slug: str):
    """One library doc by slug."""
    doc = await org_library.get_doc(slug)
    if doc is None:
        raise _not_found("LIBRARY_DOC_NOT_FOUND", f"No library doc '{slug}'")
    return doc


@router.get("/case-types", response_model=list[CaseTypeResponse])
async def list_case_types():
    """``general`` first, then the org's types by label."""
    return await case_types.list_case_types()


@router.get("/case-types/{slug}", response_model=CaseTypeResponse)
async def get_case_type(slug: str):
    """One case type in full: vocabulary, outcomes and actions, fields, stages, SLA hours,
    retention, notice, playbook, starter queries, report templates and trace defaults.
    `general` is built in."""
    case_type = await case_types.get_case_type(slug)
    if case_type is None:
        raise _not_found("CASE_TYPE_NOT_FOUND", f"No case type '{slug}'")
    return case_type
