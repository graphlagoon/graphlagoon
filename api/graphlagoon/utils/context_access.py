"""Graph context lookup with access control.

One helper, used by every router that reaches for a context on the graph side:
it collapses the database/in-memory split into a single call and raises the
`{"error": {"code", "message", "details"}}` envelope the frontend parses.

Lived in `routers/graph.py` until the graph cache needed it too; `graph.py`
re-exports it for callers that import it from its historical home.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Union
from uuid import UUID

from fastapi import HTTPException

from graphlagoon.db.database import is_database_available, get_session_maker
from graphlagoon.db.memory_store import get_memory_store, MemoryGraphContext

if TYPE_CHECKING:
    from graphlagoon.db.models import GraphContext


async def get_context_with_access(
    context_id: UUID, user_email: str
) -> Union["GraphContext", MemoryGraphContext]:
    """Get graph context and verify access.

    Access is granted if the user:
    - Is a superuser (GRAPH_LAGOON_SUPERUSER_EMAILS), OR
    - Owns the context, OR
    - Has a context-level share (GraphContextShare), OR
    - Has an exploration-level share (ExplorationShare) for any exploration in this context
    """
    from graphlagoon.utils.authz import is_superuser
    from graphlagoon.utils.sharing import user_has_share_access, share_match_emails

    not_found_error = HTTPException(
        status_code=404,
        detail={
            "error": {
                "code": "GRAPH_CONTEXT_NOT_FOUND",
                "message": f"Graph context with id '{context_id}' not found",
                "details": {},
            }
        },
    )
    forbidden_error = HTTPException(
        status_code=403,
        detail={
            "error": {
                "code": "FORBIDDEN",
                "message": "You don't have access to this graph context",
                "details": {},
            }
        },
    )

    if is_database_available():
        from sqlalchemy import select
        from sqlalchemy.orm import selectinload
        from graphlagoon.db.models import GraphContext, Exploration, ExplorationShare

        session_maker = get_session_maker()
        async with session_maker() as session:
            result = await session.execute(
                select(GraphContext)
                .options(selectinload(GraphContext.shares))
                .where(GraphContext.id == context_id)
            )
            context = result.scalar_one_or_none()

            if context is None:
                raise not_found_error

            if context.owner_email == user_email or is_superuser(user_email):
                return context

            if user_has_share_access(user_email, context.shares):
                return context

            # Check exploration-level shares. `share_match_emails` is the single
            # source of truth for which `shared_with_email` values grant access —
            # exact match, the public sentinel "*" and the domain wildcard. Building
            # these conditions by hand here used to omit "*", so in database mode a
            # user whose only grant was a *public* exploration share could list
            # explorations but got 403 from every graph endpoint.
            exp_share_result = await session.execute(
                select(ExplorationShare.id)
                .join(Exploration, ExplorationShare.exploration_id == Exploration.id)
                .where(
                    Exploration.graph_context_id == context_id,
                    ExplorationShare.shared_with_email.in_(
                        share_match_emails(user_email)
                    ),
                )
                .limit(1)
            )
            if exp_share_result.scalar_one_or_none() is not None:
                return context

            raise forbidden_error
    else:
        store = get_memory_store()
        context = store.get_graph_context(context_id)

        if context is None:
            raise not_found_error

        if context.owner_email == user_email or is_superuser(user_email):
            return context

        if user_has_share_access(user_email, context.shares):
            return context

        # Check exploration-level shares
        for exp in store.explorations.values():
            if exp.graph_context_id == context_id and user_has_share_access(
                user_email, exp.shares
            ):
                return context

        raise forbidden_error
