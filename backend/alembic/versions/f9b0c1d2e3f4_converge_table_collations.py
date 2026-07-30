"""Converge every table on one collation.

The live schema drifted: the tables the DB team created are utf8mb4_unicode_ci,
everything created since inherited the server default utf8mb4_0900_ai_ci. Any
string comparison across that line raises 1267, and a UNION across it raises
1271 -- which is what broke GET /api/indents/activity, whose ledger unions
ind_indents/wf_actions against inv_allocations/inv_material_requests.

Earlier migrations worked around it per-statement with an inline
COLLATE utf8mb4_general_ci on both sides. This converges the schema instead, so
new cross-module queries do not have to know about it.

Revision ID: f9b0c1d2e3f4
Revises: f8a9b0c1d2e3
"""
from alembic import op

revision = "f9b0c1d2e3f4"
down_revision = "f8a9b0c1d2e3"
branch_labels = None
depends_on = None

TARGET = "utf8mb4_unicode_ci"


def _converge(collation: str) -> None:
    conn = op.get_bind()
    schema = conn.exec_driver_sql("SELECT DATABASE()").scalar()
    drifted = [
        row[0]
        for row in conn.exec_driver_sql(
            "SELECT TABLE_NAME FROM information_schema.TABLES "
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' "
            f"AND TABLE_COLLATION <> '{collation}'"
        )
    ]
    # ponytail: FK checks off for the batch -- a string FK column and its parent
    # must not be mid-conversion at different collations. Restored below.
    conn.exec_driver_sql("SET FOREIGN_KEY_CHECKS = 0")
    try:
        for table in drifted:
            conn.exec_driver_sql(
                f"ALTER TABLE `{table}` CONVERT TO CHARACTER SET utf8mb4 "
                f"COLLATE {collation}"
            )
    finally:
        conn.exec_driver_sql("SET FOREIGN_KEY_CHECKS = 1")
    # Without this, the next table Alembic creates drifts straight back.
    conn.exec_driver_sql(
        f"ALTER DATABASE `{schema}` CHARACTER SET utf8mb4 COLLATE {collation}"
    )


def upgrade() -> None:
    _converge(TARGET)


def downgrade() -> None:
    # The pre-drift state was a mix; there is nothing coherent to restore.
    pass
