"""Park the Approvals "Team Queue" menu row: the screen is gone.

Team Queue reported on other approvers' backlogs and could decide nothing, so it is
removed from the frontend along with its route, its catalogue row in
`scripts/seed.py` PAGE_TREE and its `approval_team` entry in `PAGE_VIEW_CODES`.

Dropping those catalogue entries keeps a NEW database clean but cannot clear an
existing one: `sync_pages` inserts and refreshes but never deletes. So the live row
is deactivated here rather than deleted -- `rbac_page_permissions` rows hang off it
and `is_active = 0` is how this schema parks a page (see `ind_ack`). The page CODE
and the `page.approval_team.view` permission are left alone: they are the identity
every existing grant hangs off.

Nothing on the backend changes. `GET /api/approvals/team-queue` and its
`/remind` sibling still answer -- the reporting-line read behind them is used
elsewhere in the approvals service -- only the screen is retired.

Revision ID: b3c4d5e6f7a8
Revises: a2b3c4d5e6f7
"""
from alembic import op
import sqlalchemy as sa

revision = "b3c4d5e6f7a8"
down_revision = "a2b3c4d5e6f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        sa.text("UPDATE rbac_pages SET is_active = 0 WHERE code = 'approval_team'")
    )


def downgrade() -> None:
    op.execute(
        sa.text("UPDATE rbac_pages SET is_active = 1 WHERE code = 'approval_team'")
    )
