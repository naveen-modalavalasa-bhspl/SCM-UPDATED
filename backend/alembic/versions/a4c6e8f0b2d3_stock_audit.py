"""Stock Audit: counted lines on adjustments, and the screen back on the rail.

`inv_adjustment_items` gains `system_qty` / `physical_qty` (the count against what
the system held), `inv_adjustments` gains `current_approver_name` (who a configured
chain is waiting on).

The `inv_adjustments` menu row was parked (is_active = 0) while the screen was
unfinished. `sync_pages` never flips is_active and never rewrites
required_permission, so this switches the row on and points it at its own
`page.inv_adjustments.view` code, which inherits every `stock.adjust` grant
(permissions.INHERITS_GRANTS_FROM). Idempotent throughout.

Revision ID: a4c6e8f0b2d3
Revises: e1f3a5c7b9d2
"""
from alembic import op
import sqlalchemy as sa

revision = "a4c6e8f0b2d3"
down_revision = "e1f3a5c7b9d2"
branch_labels = None
depends_on = None


def _has_column(table: str, column: str) -> bool:
    return column in {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    if not _has_column("inv_adjustment_items", "system_qty"):
        op.add_column("inv_adjustment_items",
                      sa.Column("system_qty", sa.Numeric(16, 3), nullable=True))
    if not _has_column("inv_adjustment_items", "physical_qty"):
        op.add_column("inv_adjustment_items",
                      sa.Column("physical_qty", sa.Numeric(16, 3), nullable=True))
    if not _has_column("inv_adjustments", "current_approver_name"):
        op.add_column("inv_adjustments",
                      sa.Column("current_approver_name", sa.String(300), nullable=True))
    op.execute(sa.text(
        "UPDATE rbac_pages SET is_active = 1, name = 'Stock Audit', "
        "required_permission = 'page.inv_adjustments.view' "
        "WHERE code = 'inv_adjustments'"
    ))


def downgrade() -> None:
    op.execute(sa.text(
        "UPDATE rbac_pages SET is_active = 0, name = 'Adjustments', "
        "required_permission = 'stock.adjust' WHERE code = 'inv_adjustments'"
    ))
    op.drop_column("inv_adjustments", "current_approver_name")
    op.drop_column("inv_adjustment_items", "physical_qty")
    op.drop_column("inv_adjustment_items", "system_qty")
