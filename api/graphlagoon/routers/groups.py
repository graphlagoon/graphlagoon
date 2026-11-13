"""Groups as share targets, for every signed-in person.

``GET /api/groups`` lists the admin-managed groups (``services.groups``) by
id, name and description so a share modal can offer them; members stay
superuser-only (``routers/admin_groups``). Read-only, hence not in the audit
registries; agent tokens are refused by the middleware allowlist.
"""

from __future__ import annotations

from fastapi import APIRouter

from graphlagoon.models.schemas import ShareableGroup, ShareableGroupsResponse
from graphlagoon.services import groups as groups_service

router = APIRouter(prefix="/api", tags=["groups"])


@router.get("/groups", response_model=ShareableGroupsResponse)
async def list_shareable_groups() -> ShareableGroupsResponse:
    """Groups a context, exploration or investigation can be shared with.

    Names and descriptions only (sorted by name); who belongs to a group is
    visible only in the admin area.
    """
    groups = await groups_service.list_groups()
    return ShareableGroupsResponse(
        items=[
            ShareableGroup(id=g["id"], name=g["name"], description=g.get("description"))
            for g in groups
        ]
    )
