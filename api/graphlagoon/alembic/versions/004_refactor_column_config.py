"""Refactor column config to structure + properties

Revision ID: 004
Revises: 003
Create Date: 2024-01-30 00:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Rename edge_columns to edge_structure
    op.alter_column("graph_contexts", "edge_columns", new_column_name="edge_structure")

    # Rename node_columns to node_structure
    op.alter_column("graph_contexts", "node_columns", new_column_name="node_structure")

    # Add edge_properties column (JSON array)
    op.add_column(
        "graph_contexts",
        sa.Column("edge_properties", postgresql.JSON(), server_default="[]"),
    )

    # Add node_properties column (JSON array)
    op.add_column(
        "graph_contexts",
        sa.Column("node_properties", postgresql.JSON(), server_default="[]"),
    )


def downgrade() -> None:
    # Remove properties columns
    op.drop_column("graph_contexts", "node_properties")
    op.drop_column("graph_contexts", "edge_properties")

    # Rename back
    op.alter_column("graph_contexts", "edge_structure", new_column_name="edge_columns")
    op.alter_column("graph_contexts", "node_structure", new_column_name="node_columns")
