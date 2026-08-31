"""mst_items dimensions and unit volume — so a bin's volume capacity can be read

A storage location has carried `capacity_volume` since the DB team built
`whs_warehouse_locations`, and nothing has ever been able to use it: the goods that
go into the bin had no volume, so "how full is this bin" had no answer and putaway
placed stock blind. These four columns are the missing half.

`unit_volume_cbm` is the volume of ONE unit in the item's own UOM, in cubic metres.
The three dimensions are the other way to say the same thing — a storekeeper measures
a carton, a planner quotes a figure — and `warehouse.capacity.unit_volume` prefers the
explicit figure, falling back to L x W x H / 1,000,000.

All four are nullable with no backfill, and that is the point. An item nobody has
measured has NO volume, not a volume of zero: zero would quietly report every bin as
empty, which is worse than the screens saying "not measured" and showing the
storekeeper exactly which items are unaccounted for.

Revision ID: e7c1a2b9d4f3
Revises: 0d4e5f6a7b8c
"""
from alembic import op
import sqlalchemy as sa

revision = "e7c1a2b9d4f3"
down_revision = "0d4e5f6a7b8c"
branch_labels = None
depends_on = None

TABLE = "mst_items"
COLUMNS = (
    ("length_cm", sa.Numeric(10, 2)),
    ("width_cm", sa.Numeric(10, 2)),
    ("height_cm", sa.Numeric(10, 2)),
    ("unit_volume_cbm", sa.Numeric(18, 6)),
)


def _present() -> set[str]:
    """`mst_items` is one of the tables built by create_all rather than by a migration,
    so a database brought up by bootstrap already carries whatever the models declare.
    Checked rather than assumed, so this is safe on both routes."""
    inspector = sa.inspect(op.get_bind())
    return {c["name"] for c in inspector.get_columns(TABLE)}


def upgrade() -> None:
    have = _present()
    for name, type_ in COLUMNS:
        if name not in have:
            op.add_column(TABLE, sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    have = _present()
    for name, _type in COLUMNS:
        if name in have:
            op.drop_column(TABLE, name)
