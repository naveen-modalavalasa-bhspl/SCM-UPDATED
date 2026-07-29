"""masters overhaul phase 1 — HSN master, UOM class, item identity columns

Revision ID: e1a2b3c4d5e6
Revises: d9e8f7a6b5c4
Create Date: 2026-07-28

Adds mst_hsn_codes and the mst_items columns the item rewrite needs. The item
columns are added now, nullable, rather than in the phase that starts using them:
one ALTER on a large table beats three, and a nullable column nothing reads yet is
inert.
"""
import sqlalchemy as sa
from alembic import op

revision = "e1a2b3c4d5e6"
down_revision = "d9e8f7a6b5c4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "mst_hsn_codes",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("code", sa.String(20), nullable=False),
        sa.Column("description", sa.String(300), nullable=True),
        sa.Column("cgst_rate", sa.Numeric(6, 3), nullable=False, server_default="0"),
        sa.Column("sgst_rate", sa.Numeric(6, 3), nullable=False, server_default="0"),
        sa.Column("igst_rate", sa.Numeric(6, 3), nullable=False, server_default="0"),
        sa.Column("cess_rate", sa.Numeric(6, 3), nullable=False, server_default="0"),
        sa.Column("effective_from", sa.Date(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code", name="uq_hsn_code"),
    )

    op.add_column("mst_items", sa.Column("hsn_id", sa.BigInteger(), nullable=True))
    op.create_index("ix_mst_items_hsn_id", "mst_items", ["hsn_id"])
    op.create_foreign_key(
        "fk_mst_items_hsn", "mst_items", "mst_hsn_codes", ["hsn_id"], ["id"],
    )
    op.add_column(
        "mst_items",
        sa.Column("is_asset", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "mst_items",
        sa.Column("is_imei_tracked", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
    )
    op.add_column("mst_items", sa.Column("serial_no", sa.Integer(), nullable=True))

    # uom_class becomes required. Existing rows are backfilled to COUNT rather than
    # left NULL: an unclassified unit would vanish from every class-filtered dropdown,
    # which is a silent data loss the admin would have no way to notice.
    op.execute("UPDATE mst_uom SET uom_class = 'COUNT' "
               "WHERE uom_class IS NULL OR uom_class = ''")


def downgrade() -> None:
    op.drop_column("mst_items", "serial_no")
    op.drop_column("mst_items", "is_imei_tracked")
    op.drop_column("mst_items", "is_asset")
    op.drop_constraint("fk_mst_items_hsn", "mst_items", type_="foreignkey")
    op.drop_index("ix_mst_items_hsn_id", table_name="mst_items")
    op.drop_column("mst_items", "hsn_id")
    op.drop_table("mst_hsn_codes")
