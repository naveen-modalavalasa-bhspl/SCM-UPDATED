"""What the leg travels ON, and who it was handed to — kept.

Two gaps on `lgs_transport_requests`, closed together because the Dispatch screen
asks for both on the same press.

`carriage_mode`: the screen has asked two questions since it was built — road/rail/
air/sea, and then which arrangement is made under it — and only the second one had a
column. The first was thrown away on every press, so a shipment sent by rail read back
as a plain third-party truck and the carrier's portal could not tell the winner which
way the job was going. NOT NULL with a ROAD default on purpose: every leg the business
has run to date is a road leg, so backfilling the existing rows to ROAD states what
actually happened rather than leaving a column of nulls the screens have to guess at.

The four custody columns: a name on its own identifies nobody once a load is being
chased. `driver_licence_no` names a driver who is not ours; the `handed_over_*` pair
pins the person custody passed to — one of ours by their employee id, anybody else by
an Aadhaar. All nullable: they are answered per mode, and no existing row has them.

Revision ID: a1b2c3d4e5f8
Revises: a3f7c21d9e04
Create Date: 2026-08-21
"""
from alembic import op
import sqlalchemy as sa

revision = "a1b2c3d4e5f8"
down_revision = "a3f7c21d9e04"
branch_labels = None
depends_on = None

TABLE = "lgs_transport_requests"
CARRIAGE = "carriage_mode"
INDEX = "ix_lgs_transport_requests_carriage_mode"

#: The nullable columns, added in one pass. Name -> type.
CUSTODY = {
    "driver_licence_no": sa.String(50),
    "handed_over_employee_id": sa.String(50),
    "handed_over_aadhaar": sa.String(12),
    "handed_over_phone": sa.String(30),
}


def _columns() -> set[str]:
    bind = op.get_bind()
    return {row[0] for row in bind.execute(sa.text(f"SHOW COLUMNS FROM {TABLE}"))}


def _indexes() -> set[str]:
    bind = op.get_bind()
    return {row[2] for row in bind.execute(sa.text(f"SHOW INDEX FROM {TABLE}"))}


def upgrade() -> None:
    columns = _columns()
    if CARRIAGE not in columns:
        op.add_column(TABLE, sa.Column(
            CARRIAGE, sa.String(20), nullable=False, server_default="ROAD"))
    if INDEX not in _indexes():
        op.create_index(INDEX, TABLE, [CARRIAGE])
    for name, type_ in CUSTODY.items():
        if name not in columns:
            op.add_column(TABLE, sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    columns = _columns()
    for name in CUSTODY:
        if name in columns:
            op.drop_column(TABLE, name)
    if INDEX in _indexes():
        op.drop_index(INDEX, table_name=TABLE)
    if CARRIAGE in columns:
        op.drop_column(TABLE, CARRIAGE)
