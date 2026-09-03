"""In-memory storage for when database is disabled.

Provides the same interface as database models but stores data in memory.
Data is lost when the application restarts.
"""

from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Deque, Dict, List, Optional
from uuid import UUID, uuid4

from graphlagoon.utils.sharing import email_matches_share


@dataclass
class MemoryUser:
    email: str
    display_name: str
    created_at: datetime = field(default_factory=datetime.now)
    last_seen_at: Optional[datetime] = None


@dataclass
class MemoryUsageLog:
    """In-memory twin of db.models.UsageLog (the audit trail)."""

    id: UUID
    user_email: str
    action: str
    resource_type: Optional[str] = None
    resource_id: Optional[UUID] = None
    log_metadata: Optional[Dict[str, Any]] = None
    created_at: datetime = field(default_factory=datetime.now)


@dataclass
class MemoryGraphContextShare:
    id: UUID
    graph_context_id: UUID
    shared_with_email: str
    permission: str = "read"
    created_at: datetime = field(default_factory=datetime.now)


@dataclass
class MemoryGraphContext:
    id: UUID
    title: str
    # Optional because a native graph database (Neptune) context defines no
    # tables; the positional slots stay put so existing construction sites are
    # unaffected.
    edge_table_name: Optional[str]
    node_table_name: Optional[str]
    owner_email: str
    datasource_type: str = "sql_warehouse"
    # Named connection for "rest" contexts; None for the single-instance types.
    datasource_name: Optional[str] = None
    description: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    edge_structure: Dict[str, str] = field(
        default_factory=lambda: {
            "edge_id_col": "edge_id",
            "src_col": "src",
            "dst_col": "dst",
            "relationship_type_col": "relationship_type",
        }
    )
    node_structure: Dict[str, str] = field(
        default_factory=lambda: {"node_id_col": "node_id", "node_type_col": "node_type"}
    )
    edge_properties: List[Dict[str, Any]] = field(default_factory=list)
    node_properties: List[Dict[str, Any]] = field(default_factory=list)
    node_types: List[str] = field(default_factory=list)
    relationship_types: List[str] = field(default_factory=list)
    default_behaviors: Dict[str, Any] = field(default_factory=dict)
    cluster_programs: List[Dict[str, Any]] = field(default_factory=list)
    context_menu_actions: List[Dict[str, Any]] = field(default_factory=list)
    metric_definitions: List[Dict[str, Any]] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)
    shares: List[MemoryGraphContextShare] = field(default_factory=list)


@dataclass
class MemoryExplorationShare:
    id: UUID
    exploration_id: UUID
    shared_with_email: str
    permission: str = "read"
    created_at: datetime = field(default_factory=datetime.now)


@dataclass
class MemoryExploration:
    id: UUID
    graph_context_id: UUID
    title: str
    owner_email: str
    state: Dict[str, Any]
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)
    shares: List[MemoryExplorationShare] = field(default_factory=list)


@dataclass
class MemoryQueryTemplate:
    id: UUID
    graph_context_id: UUID
    owner_email: str
    name: str
    query_type: str  # "cypher" | "sql"
    query: str
    description: Optional[str] = None
    parameters: List[Dict[str, Any]] = field(default_factory=list)
    options: Dict[str, Any] = field(default_factory=dict)
    visibility: str = "shared"  # "shared" | "private"
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)


@dataclass
class MemoryGroupMember:
    """In-memory twin of db.models.GroupMember."""

    id: UUID
    group_id: UUID
    kind: str  # "email" | "databricks_group"
    value: str  # lowercased
    created_at: datetime = field(default_factory=datetime.now)


@dataclass
class MemoryGroup:
    """In-memory twin of db.models.Group (members inline, like shares)."""

    id: UUID
    name: str
    description: Optional[str] = None
    members: List[MemoryGroupMember] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)


@dataclass
class MemoryPermissionRule:
    """In-memory twin of db.models.PermissionRule."""

    id: UUID
    permission_id: str
    group_id: UUID
    effect: str  # "allow" | "deny"
    created_at: datetime = field(default_factory=datetime.now)


USAGE_LOG_MAX_ENTRIES = 10_000


class InMemoryStore:
    """In-memory storage for GraphContexts and Explorations."""

    _instance: Optional["InMemoryStore"] = None

    def __init__(self):
        self.users: Dict[str, MemoryUser] = {}
        self.graph_contexts: Dict[UUID, MemoryGraphContext] = {}
        self.explorations: Dict[UUID, MemoryExploration] = {}
        self.query_templates: Dict[UUID, MemoryQueryTemplate] = {}
        self.groups: Dict[UUID, MemoryGroup] = {}
        # permission_id -> "everyone" | "restricted"; absent ⇒ "everyone"
        self.permission_modes: Dict[str, str] = {}
        self.permission_rules: Dict[UUID, MemoryPermissionRule] = {}
        # Audit trail, newest last. Bounded so a long-running dev server
        # cannot grow without limit; the admin area reads it newest first.
        self.usage_logs: Deque[MemoryUsageLog] = deque(maxlen=USAGE_LOG_MAX_ENTRIES)

    @classmethod
    def get_instance(cls) -> "InMemoryStore":
        """Get singleton instance of the store."""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset(cls):
        """Reset the store (useful for testing)."""
        cls._instance = None

    # User operations
    def ensure_user(self, email: str) -> MemoryUser:
        """Ensure user exists, create if not."""
        if email not in self.users:
            self.users[email] = MemoryUser(
                email=email, display_name=email.split("@")[0]
            )
        return self.users[email]

    # GraphContext operations
    def create_graph_context(
        self,
        title: str,
        edge_table_name: Optional[str],
        node_table_name: Optional[str],
        owner_email: str,
        datasource_type: str = "sql_warehouse",
        datasource_name: Optional[str] = None,
        description: Optional[str] = None,
        tags: Optional[List[str]] = None,
        edge_structure: Optional[Dict[str, str]] = None,
        node_structure: Optional[Dict[str, str]] = None,
        edge_properties: Optional[List[Dict[str, Any]]] = None,
        node_properties: Optional[List[Dict[str, Any]]] = None,
        node_types: Optional[List[str]] = None,
        relationship_types: Optional[List[str]] = None,
        default_behaviors: Optional[Dict[str, Any]] = None,
        cluster_programs: Optional[List[Dict[str, Any]]] = None,
        context_menu_actions: Optional[List[Dict[str, Any]]] = None,
        metric_definitions: Optional[List[Dict[str, Any]]] = None,
    ) -> MemoryGraphContext:
        """Create a new graph context."""
        context_id = uuid4()
        context = MemoryGraphContext(
            id=context_id,
            title=title,
            edge_table_name=edge_table_name,
            node_table_name=node_table_name,
            owner_email=owner_email,
            datasource_type=datasource_type,
            datasource_name=datasource_name,
            description=description,
            tags=tags or [],
            edge_structure=edge_structure
            or {
                "edge_id_col": "edge_id",
                "src_col": "src",
                "dst_col": "dst",
                "relationship_type_col": "relationship_type",
            },
            node_structure=node_structure
            or {"node_id_col": "node_id", "node_type_col": "node_type"},
            edge_properties=edge_properties or [],
            node_properties=node_properties or [],
            node_types=node_types or [],
            relationship_types=relationship_types or [],
            default_behaviors=default_behaviors or {},
            cluster_programs=cluster_programs or [],
            context_menu_actions=context_menu_actions or [],
            metric_definitions=metric_definitions or [],
        )
        self.graph_contexts[context_id] = context
        return context

    def get_graph_context(self, context_id: UUID) -> Optional[MemoryGraphContext]:
        """Get a graph context by ID."""
        return self.graph_contexts.get(context_id)

    def list_graph_contexts(self, user_email: str) -> List[MemoryGraphContext]:
        """List graph contexts accessible by a user."""
        result = []
        for context in self.graph_contexts.values():
            if context.owner_email == user_email:
                result.append(context)
            elif any(
                email_matches_share(user_email, s.shared_with_email)
                for s in context.shares
            ):
                result.append(context)
        return sorted(result, key=lambda c: c.updated_at, reverse=True)

    def update_graph_context(
        self, context_id: UUID, **kwargs
    ) -> Optional[MemoryGraphContext]:
        """Update a graph context."""
        context = self.graph_contexts.get(context_id)
        if context is None:
            return None

        for key, value in kwargs.items():
            if hasattr(context, key) and value is not None:
                setattr(context, key, value)
        context.updated_at = datetime.now()
        return context

    def delete_graph_context(self, context_id: UUID) -> bool:
        """Delete a graph context and its explorations."""
        if context_id not in self.graph_contexts:
            return False

        # Collect explorations with snapshots before deleting them
        to_delete = [
            eid
            for eid, exp in self.explorations.items()
            if exp.graph_context_id == context_id
        ]
        snapshot_ids = [
            eid for eid in to_delete if self.explorations[eid].state.get("has_snapshot")
        ]

        for eid in to_delete:
            del self.explorations[eid]

        del self.graph_contexts[context_id]

        # Best-effort snapshot file cleanup (fire-and-forget via asyncio)
        if snapshot_ids:
            import asyncio
            import logging

            _log = logging.getLogger(__name__)

            async def _cleanup():
                try:
                    from graphlagoon.services.snapshot import get_snapshot_service

                    svc = get_snapshot_service()
                    for eid in snapshot_ids:
                        try:
                            await svc.delete(eid)
                        except Exception as exc:
                            _log.warning("Could not delete snapshot %s: %s", eid, exc)
                except Exception as exc:
                    _log.warning("Snapshot cleanup failed: %s", exc)

            try:
                loop = asyncio.get_running_loop()
                loop.create_task(_cleanup())
            except RuntimeError:
                pass  # No running event loop (e.g. tests) — skip cleanup

        return True

    def share_graph_context(
        self, context_id: UUID, shared_with_email: str, permission: str = "read"
    ) -> Optional[MemoryGraphContextShare]:
        """Share a graph context with another user."""
        context = self.graph_contexts.get(context_id)
        if context is None:
            return None

        # Check if already shared
        for share in context.shares:
            if share.shared_with_email == shared_with_email:
                share.permission = permission
                return share

        share = MemoryGraphContextShare(
            id=uuid4(),
            graph_context_id=context_id,
            shared_with_email=shared_with_email,
            permission=permission,
        )
        context.shares.append(share)
        return share

    def unshare_graph_context(self, context_id: UUID, shared_with_email: str) -> bool:
        """Remove sharing for a graph context."""
        context = self.graph_contexts.get(context_id)
        if context is None:
            return False

        context.shares = [
            s for s in context.shares if s.shared_with_email != shared_with_email
        ]
        return True

    # Exploration operations
    def create_exploration(
        self,
        graph_context_id: UUID,
        title: str,
        owner_email: str,
        state: Dict[str, Any],
    ) -> Optional[MemoryExploration]:
        """Create a new exploration."""
        if graph_context_id not in self.graph_contexts:
            return None

        exploration_id = uuid4()
        exploration = MemoryExploration(
            id=exploration_id,
            graph_context_id=graph_context_id,
            title=title,
            owner_email=owner_email,
            state=state,
        )
        self.explorations[exploration_id] = exploration
        return exploration

    def get_exploration(self, exploration_id: UUID) -> Optional[MemoryExploration]:
        """Get an exploration by ID."""
        return self.explorations.get(exploration_id)

    def list_explorations(
        self, user_email: str, graph_context_id: Optional[UUID] = None
    ) -> List[MemoryExploration]:
        """List explorations accessible by a user."""
        result = []
        for exp in self.explorations.values():
            if graph_context_id and exp.graph_context_id != graph_context_id:
                continue
            if exp.owner_email == user_email:
                result.append(exp)
            elif any(
                email_matches_share(user_email, s.shared_with_email) for s in exp.shares
            ):
                result.append(exp)
        return sorted(result, key=lambda e: e.updated_at, reverse=True)

    def update_exploration(
        self, exploration_id: UUID, **kwargs
    ) -> Optional[MemoryExploration]:
        """Update an exploration."""
        exp = self.explorations.get(exploration_id)
        if exp is None:
            return None

        for key, value in kwargs.items():
            if hasattr(exp, key) and value is not None:
                setattr(exp, key, value)
        exp.updated_at = datetime.now()
        return exp

    def delete_exploration(self, exploration_id: UUID) -> bool:
        """Delete an exploration."""
        if exploration_id not in self.explorations:
            return False
        del self.explorations[exploration_id]
        return True

    def share_exploration(
        self, exploration_id: UUID, shared_with_email: str, permission: str = "read"
    ) -> Optional[MemoryExplorationShare]:
        """Share an exploration with another user."""
        exp = self.explorations.get(exploration_id)
        if exp is None:
            return None

        # Check if already shared
        for share in exp.shares:
            if share.shared_with_email == shared_with_email:
                share.permission = permission
                return share

        share = MemoryExplorationShare(
            id=uuid4(),
            exploration_id=exploration_id,
            shared_with_email=shared_with_email,
            permission=permission,
        )
        exp.shares.append(share)
        return share

    def unshare_exploration(self, exploration_id: UUID, shared_with_email: str) -> bool:
        """Remove sharing for an exploration."""
        exp = self.explorations.get(exploration_id)
        if exp is None:
            return False

        exp.shares = [s for s in exp.shares if s.shared_with_email != shared_with_email]
        return True

    # QueryTemplate operations
    def create_query_template(
        self,
        graph_context_id: UUID,
        owner_email: str,
        name: str,
        query_type: str,
        query: str,
        description: Optional[str] = None,
        parameters: Optional[List[Dict[str, Any]]] = None,
        options: Optional[Dict[str, Any]] = None,
        visibility: str = "shared",
    ) -> MemoryQueryTemplate:
        """Create a new query template."""
        template_id = uuid4()
        template = MemoryQueryTemplate(
            id=template_id,
            graph_context_id=graph_context_id,
            owner_email=owner_email,
            name=name,
            query_type=query_type,
            query=query,
            description=description,
            parameters=parameters or [],
            options=options or {},
            visibility=visibility,
        )
        self.query_templates[template_id] = template
        return template

    def get_query_template(self, template_id: UUID) -> Optional[MemoryQueryTemplate]:
        """Get a query template by ID."""
        return self.query_templates.get(template_id)

    def list_query_templates(self, context_id: UUID) -> List[MemoryQueryTemplate]:
        """List all query templates for a context."""
        result = [
            t for t in self.query_templates.values() if t.graph_context_id == context_id
        ]
        return sorted(result, key=lambda t: t.created_at)

    def update_query_template(
        self, template_id: UUID, **kwargs
    ) -> Optional[MemoryQueryTemplate]:
        """Update a query template."""
        template = self.query_templates.get(template_id)
        if template is None:
            return None
        for key, value in kwargs.items():
            if hasattr(template, key) and value is not None:
                setattr(template, key, value)
        template.updated_at = datetime.now()
        return template

    def delete_query_template(self, template_id: UUID) -> bool:
        """Delete a query template."""
        if template_id not in self.query_templates:
            return False
        del self.query_templates[template_id]
        return True

    # Group / permission operations (semantics live in services.groups —
    # these are thin storage methods mirroring the DB tables)
    def create_group(
        self,
        name: str,
        description: Optional[str] = None,
        members: Optional[List[Dict[str, str]]] = None,
    ) -> MemoryGroup:
        group_id = uuid4()
        group = MemoryGroup(id=group_id, name=name, description=description)
        for m in members or []:
            group.members.append(
                MemoryGroupMember(
                    id=uuid4(), group_id=group_id, kind=m["kind"], value=m["value"]
                )
            )
        self.groups[group_id] = group
        return group

    def get_group(self, group_id: UUID) -> Optional[MemoryGroup]:
        return self.groups.get(group_id)

    def get_group_by_name(self, name: str) -> Optional[MemoryGroup]:
        for group in self.groups.values():
            if group.name == name:
                return group
        return None

    def list_groups(self) -> List[MemoryGroup]:
        return sorted(self.groups.values(), key=lambda g: g.name)

    def update_group(
        self,
        group_id: UUID,
        name: Optional[str] = None,
        description: Optional[str] = None,
        members: Optional[List[Dict[str, str]]] = None,
    ) -> Optional[MemoryGroup]:
        group = self.groups.get(group_id)
        if group is None:
            return None
        if name is not None:
            group.name = name
        group.description = description
        if members is not None:  # full replacement, like the DB path
            group.members = [
                MemoryGroupMember(
                    id=uuid4(), group_id=group_id, kind=m["kind"], value=m["value"]
                )
                for m in members
            ]
        group.updated_at = datetime.now()
        return group

    def delete_group(self, group_id: UUID) -> Optional[MemoryGroup]:
        group = self.groups.pop(group_id, None)
        if group is None:
            return None
        # Mirror the DB's ON DELETE CASCADE on permission_rules.group_id
        self.permission_rules = {
            rid: rule
            for rid, rule in self.permission_rules.items()
            if rule.group_id != group_id
        }
        return group

    def set_permission(
        self, permission_id: str, mode: str, rules: List[Dict[str, Any]]
    ) -> None:
        """Full replacement of one permission's mode and rules."""
        self.permission_modes[permission_id] = mode
        self.permission_rules = {
            rid: rule
            for rid, rule in self.permission_rules.items()
            if rule.permission_id != permission_id
        }
        for r in rules:
            rule = MemoryPermissionRule(
                id=uuid4(),
                permission_id=permission_id,
                group_id=r["group_id"],
                effect=r["effect"],
            )
            self.permission_rules[rule.id] = rule

    def list_permission_rules(self) -> List[MemoryPermissionRule]:
        return list(self.permission_rules.values())

    # Audit operations
    def record_usage(
        self,
        user_email: str,
        action: str,
        resource_type: Optional[str] = None,
        resource_id: Optional[UUID] = None,
        log_metadata: Optional[Dict[str, Any]] = None,
    ) -> MemoryUsageLog:
        entry = MemoryUsageLog(
            id=uuid4(),
            user_email=user_email,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            log_metadata=log_metadata,
        )
        self.usage_logs.append(entry)
        return entry

    def clear_all(self, *, keep_usage_logs: bool = True):
        """Clear all data (for dev mode).

        The audit trail is preserved by default so the "environment cleared"
        entry — and everything that led up to it — survives the clear itself,
        mirroring the DB path where usage_logs is never truncated.
        """
        self.users.clear()
        self.graph_contexts.clear()
        self.explorations.clear()
        self.query_templates.clear()
        self.groups.clear()
        self.permission_modes.clear()
        self.permission_rules.clear()
        if not keep_usage_logs:
            self.usage_logs.clear()


def get_memory_store() -> InMemoryStore:
    """Get the in-memory store instance."""
    return InMemoryStore.get_instance()
