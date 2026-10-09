"""Region/Location on an indent, snapshotted from the requester's HCM location.

HCM tags every employee to a location on `hcm_employees.office_id` (the `office` object
on the /employees feed, which also carries the geo_location block). That tag is the
grouping source for monthly indents, so the indent snapshots it at create time the same
way it already snapshots department and project.

Deliberately NOT `ind_indents.office_id`, which is already present: that column resolves
through the position/assignment chain and answers "which office does this role sit in".
The two disagree on 5 of the 296 live indents, so reusing it would silently group a
handful of requests under the wrong location. No `mst_regions` master either — HCM's
office already is the region, and a second copy would only drift.

Additive and nullable. Existing indents stay valid with a NULL region, and the backfill
below fills in every row whose raiser HCM still has a location for.

Re-parented onto e6f7a8b9c0d1 when the branch it was written on (saiteja/indent) was
reconciled with qa: both revisions were authored against d5e6f7a8b9c0, which left two
heads and a live `alembic_version` pointing at a revision no longer in the tree. The
chain is linear again; every step here is guarded, so it is a no-op on a database that
already carries the columns.

Revision ID: a6b7c8d9e0f1
Revises: e6f7a8b9c0d1
Create Date: 2026-08-06
"""
import sqlalchemy as sa
from alembic import op

revision = "a6b7c8d9e0f1"
down_revision = "e6f7a8b9c0d1"
branch_labels = None
depends_on = None

TABLE = "ind_indents"
INDEX = "ix_ind_region_status"


def _columns(bind) -> set[str]:
    return {c["name"] for c in sa.inspect(bind).get_columns(TABLE)}


def _indexes(bind) -> set[str]:
    return {i["name"] for i in sa.inspect(bind).get_indexes(TABLE)}


def upgrade() -> None:
    bind = op.get_bind()
    existing = _columns(bind)

    if "region_id" not in existing:
        op.add_column(TABLE, sa.Column("region_id", sa.BigInteger(), nullable=True))
        op.create_index(f"ix_{TABLE}_region_id", TABLE, ["region_id"])
    if "region_name" not in existing:
        op.add_column(TABLE, sa.Column("region_name", sa.String(length=200), nullable=True))
    if INDEX not in _indexes(bind):
        op.create_index(INDEX, TABLE, ["region_id", "status"])

    # Backfill. `created_by_id` is the documented raiser, but it is NULL on all 296
    # live indents (it was added after they were raised), so it falls back to
    # `requested_by_id` — the same person by construction: create_indent() writes
    # user.id to both. Only rows the employee mirror can still resolve are touched;
    # anything else is left NULL rather than guessed at.
    op.execute(sa.text(f"""
        UPDATE {TABLE} i
        JOIN hcm_employees e
          ON e.id = COALESCE(i.created_by_id, i.requested_by_id)
        JOIN hcm_offices o
          ON o.id = e.office_id
         SET i.region_id = e.office_id,
             i.region_name = o.name
       WHERE i.region_id IS NULL
         AND e.office_id IS NOT NULL
    """))


def downgrade() -> None:
    bind = op.get_bind()
    if INDEX in _indexes(bind):
        op.drop_index(INDEX, table_name=TABLE)
    existing = _columns(bind)
    if "region_name" in existing:
        op.drop_column(TABLE, "region_name")
    if "region_id" in existing:
        if f"ix_{TABLE}_region_id" in _indexes(bind):
            op.drop_index(f"ix_{TABLE}_region_id", table_name=TABLE)
        op.drop_column(TABLE, "region_id")
