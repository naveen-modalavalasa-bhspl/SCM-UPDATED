"""Rename every module's "Overview" menu row to "Dashboard".

Business request (2026-09-21): each module's first child is the module's
dashboard, and the word on the rail should say so. Only the NAME moves.

The page codes are untouched on purpose -- a code is an identity, and every
`page.<code>.view` grant already issued hangs off it. `required_permission`,
`path`, `parent_id` and `sort_order` are left exactly as they are, so no
approval ladder, job profile or deep link changes.

`page_registry.sync_pages` renames the four rows it catalogues on the next
start (approval_overview, pro_overview, logistics_overview, returns_overview).
The other three -- ind_dashboard, inv_overview, wh_dashboard -- are seed.py
PAGE_TREE rows that sync does not manage and nobody reseeds a live database,
which is what this migration is for.

Guarded on the current name, so an already-renamed row is left alone and a row
an admin has renamed to something of their own is never overwritten.

Revision ID: e1f3a5c7b9d2
Revises: d8a4f2c6e1b9
"""
from alembic import op
import sqlalchemy as sa

revision = "e1f3a5c7b9d2"
down_revision = "d8a4f2c6e1b9"
branch_labels = None
depends_on = None

CODES = (
    "ind_dashboard",
    "approval_overview",
    "pro_overview",
    "inv_overview",
    "wh_dashboard",
    "logistics_overview",
    "returns_overview",
)


def _rename(frm: str, to: str) -> None:
    op.execute(
        sa.text(
            "UPDATE rbac_pages SET name = :to WHERE code IN :codes AND name = :frm"
        ).bindparams(sa.bindparam("codes", value=CODES, expanding=True), to=to, frm=frm)
    )


def upgrade() -> None:
    _rename("Overview", "Dashboard")


def downgrade() -> None:
    _rename("Dashboard", "Overview")
