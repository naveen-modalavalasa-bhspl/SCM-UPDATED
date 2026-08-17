"""Purchase order: project, terms, addresses and the valuation columns

Everything a printed purchase order says that the lines do not. All additive and all
nullable (or defaulted to 0), so an order raised before this migration reads exactly
as it did — a blank term simply prints nothing and the two money columns default to
zero, which leaves `total = sub_total + tax` untouched for every existing row.

  * `project_id` / `project_name` — what the spend is booked against, snapshotted like
    every other soft FK so renaming a project never rewrites an order.
  * `payment_terms`, `delivery_terms`, `material_terms`, `logistics_terms` — long text.
  * `billing_address`, `shipping_address` — long text; who is invoiced, where it lands.
  * `discount_amount`, `freight_amount` — document-level money. The order total becomes
    `sub_total - discount + tax + freight`.

Revision ID: f4a5b6c7d8e9
Revises: a9b8c7d6e5f4
"""
from alembic import op
import sqlalchemy as sa

revision = "f4a5b6c7d8e9"
down_revision = "a9b8c7d6e5f4"
branch_labels = None
depends_on = None

TABLE = "pro_purchase_orders"

COLUMNS = [
    ("project_id", sa.BigInteger(), True, None),
    ("project_name", sa.String(200), True, None),
    ("payment_terms", sa.Text(), True, None),
    ("delivery_terms", sa.Text(), True, None),
    ("material_terms", sa.Text(), True, None),
    ("logistics_terms", sa.Text(), True, None),
    ("billing_address", sa.Text(), True, None),
    ("shipping_address", sa.Text(), True, None),
    ("discount_amount", sa.Numeric(16, 2), False, "0"),
    ("freight_amount", sa.Numeric(16, 2), False, "0"),
]


def _columns() -> set[str]:
    """What the live table already has.

    The QA and production schemas were built by hand before Alembic caught up, so a
    column this migration adds may already be there. Checked rather than assumed — a
    duplicate ADD COLUMN stops the whole upgrade.
    """
    bind = op.get_bind()
    return {row[0] for row in bind.execute(sa.text(f"SHOW COLUMNS FROM `{TABLE}`"))}


def upgrade() -> None:
    have = _columns()
    for name, type_, nullable, default in COLUMNS:
        if name in have:
            continue
        op.add_column(TABLE, sa.Column(
            name, type_, nullable=nullable,
            server_default=sa.text(default) if default is not None else None,
        ))
    if "project_id" not in have:
        op.create_index(f"ix_{TABLE}_project_id", TABLE, ["project_id"])


def downgrade() -> None:
    have = _columns()
    if "project_id" in have:
        op.drop_index(f"ix_{TABLE}_project_id", table_name=TABLE)
    for name, *_ in COLUMNS:
        if name in have:
            op.drop_column(TABLE, name)
