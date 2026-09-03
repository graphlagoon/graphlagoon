"""Groups & permissions: groups, group_members, permission_modes, permission_rules

Revision ID: 015
Revises: 014
Create Date: 2026-09-03 09:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "015"
down_revision: Union[str, None] = "014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_tables = set(inspector.get_table_names())

    if "groups" not in existing_tables:
        op.create_table(
            "groups",
            sa.Column(
                "id",
                postgresql.UUID(as_uuid=True),
                primary_key=True,
            ),
            sa.Column("name", sa.String(100), nullable=False, unique=True),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        )

    if "group_members" not in existing_tables:
        op.create_table(
            "group_members",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "group_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("groups.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("kind", sa.String(20), nullable=False),
            sa.Column("value", sa.String(255), nullable=False),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
            sa.UniqueConstraint(
                "group_id", "kind", "value", name="uq_group_members_group_kind_value"
            ),
        )
        op.create_index("ix_group_members_group_id", "group_members", ["group_id"])

    if "permission_modes" not in existing_tables:
        op.create_table(
            "permission_modes",
            sa.Column("permission_id", sa.String(100), primary_key=True),
            sa.Column(
                "mode", sa.String(20), nullable=False, server_default="everyone"
            ),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        )

    if "permission_rules" not in existing_tables:
        op.create_table(
            "permission_rules",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("permission_id", sa.String(100), nullable=False),
            sa.Column(
                "group_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("groups.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("effect", sa.String(10), nullable=False),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
            sa.UniqueConstraint(
                "permission_id",
                "group_id",
                name="uq_permission_rules_permission_group",
            ),
        )
        op.create_index(
            "ix_permission_rules_permission_id", "permission_rules", ["permission_id"]
        )
        op.create_index(
            "ix_permission_rules_group_id", "permission_rules", ["group_id"]
        )


def downgrade() -> None:
    op.drop_index("ix_permission_rules_group_id", table_name="permission_rules")
    op.drop_index("ix_permission_rules_permission_id", table_name="permission_rules")
    op.drop_table("permission_rules")
    op.drop_table("permission_modes")
    op.drop_index("ix_group_members_group_id", table_name="group_members")
    op.drop_table("group_members")
    op.drop_table("groups")
