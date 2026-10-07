"""`stk_project_holds` — a lot set aside for one project (Stock Segregation > Project
Lots, 2026-10-06). Idempotent: built from the model, so bootstrap and this agree.

Revision ID: f8b0d2e4a6c8
Revises: e7a9c1d3f5b7
Create Date: 2026-10-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f8b0d2e4a6c8"
down_revision: Union[str, Sequence[str], None] = "e7a9c1d3f5b7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "stk_project_holds"


def upgrade() -> None:
    if TABLE in sa.inspect(op.get_bind()).get_table_names():
        return
    from app.modules.inventory.models import ProjectHold
    ProjectHold.__table__.create(op.get_bind(), checkfirst=True)


def downgrade() -> None:
    if TABLE in sa.inspect(op.get_bind()).get_table_names():
        op.drop_table(TABLE)
