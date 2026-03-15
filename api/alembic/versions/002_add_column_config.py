"""Add column configuration to graph_contexts

Revision ID: 002
Revises: 001
Create Date: 2024-01-30 00:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add edge_columns and node_columns to graph_contexts
    op.add_column(
        "graph_contexts",
        sa.Column(
            "edge_columns",
            postgresql.JSON(),
            server_default='{"edge_id_col": "edge_id", "src_col": "src", "dst_col": "dst", "relationship_type_col": "relationship_type"}',
        ),
    )
    op.add_column(
        "graph_contexts",
        sa.Column(
            "node_columns",
            postgresql.JSON(),
            server_default='{"node_id_col": "node_id", "node_type_col": "node_type"}',
        ),
    )


def downgrade() -> None:
    op.drop_column("graph_contexts", "node_columns")
    op.drop_column("graph_contexts", "edge_columns")
