"""``GET /api/live``: what an open page polls to pick up what an agent (or another
tab) changed, without reloading. Revisions only — no graph, no audit — so the poll
stays cheap; the page fetches the change itself when a revision moves. Polling
(not SSE) keeps it working behind the Databricks Apps proxy and across workers."""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request

from graphlagoon.config import get_settings
from graphlagoon.middleware.auth import get_current_user
from graphlagoon.services import cases
from graphlagoon.services.cases import InvestigationError

router = APIRouter(tags=["live"])

MAX_EXPLORATIONS = 20
MAX_CASES = 5


@router.get("/api/live")
async def live(
    request: Request,
    exploration: list[UUID] = Query(default=[]),
    case: list[UUID] = Query(default=[]),
) -> dict:
    """``explorations[id]``: ``{revision, last_change}``; ``cases[id]``:
    ``{last_event_id, last_event_at, explorations: {id: revision}}``. An id the
    caller cannot read (or that is gone) is null, never an error."""
    from graphlagoon.routers.explorations import _readable_state

    user_email = get_current_user(request)
    out: dict = {
        "refresh_seconds": get_settings().live_refresh_seconds,
        "explorations": {},
        "cases": {},
    }
    for eid in exploration[:MAX_EXPLORATIONS]:
        state: Optional[dict]
        try:
            state = await _readable_state(eid, user_email)
        except HTTPException:
            state = None
        out["explorations"][str(eid)] = (
            {"revision": int(state.get("revision") or 0), "last_change": state.get("last_change")}
            if state is not None
            else None
        )
    for cid in case[:MAX_CASES]:
        try:
            out["cases"][str(cid)] = await cases.live_revision(cid, user_email)
        except InvestigationError:
            out["cases"][str(cid)] = None
    return out
