"""User registry helpers shared by the auth middleware and the admin area.

Users are identified by e-mail (injected by the platform proxy or chosen by
the client in dev mode); there is no sign-up. ``touch_user`` is the single
place that records "this e-mail exists and was seen": the middleware calls it
per request, admin handlers call it for the user they act on behalf of, and
ownership transfers call it for the new owner so the Users tab lists them
even before they log in.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from graphlagoon.db.database import get_session_maker, is_database_available
from graphlagoon.db.memory_store import get_memory_store

logger = logging.getLogger(__name__)

# Cap on how often ``last_seen_at`` is written back. Every request already
# SELECTs the user row; a conditional UPDATE every 15 minutes keeps the write
# amplification negligible while still answering "who is active?".
LAST_SEEN_REFRESH = timedelta(minutes=15)


def _needs_refresh(last_seen: datetime | None, now: datetime) -> bool:
    if last_seen is None:
        return True
    if last_seen.tzinfo is None:
        last_seen = last_seen.replace(tzinfo=timezone.utc)
    return now - last_seen > LAST_SEEN_REFRESH


async def touch_user(email: str, session=None) -> None:
    """Ensure ``email`` exists in the user registry and bump ``last_seen_at``.

    Works in both persistence modes. When ``session`` is given (DB mode) the
    caller owns commit/rollback; otherwise a short-lived session is opened.
    Never raises: a registry hiccup must not fail the request that caused it.
    """
    if not email:
        return
    now = datetime.now(timezone.utc)
    try:
        if is_database_available():
            if session is not None:
                await _touch_db(session, email, now)
            else:
                session_maker = get_session_maker()
                async with session_maker() as own:
                    await _touch_db(own, email, now)
                    await own.commit()
        else:
            store = get_memory_store()
            user = store.ensure_user(email)
            if _needs_refresh(user.last_seen_at, now):
                user.last_seen_at = now
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("touch_user(%s) failed: %s", email, exc)


async def _touch_db(session, email: str, now: datetime) -> None:
    from sqlalchemy import select

    from graphlagoon.db.models import User

    result = await session.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user is None:
        user = User(email=email, display_name=email.split("@")[0], last_seen_at=now)
        session.add(user)
        await session.flush()
        return
    if _needs_refresh(user.last_seen_at, now):
        user.last_seen_at = now
        await session.flush()
