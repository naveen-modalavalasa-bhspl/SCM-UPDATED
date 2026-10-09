"""Park the Logistics "Acknowledgements" menu row: the screen is gone.

Signing for what arrived is the INDENT RAISER's act — they asked for the material, so
they are the only person who can say what turned up — and that screen lives under
Indents. The logistics route already redirects there, and a claim the signature raises
stays on the shipment timeline, which Shipment Tracking draws. Only the second desk
reading it is gone.

The row was dropped from `page_registry.PAGES` when the screen was removed, which keeps
a NEW database clean but cannot clear an existing one: `sync_pages` inserts and
refreshes but never deletes, and never forces `is_active` either way, precisely so an
admin who retired a screen does not get it back on the next restart. So the live row is
deactivated here rather than deleted -- `rbac_page_permissions` rows hang off it and
`is_active = 0` is how this schema parks a page (see `approval_team`, `ind_ack`).

The page CODE and the `page.logistics_acknowledgements.view` permission are left alone:
they are the identity every existing grant hangs off, and dropping them would silently
revoke whatever a job profile already holds.

`logistics_exceptions` is deliberately NOT touched. Its tab still lands somewhere real
and the desk works claims from it.

Revision ID: c4d5e6f7a8b1
Revises: b3c4d5e6f7a8
"""
from alembic import op
import sqlalchemy as sa

revision = "c4d5e6f7a8b1"
down_revision = "b3c4d5e6f7a8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(sa.text(
        "UPDATE rbac_pages SET is_active = 0 "
        "WHERE code = 'logistics_acknowledgements'"
    ))


def downgrade() -> None:
    op.execute(sa.text(
        "UPDATE rbac_pages SET is_active = 1 "
        "WHERE code = 'logistics_acknowledgements'"
    ))
