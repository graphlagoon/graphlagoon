from sqlalchemy import (
    BigInteger,
    Column,
    String,
    Text,
    DateTime,
    Float,
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
# Investigations (docs/dev/plans/investigation/03-arquitetura.md §2.2)
# ---------------------------------------------------------------------------


def _investigation_fk():
    return Column(
        UUID(as_uuid=True),
        ForeignKey("investigations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )


class Investigation(Base):
    """A case: N explorations (any context), files and notes, ending in a decision."""

    __tablename__ = "investigations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    owner_email = Column(String(255), nullable=False, index=True)
    assignee_email = Column(String(255), nullable=True)
    # "selecao" | "analise" | "decidido" | "arquivado"
    status = Column(
        String(20), nullable=False, default="selecao", server_default="selecao"
    )
    typology = Column(String(100), nullable=True)
    origin = Column(String(50), nullable=True)
    selected_at = Column(DateTime, nullable=True)
    # roles {entityKey: role}, pins, hypotheses[], view preferences
    state = Column(JSON, nullable=False, default={})
    decision = Column(JSON, nullable=True)
    frozen_hash = Column(String(64), nullable=True)
    frozen_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    shares = relationship(
        "InvestigationShare",
        back_populates="investigation",
        cascade="all, delete-orphan",
    )


class InvestigationShare(Base):
    """Nominal e-mail only — wildcards are refused (tipping-off, LC 105)."""

    __tablename__ = "investigation_shares"
    __table_args__ = (
        UniqueConstraint(
            "investigation_id",
            "shared_with_email",
            name="uq_investigation_shares_investigation_email",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    investigation_id = _investigation_fk()
    shared_with_email = Column(String(255), nullable=False)
    permission = Column(String(10), nullable=False, default="read")  # read | write
    created_at = Column(DateTime, server_default=func.now())

    investigation = relationship("Investigation", back_populates="shares")


class InvestigationFile(Base):
    __tablename__ = "investigation_files"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    investigation_id = _investigation_fk()
    filename = Column(String(255), nullable=False)
    role = Column(String(20), nullable=False)  # graph | enrichment | attachment
    sha256 = Column(String(64), nullable=False)
    size_bytes = Column(BigInteger, nullable=False)
    content_type = Column(String(255), nullable=True)
    blob_key = Column(String(512), nullable=False)
    mapping = Column(JSON, nullable=True)
    context_id = Column(UUID(as_uuid=True), nullable=True)
    uploaded_by = Column(String(255), nullable=False)
    uploaded_at = Column(DateTime, server_default=func.now())


class InvestigationSource(Base):
    __tablename__ = "investigation_sources"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    investigation_id = _investigation_fk()
    kind = Column(String(20), nullable=False)  # exploration | file
    exploration_id = Column(
        UUID(as_uuid=True),
        ForeignKey("explorations.id", ondelete="SET NULL"),
        nullable=True,
    )
    file_id = Column(
        UUID(as_uuid=True),
        ForeignKey("investigation_files.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Denormalized (no FK) so access can be checked — and a placeholder shown —
    # even after the exploration is gone.
    context_id = Column(UUID(as_uuid=True), nullable=True)
    mode = Column(String(10), nullable=False, default="live")  # live | frozen
    frozen_blob_key = Column(String(512), nullable=True)
    frozen_sha256 = Column(String(64), nullable=True)
    title_snapshot = Column(String(255), nullable=False)
    added_by = Column(String(255), nullable=False)
    added_at = Column(DateTime, server_default=func.now())
    position = Column(Integer, nullable=False, default=0)


class InvestigationEvent(Base):
    """Immutable, hash-chained case journal: hash = sha256(prev_hash + canonical json)."""

    __tablename__ = "investigation_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    investigation_id = _investigation_fk()
    at = Column(DateTime, server_default=func.now())
    actor_email = Column(String(255), nullable=False)
    # "human" | "agent"; an agent acts for actor_email through agent_token_id
    actor_kind = Column(
        String(10), nullable=False, default="human", server_default="human"
    )
    agent_token_id = Column(UUID(as_uuid=True), nullable=True)
    agent_name = Column(String(100), nullable=True)
    kind = Column(String(50), nullable=False)
    payload = Column(JSON, nullable=False, default={})
    prev_hash = Column(String(64), nullable=True)
    hash = Column(String(64), nullable=False)


class InvestigationNote(Base):
    __tablename__ = "investigation_notes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    investigation_id = _investigation_fk()
    anchor = Column(JSON, nullable=False, default={})  # {kind, id}
    body = Column(Text, nullable=False)
    author_email = Column(String(255), nullable=False)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class InvestigationEvidence(Base):
    """Immutable frozen evidence (gz blob + sha256)."""

    __tablename__ = "investigation_evidence"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    investigation_id = _investigation_fk()
    title = Column(String(255), nullable=False)
    kind = Column(String(20), nullable=False)  # graph_state | trace | table | file
    blob_key = Column(String(512), nullable=False)
    sha256 = Column(String(64), nullable=False)
    params = Column(JSON, nullable=False, default={})
    created_by = Column(String(255), nullable=False)
    created_at = Column(DateTime, server_default=func.now())


class EntityMatch(Base):
    __tablename__ = "entity_matches"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    investigation_id = _investigation_fk()
    left = Column(JSON, nullable=False)  # {source_id, node_id, entity_key?}
    right = Column(JSON, nullable=False)
    score = Column(Float, nullable=False, default=0.0)
    reasons = Column(JSON, nullable=False, default=[])
    # sugerido | aceito | recusado | adiado
    status = Column(String(20), nullable=False, default="sugerido")
    reason_text = Column(Text, nullable=True)
    decided_by = Column(String(255), nullable=True)
    decided_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, server_default=func.now())


class InvestigationArtifact(Base):
    """An entry in the case space (T10): slides, docs, reports, images, data."""

    __tablename__ = "investigation_artifacts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    investigation_id = _investigation_fk()
    name = Column(String(255), nullable=False)
    kind = Column(String(20), nullable=False)  # slides | doc | report | image | data | other
    current_version = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime, server_default=func.now())


class InvestigationArtifactVersion(Base):
    """Immutable version of an artifact; approving is a human action."""

    __tablename__ = "investigation_artifact_versions"
    __table_args__ = (
        UniqueConstraint("artifact_id", "version", name="uq_artifact_versions_version"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Denormalized so a case's versions are listed (and cascade) in one hop.
    investigation_id = _investigation_fk()
    artifact_id = Column(
        UUID(as_uuid=True),
        ForeignKey("investigation_artifacts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version = Column(Integer, nullable=False)
    blob_key = Column(String(512), nullable=False)
    sha256 = Column(String(64), nullable=False)
    size_bytes = Column(BigInteger, nullable=False)
    content_type = Column(String(255), nullable=False)
    status = Column(String(10), nullable=False, default="draft")  # draft | approved
    actor = Column(JSON, nullable=False, default={})  # {kind, email, agent_name?, token_id?}
    source_evidence_ids = Column(JSON, nullable=False, default=[])
    note = Column(Text, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    approved_by = Column(String(255), nullable=True)
    approved_at = Column(DateTime, nullable=True)


class AgentToken(Base):
    """Personal token an AI agent uses to act for its owner (03-arquitetura §8.2).

    Only the sha256 of the token is stored; the token is shown once on creation.
    """

    __tablename__ = "agent_tokens"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_email = Column(String(255), nullable=False, index=True)
    name = Column(String(100), nullable=False)
    token_hash = Column(String(64), nullable=False, unique=True)
    scopes = Column(JSON, nullable=False, default=[])
    created_at = Column(DateTime, server_default=func.now())
    expires_at = Column(DateTime, nullable=False)
    revoked_at = Column(DateTime, nullable=True)
