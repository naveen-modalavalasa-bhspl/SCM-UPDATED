"""Handling units: a bin's capacity is checked against PACKS, not against loose volume

The first attempt at bin capacity gave `mst_items` three dimensions and a
`unit_volume_cbm`, and computed occupancy as `qty x volume_per_unit`. That is the one
model every real WMS rejects, because you cannot pour boxes like liquid: 500 SIM cards
whose "each" volume sums to 0.002 cbm actually arrive as ten rigid boxes on a pallet
and occupy a pallet's footprint. Loose volume systematically reports a full bin as
empty, and the error grows with how well the goods are packed.

What replaces it is what SAP EWM, Oracle WMS and Manhattan all do: the goods are
measured at the PACKAGING LEVEL they physically move in, and a bin is checked against
the resulting handling units on three independent gates — cube, weight and the
outer bounding box — plus a discrete count of how many units the bin type accepts.

So, four sets of columns:

**`mst_packaging`** — the container type finally carries its own physical spec. Its
`length/width/height_cm` and `weight_kg` columns have existed since the DB team built
the table and the API deliberately ignored them; `weight_kg` is the TARE weight, the
empty container. `is_stackable` / `max_stack_tiers` / `is_rotatable` are the handling
rules a slotting check needs, and `fill_efficiency_pct` is the void factor: loose parts
in a rigid tote never reach 100% of its cube.

**`mst_item_packaging`** — one rung of an item's ladder becomes a full packaging unit
in the WMS sense: the conversion factor was already there (`quantity`), and the
dimensions, the GROSS weight (container plus contents, which is item-specific and so
cannot live on the container type) and `is_default_putaway_unit` complete it. The
dimensions are an OVERRIDE: blank means "the container type's own", which is the
common case and keeps the ladder cheap to configure.

**`whs_warehouse_locations`** — a bin gains the other two sides of its box (it had
`height_cm` only), the discrete limit `max_handling_units` (bin type B1 takes one
euro-pallet or four totes), and its own `fill_efficiency_pct`.

**`whs_warehouse_items`** — a putaway task records WHICH packaging unit was received,
because "3 cases" and "1500 eaches" need different shelf space and only the document
knows which one landed on the dock.

The four `mst_items` volume columns are dropped. Nothing reads them any more and
leaving them would invite a second, disagreeing answer to the same question.

Revision ID: b8e4f1c7a2d9
Revises: e7c1a2b9d4f3
"""
from alembic import op
import sqlalchemy as sa

revision = "b8e4f1c7a2d9"
down_revision = "e7c1a2b9d4f3"
branch_labels = None
depends_on = None


#: table -> columns to add. Everything is nullable with no backfill, for the reason the
#: capacity module gives at length: an unmeasured pack has NO volume, not a volume of
#: zero, and zero would report a packed bin as empty.
ADDITIONS: dict[str, tuple[tuple[str, object], ...]] = {
    "mst_packaging": (
        # L x W x H are the OUTER bounding box of the empty container, in cm.
        ("length_cm", sa.Numeric(10, 2)),
        ("width_cm", sa.Numeric(10, 2)),
        ("height_cm", sa.Numeric(10, 2)),
        # Tare — the container's own weight, empty.
        ("weight_kg", sa.Numeric(12, 3)),
        ("is_stackable", sa.Boolean()),
        # How many may sit on top of one another. 1 means non-stackable; NULL means
        # nobody has said, which is not the same as "as many as you like".
        ("max_stack_tiers", sa.Integer()),
        ("is_rotatable", sa.Boolean()),
        # Void factor: the share of the container's cube that goods actually reach.
        ("fill_efficiency_pct", sa.Numeric(5, 2)),
    ),
    "mst_item_packaging": (
        # Per-item override of the container type's box. Blank = use the container's.
        ("length_cm", sa.Numeric(10, 2)),
        ("width_cm", sa.Numeric(10, 2)),
        ("height_cm", sa.Numeric(10, 2)),
        # GROSS: container plus the item inside it. Item-specific, hence not on
        # mst_packaging — a box of bolts and a box of foam weigh nothing alike.
        ("gross_weight_kg", sa.Numeric(12, 3)),
        ("max_stack_tiers", sa.Integer()),
        # Which rung putaway and occupancy work in when nothing else is chosen.
        ("is_default_putaway_unit", sa.Boolean()),
    ),
    "whs_warehouse_locations": (
        ("length_cm", sa.Numeric(10, 2)),
        ("width_cm", sa.Numeric(10, 2)),
        # The discrete gate: "this bin takes 1 pallet" is a limit no cube expresses.
        ("max_handling_units", sa.Integer()),
        ("fill_efficiency_pct", sa.Numeric(5, 2)),
    ),
    "whs_warehouse_items": (
        ("item_packaging_id", sa.BigInteger()),
        ("package_id", sa.BigInteger()),
        ("package_name", sa.String(200)),
        # How many handling units the task represents, at the rung above.
        ("handling_units", sa.Numeric(15, 3)),
    ),
}

#: The loose-volume experiment, removed. `warehouse.capacity` no longer reads them and
#: `mst_items` is mapped column-for-column, so a leftover here is a column the model
#: must keep declaring for no reason.
REMOVALS = ("length_cm", "width_cm", "height_cm", "unit_volume_cbm")


def _columns(table: str) -> set[str]:
    """Several of these tables were built by `create_all` rather than by a migration, so
    a database brought up by bootstrap already carries whatever the models declare.
    Checked rather than assumed, so this is safe on both routes."""
    inspector = sa.inspect(op.get_bind())
    return {c["name"] for c in inspector.get_columns(table)}


def upgrade() -> None:
    for table, columns in ADDITIONS.items():
        have = _columns(table)
        for name, type_ in columns:
            if name not in have:
                op.add_column(table, sa.Column(name, type_, nullable=True))

    have = _columns("mst_items")
    for name in REMOVALS:
        if name in have:
            op.drop_column("mst_items", name)


def downgrade() -> None:
    have = _columns("mst_items")
    for name in REMOVALS:
        if name not in have:
            op.add_column(
                "mst_items",
                sa.Column(name, sa.Numeric(18, 6) if name == "unit_volume_cbm"
                          else sa.Numeric(10, 2), nullable=True),
            )
    # mst_packaging's dimension columns predate this migration on the live table, so
    # they are NOT dropped on the way back down — only what this revision introduced.
    for table, columns in ADDITIONS.items():
        have = _columns(table)
        for name, _type in columns:
            if name in have and not (table == "mst_packaging"
                                     and name in {"length_cm", "width_cm", "height_cm",
                                                  "weight_kg"}):
                op.drop_column(table, name)
