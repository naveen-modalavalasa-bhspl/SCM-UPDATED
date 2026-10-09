"""Make a monthly cycle a document instead of a GROUP BY.

"August 2026 — consolidated" was never stored. Every screen re-derived it from
`ind_indents.indent_date`, and each one asked a slightly different question of the same
month: the fulfilment queue counted indents still owed stock, the allocation approval
screen counted indents whose allocations were awaiting a signature. Both printed the
answer under the word "indents", so one row said 9 and the screen it opened said 43.

`ind_consolidations` gives the cycle an identity and a frozen membership. An indent
joins the OPEN consolidation for its month when its approval finishes, and the document
is SEALED when the storekeeper submits the allocation batch. Indents approved after
that open the next consolidation for the same month rather than joining work that has
already been decided.

Backfill: every existing MONTHLY indent past approval joins one SEALED consolidation
per month, which is how those months have been reading on screen all along. Drafts and
indents still in approval are left NULL — they have not reached the queue yet, and
`_join_consolidation` will place them when they do.

Revision ID: b3d5f7a9c1e2
Revises: a7d3e91c4b28
"""
import sqlalchemy as sa
from alembic import op

revision = "b3d5f7a9c1e2"
down_revision = "a7d3e91c4b28"
branch_labels = None
depends_on = None


#: Statuses that mean "approval is behind this indent". Mirrors
#: `indents.service._POST_APPROVAL_STATUSES` — anything earlier has not entered the
#: fulfilment queue, so it has no cycle to belong to yet.
_POST_APPROVAL = (
    "APPROVED", "AWAITING_ALLOCATION", "ALLOCATED", "PARTIALLY_FULFILLED",
    "PENDING_PROCUREMENT", "PARTIALLY_ORDERED", "ORDERED", "CLOSED",
)


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def _has_column(table: str, column: str) -> bool:
    inspector = sa.inspect(op.get_bind())
    return column in {row["name"] for row in inspector.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table("ind_consolidations"):
        op.create_table(
            "ind_consolidations",
            sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
            sa.Column("consolidation_no", sa.String(50), nullable=False, unique=True),
            sa.Column("cycle", sa.String(10), nullable=False),
            sa.Column("status", sa.String(20), nullable=False,
                      server_default="OPEN"),
            sa.Column("sealed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("sealed_by_id", sa.BigInteger(), nullable=True),
            sa.Column("sealed_by_name", sa.String(200), nullable=True),
            sa.Column("created_by_id", sa.BigInteger(), nullable=True),
            sa.Column("created_by_name", sa.String(200), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True,
                      server_default=sa.text("CURRENT_TIMESTAMP"),
                      onupdate=sa.text("CURRENT_TIMESTAMP")),
        )
        op.create_index("ix_ind_consolidations_cycle", "ind_consolidations", ["cycle"])
        op.create_index("ix_ind_consolidations_status", "ind_consolidations", ["status"])
        op.create_index("ix_ind_cons_cycle_status", "ind_consolidations",
                        ["cycle", "status"])

    if not _has_column("ind_indents", "consolidation_id"):
        op.add_column("ind_indents",
                      sa.Column("consolidation_id", sa.BigInteger(), nullable=True))
        op.create_index("ix_ind_indents_consolidation_id", "ind_indents",
                        ["consolidation_id"])
        op.create_foreign_key(
            "fk_ind_indents_consolidation", "ind_indents", "ind_consolidations",
            ["consolidation_id"], ["id"], ondelete="RESTRICT")

    # --- backfill: one sealed document per month that already has monthly indents ---
    # Only months with something to hold. A month whose monthly indents are all still
    # in approval gets its document from the application, when the first one lands.
    cycles = [row[0] for row in bind.execute(sa.text(
        """
        SELECT DISTINCT COALESCE(CONCAT(YEAR(indent_date), '-', LPAD(MONTH(indent_date), 2, '0')), 'UNDATED') AS cycle
        FROM ind_indents
        WHERE indent_type = 'MONTHLY'
          AND consolidation_id IS NULL
          AND status IN :statuses
        ORDER BY cycle
        """
    ).bindparams(sa.bindparam("statuses", expanding=True)), {"statuses": list(_POST_APPROVAL)})]

    if not cycles:
        return

    # Numbered from the live series if one is configured, so the backfilled documents
    # sit in the same sequence as everything created afterwards. `sys_doc_series` is
    # bumped by the same amount, or the next runtime document would reuse a number.
    series = bind.execute(sa.text(
        "SELECT id, prefix, fiscal_year, last_number FROM sys_doc_series "
        "WHERE doc_type = 'consolidation' AND is_active = 1 "
        "ORDER BY fiscal_year DESC LIMIT 1"
    )).fetchone()
    start = series[3] if series else 0
    prefix = series[1] if series else "CON"
    fiscal_year = series[2] if series else _fiscal_year_now(bind)

    for offset, cycle in enumerate(cycles, start=1):
        number = start + offset
        bind.execute(sa.text(
            """
            INSERT INTO ind_consolidations
                (consolidation_no, cycle, status, sealed_at, sealed_by_name,
                 created_by_name, created_at)
            VALUES (:no, :cycle, 'SEALED', CURRENT_TIMESTAMP, 'Migration',
                    'Migration', CURRENT_TIMESTAMP)
            """
        ), {"no": f"{prefix}/{fiscal_year}/{number:05d}", "cycle": cycle})
        bind.execute(sa.text(
            """
            UPDATE ind_indents SET consolidation_id = (
                SELECT id FROM ind_consolidations WHERE consolidation_no = :no
            )
            WHERE indent_type = 'MONTHLY'
              AND consolidation_id IS NULL
              AND status IN :statuses
              AND COALESCE(CONCAT(YEAR(indent_date), '-', LPAD(MONTH(indent_date), 2, '0')), 'UNDATED') = :cycle
            """
        ).bindparams(sa.bindparam("statuses", expanding=True)),
            {"no": f"{prefix}/{fiscal_year}/{number:05d}", "cycle": cycle,
             "statuses": list(_POST_APPROVAL)})

    # The series has to end up knowing about the numbers just spent, or the first
    # consolidation the application creates reuses one and dies on the unique index.
    # Creating the row rather than leaving it to `next_number`'s auto-create is the
    # whole point: auto-create starts at zero, which is exactly the collision.
    if series:
        bind.execute(sa.text(
            "UPDATE sys_doc_series SET last_number = :n WHERE id = :id"
        ), {"n": start + len(cycles), "id": series[0]})
    else:
        bind.execute(sa.text(
            """
            INSERT INTO sys_doc_series
                (doc_type, fiscal_year, prefix, pattern, last_number, is_active)
            VALUES ('consolidation', :fy, :prefix, '{PREFIX}/{FY}/{SEQ:5}', :n, 1)
            """
        ), {"fy": fiscal_year, "prefix": prefix, "n": len(cycles)})


def _fiscal_year_now(bind) -> str:
    """Indian FY label for today, matching `shared/numbering._fiscal_year`."""
    today = bind.execute(sa.text("SELECT CURDATE()")).scalar()
    start = today.year if today.month >= 4 else today.year - 1
    return f"{start}-{str(start + 1)[-2:]}"


def downgrade() -> None:
    if _has_column("ind_indents", "consolidation_id"):
        op.drop_constraint("fk_ind_indents_consolidation", "ind_indents",
                           type_="foreignkey")
        op.drop_index("ix_ind_indents_consolidation_id", table_name="ind_indents")
        op.drop_column("ind_indents", "consolidation_id")
    if _has_table("ind_consolidations"):
        op.drop_table("ind_consolidations")
