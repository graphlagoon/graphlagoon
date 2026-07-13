"""Add visibility column to query_templates

Revision ID: 008
Revises: 007
Create Date: 2026-07-13 00:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "008"
down_revision: Union[str, None] = "007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_cols = {c["name"] for c in inspector.get_columns("query_templates")}

    if "visibility" not in existing_cols:
        op.add_column(
            "query_templates",
            sa.Column(
                "visibility",
                sa.String(10),
                nullable=False,
                server_default="shared",
            ),
        )


def downgrade() -> None:
    op.drop_column("query_templates", "visibility")
