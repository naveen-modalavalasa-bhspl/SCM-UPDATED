"""What an issue IS, rather than what it was for.

`out_issues.issue_type` held DEPARTMENT / PROJECT / VEHICLE / CONSUMPTION / SCRAP.
Those five describe the REASON for an issue, and the reason is already on the
document: a department, a project and a vehicle are columns of their own, and
consumption against scrap is a difference nothing downstream ever read.

The one thing about an issue that changes how it behaves is whether it serves a
request somebody raised or whether the store is moving stock on its own account —
`indent_id` set or not — so that is what the field says now: INDENT_BASED or DIRECT.

The backfill reads that same column rather than mapping the old words, because the
old words could never disagree with it: an issue drafted from an indent carried
whatever type the storekeeper happened to pick, and an issue with no indent was
routinely left on the DEPARTMENT default. `indent_id` is the fact.

Revision ID: a4d8f2c6b9e3
Revises: e8c4b6d2a7f1
Create Date: 2026-09-12
"""
from typing import Sequence, Union

from alembic import op

revision: str = "a4d8f2c6b9e3"
down_revision: Union[str, Sequence[str], None] = "e8c4b6d2a7f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "UPDATE out_issues SET issue_type = CASE "
        "WHEN indent_id IS NOT NULL THEN 'INDENT_BASED' ELSE 'DIRECT' END "
        "WHERE issue_type NOT IN ('INDENT_BASED', 'DIRECT') OR issue_type IS NULL"
    )


def downgrade() -> None:
    # The five it came from are not recoverable — the distinction they carried was
    # never written anywhere else — so the closest true statement is put back.
    op.execute(
        "UPDATE out_issues SET issue_type = 'DEPARTMENT' "
        "WHERE issue_type IN ('INDENT_BASED', 'DIRECT')"
    )
