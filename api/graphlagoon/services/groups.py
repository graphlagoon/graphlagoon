"""CRUD for permission groups and permission rules.

All group/permission storage goes through this module — routers never branch
on the persistence mode themselves (the memory-store drift documented in
``routers/graph_contexts.py`` is exactly what this avoids for the new
feature). Members are normalized at this edge: values lowercased/stripped,
``email`` members validated for shape, duplicates dropped.
"""

from __future__ import annotations

import logging
from typing import Any, Optional
from uuid import UUID

from graphlagoon.db.database import get_session_maker, is_database_available
from graphlagoon.db.memory_store import get_memory_store
from graphlagoon.utils.sharing import validate_owner_email

logger = logging.getLogger(__name__)

MEMBER_KINDS = ("email", "databricks_group")


class GroupError(Exception):
    """Base class; ``message`` is safe to surface to the admin UI."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class GroupNameTaken(GroupError):
    pass


class GroupNotFound(GroupError):
    pass


class InvalidMember(GroupError):
    pass


def normalize_members(members: list[dict[str, str]]) -> list[dict[str, str]]:
    """Validate and normalize ``[{kind, value}]``; raises ``InvalidMember``."""
    seen: set[tuple[str, str]] = set()
    normalized: list[dict[str, str]] = []
    for member in members:
        kind = (member.get("kind") or "").strip()
        value = (member.get("value") or "").strip().lower()
        if kind not in MEMBER_KINDS:
            raise InvalidMember(f"Unknown member kind: {kind!r}")
        if not value:
            raise InvalidMember("Member value cannot be empty")
        if kind == "email":
            ok, error = validate_owner_email(value)
            if not ok:
                raise InvalidMember(error)
        if (kind, value) in seen:
            continue
        seen.add((kind, value))
        normalized.append({"kind": kind, "value": value})
    return normalized


def _normalize_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise InvalidMember("Group name is required")
    if len(name) > 100:
        raise InvalidMember("Group name must be at most 100 characters")
    return name


def _serialize(group: Any, members: list[Any]) -> dict:
    return {
        "id": str(group.id),
        "name": group.name,
        "description": group.description,
        "members": [
            {"id": str(m.id), "kind": m.kind, "value": m.value} for m in members
        ],
        "created_at": group.created_at.isoformat() if group.created_at else None,
        "updated_at": group.updated_at.isoformat() if group.updated_at else None,
    }


async def list_groups() -> list[dict]:
    """All groups with members, sorted by name."""
    if is_database_available():
        from sqlalchemy import select
        from sqlalchemy.orm import selectinload

        from graphlagoon.db.models import Group

        session_maker = get_session_maker()
        async with session_maker() as session:
            result = await session.execute(
                select(Group).options(selectinload(Group.members)).order_by(Group.name)
            )
            return [_serialize(g, g.members) for g in result.scalars().all()]

    store = get_memory_store()
    return [_serialize(g, g.members) for g in store.list_groups()]


async def get_group(group_id: UUID) -> Optional[dict]:
    if is_database_available():
        from sqlalchemy import select
        from sqlalchemy.orm import selectinload

        from graphlagoon.db.models import Group

        session_maker = get_session_maker()
        async with session_maker() as session:
            result = await session.execute(
                select(Group)
                .options(selectinload(Group.members))
                .where(Group.id == group_id)
            )
            group = result.scalar_one_or_none()
            return _serialize(group, group.members) if group else None

    store = get_memory_store()
    group = store.get_group(group_id)
    return _serialize(group, group.members) if group else None


async def create_group(
    name: str, description: Optional[str], members: list[dict[str, str]]
) -> dict:
    name = _normalize_name(name)
    members = normalize_members(members)

    if is_database_available():
        from sqlalchemy import select

        from graphlagoon.db.models import Group, GroupMember

        session_maker = get_session_maker()
        async with session_maker() as session:
            existing = await session.execute(select(Group).where(Group.name == name))
            if existing.scalar_one_or_none() is not None:
                raise GroupNameTaken(f'A group named "{name}" already exists')
            group = Group(name=name, description=description)
            session.add(group)
            await session.flush()
            rows = [
                GroupMember(group_id=group.id, kind=m["kind"], value=m["value"])
                for m in members
            ]
            session.add_all(rows)
            await session.commit()
            await session.refresh(group)
            return _serialize(group, rows)

    store = get_memory_store()
    if store.get_group_by_name(name) is not None:
        raise GroupNameTaken(f'A group named "{name}" already exists')
    group = store.create_group(name=name, description=description, members=members)
    return _serialize(group, group.members)


async def update_group(
    group_id: UUID,
    name: str,
    description: Optional[str],
    members: list[dict[str, str]],
) -> dict:
    """Full replacement of name, description and members."""
    name = _normalize_name(name)
    members = normalize_members(members)

    if is_database_available():
        from sqlalchemy import delete, select

        from graphlagoon.db.models import Group, GroupMember

        session_maker = get_session_maker()
        async with session_maker() as session:
            result = await session.execute(select(Group).where(Group.id == group_id))
            group = result.scalar_one_or_none()
            if group is None:
                raise GroupNotFound("Group not found")
            clash = await session.execute(
                select(Group).where(Group.name == name, Group.id != group_id)
            )
            if clash.scalar_one_or_none() is not None:
                raise GroupNameTaken(f'A group named "{name}" already exists')
            group.name = name
            group.description = description
            await session.execute(
                delete(GroupMember).where(GroupMember.group_id == group_id)
            )
            rows = [
                GroupMember(group_id=group_id, kind=m["kind"], value=m["value"])
                for m in members
            ]
            session.add_all(rows)
            await session.commit()
            await session.refresh(group)
            return _serialize(group, rows)

    store = get_memory_store()
    if store.get_group(group_id) is None:
        raise GroupNotFound("Group not found")
    clash = store.get_group_by_name(name)
    if clash is not None and clash.id != group_id:
        raise GroupNameTaken(f'A group named "{name}" already exists')
    group = store.update_group(
        group_id, name=name, description=description, members=members
    )
    return _serialize(group, group.members)


async def delete_group(group_id: UUID) -> dict:
    """Deletes the group (rules cascade); returns the deleted payload for
    the audit entry. Raises ``GroupNotFound``."""
    if is_database_available():
        from sqlalchemy import select
        from sqlalchemy.orm import selectinload

        from graphlagoon.db.models import Group, PermissionRule

        session_maker = get_session_maker()
        async with session_maker() as session:
            result = await session.execute(
                select(Group)
                .options(selectinload(Group.members))
                .where(Group.id == group_id)
            )
            group = result.scalar_one_or_none()
            if group is None:
                raise GroupNotFound("Group not found")
            rules = await session.execute(
                select(PermissionRule).where(PermissionRule.group_id == group_id)
            )
            payload = _serialize(group, group.members)
            payload["rules_removed"] = len(rules.scalars().all())
            await session.delete(group)
            await session.commit()
            return payload

    store = get_memory_store()
    rules_removed = sum(
        1 for r in store.list_permission_rules() if r.group_id == group_id
    )
    group = store.delete_group(group_id)
    if group is None:
        raise GroupNotFound("Group not found")
    payload = _serialize(group, group.members)
    payload["rules_removed"] = rules_removed
    return payload


async def list_groups_membership() -> list[dict]:
    """Lightweight membership view for permission evaluation:
    ``[{id: UUID, name, emails: set[str], databricks: set[str]}]``."""
    groups = await list_groups()
    result = []
    for g in groups:
        result.append(
            {
                "id": UUID(g["id"]),
                "name": g["name"],
                "emails": {
                    m["value"] for m in g["members"] if m["kind"] == "email"
                },
                "databricks": {
                    m["value"] for m in g["members"] if m["kind"] == "databricks_group"
                },
            }
        )
    return result


async def get_permissions_config() -> dict[str, dict]:
    """Stored modes/rules keyed by permission id (group names included).
    Permissions with no rows are simply absent — the caller merges with the
    catalog and treats absence as ``mode="everyone"``."""
    if is_database_available():
        from sqlalchemy import select

        from graphlagoon.db.models import Group, PermissionMode, PermissionRule

        session_maker = get_session_maker()
        async with session_maker() as session:
            modes = (await session.execute(select(PermissionMode))).scalars().all()
            rules = (
                (
                    await session.execute(
                        select(PermissionRule, Group.name).join(
                            Group, PermissionRule.group_id == Group.id
                        )
                    )
                )
                .all()
            )
            config: dict[str, dict] = {}
            for mode in modes:
                config.setdefault(
                    mode.permission_id, {"mode": mode.mode, "rules": []}
                )
            for rule, group_name in rules:
                entry = config.setdefault(
                    rule.permission_id, {"mode": "everyone", "rules": []}
                )
                entry["rules"].append(
                    {
                        "group_id": str(rule.group_id),
                        "group_name": group_name,
                        "effect": rule.effect,
                    }
                )
            return config

    store = get_memory_store()
    config = {}
    for permission_id, mode in store.permission_modes.items():
        config.setdefault(permission_id, {"mode": mode, "rules": []})
    for rule in store.list_permission_rules():
        group = store.get_group(rule.group_id)
        entry = config.setdefault(
            rule.permission_id, {"mode": "everyone", "rules": []}
        )
        entry["rules"].append(
            {
                "group_id": str(rule.group_id),
                "group_name": group.name if group else "(deleted)",
                "effect": rule.effect,
            }
        )
    return config


async def set_permission(
    permission_id: str, mode: str, rules: list[dict[str, Any]]
) -> None:
    """Full replacement of one permission's mode and rules.

    ``rules`` is ``[{group_id: UUID, effect: "allow"|"deny"}]``; every group
    must exist (``GroupNotFound`` otherwise). The caller validates
    ``permission_id`` against the catalog.
    """
    deduped: dict[UUID, str] = {}
    for r in rules:
        deduped[r["group_id"]] = r["effect"]

    if is_database_available():
        from sqlalchemy import delete, select

        from graphlagoon.db.models import Group, PermissionMode, PermissionRule

        session_maker = get_session_maker()
        async with session_maker() as session:
            for group_id in deduped:
                exists = await session.execute(
                    select(Group.id).where(Group.id == group_id)
                )
                if exists.scalar_one_or_none() is None:
                    raise GroupNotFound(f"Group {group_id} not found")
            result = await session.execute(
                select(PermissionMode).where(
                    PermissionMode.permission_id == permission_id
                )
            )
            mode_row = result.scalar_one_or_none()
            if mode_row is None:
                session.add(PermissionMode(permission_id=permission_id, mode=mode))
            else:
                mode_row.mode = mode
            await session.execute(
                delete(PermissionRule).where(
                    PermissionRule.permission_id == permission_id
                )
            )
            session.add_all(
                PermissionRule(
                    permission_id=permission_id, group_id=group_id, effect=effect
                )
                for group_id, effect in deduped.items()
            )
            await session.commit()
            return

    store = get_memory_store()
    for group_id in deduped:
        if store.get_group(group_id) is None:
            raise GroupNotFound(f"Group {group_id} not found")
    store.set_permission(
        permission_id,
        mode,
        [{"group_id": gid, "effect": effect} for gid, effect in deduped.items()],
    )
