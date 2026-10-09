"""Agents: personal agent tokens and actor columns on the case journal

Revision ID: 017
Revises: 016
Create Date: 2026-10-10 06:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "017"
down_revision: Union[str, None] = "016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

EVENT_COLUMNS = (
    (
        "actor_kind",
        lambda: sa.Column(
            "actor_kind", sa.String(10), nullable=False, server_default="human"
        ),
    ),
    (
        "agent_token_id",
        lambda: sa.Column(
            "agent_token_id", postgresql.UUID(as_uuid=True), nullable=True
        ),
    ),
    ("agent_name", lambda: sa.Column("agent_name", sa.String(100), nullable=True)),
)


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_cols = {c["name"] for c in inspector.get_columns("investigation_events")}
    for name, column in EVENT_COLUMNS:
        if name not in existing_cols:
            op.add_column("investigation_events", column())

    if "agent_tokens" not in set(inspector.get_table_names()):
        op.create_table(
            "agent_tokens",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("owner_email", sa.String(255), nullable=False),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
            sa.Column("scopes", postgresql.JSON(), nullable=False, server_default="[]"),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
            sa.Column("expires_at", sa.DateTime(), nullable=False),
            sa.Column("revoked_at", sa.DateTime(), nullable=True),
        )
        op.create_index("ix_agent_tokens_owner_email", "agent_tokens", ["owner_email"])


def downgrade() -> None:
    op.drop_index("ix_agent_tokens_owner_email", table_name="agent_tokens")
    op.drop_table("agent_tokens")
    for name, _ in reversed(EVENT_COLUMNS):
        op.drop_column("investigation_events", name)
