"""Initial migration

Revision ID: 001
Revises:
Create Date: 2024-01-01 00:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Users table
    op.create_table(
        "users",
        sa.Column("email", sa.String(255), primary_key=True),
        sa.Column("display_name", sa.String(255)),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )

    # Graph contexts table
    op.create_table(
        "graph_contexts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("tags", postgresql.ARRAY(sa.Text()), default=[]),
        sa.Column("edge_table_name", sa.String(255), nullable=False),
        sa.Column("node_table_name", sa.String(255), nullable=False),
        sa.Column("owner_email", sa.String(255), sa.ForeignKey("users.email")),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
    )

    # Graph context shares table
    op.create_table(
        "graph_context_shares",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "graph_context_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("graph_contexts.id", ondelete="CASCADE"),
        ),
        sa.Column("shared_with_email", sa.String(255), nullable=False),
        sa.Column("permission", sa.String(50), default="read"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )

    # Explorations table
    op.create_table(
        "explorations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "graph_context_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("graph_contexts.id", ondelete="CASCADE"),
        ),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("owner_email", sa.String(255), sa.ForeignKey("users.email")),
        sa.Column("state", postgresql.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
    )

    # Exploration shares table
    op.create_table(
        "exploration_shares",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "exploration_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("explorations.id", ondelete="CASCADE"),
        ),
        sa.Column("shared_with_email", sa.String(255), nullable=False),
        sa.Column("permission", sa.String(50), default="read"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )

    # Usage logs table
    op.create_table(
        "usage_logs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_email", sa.String(255)),
        sa.Column("action", sa.String(100), nullable=False),
        sa.Column("resource_type", sa.String(50)),
        sa.Column("resource_id", postgresql.UUID(as_uuid=True)),
        sa.Column("metadata", postgresql.JSON()),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("usage_logs")
    op.drop_table("exploration_shares")
    op.drop_table("explorations")
    op.drop_table("graph_context_shares")
    op.drop_table("graph_contexts")
    op.drop_table("users")
