"""Add default_behaviors JSON column to graph_contexts

Revision ID: 007
Revises: 006
Create Date: 2026-07-13 15:20:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "007"
down_revision: Union[str, None] = "006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_cols = {c["name"] for c in inspector.get_columns("graph_contexts")}

    if "default_behaviors" not in existing_cols:
        op.add_column(
            "graph_contexts",
            sa.Column(
                "default_behaviors",
                postgresql.JSON(),
                server_default="{}",
            ),
        )


def downgrade() -> None:
    op.drop_column("graph_contexts", "default_behaviors")
