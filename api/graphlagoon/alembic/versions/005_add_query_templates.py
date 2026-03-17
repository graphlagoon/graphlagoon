"""Add query_templates table

Revision ID: 005
Revises: 004
Create Date: 2026-03-13 00:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_tables = inspector.get_table_names()

    if "query_templates" not in existing_tables:
        op.create_table(
            "query_templates",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "graph_context_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("graph_contexts.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("owner_email", sa.String(255), nullable=False),
            sa.Column("name", sa.String(255), nullable=False),
            sa.Column("description", sa.Text, nullable=True),
            sa.Column("query_type", sa.String(10), nullable=False),
            sa.Column("query", sa.Text, nullable=False),
            sa.Column("parameters", postgresql.JSON(), server_default="[]"),
            sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
        )

    existing_indexes = {idx["name"] for idx in inspector.get_indexes("query_templates")}
    if "ix_query_templates_context_id" not in existing_indexes:
        op.create_index(
            "ix_query_templates_context_id",
            "query_templates",
            ["graph_context_id"],
        )


def downgrade() -> None:
    op.drop_index("ix_query_templates_context_id", table_name="query_templates")
    op.drop_table("query_templates")
