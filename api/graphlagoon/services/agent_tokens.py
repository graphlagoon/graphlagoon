"""Personal agent tokens (03-arquitetura §8.2): create, list, revoke, resolve.

A token is ``glt_`` + 32 random bytes in base64url. Only its sha256 is
stored, so a leaked database does not leak usable tokens.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Any, Optional
from uuid import UUID, uuid4

from graphlagoon.db.database import get_session_maker, is_database_available
from graphlagoon.db.memory_store import get_memory_store

TOKEN_PREFIX = "glt_"
SCOPES = ("read", "analyze", "write", "propose")


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def is_active(token: Any, now: Optional[datetime] = None) -> bool:
    return token.revoked_at is None and token.expires_at > (now or datetime.now())


def serialize(token: Any) -> dict:
    return {
        "id": token.id,
        "owner_email": token.owner_email,
        "name": token.name,
        "scopes": list(token.scopes or []),
        "created_at": token.created_at,
        "expires_at": token.expires_at,
        "revoked_at": token.revoked_at,
        "active": is_active(token),
    }


async def create_token(
    owner_email: str, name: str, scopes: list[str], expires_in_days: int
) -> tuple[dict, str]:
    """Returns the stored token and the raw secret (shown to the caller once)."""
    raw = TOKEN_PREFIX + secrets.token_urlsafe(32)
    fields = {
        "id": uuid4(),
        "owner_email": owner_email,
        "name": name,
        "token_hash": hash_token(raw),
        "scopes": [s for s in SCOPES if s in set(scopes)],
        "created_at": datetime.now(),
        "expires_at": datetime.now() + timedelta(days=expires_in_days),
    }
    if not is_database_available():
        from graphlagoon.db.memory_store import MemoryAgentToken

        token = MemoryAgentToken(**fields)
        get_memory_store().agent_tokens[token.id] = token
        return serialize(token), raw

    from graphlagoon.db.models import AgentToken

    async with get_session_maker()() as session:
        token = AgentToken(**fields)
        session.add(token)
        await session.commit()
        await session.refresh(token)
        return serialize(token), raw


async def list_tokens(owner_email: Optional[str] = None) -> list[dict]:
    """The owner's tokens, or every token when ``owner_email`` is None (admin)."""
    if not is_database_available():
        rows = [
            t
            for t in get_memory_store().agent_tokens.values()
            if owner_email is None or t.owner_email == owner_email
        ]
    else:
        from sqlalchemy import select

        from graphlagoon.db.models import AgentToken

        query = select(AgentToken)
        if owner_email is not None:
            query = query.where(AgentToken.owner_email == owner_email)
        async with get_session_maker()() as session:
            rows = list((await session.execute(query)).scalars().all())
    rows.sort(key=lambda t: t.created_at, reverse=True)
    return [serialize(t) for t in rows]


async def revoke_token(token_id: UUID, owner_email: Optional[str] = None) -> bool:
    """Revokes the token (only the owner's when ``owner_email`` is given).
    False when it does not exist for that caller. Revoking twice is a no-op."""
    if not is_database_available():
        token = get_memory_store().agent_tokens.get(token_id)
        if token is None or (owner_email and token.owner_email != owner_email):
            return False
        token.revoked_at = token.revoked_at or datetime.now()
        return True

    from graphlagoon.db.models import AgentToken

    async with get_session_maker()() as session:
        token = await session.get(AgentToken, token_id)
        if token is None or (owner_email and token.owner_email != owner_email):
            return False
        if token.revoked_at is None:
            token.revoked_at = datetime.now()
            await session.commit()
        return True


async def resolve_token(raw: str) -> Optional[dict]:
    """The active token for a raw ``glt_…`` secret, or None (unknown,
    expired or revoked)."""
    digest = hash_token(raw)
    if not is_database_available():
        token = next(
            (
                t
                for t in get_memory_store().agent_tokens.values()
                if t.token_hash == digest
            ),
            None,
        )
    else:
        from sqlalchemy import select

        from graphlagoon.db.models import AgentToken

        async with get_session_maker()() as session:
            token = (
                await session.execute(
                    select(AgentToken).where(AgentToken.token_hash == digest)
                )
            ).scalar_one_or_none()
    if token is None or not is_active(token):
        return None
    return serialize(token)
