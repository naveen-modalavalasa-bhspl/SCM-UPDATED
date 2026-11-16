"""Brand-item mapping table (2026-10-15).

Brand and manufacturer are no longer typed on the item form; they are managed
centrally on the Brand Item Mapping screen (Masters > Classification), which maps
brands onto items category by category. One item may carry several brands; one
brand may cover many items. Manufacturers ride along from each brand's own
mst_brand_manufacturers rows, so they are NOT stored here.

Idempotent, like its neighbours: creating the table, its indexes and its unique
constraint only when each one is missing.

Revision ID: 69f59895baf8
Revises: a1b0c9d8e7f6
"""
from alembic import op
import sqlalchemy as sa

revision = "69f59895baf8"
down_revision = "a1b0c9d8e7f6"
branch_labels = None
depends_on = None

TABLE = "mst_brand_item_mappings"


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _indexes(table: str) -> set[str]:
    return {ix["name"] for ix in sa.inspect(op.get_bind()).get_indexes(table)}


def _constraints(table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_unique_constraints(table)}


def upgrade() -> None:
    if TABLE not in _tables():
        op.create_table(
            TABLE,
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("item_id", sa.BigInteger(), nullable=False),
            sa.Column("item_code", sa.String(50), nullable=True),
            sa.Column("item_name", sa.String(300), nullable=True),
            sa.Column("brand_id", sa.BigInteger(), nullable=False),
            sa.Column("brand_code", sa.String(50), nullable=True),
            sa.Column("brand_name", sa.String(200), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False,
                      server_default=sa.text("1")),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["item_id"], ["mst_items.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["brand_id"], ["mst_brands.id"]),
        )
    existing_indexes = _indexes(TABLE)
    if "ix_mst_brand_item_mappings_item_id" not in existing_indexes:
        op.create_index("ix_mst_brand_item_mappings_item_id", TABLE, ["item_id"])
    if "ix_mst_brand_item_mappings_brand_id" not in existing_indexes:
        op.create_index("ix_mst_brand_item_mappings_brand_id", TABLE, ["brand_id"])
    if "uq_brand_item_mapping" not in _constraints(TABLE):
        op.create_unique_constraint("uq_brand_item_mapping", TABLE,
                                    ["item_id", "brand_id"])


def downgrade() -> None:
    if TABLE in _tables():
        op.drop_table(TABLE)
