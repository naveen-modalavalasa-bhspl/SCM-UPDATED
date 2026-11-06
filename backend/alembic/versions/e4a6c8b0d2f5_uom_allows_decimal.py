""""Allows decimal" moves onto the UOM itself; UOM types go back to the enum (2026-11-04).

`mst_uom.allows_decimal`: may a document carry a fraction of THIS unit. It was a flag
on `mst_uom_classes` (Masters > UOM Types), so a custom type whose NAME read "COUNT"
while its CODE was "CNT" was a different type to every rule that compared codes.

Backfill keeps today's answer for every unit: its type row's flag when the type has a
row, otherwise whole-only (the 2026-11-03 rule). Then every `uom_class` that is not one
of the built-in `UomClass` values is folded back onto one: the type's NAME when it
names a built-in ("COUNT" for CNT), the whole-unit spellings onto COUNT / PACKAGING, a
remaining whole-only type onto COUNT. `mst_uom_classes` is left in place, unread.
Idempotent.

Revision ID: e4a6c8b0d2f5
Revises: b9d1f3a5c7e0
Create Date: 2026-11-04
"""
import sqlalchemy as sa
from alembic import op

revision = "e4a6c8b0d2f5"
down_revision = "b9d1f3a5c7e0"
branch_labels = None
depends_on = None

BUILT_IN = {"COUNT", "LENGTH", "AREA", "VOLUME", "WEIGHT", "TEMPERATURE", "TIME",
            "PRESSURE", "ENERGY", "PACKAGING"}
SPELLINGS = {"QUANTITY": "COUNT", "QUA": "COUNT", "COU": "COUNT", "CNT": "COUNT",
             "NOS": "COUNT", "PAC": "PACKAGING"}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "allows_decimal" not in {c["name"] for c in inspector.get_columns("mst_uom")}:
        op.add_column("mst_uom", sa.Column("allows_decimal", sa.Boolean(), nullable=False,
                                           server_default=sa.false()))
        fresh = True
    else:
        fresh = False

    types: dict[str, tuple[str, bool]] = {}
    if "mst_uom_classes" in inspector.get_table_names():
        cols = {c["name"] for c in inspector.get_columns("mst_uom_classes")}
        flag = "allows_decimal" if "allows_decimal" in cols else "1"
        for code, name, allows in bind.execute(sa.text(
                f"SELECT code, name, {flag} FROM mst_uom_classes")):
            types[(code or "").strip().upper()] = ((name or "").strip().upper(), bool(allows))

    # Matched in Python: the two tables carry different collations on the live server.
    for uom_id, uom_class in bind.execute(sa.text("SELECT id, uom_class FROM mst_uom")).all():
        key = (uom_class or "").strip().upper()
        name, allows = types.get(key, ("", False))
        if fresh:
            bind.execute(sa.text("UPDATE mst_uom SET allows_decimal = :a WHERE id = :i"),
                         {"a": allows, "i": uom_id})
        if key in BUILT_IN:
            target = key
        elif name in BUILT_IN:
            target = name
        elif key in SPELLINGS or name in SPELLINGS:
            target = SPELLINGS.get(key) or SPELLINGS[name]
        elif key and not allows:
            target = "COUNT"
        else:
            target = key or None
        if target and target != uom_class:
            bind.execute(sa.text("UPDATE mst_uom SET uom_class = :c WHERE id = :i"),
                         {"c": target, "i": uom_id})


def downgrade() -> None:
    if "allows_decimal" in {c["name"] for c in sa.inspect(op.get_bind()).get_columns("mst_uom")}:
        op.drop_column("mst_uom", "allows_decimal")
