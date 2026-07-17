"""Add cluster_programs JSON column to graph_contexts

Revision ID: 009
Revises: 008
Create Date: 2026-07-17 12:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "009"
down_revision: Union[str, None] = "008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_cols = {c["name"] for c in inspector.get_columns("graph_contexts")}

    if "cluster_programs" not in existing_cols:
        op.add_column(
            "graph_contexts",
            sa.Column(
                "cluster_programs",
                postgresql.JSON(),
                server_default="[]",
            ),
        )


def downgrade() -> None:
    op.drop_column("graph_contexts", "cluster_programs")
