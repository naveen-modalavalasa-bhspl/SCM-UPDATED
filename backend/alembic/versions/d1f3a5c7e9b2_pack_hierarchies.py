"""Pack hierarchies: an item may be packed in several named families (2026-10-08).

Adds `mst_pack_hierarchies` and `mst_item_packaging.hierarchy_id`. Every item that
already has a ladder gets ONE hierarchy named "Standard" (its default) and all of its
rungs are moved into it, so nothing that reads a ladder today changes what it reads.

The unique key on rungs moves from (item, level) to (hierarchy, level): two
hierarchies of one item each have their own level 1.

Idempotent: every step checks the live schema first.

Revision ID: d1f3a5c7e9b2
Revises: c2e4a6b8d0f1
Create Date: 2026-10-08
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d1f3a5c7e9b2"
down_revision: Union[str, Sequence[str], None] = "c2e4a6b8d0f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

HIER = "mst_pack_hierarchies"
RUNG = "mst_item_packaging"
OLD_UQ = "uq_item_packaging_level"
NEW_UQ = "uq_item_packaging_hierarchy_level"
FK = "fk_item_packaging_hierarchy"
IX = "ix_mst_item_packaging_hierarchy_id"


def _insp():
    return sa.inspect(op.get_bind())


def _tables() -> set[str]:
    return set(_insp().get_table_names())


def _columns(table: str) -> set[str]:
    return {c["name"] for c in _insp().get_columns(table)}


def _indexes(table: str) -> set[str]:
    insp = _insp()
    names = {i["name"] for i in insp.get_indexes(table)}
    names |= {u["name"] for u in insp.get_unique_constraints(table)}
    return names


def _fks(table: str) -> set[str]:
    return {f["name"] for f in _insp().get_foreign_keys(table)}


def upgrade() -> None:
    if HIER not in _tables():
        op.create_table(
            HIER,
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("item_id", sa.BigInteger(),
                      sa.ForeignKey("mst_items.id", ondelete="CASCADE"),
                      nullable=False, index=True),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("description", sa.String(300), nullable=True),
            sa.Column("is_default", sa.Boolean(), nullable=False,
                      server_default=sa.text("0")),
            sa.Column("is_active", sa.Boolean(), nullable=False,
                      server_default=sa.text("1")),
            sa.Column("created_at", sa.DateTime(), nullable=True,
                      server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=True,
                      server_default=sa.func.now()),
            sa.UniqueConstraint("item_id", "name", name="uq_pack_hierarchy_item_name"),
        )

    if "hierarchy_id" not in _columns(RUNG):
        op.add_column(RUNG, sa.Column("hierarchy_id", sa.BigInteger(), nullable=True))
    if IX not in _indexes(RUNG):
        op.create_index(IX, RUNG, ["hierarchy_id"])
    if FK not in _fks(RUNG):
        op.create_foreign_key(FK, RUNG, HIER, ["hierarchy_id"], ["id"],
                              ondelete="CASCADE")

    # Backfill: one "Standard" hierarchy per item that has rungs and none yet.
    bind = op.get_bind()
    bind.execute(sa.text(f"""
        INSERT INTO {HIER} (item_id, name, description, is_default, is_active,
                            created_at, updated_at)
        SELECT DISTINCT r.item_id, 'Standard',
               'Created from the item''s original packing ladder', 1, 1, NOW(), NOW()
        FROM {RUNG} r
        WHERE NOT EXISTS (SELECT 1 FROM {HIER} h WHERE h.item_id = r.item_id)
    """))
    bind.execute(sa.text(f"""
        UPDATE {RUNG} r
        JOIN {HIER} h ON h.item_id = r.item_id AND h.name = 'Standard'
        SET r.hierarchy_id = h.id
        WHERE r.hierarchy_id IS NULL
    """))

    indexes = _indexes(RUNG)
    if NEW_UQ not in indexes:
        op.create_unique_constraint(NEW_UQ, RUNG, ["hierarchy_id", "level"])
    if OLD_UQ in _indexes(RUNG):
        # item_id keeps its own plain index, so the item FK is still covered.
        if "ix_mst_item_packaging_item_id" not in _indexes(RUNG):
            op.create_index("ix_mst_item_packaging_item_id", RUNG, ["item_id"])
        op.drop_constraint(OLD_UQ, RUNG, type_="unique")


def downgrade() -> None:
    if OLD_UQ not in _indexes(RUNG):
        # Only safe while every item still has a single hierarchy.
        op.create_unique_constraint(OLD_UQ, RUNG, ["item_id", "level"])
    if NEW_UQ in _indexes(RUNG):
        op.drop_constraint(NEW_UQ, RUNG, type_="unique")
    if FK in _fks(RUNG):
        op.drop_constraint(FK, RUNG, type_="foreignkey")
    if IX in _indexes(RUNG):
        op.drop_index(IX, table_name=RUNG)
    if "hierarchy_id" in _columns(RUNG):
        op.drop_column(RUNG, "hierarchy_id")
    if HIER in _tables():
        op.drop_table(HIER)
