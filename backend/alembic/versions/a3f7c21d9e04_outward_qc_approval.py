"""outward_qc_approval

Outward QC becomes an approvable document: three snapshot columns on
`whs_inspections`, the same shape the consignment already carries.

Nothing about today's behaviour changes without configuration. Completing an
outward inspection only enters approval where an admin has configured a
QC_OUTWARD ladder on Settings > Approvals Config; with none — every project
today — the check completes on the spot exactly as it did before.

Revision ID: a3f7c21d9e04
Revises: 96dd19ed80c2
Create Date: 2026-08-20
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a3f7c21d9e04'
down_revision: Union[str, None] = '96dd19ed80c2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


COLUMNS = (
    ("current_approver_name", sa.String(300)),
    ("approved_by_name", sa.String(200)),
    ("approved_at", sa.DateTime()),
)


def _existing() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if "whs_inspections" not in inspector.get_table_names():
        return {name for name, _ in COLUMNS}
    return {column["name"] for column in inspector.get_columns("whs_inspections")}


def upgrade() -> None:
    existing = _existing()
    for name, type_ in COLUMNS:
        if name not in existing:
            op.add_column("whs_inspections", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    existing = _existing()
    for name, _type in COLUMNS:
        if name in existing:
            op.drop_column("whs_inspections", name)
