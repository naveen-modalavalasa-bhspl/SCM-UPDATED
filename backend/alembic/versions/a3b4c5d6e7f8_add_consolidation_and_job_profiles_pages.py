"""Put Consolidation and Job Profiles on the menu.

Both screens are built, routed and working, and neither had an `rbac_pages` row —
so the only way in was to type the URL. Same gap the five warehouse screens had in
`d2e3f4a5b6c7`, and it is fixed the same way.

Job Profiles is the sharper one: the screen that hands out access was itself
unreachable from the rail.

No permission is invented. Each row reuses what its own endpoints already require,
so the screens appear immediately for whoever can already use them rather than
waiting on a new grant:

- Consolidation -> `indent.approve`, which is what GET /api/approvals/consolidation
  and POST /api/approvals/consolidation/approve both check. A viewer who cannot
  approve would open the screen to a 403.
- Job Profiles -> `admin.roles.manage`, the same permission Roles & Access carries.
  The two write the same grants; anything that can open one can open the other.

The Approvals children are re-stated at absolute sort orders rather than shifted, so
re-running lands on the same menu instead of walking the tail down each time.

Deliberately NOT added: Demand by Item, Adjustments and Valuation & Ageing. Those
three are parked on purpose (see the comments in scripts/seed.py PAGE_TREE) until
they are implemented properly, and `/reports` plus `/admin/approvals-config/custom`
are an index redirect and a detail editor, not menu entries.

Revision ID: a3b4c5d6e7f8
Revises: f2a3b4c5d6e7
"""
from alembic import op
import sqlalchemy as sa


revision = "a3b4c5d6e7f8"
down_revision = "f2a3b4c5d6e7"
branch_labels = None
depends_on = None


# code, path, name, icon, module, permission, sort order, parent code.
# Mirrors PAGE_TREE in scripts/seed.py — the two must agree or a reseed would
# silently reorder the live menu.
PAGES = (
    ("approval_consolidation", "/approvals/consolidation", "Consolidation", "boxes",
     "approvals", "indent.approve", 22, "approvals"),
    ("rbac_job_profiles", "/rbac/job-profiles", "Job Profiles", "users",
     "rbac", "admin.roles.manage", 83, "grp_rbac"),
)

# Making room for Consolidation at 22. Stated absolutely so a re-run is a no-op.
RESEQUENCED = (
    ("approval_decisions", 23),
    ("approval_team", 24),
)


def upgrade() -> None:
    connection = op.get_bind()

    upsert = sa.text("""
        INSERT INTO rbac_pages
            (code, path, name, icon, module, parent_id, sort_order,
             required_permission, show_on_mobile, is_active)
        VALUES
            (:code, :path, :name, :icon, :module, NULL, :sort_order,
             :permission, 1, 1)
        ON DUPLICATE KEY UPDATE
            path = VALUES(path),
            name = VALUES(name),
            icon = VALUES(icon),
            module = VALUES(module),
            sort_order = VALUES(sort_order),
            required_permission = VALUES(required_permission),
            is_active = 1
    """)
    for code, path, name, icon, module, permission, sort_order, _parent in PAGES:
        connection.execute(upsert, {
            "code": code, "path": path, "name": name, "icon": icon,
            "module": module, "permission": permission, "sort_order": sort_order,
        })

    # Parent resolved by code, never by an assumed id: the group rows carry different
    # ids on every database.
    attach = sa.text("""
        UPDATE rbac_pages AS child
        JOIN rbac_pages AS parent ON parent.code = :parent_code
        SET child.parent_id = parent.id
        WHERE child.code = :code
    """)
    for code, _path, _name, _icon, _module, _perm, _sort, parent_code in PAGES:
        connection.execute(attach, {"code": code, "parent_code": parent_code})

    reorder = sa.text(
        "UPDATE rbac_pages SET sort_order = :sort_order WHERE code = :code")
    for code, sort_order in RESEQUENCED:
        connection.execute(reorder, {"code": code, "sort_order": sort_order})


def downgrade() -> None:
    # Removing navigation on a rollback would hide screens people are mid-way through
    # using, and the rows may predate this migration.
    pass
