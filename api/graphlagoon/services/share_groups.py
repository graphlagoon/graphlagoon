"""Group shares: which ``group:<uuid>`` sentinels grant the caller.

A share row may name a group instead of an e-mail (``utils.sharing``). The
sync access predicates (``can_read`` / ``can_write`` / ``email_matches_share``)
read the caller's sentinels from a request-scoped ContextVar; this module
fills it, at most once per request and user, from ``permissions.user_member_group_ids``
(e-mail members read live; Databricks members through the SCIM cache).

Two entry points:
- ``prime_group_shares`` before a list query or a gate that may be satisfied
  only by a group share (the rows are not loaded yet);
- ``group_shares_if_needed`` when the object's shares are already in hand —
  no IO unless one of them is a group share.
"""

from __future__ import annotations

from typing import Iterable, Optional
from uuid import UUID

from graphlagoon.services import groups as groups_service
from graphlagoon.services.permissions import user_member_group_ids
from graphlagoon.utils.sharing import (
    current_group_shares,
    group_share_value,
    is_group_share,
    parse_group_share,
    set_group_shares,
)


def share_target(share) -> str:
    """The principal a share row names (``shared_with_email`` or ``email``)."""
    return getattr(share, "shared_with_email", None) or getattr(share, "email", None) or ""


async def prime_group_shares(user_email: str) -> frozenset:
    """Resolve (once per request) the group sentinels that grant ``user_email``."""
    primed = current_group_shares(user_email)
    if primed is not None:
        return primed
    group_ids = await user_member_group_ids(user_email)
    sentinels = frozenset(group_share_value(gid) for gid in group_ids)
    set_group_shares(user_email, sentinels)
    return sentinels


async def group_shares_if_needed(user_email: str, shares: Iterable) -> frozenset:
    """``prime_group_shares`` only when some share row names a group."""
    if any(is_group_share(share_target(s)) for s in shares):
        return await prime_group_shares(user_email)
    return current_group_shares(user_email) or frozenset()


async def validate_group_share_target(value: str) -> tuple[bool, str, Optional[str]]:
    """``(ok, error_message, group_name)`` for a ``group:<uuid>`` share target."""
    group_id: Optional[UUID] = parse_group_share(value)
    if group_id is None:
        return False, f"Invalid group share target: {value}", None
    group = await groups_service.get_group(group_id)
    if group is None:
        return False, f"Group not found: {group_id}", None
    return True, "", group["name"]
