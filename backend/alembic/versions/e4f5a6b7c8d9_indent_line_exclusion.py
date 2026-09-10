"""Record that an approver EXCLUDED an indent line, not merely cut it to zero.

Excluding a line from a consolidation and approving it at zero both ended at
`approved_qty = 0`, so nothing downstream could tell them apart: My Decisions showed the
dropped line as an ordinary one, the next rung up was offered an Exclude button for
something already excluded, and neither screen could name who dropped it
(BUG_SCM_0004 / 0007 / 0008).

Nullable and defaulted, so every existing row reads as "not excluded" — which is the
truth for them: before this, excluding was not a thing the system recorded.

Revision ID: e4f5a6b7c8d9
Revises: c7d8e9f0a1b2
"""
import sqlalchemy as sa
from alembic import op

revision = "e4f5a6b7c8d9"
down_revision = "c7d8e9f0a1b2"
branch_labels = None
depends_on = None

_COLUMNS = (
    ("is_excluded", sa.Column("is_excluded", sa.Boolean(), nullable=False,
                              server_default="0")),
    ("excluded_by_id", sa.Column("excluded_by_id", sa.BigInteger(), nullable=True)),
    ("excluded_by_name", sa.Column("excluded_by_name", sa.String(200), nullable=True)),
    ("excluded_at", sa.Column("excluded_at", sa.DateTime(), nullable=True)),
)


def _existing() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return {c["name"] for c in inspector.get_columns("ind_indent_items")}


def upgrade() -> None:
    # Idempotent: this database is built by bootstrap from the models on a new install,
    # so the columns may already be there before the migration ever runs. See the
    # bootstrap note in CLAUDE.md.
    have = _existing()
    for name, column in _COLUMNS:
        if name not in have:
            op.add_column("ind_indent_items", column)


def downgrade() -> None:
    have = _existing()
    for name, _ in reversed(_COLUMNS):
        if name in have:
            op.drop_column("ind_indent_items", name)
