"""Put the company and the project into every document number.

Asked for so a number says on sight where the paper came from:

    BHS/MED/2026-27/IND0007
    ^^^ ^^^ ^^^^^^^ ^^^^^^^
    |   |   |       document type + running number
    |   |   financial year
    |   project (3 letters)
    company (3 letters)

NO CODE CHANGE WAS NEEDED for the shape itself — `shared/numbering` has understood
{COMPANY} and {PROJECT} since they were added, including a separate running number per
company/project (`scope_key`). This migration is the configuration that turns them on.

THREE LETTERS, not twelve. `slug`'s default limit is 12, and a real pair of names
renders `TIRUMALACONS/MEDAKPHASETW/2026-27/IND0007` — 41 characters into document-number
columns whose narrowest is String(30). `numbering.SCOPE_SLUG_LEN` pins the two scope
tokens to 3, which keeps the longest possible number at 23.

WHAT THIS DOES NOT DO: renumber anything. Existing documents keep the number they were
created with — stock rows, ledger rows and every document that points backward at
another all carry it as a string — so the two formats coexist and the old one simply
stops being issued. The new format cannot collide with the old: every new number starts
with a company segment that no old number has.

Each company/project also starts its own sequence at 1, which is the point of scoping
it. `lot` is left alone: its pattern already carries {WH}/{PATH} and localises itself.

Revision ID: c3d4e5f6a7b9
Revises: b2d3e4f5a6c8
Create Date: 2026-08-21
"""
from alembic import op
import sqlalchemy as sa

revision = "c3d4e5f6a7b9"
down_revision = "b2d3e4f5a6c8"
branch_labels = None
depends_on = None

NEW_PATTERN = "{COMPANY}/{PROJECT}/{FY}/{PREFIX}{SEQ:4}"
OLD_PATTERN = "{PREFIX}/{FY}/{SEQ:5}"


def upgrade() -> None:
    # Only the rows still on the plain default. A series an admin has already
    # customised is their decision and is left exactly as it is.
    op.execute(sa.text(
        "UPDATE sys_doc_series SET pattern = :new WHERE pattern = :old"
    ).bindparams(new=NEW_PATTERN, old=OLD_PATTERN))

    # FIXED alongside — STOCK_MOVEMENT fell through the three-letter prefix fallback
    # (`STOCK_MOVEMENT`[:3]) and came out as "STO", which is what this system calls a
    # Stock TRANSFER Order: a different table, a different screen, a different
    # document. Every movement and every movement ORDER was numbered as if it were an
    # inter-warehouse transfer.
    op.execute(sa.text(
        "UPDATE sys_doc_series SET prefix = 'SMV' "
        "WHERE doc_type = 'STOCK_MOVEMENT' AND prefix = 'STO'"
    ))


def downgrade() -> None:
    op.execute(sa.text(
        "UPDATE sys_doc_series SET pattern = :old WHERE pattern = :new"
    ).bindparams(new=NEW_PATTERN, old=OLD_PATTERN))
    op.execute(sa.text(
        "UPDATE sys_doc_series SET prefix = 'STO' "
        "WHERE doc_type = 'STOCK_MOVEMENT' AND prefix = 'SMV'"
    ))
