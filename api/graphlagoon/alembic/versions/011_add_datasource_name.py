"""Add datasource_name to graph_contexts

REST connections are the first datasource type with multiple named instances
per server, so a context must record WHICH connection it queries, not just the
type. Nullable with no default: every pre-existing row is a single-instance
type (warehouse or Neptune), for which the name is meaningless.

Revision ID: 011
Revises: 010
Create Date: 2026-08-14 12:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "011"
down_revision: Union[str, None] = "010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_cols = {c["name"] for c in inspector.get_columns("graph_contexts")}

    if "datasource_name" not in existing_cols:
        op.add_column(
            "graph_contexts",
            sa.Column("datasource_name", sa.String(length=100), nullable=True),
        )


def downgrade() -> None:
    # Dropping the column strands any "rest" context (its queries would fall
    # back to the default warehouse and fail) — delete those contexts first if
    # you mean it.
    op.drop_column("graph_contexts", "datasource_name")
