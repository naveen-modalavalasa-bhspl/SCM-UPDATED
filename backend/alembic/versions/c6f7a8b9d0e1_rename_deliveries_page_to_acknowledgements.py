"""One Acknowledgements menu row, pointing at the screen that exists.

Two things were wrong in `rbac_pages`, and together they put a dead link on the
left rail.

1. `ind_deliveries` ("My Deliveries", `/indents/deliveries`) is the acknowledgement
   screen -- it is titled "Acknowledgements" and every button on it says
   "Acknowledge". Its route is now `/indents/acknowledgements`, so the row has to
   follow or the rail links at a 404.

2. `ind_ack` ("Acknowledgments", `/indents/acknowledgments`) duplicated it. That
   page and its route were deleted, but the row stayed active, so the rail still
   advertised it and clicking it rendered "No screen at this address". It is
   deactivated here rather than deleted: `rbac_page_permissions` rows hang off it,
   and `is_active = 0` is how this schema parks a page (see `ind_board`).

Targeted UPDATEs rather than a reseed -- seed.py prunes and rewrites real data.

The page CODE stays `ind_deliveries`. It is the identity every
`rbac_page_permissions` grant and every `page.ind_deliveries` permission hangs off;
renaming it would silently drop the screen off every job profile that has it.

Revision ID: c6f7a8b9d0e1
Revises: c5e6f7a8b9d0
"""
from alembic import op
import sqlalchemy as sa

revision = "c6f7a8b9d0e1"
down_revision = "c5e6f7a8b9d0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE rbac_pages SET path = '/indents/acknowledgements', "
            "name = 'Acknowledgements' "
            "WHERE code = 'ind_deliveries' AND path = '/indents/deliveries'"
        )
    )
    op.execute(
        sa.text("UPDATE rbac_pages SET is_active = 0 WHERE code = 'ind_ack'")
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE rbac_pages SET path = '/indents/deliveries', "
            "name = 'My Deliveries' "
            "WHERE code = 'ind_deliveries' AND path = '/indents/acknowledgements'"
        )
    )
    op.execute(
        sa.text("UPDATE rbac_pages SET is_active = 1 WHERE code = 'ind_ack'")
    )
