from sqlalchemy import (
    BigInteger,
    Column,
    String,
    Text,
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID, ARRAY
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import uuid

from graphlagoon.db.database import Base


class User(Base):
    """User table for tracking users in dev mode.

    Note: In Databricks mode, users are identified by X-Forwarded-Email header.
    This table is optional and used for dev mode user tracking.
    """

    __tablename__ = "users"

    email = Column(String(255), primary_key=True)
    display_name = Column(String(255))
    created_at = Column(DateTime, server_default=func.now())
    # Bumped at most every 15 minutes by services.users.touch_user; feeds the
    # admin area's "who is active" view. NULL for rows created before 014.
    last_seen_at = Column(DateTime(timezone=True), nullable=True)


class GraphContext(Base):
    __tablename__ = "graph_contexts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title = Column(String(255), nullable=False)
    description = Column(Text)
    tags = Column(ARRAY(Text), default=[])
    # Which backend this context is queried through ("sql_warehouse" | "neptune").
    # Server default backfills every pre-existing row, so contexts created before
    # datasources were pluggable keep behaving exactly as they did.
    datasource_type = Column(String(50), nullable=False, server_default="sql_warehouse")
    # Which named connection a "rest" context uses. Null for the single-instance
    # types (warehouse, neptune) — only "rest" has multiple named instances.
    datasource_name = Column(String(100), nullable=True)
    # Nullable since a native graph database (Neptune) defines no tables at all.
    # Required for sql_warehouse contexts — enforced by GraphContextCreate.
    edge_table_name = Column(String(255), nullable=True)
    node_table_name = Column(String(255), nullable=True)
    # Structural column mapping configuration
    edge_structure = Column(
        JSON,
        default={
            "edge_id_col": "edge_id",
            "src_col": "src",
            "dst_col": "dst",
            "relationship_type_col": "relationship_type",
        },
    )
    node_structure = Column(
        JSON, default={"node_id_col": "node_id", "node_type_col": "node_type"}
    )
    # Property columns (non-structural metadata)
    edge_properties = Column(JSON, default=[])
    node_properties = Column(JSON, default=[])
    # Schema information - possible values for node and edge types
    node_types = Column(ARRAY(Text), default=[])
    relationship_types = Column(ARRAY(Text), default=[])
    # Default frontend behavior settings applied when this context is opened
    default_behaviors = Column(JSON, default={})
    # Context-level cluster programs (list of ClusterProgram dicts, opaque to the backend)
    cluster_programs = Column(JSON, default=[])
    # Context-level configurable context-menu actions (list of ContextMenuActionConfig
    # dicts, opaque to the backend — the frontend owns the shape)
    context_menu_actions = Column(JSON, default=[])
    # Writer-authored custom metric definitions (list of MetricDefinition dicts:
    # per-node/edge JavaScript evaluated in the frontend's sandboxed worker).
    # Never returned to read-only users — see routers.graph_contexts.context_to_response.
    metric_definitions = Column(JSON, default=[])
    # Investigation support (03-arquitetura §2.1): IdentityKey list, EnrichmentTable
    # list and EdgeSemantics dict. Validated where they are first used (F1.4/F2.1/F3.1).
    identity_keys = Column(JSON, default=[])
    enrichment_tables = Column(JSON, default=[])
    edge_semantics = Column(JSON, default={})
    # Owner email from request header (no FK - users identified by headers in Databricks mode)
    owner_email = Column(String(255), nullable=False)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    # Relationships
    shares = relationship(
        "GraphContextShare",
        back_populates="graph_context",
        cascade="all, delete-orphan",
    )
    explorations = relationship(
        "Exploration", back_populates="graph_context", cascade="all, delete-orphan"
    )
    query_templates = relationship(
        "QueryTemplate", back_populates="graph_context", cascade="all, delete-orphan"
    )


class GraphContextShare(Base):
    __tablename__ = "graph_context_shares"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    graph_context_id = Column(
        UUID(as_uuid=True), ForeignKey("graph_contexts.id", ondelete="CASCADE")
    )
    shared_with_email = Column(String(255), nullable=False)
    permission = Column(String(50), default="read")
    created_at = Column(DateTime, server_default=func.now())

    # Relationships
    graph_context = relationship("GraphContext", back_populates="shares")


class Exploration(Base):
    __tablename__ = "explorations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    graph_context_id = Column(
        UUID(as_uuid=True), ForeignKey("graph_contexts.id", ondelete="CASCADE")
    )
    title = Column(String(255), nullable=False)
    # Owner email from request header (no FK - users identified by headers in Databricks mode)
    owner_email = Column(String(255), nullable=False)
    state = Column(JSON, nullable=False)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    # Relationships
    graph_context = relationship("GraphContext", back_populates="explorations")
    shares = relationship(
        "ExplorationShare", back_populates="exploration", cascade="all, delete-orphan"
    )


class ExplorationShare(Base):
    __tablename__ = "exploration_shares"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    exploration_id = Column(
        UUID(as_uuid=True), ForeignKey("explorations.id", ondelete="CASCADE")
    )
    shared_with_email = Column(String(255), nullable=False)
    permission = Column(String(50), default="read")
    created_at = Column(DateTime, server_default=func.now())

    # Relationships
    exploration = relationship("Exploration", back_populates="shares")


class QueryTemplate(Base):
    __tablename__ = "query_templates"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    graph_context_id = Column(
        UUID(as_uuid=True),
        ForeignKey("graph_contexts.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Owner email from request header (no FK - users identified by headers in Databricks mode)
    owner_email = Column(String(255), nullable=False)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    query_type = Column(String(10), nullable=False)  # "cypher" | "sql"
    query = Column(Text, nullable=False)
    parameters = Column(JSON, default=[])
    options = Column(JSON, default={})
    # "shared" (visible to everyone with context access) | "private" (creator only)
    visibility = Column(String(10), nullable=False, server_default="shared")
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    # Relationships
    graph_context = relationship("GraphContext", back_populates="query_templates")


class UsageLog(Base):
    __tablename__ = "usage_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_email = Column(String(255))
    action = Column(String(100), nullable=False)
    resource_type = Column(String(50))
    resource_id = Column(UUID(as_uuid=True))
    log_metadata = Column("metadata", JSON)  # 'metadata' is reserved in SQLAlchemy
    created_at = Column(DateTime, server_default=func.now())


class Group(Base):
    """A named principal for permission rules (services.permissions).

    Members are emails and/or Databricks workspace group names — a user
    belongs to the group through either kind. Superuser-managed only.
    """

    __tablename__ = "groups"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(100), nullable=False, unique=True)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    members = relationship(
        "GroupMember", back_populates="group", cascade="all, delete-orphan"
    )
    rules = relationship(
        "PermissionRule", back_populates="group", cascade="all, delete-orphan"
    )


class GroupMember(Base):
    __tablename__ = "group_members"
    __table_args__ = (
        UniqueConstraint(
            "group_id", "kind", "value", name="uq_group_members_group_kind_value"
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    group_id = Column(
        UUID(as_uuid=True), ForeignKey("groups.id", ondelete="CASCADE"), nullable=False
    )
    # "email" (no FK — users identified by headers in Databricks mode) or
    # "databricks_group" (a workspace group displayName, resolved via SCIM).
    # Values are stored lowercased; matching is exact, no wildcards.
    kind = Column(String(20), nullable=False)
    value = Column(String(255), nullable=False)
    created_at = Column(DateTime, server_default=func.now())

    group = relationship("Group", back_populates="members")


class PermissionMode(Base):
    """Per-permission mode: "everyone" | "restricted". No row ⇒ "everyone",
    so an empty table (and any pre-feature deployment) behaves exactly as
    before the permission existed."""

    __tablename__ = "permission_modes"

    permission_id = Column(String(100), primary_key=True)
    mode = Column(String(20), nullable=False, server_default="everyone")
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class PermissionRule(Base):
    """allow/deny of one permission for one group. Deny always wins; allow
    only matters when the permission's mode is "restricted"."""

    __tablename__ = "permission_rules"
    __table_args__ = (
        UniqueConstraint(
            "permission_id", "group_id", name="uq_permission_rules_permission_group"
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    permission_id = Column(String(100), nullable=False, index=True)
    group_id = Column(
        UUID(as_uuid=True),
        ForeignKey("groups.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    effect = Column(String(10), nullable=False)  # "allow" | "deny"
    created_at = Column(DateTime, server_default=func.now())

    group = relationship("Group", back_populates="rules")




# ---------------------------------------------------------------------------
# Investigations v2 (docs/dev/plans/investigation/05-plano-v2.md §1)
# ---------------------------------------------------------------------------


def _investigation_fk():
    return Column(
        UUID(as_uuid=True),
        ForeignKey("investigations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )


class Investigation(Base):
    """A case: one place where items (graphs, queries, tables, documents, notes)
    accumulate with versions and authors, ending in a decision."""

    __tablename__ = "investigations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    # slug of an admin-defined case type (case_types), or the built-in "general"
    case_type = Column(String(50), nullable=False, default="general", server_default="general", index=True)
    # values of the case type's fields: {field id: value}
    fields = Column(JSON, nullable=False, default={})
    # the alert or ticket that opened the case (idempotent creation)
    external_ref = Column(String(255), nullable=True, index=True)
    # open | analysis | closed (closed only by a decision that closes the case)
    status = Column(String(20), nullable=False, default="open", server_default="open")
    # one of the case type's stages (a free label), or null
    stage = Column(String(100), nullable=True)
    owner_email = Column(String(255), nullable=False, index=True)
    assignee_email = Column(String(255), nullable=True)
    occurred_at = Column(DateTime, nullable=True)
    alert_at = Column(DateTime, nullable=True)
    # {open: hours, analysis: hours}: copied from the case type, editable per case
    sla_hours = Column(JSON, nullable=True)
    tags = Column(JSON, nullable=False, default=[])
    # identity_keys, edge_semantics, enrichment_tables, agent_suggest_kinds,
    # label_templates, vocabularies
    settings = Column(JSON, nullable=False, default={})
    # view only: layout, pins, views, groups_closed
    state = Column(JSON, nullable=False, default={})
    # every decision, oldest first, each with its own hash (06 §1); reassign, never mutate in place
    decisions = Column(JSON, nullable=False, default=[])
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    shares = relationship(
        "InvestigationShare",
        back_populates="investigation",
        cascade="all, delete-orphan",
    )


class InvestigationShare(Base):
    """Nominal e-mail only — wildcards are refused (need-to-know)."""

    __tablename__ = "investigation_shares"
    __table_args__ = (
        UniqueConstraint(
            "investigation_id", "email", name="uq_investigation_shares_investigation_email"
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    investigation_id = _investigation_fk()
    email = Column(String(255), nullable=False)
    role = Column(String(10), nullable=False, default="reader")  # reader | editor
    created_at = Column(DateTime, server_default=func.now())

    investigation = relationship("Investigation", back_populates="shares")


class CaseItem(Base):
    """Anything in the case (05 §1): kind graph|table|query|document|note with a
    subkind, an author, provenance and N immutable versions."""

    __tablename__ = "case_items"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    investigation_id = _investigation_fk()
    kind = Column(String(20), nullable=False)
    subkind = Column(String(30), nullable=False)
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    tags = Column(JSON, nullable=False, default=[])
    status = Column(String(20), nullable=False, default="confirmed")  # suggested | confirmed | rejected
    author_kind = Column(String(10), nullable=False, default="human")  # human | agent
    author_email = Column(String(255), nullable=False)
    agent_token_id = Column(UUID(as_uuid=True), nullable=True)
    # context_id, exploration_id, query_item_id, run_id, tool, params, parent_item_id, tool_call_id
    provenance = Column(JSON, nullable=False, default={})
    exploration_id = Column(
        UUID(as_uuid=True), ForeignKey("explorations.id", ondelete="SET NULL"), nullable=True
    )
    context_id = Column(UUID(as_uuid=True), nullable=True)
    query = Column(JSON, nullable=True)  # {text, language, parameters[], output}
    mapping = Column(JSON, nullable=True)  # {as: graph|enrichment, spec}; of the case, never a context
    anchor = Column(JSON, nullable=True)  # {entity_ids[], edge_ids[], item_id}
    state = Column(JSON, nullable=True)  # view only, never a version: {chart: {type, x, series[]}}
    current_version = Column(Integer, nullable=False, default=0)
    position = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    deleted_at = Column(DateTime, nullable=True)


class CaseItemVersion(Base):
    """Immutable content of an item; a pinned version is the evidence."""

    __tablename__ = "case_item_versions"
    __table_args__ = (
        UniqueConstraint("item_id", "version", name="uq_case_item_versions_version"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    investigation_id = _investigation_fk()
    item_id = Column(
        UUID(as_uuid=True),
        ForeignKey("case_items.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version = Column(Integer, nullable=False)
    sha256 = Column(String(64), nullable=False)
    blob_key = Column(String(512), nullable=False)
    size_bytes = Column(BigInteger, nullable=False)
    content_type = Column(String(255), nullable=False)
    text_blob_key = Column(String(512), nullable=True)  # text extraction for search and MCP
    # {statement_id, started_at, duration_ms, row_count, params, run_by, author_kind}
    run = Column(JSON, nullable=True)
    created_by = Column(String(255), nullable=False)
    author_kind = Column(String(10), nullable=False, default="human")
    created_at = Column(DateTime, server_default=func.now())
    pinned_at = Column(DateTime, nullable=True)
    pinned_by = Column(String(255), nullable=True)
    pin_label = Column(String(255), nullable=True)


class CaseAnnotation(Base):
    """role | tag | group | same_as | hypothesis | hypothesis_status |
    status_change over entities or items; an agent's may arrive ``suggested``."""

    __tablename__ = "case_annotations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    investigation_id = _investigation_fk()
    kind = Column(String(30), nullable=False)
    targets = Column(JSON, nullable=False, default=[])  # entity ids or item ids
    value = Column(JSON, nullable=False, default={})
    reason = Column(Text, nullable=True)
    status = Column(String(20), nullable=False, default="confirmed")
    author_kind = Column(String(10), nullable=False, default="human")
    author_email = Column(String(255), nullable=False)
    agent_token_id = Column(UUID(as_uuid=True), nullable=True)
    confirmed_by = Column(String(255), nullable=True)
    confirmed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, server_default=func.now())


class CaseEntity(Base):
    """06 P7: an entity on the case's unified graph, by its uid (stable across
    cases for keyed entities: ``Account:12345``). Rewritten when the case's graph
    inputs change (``stamp``); read by "seen in other cases"."""

    __tablename__ = "case_entities"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    investigation_id = _investigation_fk()
    uid = Column(String(512), nullable=False, index=True)
    entity = Column(String(100), nullable=True)
    node_type = Column(String(100), nullable=True)
    label = Column(String(255), nullable=True)
    stamp = Column(String(64), nullable=False)
    updated_at = Column(DateTime, server_default=func.now())


class InvestigationEvent(Base):
    """Append-only case journal; each decision's hash covers it up to that decision."""

    __tablename__ = "investigation_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    investigation_id = _investigation_fk()
    actor_email = Column(String(255), nullable=False)
    actor_kind = Column(String(10), nullable=False, default="human", server_default="human")
    agent_token_id = Column(UUID(as_uuid=True), nullable=True)
    agent_name = Column(String(100), nullable=True)
    kind = Column(String(50), nullable=False)
    payload = Column(JSON, nullable=False, default={})
    created_at = Column(DateTime, server_default=func.now())


class AgentToken(Base):
    """Personal token an AI agent uses to act for its owner (05 §6): identity
    plus a short list of human-only acts; no read/analyze/write scopes."""

    __tablename__ = "agent_tokens"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(100), nullable=False)
    owner_email = Column(String(255), nullable=False, index=True)
    token_hash = Column(String(64), nullable=False, unique=True)
    # "user" (every case the owner reads) or "case" (only investigation_ids)
    scope = Column(String(10), nullable=False, default="user")
    investigation_ids = Column(JSON, nullable=False, default=[])
    created_at = Column(DateTime, server_default=func.now())
    expires_at = Column(DateTime, nullable=False)
    revoked_at = Column(DateTime, nullable=True)
    last_used_at = Column(DateTime, nullable=True)  # bumped at most once a minute


class CaseType(Base):
    """An admin-defined kind of case (06 §1): vocabulary, decision catalog,
    fields, SLA, notice. ``spec`` is ``schemas.CaseTypeSpec``; "general" is
    built in and never stored."""

    __tablename__ = "case_types"

    slug = Column(String(50), primary_key=True)
    spec = Column(JSON, nullable=False, default={})
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class OrgLibrary(Base):
    """Playbooks and templates in markdown, read by agents through MCP (F5)."""

    __tablename__ = "org_library"

    slug = Column(String(100), primary_key=True)
    title = Column(String(255), nullable=False)
    kind = Column(String(20), nullable=False, default="playbook")  # playbook | template
    body = Column(Text, nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
