"""Add options JSON column to query_templates

Revision ID: 006
Revises: 005
Create Date: 2026-03-14 00:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "006"
down_revision: Union[str, None] = "005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_cols = {c["name"] for c in inspector.get_columns("query_templates")}

    if "options" not in existing_cols:
        op.add_column(
            "query_templates",
            sa.Column(
                "options",
                postgresql.JSON(),
                server_default="{}",
            ),
        )


def downgrade() -> None:
    op.drop_column("query_templates", "options")
