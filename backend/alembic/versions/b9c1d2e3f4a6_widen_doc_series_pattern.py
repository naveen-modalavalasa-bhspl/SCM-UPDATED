"""Room for a real numbering pattern.

VARCHAR(50) fits {PREFIX}/{FY}/{SEQ:5} and little else — {PREFIX}/{COMPANY}/{PROJECT}/
{YYYY}/{MM}/{DD}/{SEQ:5} is 53 characters and was rejected. Widened to 100; nothing
truncates, so this is safe to run on live data.

Revision ID: b9c1d2e3f4a6
Revises: a9b1c2d3e4f5
"""
from alembic import op
import sqlalchemy as sa

revision = "b9c1d2e3f4a6"
down_revision = "a9b1c2d3e4f5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("sys_doc_series", "pattern",
                    existing_type=sa.String(50), type_=sa.String(100), nullable=False)


def downgrade() -> None:
    # Only safe while every stored pattern still fits 50 characters.
    op.alter_column("sys_doc_series", "pattern",
                    existing_type=sa.String(100), type_=sa.String(50), nullable=False)
