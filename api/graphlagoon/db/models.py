from sqlalchemy import Column, String, Text, DateTime, ForeignKey, JSON
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


class GraphContext(Base):
    __tablename__ = "graph_contexts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title = Column(String(255), nullable=False)
    description = Column(Text)
    tags = Column(ARRAY(Text), default=[])
    edge_table_name = Column(String(255), nullable=False)
    node_table_name = Column(String(255), nullable=False)
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
