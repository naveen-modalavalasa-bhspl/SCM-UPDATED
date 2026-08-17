"""Merge the logistics consignment-flow head into the procurement/requisition head.

Both sides descend from ``d7e8f9a0b1c2``. The logistics work brought its own
mergepoint (``b2d3e4f5a6c7``, joining the consignment flow to the vendor-despatch
branch), but it was cut when the procurement branch still ended at
``f2a3b4c5d6e8`` — that branch has since grown two more revisions and now ends at
``c4d5e6f7a8b0``.

Left alone that is two heads, and ``alembic upgrade head`` refuses to run at all:
"Multiple head revisions are present". So a database carrying the logistics columns
could never receive the requisition ones, and vice versa. Joining them here keeps
both already-published histories intact and lets a single ``upgrade head`` apply
whichever side a given database is missing.

No schema change of its own — every column belongs to a parent revision.

Revision ID: a9b8c7d6e5f4
Revises: b2d3e4f5a6c7, c4d5e6f7a8b0
"""

revision = "a9b8c7d6e5f4"
down_revision = ("b2d3e4f5a6c7", "c4d5e6f7a8b0")
branch_labels = None
depends_on = None


def upgrade() -> None:
    """The parent migrations carry every schema change."""


def downgrade() -> None:
    """Splitting the graph back apart needs no schema change."""
