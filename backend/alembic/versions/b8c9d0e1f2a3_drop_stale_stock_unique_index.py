"""Drop `uq_stk_bal`, the pre-project stock unique index.

Stock is keyed by five columns — item, warehouse, bin, batch and **project** — and
`uq_stk_balance_item_wh_bin_batch_proj` is what makes `move_stock()`'s locking upsert
safe. `uq_stk_bal` is the older four-column version of that same key, from before
project_id joined it. It was never created by a migration or by the ORM, so it exists
only on databases that predate the project split; a fresh schema has never had it.

Two projects storing the same item in the same bin is now ordinary, and the old index
forbids it: `move_stock()` looks for a row on all five columns, correctly finds none,
inserts, and the four-column index rejects the insert as a duplicate. It surfaced as a
500 on putaway confirm, but every caller of `move_stock()` — receipts, transfers,
issues — was standing on the same landmine.

Nothing is lost by dropping it: the five-column index is strictly stricter, and the
foreign keys on `warehouse_id` and `item_id` keep their own indexes (`ix_bal_wh`,
`ix_bal_item`), so MySQL does not need this one to enforce them.

Revision ID: b8c9d0e1f2a3
Revises: a5b6c7d8e9f0
"""
from alembic import op
import sqlalchemy as sa

revision = "b8c9d0e1f2a3"
down_revision = "a5b6c7d8e9f0"
branch_labels = None
depends_on = None

STALE_INDEX = "uq_stk_bal"
STOCK_KEY = "uq_stk_balance_item_wh_bin_batch_proj"


def _index_exists(conn, name: str) -> bool:
    return bool(conn.execute(sa.text(
        "SELECT 1 FROM information_schema.STATISTICS "
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stk_balance' "
        "AND INDEX_NAME = :name LIMIT 1"
    ), {"name": name}).scalar())


def upgrade() -> None:
    conn = op.get_bind()
    if not _index_exists(conn, STALE_INDEX):
        return          # a schema built from the migrations never had it

    # Only ever drop the old key while the real one is in place, so the table is never
    # left without uniqueness on the stock row.
    if not _index_exists(conn, STOCK_KEY):
        raise RuntimeError(
            f"{STOCK_KEY} is missing from stk_balance; refusing to drop {STALE_INDEX} "
            "and leave stock rows unconstrained."
        )
    op.drop_index(STALE_INDEX, table_name="stk_balance")


def downgrade() -> None:
    conn = op.get_bind()
    if _index_exists(conn, STALE_INDEX):
        return
    # Recreating it can fail where stock has since been split across projects — which
    # is the whole reason it went. That is the correct outcome: the data has outgrown
    # the constraint, and downgrading has to say so rather than discard rows.
    op.create_index(
        STALE_INDEX, "stk_balance",
        ["warehouse_id", "item_id", "bin_id", "batch_id"], unique=True,
    )
