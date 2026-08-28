"""Admin area: users.last_seen_at + usage_logs indexes

Revision ID: 014
Revises: 013
Create Date: 2026-08-28 14:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "014"
down_revision: Union[str, None] = "013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)

    user_cols = {c["name"] for c in inspector.get_columns("users")}
    if "last_seen_at" not in user_cols:
        op.add_column(
            "users",
            sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        )

    existing = {i["name"] for i in inspector.get_indexes("usage_logs")}
    if "ix_usage_logs_created_at" not in existing:
        op.create_index(
            "ix_usage_logs_created_at",
            "usage_logs",
            [sa.text("created_at DESC")],
        )
    if "ix_usage_logs_user_email" not in existing:
        op.create_index("ix_usage_logs_user_email", "usage_logs", ["user_email"])
    if "ix_usage_logs_action" not in existing:
        op.create_index("ix_usage_logs_action", "usage_logs", ["action"])


def downgrade() -> None:
    op.drop_index("ix_usage_logs_action", table_name="usage_logs")
    op.drop_index("ix_usage_logs_user_email", table_name="usage_logs")
    op.drop_index("ix_usage_logs_created_at", table_name="usage_logs")
    op.drop_column("users", "last_seen_at")
