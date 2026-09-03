"""Permission evaluation over groups and rules.

The decision procedure (documented in docs/guide/permissions.md):

1. superuser → allow (lockout-proof — the superuser list is an env var);
2. any **deny** rule whose group contains the user → deny, even when the
   permission's mode is "everyone";
3. mode "restricted" → allow only via an **allow** rule's group;
4. otherwise (mode "everyone", the default) → allow.

Rules and modes are read per check — three tiny indexed tables — so admin
changes apply immediately and multi-worker deployments cannot disagree. The
only cached thing is the expensive external call (SCIM membership, see
``services.group_resolution``). The default posture (no rows) short-circuits
before any group or SCIM IO, so a deployment that never configures rules
pays ~2 small SELECTs per gated request and nothing else.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import AbstractSet, Optional, Sequence
from uuid import UUID

from graphlagoon.db.database import get_session_maker, is_database_available
from graphlagoon.db.memory_store import get_memory_store
from graphlagoon.services import groups as groups_service
from graphlagoon.services.group_resolution import (
    ResolvedMembership,
    get_group_resolver,
)
from graphlagoon.services.permission_catalog import PERMISSIONS
from graphlagoon.utils.authz import is_superuser


@dataclass(frozen=True)
class Decision:
    allowed: bool
    # "superuser" | "deny_rule" | "allow_rule" | "mode_everyone" | "restricted_no_match"
    reason: str
    group_id: Optional[UUID] = None  # the matched rule's group (inspector)


@dataclass(frozen=True)
class PermissionState:
    modes: dict  # permission_id -> "everyone" | "restricted" (absent ⇒ everyone)
    rules: dict  # permission_id -> list[(group_id, effect)]


def evaluate(
    *,
    superuser: bool,
    mode: str,
    rules: Sequence[tuple[UUID, str]],
    member_group_ids: AbstractSet[UUID],
) -> Decision:
    """Pure decision core — no IO, exhaustively unit-tested."""
    if superuser:
        return Decision(allowed=True, reason="superuser")
    for group_id, effect in rules:
        if effect == "deny" and group_id in member_group_ids:
            return Decision(allowed=False, reason="deny_rule", group_id=group_id)
    if mode == "restricted":
        for group_id, effect in rules:
            if effect == "allow" and group_id in member_group_ids:
                return Decision(allowed=True, reason="allow_rule", group_id=group_id)
        return Decision(allowed=False, reason="restricted_no_match")
    return Decision(allowed=True, reason="mode_everyone")


async def load_permission_state() -> PermissionState:
    if is_database_available():
        from sqlalchemy import select

        from graphlagoon.db.models import PermissionMode, PermissionRule

        session_maker = get_session_maker()
        async with session_maker() as session:
            mode_rows = (await session.execute(select(PermissionMode))).scalars().all()
            rule_rows = (await session.execute(select(PermissionRule))).scalars().all()
        modes = {m.permission_id: m.mode for m in mode_rows}
        rules: dict[str, list[tuple[UUID, str]]] = {}
        for r in rule_rows:
            rules.setdefault(r.permission_id, []).append((r.group_id, r.effect))
        return PermissionState(modes=modes, rules=rules)

    store = get_memory_store()
    rules = {}
    for r in store.list_permission_rules():
        rules.setdefault(r.permission_id, []).append((r.group_id, r.effect))
    return PermissionState(modes=dict(store.permission_modes), rules=rules)


async def user_member_group_ids(
    user_email: str, only_groups: Optional[AbstractSet[UUID]] = None
) -> set[UUID]:
    """Which groups (optionally restricted to ``only_groups``) contain the
    user — by email (exact, lowercased; no wildcards) or through a
    Databricks group. The SCIM resolver is consulted at most once, and only
    when some candidate group actually lists a databricks member."""
    email = (user_email or "").strip().lower()
    memberships = await groups_service.list_groups_membership()
    if only_groups is not None:
        memberships = [g for g in memberships if g["id"] in only_groups]

    member_ids: set[UUID] = {g["id"] for g in memberships if email in g["emails"]}

    if any(g["databricks"] for g in memberships):
        resolved = await get_group_resolver().groups_for(email)
        for g in memberships:
            if g["databricks"] & resolved.names:
                member_ids.add(g["id"])
    return member_ids


async def check_permission(user_email: str, perm_id: str) -> Decision:
    if is_superuser(user_email):
        return Decision(allowed=True, reason="superuser")
    state = await load_permission_state()
    rules = state.rules.get(perm_id, [])
    mode = state.modes.get(perm_id, "everyone")
    if not rules and mode == "everyone":
        # Default posture: no group loading, no SCIM.
        return Decision(allowed=True, reason="mode_everyone")
    member_ids = await user_member_group_ids(
        user_email, only_groups={group_id for group_id, _ in rules}
    )
    return evaluate(
        superuser=False, mode=mode, rules=rules, member_group_ids=member_ids
    )


async def effective_permissions(user_email: str) -> list[str]:
    """Sorted permission ids the user currently holds (for the SPA config)."""
    all_ids = sorted(p.id for p in PERMISSIONS)
    if is_superuser(user_email):
        return all_ids
    state = await load_permission_state()
    rule_groups: set[UUID] = {
        group_id for rules in state.rules.values() for group_id, _ in rules
    }
    member_ids: set[UUID] = set()
    if rule_groups:
        member_ids = await user_member_group_ids(user_email, only_groups=rule_groups)
    granted = []
    for perm_id in all_ids:
        decision = evaluate(
            superuser=False,
            mode=state.modes.get(perm_id, "everyone"),
            rules=state.rules.get(perm_id, []),
            member_group_ids=member_ids,
        )
        if decision.allowed:
            granted.append(perm_id)
    return granted


async def inspect_user(email: str) -> dict:
    """Everything the admin inspector shows: superuser status, resolved
    Databricks groups (with provenance), group memberships (with how), and
    the per-permission decision with the matched rule."""
    email = (email or "").strip().lower()
    superuser = is_superuser(email)
    memberships = await groups_service.list_groups_membership()

    resolution: ResolvedMembership
    if any(g["databricks"] for g in memberships):
        resolution = await get_group_resolver().groups_for(email)
    else:
        resolution = ResolvedMembership(names=frozenset(), source="none")

    group_names = {g["id"]: g["name"] for g in memberships}
    member_entries = []
    member_ids: set[UUID] = set()
    for g in memberships:
        via = []
        if email in g["emails"]:
            via.append("email")
        for name in sorted(g["databricks"] & resolution.names):
            via.append(f"databricks:{name}")
        if via:
            member_ids.add(g["id"])
            member_entries.append(
                {"group_id": str(g["id"]), "name": g["name"], "via": ", ".join(via)}
            )

    state = await load_permission_state()
    permissions = []
    for perm in sorted(PERMISSIONS, key=lambda p: p.id):
        decision = evaluate(
            superuser=superuser,
            mode=state.modes.get(perm.id, "everyone"),
            rules=state.rules.get(perm.id, []),
            member_group_ids=member_ids,
        )
        matched = None
        if decision.group_id is not None:
            matched = {
                "effect": "deny" if decision.reason == "deny_rule" else "allow",
                "group_id": str(decision.group_id),
                "group_name": group_names.get(decision.group_id, "(deleted)"),
            }
        permissions.append(
            {
                "id": perm.id,
                "label": perm.label,
                "mode": state.modes.get(perm.id, "everyone"),
                "allowed": decision.allowed,
                "reason": decision.reason,
                "matched": matched,
            }
        )

    return {
        "email": email,
        "is_superuser": superuser,
        "resolved_databricks_groups": sorted(resolution.names),
        "resolution": {"source": resolution.source, "error": resolution.error},
        "group_memberships": member_entries,
        "permissions": permissions,
    }
