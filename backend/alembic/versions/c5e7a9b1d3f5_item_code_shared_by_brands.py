"""`mst_items.code` is no longer unique: brand variants share one code (2026-10-06).

070001-001 is the 300 Ltr Refrigerator whether Elanpro or Western makes it. The unique
index on `code` is swapped for a plain one, and existing variants of one category +
general name (101010-001 style codes only) are folded onto the first item's code.
Idempotent.

Revision ID: c5e7a9b1d3f5
Revises: b4d6f8a0c2e4
Create Date: 2026-10-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c5e7a9b1d3f5"
down_revision: Union[str, Sequence[str], None] = "b4d6f8a0c2e4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "mst_items"
PLAIN = "ix_mst_items_code"


def _code_indexes():
    insp = sa.inspect(op.get_bind())
    unique = [u["name"] for u in insp.get_unique_constraints(TABLE)
              if u["column_names"] == ["code"]]
    unique += [i["name"] for i in insp.get_indexes(TABLE)
               if i["column_names"] == ["code"] and i.get("unique")]
    plain = [i["name"] for i in insp.get_indexes(TABLE)
             if i["column_names"] == ["code"] and not i.get("unique")]
    return set(unique), plain


def upgrade() -> None:
    unique, plain = _code_indexes()
    if not plain:
        op.create_index(PLAIN, TABLE, ["code"])
    for name in unique:
        op.drop_index(name, table_name=TABLE)
    # Fold brand variants onto the first code of their category + general name.
    op.execute(sa.text("""
        UPDATE mst_items i
        JOIN (SELECT category_id, general_name_id, MIN(id) AS first_id
              FROM mst_items
              WHERE code REGEXP '^[0-9]{6}-[0-9]{3}$' AND general_name_id IS NOT NULL
              GROUP BY category_id, general_name_id) g
          ON g.category_id = i.category_id AND g.general_name_id = i.general_name_id
        JOIN mst_items f ON f.id = g.first_id
        SET i.code = f.code, i.serial_no = f.serial_no
        WHERE i.code REGEXP '^[0-9]{6}-[0-9]{3}$' AND i.id <> f.id
    """))


def downgrade() -> None:
    unique, plain = _code_indexes()
    if not unique:
        op.create_index("code", TABLE, ["code"], unique=True)
    for name in plain:
        op.drop_index(name, table_name=TABLE)
