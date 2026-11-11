"""default_unbatched_stock

Revision ID: da110162fdb7
Revises: fb5af1a673a8
Create Date: 2026-11-11 15:12:39.263330
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'da110162fdb7'
down_revision: Union[str, None] = 'fb5af1a673a8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    # Find all items with unbatched stock held
    unbatched = conn.execute(sa.text("""
        SELECT sb.item_id, mi.code, mi.name, SUM(sb.total_qty) AS qty
        FROM stk_balance sb
        JOIN mst_items mi ON mi.id = sb.item_id
        WHERE (sb.batch_id = 0 OR sb.batch_id IS NULL) AND sb.total_qty > 0
        GROUP BY sb.item_id, mi.code, mi.name
    """)).fetchall()

    for item_id, code, name, qty in unbatched:
        # Check if an 'Unbatched' batch already exists for this item
        existing = conn.execute(sa.text(
            "SELECT id FROM stk_batches WHERE item_id = :item_id AND batch_no = 'Unbatched'"
        ), {"item_id": item_id}).scalar()

        if existing:
            batch_id = existing
        else:
            conn.execute(sa.text("""
                INSERT INTO stk_batches (
                    item_id, item_code, item_name, batch_no, status, initial_qty, created_at
                ) VALUES (
                    :item_id, :code, :name, 'Unbatched', 'ACTIVE', :qty, NOW()
                )
            """), {"item_id": item_id, "code": code, "name": name, "qty": qty or 0})
            batch_id = conn.execute(sa.text("SELECT LAST_INSERT_ID()")).scalar()

        # Update balance rows
        conn.execute(sa.text("""
            UPDATE stk_balance
            SET batch_id = :batch_id, batch_no = 'Unbatched'
            WHERE item_id = :item_id AND (batch_id = 0 OR batch_id IS NULL)
        """), {"batch_id": batch_id, "item_id": item_id})

        # Update serial numbers
        conn.execute(sa.text("""
            UPDATE whs_serial_numbers
            SET batch_id = :batch_id
            WHERE item_id = :item_id AND (batch_id IS NULL OR batch_id = 0)
        """), {"batch_id": batch_id, "item_id": item_id})


def downgrade() -> None:
    pass
