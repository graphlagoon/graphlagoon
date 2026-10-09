"""Investigations: case tables and investigation columns on graph_contexts

Revision ID: 016
Revises: 015
Create Date: 2026-10-09 23:00:00.000000

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

CONTEXT_COLUMNS = (
    ("identity_keys", "[]"),
    ("enrichment_tables", "[]"),
    ("edge_semantics", "{}"),
)

# Children of `investigations`, in creation order (sources references files).
CHILD_TABLES = (
    "investigation_shares",
    "investigation_files",
    "investigation_sources",
    "investigation_events",
    "investigation_notes",
    "investigation_evidence",
    "entity_matches",
)


def _id():
    return sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True)


def _investigation_id():
    return sa.Column(
        "investigation_id",
        postgresql.UUID(as_uuid=True),
        sa.ForeignKey("investigations.id", ondelete="CASCADE"),
        nullable=False,
    )


def _now(name: str):
    return sa.Column(name, sa.DateTime(), server_default=sa.func.now())


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_tables = set(inspector.get_table_names())
    existing_cols = {c["name"] for c in inspector.get_columns("graph_contexts")}

    for name, default in CONTEXT_COLUMNS:
        if name not in existing_cols:
            op.add_column(
                "graph_contexts",
                sa.Column(name, postgresql.JSON(), server_default=default),
            )

    if "investigations" not in existing_tables:
        op.create_table(
            "investigations",
            _id(),
            sa.Column("title", sa.String(255), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("owner_email", sa.String(255), nullable=False),
            sa.Column("assignee_email", sa.String(255), nullable=True),
            sa.Column(
                "status", sa.String(20), nullable=False, server_default="selecao"
            ),
            sa.Column("typology", sa.String(100), nullable=True),
            sa.Column("origin", sa.String(50), nullable=True),
            sa.Column("selected_at", sa.DateTime(), nullable=True),
            sa.Column("state", postgresql.JSON(), nullable=False, server_default="{}"),
            sa.Column("decision", postgresql.JSON(), nullable=True),
            sa.Column("frozen_hash", sa.String(64), nullable=True),
            sa.Column("frozen_at", sa.DateTime(), nullable=True),
            _now("created_at"),
            _now("updated_at"),
        )
        op.create_index(
            "ix_investigations_owner_email", "investigations", ["owner_email"]
        )

    tables = {
        "investigation_shares": [
            sa.Column("shared_with_email", sa.String(255), nullable=False),
            sa.Column(
                "permission", sa.String(10), nullable=False, server_default="read"
            ),
            _now("created_at"),
            sa.UniqueConstraint(
                "investigation_id",
                "shared_with_email",
                name="uq_investigation_shares_investigation_email",
            ),
        ],
        "investigation_files": [
            sa.Column("filename", sa.String(255), nullable=False),
            sa.Column("role", sa.String(20), nullable=False),
            sa.Column("sha256", sa.String(64), nullable=False),
            sa.Column("size_bytes", sa.BigInteger(), nullable=False),
            sa.Column("content_type", sa.String(255), nullable=True),
            sa.Column("blob_key", sa.String(512), nullable=False),
            sa.Column("mapping", postgresql.JSON(), nullable=True),
            sa.Column("context_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("uploaded_by", sa.String(255), nullable=False),
            _now("uploaded_at"),
        ],
        "investigation_sources": [
            sa.Column("kind", sa.String(20), nullable=False),
            sa.Column(
                "exploration_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("explorations.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column(
                "file_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("investigation_files.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("context_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("mode", sa.String(10), nullable=False, server_default="live"),
            sa.Column("frozen_blob_key", sa.String(512), nullable=True),
            sa.Column("frozen_sha256", sa.String(64), nullable=True),
            sa.Column("title_snapshot", sa.String(255), nullable=False),
            sa.Column("added_by", sa.String(255), nullable=False),
            _now("added_at"),
            sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        ],
        "investigation_events": [
            _now("at"),
            sa.Column("actor_email", sa.String(255), nullable=False),
            sa.Column("kind", sa.String(50), nullable=False),
            sa.Column(
                "payload", postgresql.JSON(), nullable=False, server_default="{}"
            ),
            sa.Column("prev_hash", sa.String(64), nullable=True),
            sa.Column("hash", sa.String(64), nullable=False),
        ],
        "investigation_notes": [
            sa.Column("anchor", postgresql.JSON(), nullable=False, server_default="{}"),
            sa.Column("body", sa.Text(), nullable=False),
            sa.Column("author_email", sa.String(255), nullable=False),
            _now("created_at"),
            _now("updated_at"),
        ],
        "investigation_evidence": [
            sa.Column("title", sa.String(255), nullable=False),
            sa.Column("kind", sa.String(20), nullable=False),
            sa.Column("blob_key", sa.String(512), nullable=False),
            sa.Column("sha256", sa.String(64), nullable=False),
            sa.Column("params", postgresql.JSON(), nullable=False, server_default="{}"),
            sa.Column("created_by", sa.String(255), nullable=False),
            _now("created_at"),
        ],
        "entity_matches": [
            sa.Column("left", postgresql.JSON(), nullable=False),
            sa.Column("right", postgresql.JSON(), nullable=False),
            sa.Column("score", sa.Float(), nullable=False, server_default="0"),
            sa.Column(
                "reasons", postgresql.JSON(), nullable=False, server_default="[]"
            ),
            sa.Column(
                "status", sa.String(20), nullable=False, server_default="sugerido"
            ),
            sa.Column("reason_text", sa.Text(), nullable=True),
            sa.Column("decided_by", sa.String(255), nullable=True),
            sa.Column("decided_at", sa.DateTime(), nullable=True),
            _now("created_at"),
        ],
    }
    for name in CHILD_TABLES:
        if name not in existing_tables:
            op.create_table(name, _id(), _investigation_id(), *tables[name])
            op.create_index(f"ix_{name}_investigation_id", name, ["investigation_id"])


def downgrade() -> None:
    for name in reversed(CHILD_TABLES):
        op.drop_index(f"ix_{name}_investigation_id", table_name=name)
        op.drop_table(name)
    op.drop_index("ix_investigations_owner_email", table_name="investigations")
    op.drop_table("investigations")
    for name, _ in CONTEXT_COLUMNS:
        op.drop_column("graph_contexts", name)
