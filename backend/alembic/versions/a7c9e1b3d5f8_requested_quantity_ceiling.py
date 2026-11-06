"""Material request and requisition lines remember what they asked for (2026-11-03).

`inv_material_request_items.requested_quantity` and
`pro_requisition_items.requested_quantity` — the ceiling every later change is held
to: a quantity may be lowered or left, never raised past what was asked. Existing
lines are backfilled with their current quantity (every MR and every requisition
past DRAFT is already submitted); a hand-made requisition still in DRAFT stays NULL so
its author can go on editing it until it is submitted. Idempotent.

Revision ID: a7c9e1b3d5f8
Revises: f8b0d2e4a6c9
Create Date: 2026-11-03
"""
import sqlalchemy as sa
from alembic import op

revision = "a7c9e1b3d5f8"
down_revision = "f8b0d2e4a6c9"
branch_labels = None
depends_on = None


def _cols(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {c["name"] for c in inspector.get_columns(table)}


def upgrade() -> None:
    mr_cols = _cols("inv_material_request_items")
    if mr_cols and "requested_quantity" not in mr_cols:
        op.add_column("inv_material_request_items",
                      sa.Column("requested_quantity", sa.Numeric(16, 3), nullable=True))
        op.execute("UPDATE inv_material_request_items SET requested_quantity = quantity "
                   "WHERE requested_quantity IS NULL")

    pr_cols = _cols("pro_requisition_items")
    if pr_cols and "requested_quantity" not in pr_cols:
        op.add_column("pro_requisition_items",
                      sa.Column("requested_quantity", sa.Numeric(16, 3), nullable=True))
        # Submitted ones, and drafts drawn from material requests (their ceiling is
        # the MR's quantity, which is what the line was written with).
        op.execute(
            "UPDATE pro_requisition_items ri JOIN pro_requisitions r "
            "ON r.id = ri.requisition_id "
            "SET ri.requested_quantity = ri.quantity "
            "WHERE ri.requested_quantity IS NULL "
            "AND (r.status <> 'DRAFT' OR r.source_mr_id IS NOT NULL)")


def downgrade() -> None:
    if "requested_quantity" in _cols("pro_requisition_items"):
        op.drop_column("pro_requisition_items", "requested_quantity")
    if "requested_quantity" in _cols("inv_material_request_items"):
        op.drop_column("inv_material_request_items", "requested_quantity")
