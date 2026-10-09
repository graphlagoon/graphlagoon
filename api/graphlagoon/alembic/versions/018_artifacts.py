"""Case space: investigation_artifacts and their immutable versions

Revision ID: 018
Revises: 017
Create Date: 2026-10-10 08:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "018"
down_revision: Union[str, None] = "017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _fk(name: str, target: str) -> sa.Column:
    return sa.Column(
        name,
        postgresql.UUID(as_uuid=True),
        sa.ForeignKey(target, ondelete="CASCADE"),
        nullable=False,
        index=True,
    )


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "investigation_artifacts" not in tables:
        op.create_table(
            "investigation_artifacts",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            _fk("investigation_id", "investigations.id"),
            sa.Column("name", sa.String(255), nullable=False),
            sa.Column("kind", sa.String(20), nullable=False),
            sa.Column("current_version", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        )
    if "investigation_artifact_versions" not in tables:
        op.create_table(
            "investigation_artifact_versions",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            _fk("investigation_id", "investigations.id"),
            _fk("artifact_id", "investigation_artifacts.id"),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("blob_key", sa.String(512), nullable=False),
            sa.Column("sha256", sa.String(64), nullable=False),
            sa.Column("size_bytes", sa.BigInteger(), nullable=False),
            sa.Column("content_type", sa.String(255), nullable=False),
            sa.Column("status", sa.String(10), nullable=False),
            sa.Column("actor", postgresql.JSON(), nullable=False),
            sa.Column("source_evidence_ids", postgresql.JSON(), nullable=False),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
            sa.Column("approved_by", sa.String(255), nullable=True),
            sa.Column("approved_at", sa.DateTime(), nullable=True),
            sa.UniqueConstraint(
                "artifact_id", "version", name="uq_artifact_versions_version"
            ),
        )


def downgrade() -> None:
    op.drop_table("investigation_artifact_versions")
    op.drop_table("investigation_artifacts")
