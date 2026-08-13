"""Add datasource_type to graph_contexts and relax the table-name columns

Every context predating this migration is a SQL warehouse context, so the
server default backfills existing rows atomically — no data migration, and no
behavioural change for anything already in the table.

The table-name columns become nullable because a native graph database
(Amazon Neptune) has no edge/node tables to name. The requirement is not
dropped, only moved: ``GraphContextCreate`` still rejects a sql_warehouse
context without both tables.

Revision ID: 010
Revises: 009
Create Date: 2026-08-13 12:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "010"
down_revision: Union[str, None] = "009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_cols = {c["name"] for c in inspector.get_columns("graph_contexts")}

    if "datasource_type" not in existing_cols:
        op.add_column(
            "graph_contexts",
            sa.Column(
                "datasource_type",
                sa.String(length=50),
                nullable=False,
                server_default="sql_warehouse",
            ),
        )

    op.alter_column(
        "graph_contexts",
        "edge_table_name",
        existing_type=sa.String(length=255),
        nullable=True,
    )
    op.alter_column(
        "graph_contexts",
        "node_table_name",
        existing_type=sa.String(length=255),
        nullable=True,
    )


def downgrade() -> None:
    # Restoring NOT NULL fails if any Neptune context exists — by design. Those
    # rows have no table names to restore, so silently inventing one would be
    # worse than refusing to downgrade; delete them first if you mean it.
    op.alter_column(
        "graph_contexts",
        "node_table_name",
        existing_type=sa.String(length=255),
        nullable=False,
    )
    op.alter_column(
        "graph_contexts",
        "edge_table_name",
        existing_type=sa.String(length=255),
        nullable=False,
    )
    op.drop_column("graph_contexts", "datasource_type")
