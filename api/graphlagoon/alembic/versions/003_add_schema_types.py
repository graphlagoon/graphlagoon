"""Add node_types and relationship_types to graph_contexts

Revision ID: 003
Revises: 002
Create Date: 2025-01-30 00:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add node_types and relationship_types arrays to graph_contexts
    op.add_column(
        "graph_contexts",
        sa.Column("node_types", postgresql.ARRAY(sa.Text()), server_default="{}"),
    )
    op.add_column(
        "graph_contexts",
        sa.Column(
            "relationship_types", postgresql.ARRAY(sa.Text()), server_default="{}"
        ),
    )


def downgrade() -> None:
    op.drop_column("graph_contexts", "relationship_types")
    op.drop_column("graph_contexts", "node_types")
