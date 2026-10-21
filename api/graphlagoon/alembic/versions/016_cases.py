"""Investigations v2 (05-plano-v2 §1): one case, items with versions, annotations,
an append-only journal, agent tokens, case types (06) and the org library. Replaces the
never-published 016–019 migrations of the first plan.

Revision ID: 016
Revises: 015
Create Date: 2026-10-10 14:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "016"
down_revision: Union[str, None] = "015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Investigation support on graph contexts (identity keys, enrichment tables,
# edge semantics) stays: contexts feed the case graph.
CONTEXT_COLUMNS = (
    ("identity_keys", "[]"),
    ("enrichment_tables", "[]"),
    ("edge_semantics", "{}"),
)

# Creation order (children after parents); dropped in reverse.
TABLES = (
    "investigations",
    "investigation_shares",
    "case_items",
    "case_item_versions",
    "case_annotations",
    "case_entities",
    "investigation_events",
    "agent_tokens",
    "case_types",
    "org_library",
)


def _uuid():
    return postgresql.UUID(as_uuid=True)


def _id():
    return sa.Column("id", _uuid(), primary_key=True)


def _case_fk():
    return sa.Column(
        "investigation_id",
        _uuid(),
        sa.ForeignKey("investigations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )


def _now(name: str):
    return sa.Column(name, sa.DateTime(), server_default=sa.func.now())


def _json(name: str, default: str = "{}", nullable: bool = False):
    return sa.Column(name, postgresql.JSON(), nullable=nullable, server_default=default)


def _author():
    return (
        sa.Column("author_kind", sa.String(10), nullable=False, server_default="human"),
        sa.Column("author_email", sa.String(255), nullable=False),
        sa.Column("agent_token_id", _uuid(), nullable=True),
    )


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing = set(inspector.get_table_names())
    context_cols = {c["name"] for c in inspector.get_columns("graph_contexts")}
    for name, default in CONTEXT_COLUMNS:
        if name not in context_cols:
            op.add_column(
                "graph_contexts", sa.Column(name, postgresql.JSON(), server_default=default)
            )

    if "investigations" not in existing:
        op.create_table(
            "investigations",
            _id(),
            sa.Column("title", sa.String(255), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            # slug of a case type (case_types) or the built-in "general"
            sa.Column("case_type", sa.String(50), nullable=False, server_default="general", index=True),
            _json("fields"),
            sa.Column("external_ref", sa.String(255), nullable=True, index=True),
            # open | analysis | closed
            sa.Column("status", sa.String(20), nullable=False, server_default="open"),
            sa.Column("owner_email", sa.String(255), nullable=False, index=True),
            sa.Column("assignee_email", sa.String(255), nullable=True),
            sa.Column("occurred_at", sa.DateTime(), nullable=True),
            sa.Column("alert_at", sa.DateTime(), nullable=True),
            _json("sla_hours", "null", nullable=True),
            _json("tags", "[]"),
            _json("settings"),
            _json("state"),
            sa.Column("stage", sa.String(100), nullable=True),
            _json("decisions", "[]"),
            _now("created_at"),
            _now("updated_at"),
        )
    if "investigation_shares" not in existing:
        op.create_table(
            "investigation_shares",
            _id(),
            _case_fk(),
            sa.Column("email", sa.String(255), nullable=False),
            sa.Column("role", sa.String(10), nullable=False, server_default="reader"),
            _now("created_at"),
            sa.UniqueConstraint(
                "investigation_id", "email", name="uq_investigation_shares_investigation_email"
            ),
        )
    if "case_items" not in existing:
        op.create_table(
            "case_items",
            _id(),
            _case_fk(),
            sa.Column("kind", sa.String(20), nullable=False),
            sa.Column("subkind", sa.String(30), nullable=False),
            sa.Column("title", sa.String(255), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            _json("tags", "[]"),
            sa.Column("status", sa.String(20), nullable=False, server_default="confirmed"),
            *_author(),
            _json("provenance"),
            sa.Column(
                "exploration_id",
                _uuid(),
                sa.ForeignKey("explorations.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("context_id", _uuid(), nullable=True),
            _json("query", "null", nullable=True),
            _json("mapping", "null", nullable=True),
            _json("anchor", "null", nullable=True),
            _json("state", "null", nullable=True),
            sa.Column("current_version", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
            _now("created_at"),
            _now("updated_at"),
            sa.Column("deleted_at", sa.DateTime(), nullable=True),
        )
    if "case_item_versions" not in existing:
        op.create_table(
            "case_item_versions",
            _id(),
            _case_fk(),
            sa.Column(
                "item_id",
                _uuid(),
                sa.ForeignKey("case_items.id", ondelete="CASCADE"),
                nullable=False,
                index=True,
            ),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("sha256", sa.String(64), nullable=False),
            sa.Column("blob_key", sa.String(512), nullable=False),
            sa.Column("size_bytes", sa.BigInteger(), nullable=False),
            sa.Column("content_type", sa.String(255), nullable=False),
            sa.Column("text_blob_key", sa.String(512), nullable=True),
            _json("run", "null", nullable=True),
            sa.Column("created_by", sa.String(255), nullable=False),
            sa.Column("author_kind", sa.String(10), nullable=False, server_default="human"),
            _now("created_at"),
            sa.Column("pinned_at", sa.DateTime(), nullable=True),
            sa.Column("pinned_by", sa.String(255), nullable=True),
            sa.Column("pin_label", sa.String(255), nullable=True),
            sa.UniqueConstraint("item_id", "version", name="uq_case_item_versions_version"),
        )
    if "case_annotations" not in existing:
        op.create_table(
            "case_annotations",
            _id(),
            _case_fk(),
            # role | tag | group | same_as | hypothesis | hypothesis_status | status_change
            sa.Column("kind", sa.String(30), nullable=False),
            _json("targets", "[]"),
            _json("value"),
            sa.Column("reason", sa.Text(), nullable=True),
            sa.Column("status", sa.String(20), nullable=False, server_default="confirmed"),
            *_author(),
            sa.Column("confirmed_by", sa.String(255), nullable=True),
            sa.Column("confirmed_at", sa.DateTime(), nullable=True),
            _now("created_at"),
        )
    if "case_entities" not in existing:
        op.create_table(
            "case_entities",
            _id(),
            _case_fk(),
            sa.Column("uid", sa.String(512), nullable=False, index=True),
            sa.Column("entity", sa.String(100), nullable=True),
            sa.Column("node_type", sa.String(100), nullable=True),
            sa.Column("label", sa.String(255), nullable=True),
            sa.Column("stamp", sa.String(64), nullable=False),
            _now("updated_at"),
        )
    if "investigation_events" not in existing:
        op.create_table(
            "investigation_events",
            _id(),
            _case_fk(),
            sa.Column("actor_email", sa.String(255), nullable=False),
            sa.Column("actor_kind", sa.String(10), nullable=False, server_default="human"),
            sa.Column("agent_token_id", _uuid(), nullable=True),
            sa.Column("agent_name", sa.String(100), nullable=True),
            sa.Column("kind", sa.String(50), nullable=False),
            _json("payload"),
            _now("created_at"),
        )
    if "agent_tokens" not in existing:
        op.create_table(
            "agent_tokens",
            _id(),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("owner_email", sa.String(255), nullable=False, index=True),
            sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
            sa.Column("scope", sa.String(10), nullable=False, server_default="user"),
            _json("investigation_ids", "[]"),
            _now("created_at"),
            sa.Column("expires_at", sa.DateTime(), nullable=False),
            sa.Column("revoked_at", sa.DateTime(), nullable=True),
            sa.Column("last_used_at", sa.DateTime(), nullable=True),
        )
    if "case_types" not in existing:
        op.create_table(
            "case_types",
            sa.Column("slug", sa.String(50), primary_key=True),
            _json("spec"),
            _now("updated_at"),
        )
    if "org_library" not in existing:
        op.create_table(
            "org_library",
            sa.Column("slug", sa.String(100), primary_key=True),
            sa.Column("title", sa.String(255), nullable=False),
            sa.Column("kind", sa.String(20), nullable=False, server_default="playbook"),
            sa.Column("body", sa.Text(), nullable=False),
            _now("updated_at"),
        )


def downgrade() -> None:
    for name in reversed(TABLES):
        op.drop_table(name)
    for name, _ in CONTEXT_COLUMNS:
        op.drop_column("graph_contexts", name)
