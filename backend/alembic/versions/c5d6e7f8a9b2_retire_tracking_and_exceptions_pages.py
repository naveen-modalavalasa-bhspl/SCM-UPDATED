"""Park the Logistics "Shipment Tracking" and "Exceptions" menu rows.

Both are replaced by one screen, Activity Ledger (`/logistics/activity`), which is
where the events they each drew a slice of actually live. Tracking answered "where is
it now" and Exceptions answered "what went wrong"; neither said who awarded the job,
at what price, or when the carrier agreed to it, so a desk chasing a consignment read
half the story on one tab and half on another. The ledger unions the request header,
`wf_actions`, `lgs_carrier_quotes` and `lgs_shipment_events`, so it carries both of
those tabs and the rest of the trail besides.

The rows were dropped from `page_registry.PAGES` when the screens were removed, which
keeps a NEW database clean but cannot clear an existing one: `sync_pages` inserts and
refreshes but never deletes, and never forces `is_active` either way, precisely so an
admin who retired a screen does not get it back on the next restart. So the live rows
are deactivated here rather than deleted -- `rbac_page_permissions` rows hang off them
and `is_active = 0` is how this schema parks a page (see `approval_team`, `ind_ack`,
`logistics_acknowledgements`).

The page CODES and their `page.*.view` permissions are left alone: they are the
identity every existing grant hangs off, and `page.logistics_activity.view` INHERITS
its grants from `page.logistics_tracking.view` on first sync (perms.INHERITS_GRANTS_FROM),
so the desk that worked the tracking board opens the ledger without an admin ticking
anything. Dropping the source permission would break exactly that.

The new page row itself is not inserted here. `sync_pages` adds it on the next start
from the catalogue, which is the one place that decides a screen's parent and order.

Revision ID: c5d6e7f8a9b2
Revises: c4d5e6f7a8b1
"""
from alembic import op
import sqlalchemy as sa

revision = "c5d6e7f8a9b2"
down_revision = "c4d5e6f7a8b1"
branch_labels = None
depends_on = None

PAGES = ("logistics_tracking", "logistics_exceptions")


def upgrade() -> None:
    op.execute(sa.text(
        "UPDATE rbac_pages SET is_active = 0 WHERE code IN :codes"
    ).bindparams(sa.bindparam("codes", value=PAGES, expanding=True)))


def downgrade() -> None:
    op.execute(sa.text(
        "UPDATE rbac_pages SET is_active = 1 WHERE code IN :codes"
    ).bindparams(sa.bindparam("codes", value=PAGES, expanding=True)))
