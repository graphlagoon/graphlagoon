"""Org-wide reads for everyone signed in (05 §6): the playbooks of the library
and the vocabularies the settings drawer suggests. Superusers write them in
``routers/admin.py``; agents read the same data as ``org://`` MCP resources."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException

from graphlagoon.models.schemas import OrgLibraryDoc, OrgVocabulary
from graphlagoon.services import org_library, org_vocabularies

router = APIRouter(prefix="/api/org", tags=["org"])


def _not_found(code: str, message: str) -> HTTPException:
    return HTTPException(status_code=404, detail={"error": {"code": code, "message": message, "details": {}}})


@router.get("/library", response_model=list[OrgLibraryDoc])
async def list_library(kind: Optional[str] = None):
    return await org_library.list_docs(kind)


@router.get("/library/{slug}", response_model=OrgLibraryDoc)
async def get_library_doc(slug: str):
    doc = await org_library.get_doc(slug)
    if doc is None:
        raise _not_found("LIBRARY_DOC_NOT_FOUND", f"No library doc '{slug}'")
    return doc


@router.get("/vocabularies", response_model=list[OrgVocabulary])
async def list_vocabularies():
    return await org_vocabularies.list_vocabularies()


@router.get("/vocabularies/{kind}", response_model=OrgVocabulary)
async def get_vocabulary(kind: str):
    vocabulary = await org_vocabularies.get_vocabulary(kind)
    if vocabulary is None:
        raise _not_found("VOCABULARY_NOT_FOUND", f"Vocabulary kinds: {', '.join(org_vocabularies.KINDS)}")
    return vocabulary
