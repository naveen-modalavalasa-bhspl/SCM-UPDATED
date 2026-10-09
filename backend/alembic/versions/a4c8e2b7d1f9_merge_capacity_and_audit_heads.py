"""merge the capacity/PO-chat lineage with the audit-trail lineage

Two heads, and that is why nothing was upgrading. `fb6b1c0ef043` — the
`sys_audit_log` client-context columns that `write_audit` names on every
INSERT — sat on its own lineage while the warehouse capacity and PO chat
work grew a second one ending at `92c9c40ec9d7`. `alembic upgrade head`
refuses to move with more than one head, so BOTH sides stayed unapplied.

That is what the raw `CREATE TABLE pro_po_comments` in `main.py`'s lifespan
was working around. With a single head again the migrations run, so the
band-aid is gone and the table is created by `e9f0a1b2c3d4`, which is where
a table belongs.

No schema of its own.

Revision ID: a4c8e2b7d1f9
Revises: 92c9c40ec9d7, fb6b1c0ef043
Create Date: 2026-09-05
"""
from typing import Sequence, Union

revision: str = "a4c8e2b7d1f9"
down_revision: Union[str, Sequence[str], None] = ("92c9c40ec9d7", "fb6b1c0ef043")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
