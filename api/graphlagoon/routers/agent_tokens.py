"""Personal agent tokens (03-arquitetura §8.2). Human-only: an agent can
neither mint nor revoke tokens. 404 while ``agents_enabled`` is off."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request

from graphlagoon.config import get_settings
from graphlagoon.middleware.auth import get_current_user
from graphlagoon.models.schemas import (
    AgentTokenCreate,
    AgentTokenCreated,
    AgentTokenResponse,
)
from graphlagoon.services import agent_tokens as service
from graphlagoon.services import audit
from graphlagoon.services.audit import AuditAction
from graphlagoon.utils.authz import forbid_agents, require_permission


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status,
        detail={"error": {"code": code, "message": message, "details": {}}},
    )


def require_agents_enabled() -> None:
    if not get_settings().agents_enabled:
        raise _error(404, "NOT_FOUND", "Not Found")


router = APIRouter(
    prefix="/api/agent-tokens",
    tags=["agent-tokens"],
    dependencies=[Depends(require_agents_enabled), Depends(forbid_agents)],
)


@router.get("", response_model=list[AgentTokenResponse])
async def list_agent_tokens(request: Request):
    return await service.list_tokens(get_current_user(request))


@router.post("", response_model=AgentTokenCreated, status_code=201)
async def create_agent_token(
    data: AgentTokenCreate,
    user_email: str = Depends(require_permission("investigation.agent")),
):
    max_days = get_settings().agent_token_max_days
    if data.expires_in_days > max_days:
        raise _error(
            422,
            "TOKEN_TOO_LONG_LIVED",
            f"Agent tokens may last at most {max_days} days.",
        )
    token, raw = await service.create_token(
        user_email, data.name.strip(), data.scopes, data.expires_in_days
    )
    await audit.record(
        user_email,
        AuditAction.AGENT_TOKEN_CREATE,
        resource_type="agent_token",
        resource_id=token["id"],
        metadata={"name": token["name"], "scopes": token["scopes"]},
    )
    return {**token, "token": raw}


@router.delete("/{token_id}")
async def revoke_agent_token(token_id: UUID, request: Request):
    user_email = get_current_user(request)
    if not await service.revoke_token(token_id, owner_email=user_email):
        raise _error(
            404, "AGENT_TOKEN_NOT_FOUND", f"Agent token '{token_id}' not found"
        )
    await audit.record(
        user_email,
        AuditAction.AGENT_TOKEN_REVOKE,
        resource_type="agent_token",
        resource_id=token_id,
    )
    return {"status": "revoked"}
