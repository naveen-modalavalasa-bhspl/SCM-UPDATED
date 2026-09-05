"""stk_ledger: index created_at on its own, so the ledger's own sort is index-served

The stock ledger screen returned 500 on every load. `list_movements` ordered by
`created_at DESC` with no item filter, and the only index carrying `created_at` is
`ix_stk_ledger_item_created`, which is led by `item_id` — useless to a query that
names no item. So MySQL filesorted, and `stk_ledger.serial_numbers` is a JSON column
whose MAXIMUM width is what MySQL uses to size a sort record, so a single record
exceeded the default 256 KB `sort_buffer_size` and the server raised 1038, "Out of
sort memory". The table held 333 rows at the time: this is not a volume problem and
it does not get better or worse as the ledger grows.

The query was also changed to order by the primary key, which is unique (`created_at`
is not — a posting writes its whole batch in one transaction, and ties left the order
undefined between pages). That fix is correct but it only holds while every future
caller remembers it. This index is the durable half: with `created_at` indexed on its
own, sorting on it is an index scan and 1038 cannot happen here again.

Revision ID: 92c9c40ec9d7
Revises: c7b8a9d0e1f2
Create Date: 2026-09-03
"""
from alembic import op
import sqlalchemy as sa

revision = "92c9c40ec9d7"
down_revision = "c7b8a9d0e1f2"
branch_labels = None
depends_on = None

INDEX = "ix_stk_ledger_created"
TABLE = "stk_ledger"


def _has_index(bind) -> bool:
    return INDEX in {row["name"] for row in sa.inspect(bind).get_indexes(TABLE)}


def upgrade() -> None:
    # Guarded because the index is also created directly on databases that were hit
    # by the outage before this migration existed; re-creating it is error 1061.
    bind = op.get_bind()
    if not _has_index(bind):
        op.create_index(INDEX, TABLE, ["created_at"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    if _has_index(bind):
        op.drop_index(INDEX, table_name=TABLE)
