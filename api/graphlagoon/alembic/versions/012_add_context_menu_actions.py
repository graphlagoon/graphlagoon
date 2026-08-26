"""Add context_menu_actions JSON column to graph_contexts

Revision ID: 012
Revises: 011
Create Date: 2026-08-25 12:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "012"
down_revision: Union[str, None] = "011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_cols = {c["name"] for c in inspector.get_columns("graph_contexts")}

    if "context_menu_actions" not in existing_cols:
        op.add_column(
            "graph_contexts",
            sa.Column(
                "context_menu_actions",
                postgresql.JSON(),
                server_default="[]",
            ),
        )


def downgrade() -> None:
    op.drop_column("graph_contexts", "context_menu_actions")
