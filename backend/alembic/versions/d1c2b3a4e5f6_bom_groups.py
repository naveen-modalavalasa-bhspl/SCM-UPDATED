"""BOM groups — which job profile gets which kit.

A BOM master says WHAT is in a kit; nothing said WHO may draw it. The rung is the
RBAC job profile (platform/rbac/profiles.py), which has no table of its own — it is
derived from the HCM mirror and keyed "<project id>:<job>" — so the pairing is stored
against that string key with the name snapshotted beside it, the way every other
master snapshots its parent.

`bom_id` cascades: deleting a BOM deletes the pairings that point at it, because a
pairing with no kit says nothing. The profile side deliberately has no constraint —
an HCM cutover re-keys positions, and a stale pairing must be visible and fixable
rather than silently deleted by the database.

Guarded and additive: a no-op on a database that already has the table.

Revision ID: d1c2b3a4e5f6
Revises: c4d5e6f7a8b9
Create Date: 2026-08-10
"""
import sqlalchemy as sa
from alembic import op

revision = "d1c2b3a4e5f6"
down_revision = "c4d5e6f7a8b9"
branch_labels = None
depends_on = None

TABLE = "mst_bom_groups"


def upgrade() -> None:
    bind = op.get_bind()
    if TABLE in sa.inspect(bind).get_table_names():
        return

    op.create_table(
        TABLE,
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("bom_id", sa.BigInteger(), nullable=False),
        sa.Column("bom_code", sa.String(50), nullable=True),
        sa.Column("bom_name", sa.String(200), nullable=True),
        sa.Column("profile_key", sa.String(150), nullable=False),
        sa.Column("profile_job", sa.String(150), nullable=True),
        sa.Column("profile_name", sa.String(200), nullable=True),
        sa.Column("project_id", sa.BigInteger(), nullable=True),
        sa.Column("project_name", sa.String(200), nullable=True),
        sa.Column("remarks", sa.String(500), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["bom_id"], ["mst_boms.id"], ondelete="CASCADE",
                                name="fk_mst_bom_groups_bom"),
        sa.UniqueConstraint("bom_id", "profile_key", name="uq_bom_group"),
        # The schema converged on one collation (f9b0c1d2e3f4); a new table must not
        # reintroduce the drift, or a join against it raises 1267 again.
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index(f"ix_{TABLE}_bom_id", TABLE, ["bom_id"])
    op.create_index(f"ix_{TABLE}_profile_key", TABLE, ["profile_key"])
    op.create_index(f"ix_{TABLE}_project_id", TABLE, ["project_id"])


def downgrade() -> None:
    bind = op.get_bind()
    if TABLE in sa.inspect(bind).get_table_names():
        op.drop_table(TABLE)
