"""Storage types become a master, and a kind knows what it may sit inside

The kinds of storage location — floor, lane, rack, shelf, bin, cold room — were an
enum in three places at once: `shared.enums.BinType`, a `STORAGE_TYPES` tuple the write
schema validated against, and a hardcoded array in the location form. They never fully
agreed. The live data has always carried STAGING locations, which the write schema
rejected, so those rows could be read and never saved from the form that owns them; and
the shape of the building ("a bin goes on a shelf or a rack") lived only in a
`defaultChildType` ladder in the browser that guessed a child's kind and constrained
nothing, so a floor could be filed under a bin and nothing said a word.

This turns them into rows:

* `whs_warehouse_storage_types` gains `sort_order`, `is_pickable`,
  `is_temperature_controlled` and `allow_top_level`. Pickability was the `BIN_TYPES`
  tuple; cold chain was the browser asking whether the code contained "COLD".
* `whs_storage_type_parents` is new: which kinds a kind may sit inside.
* Both are seeded with the ladder this system has always described (flow doc section 1),
  plus a row for every storage type the DATA already uses that the ladder does not name
  — a location whose kind has no master row would drop out of its own form.
* `whs_warehouse_locations.storage_type_id` is backfilled from the code. That column
  held a refrigeration type before this and is empty on every database we have; a
  non-NULL one is left exactly as it is rather than being overwritten on a guess.

The seed below is a SNAPSHOT, deliberately duplicated from
`app/modules/warehouse/storage_types.DEFAULTS` rather than imported: no migration in
this tree imports application code, because a migration has to keep working against the
code as it was the day it ran. `ensure_defaults` is the living copy — it fills in what
is missing and never corrects what an admin has edited.

This sits on top of `a4c8e2b7d1f9`, which is where the two heads (`92c9c40ec9d7` and
`fb6b1c0ef043`) are joined — `alembic upgrade head` refuses to move at all with more
than one, which is exactly how the audit-trail columns on the second head went
unapplied and 500'd two screens. This migration merged them itself until qa landed
`a4c8e2b7d1f9` doing the same join; two independent merges of the same pair are two
heads again, so it chains after that one instead.

Revision ID: c1a7d3f9b2e5
Revises: a4c8e2b7d1f9
Create Date: 2026-09-05
"""
from alembic import op
import sqlalchemy as sa

revision = "c1a7d3f9b2e5"
down_revision = "a4c8e2b7d1f9"
branch_labels = None
depends_on = None

TYPES = "whs_warehouse_storage_types"
PARENTS = "whs_storage_type_parents"
LOCATIONS = "whs_warehouse_locations"

# code, name, description, sort order, pickable, cold, may stand at the top, parents
SEED = (
    ("BLOCK", "Block", "A building or a whole shed on the site.",
     10, 0, 0, 1, ()),
    ("FLOOR", "Floor", "One level of a block.",
     20, 0, 0, 1, ("BLOCK",)),
    ("ZONE", "Zone", "A named area of a floor - fast movers, bonded, returns.",
     25, 0, 0, 1, ("BLOCK", "FLOOR")),
    ("STAGING", "Staging area", "Where goods stand between the gate and their bay.",
     26, 0, 0, 1, ("BLOCK", "FLOOR", "ZONE")),
    ("LANE", "Lane / aisle", "A run of racking you walk down.",
     30, 0, 0, 0, ("BLOCK", "FLOOR", "ZONE")),
    ("COLD_ROOM", "Cold room",
     "A temperature-controlled room, racked inside like any other.",
     35, 0, 1, 1, ("BLOCK", "FLOOR", "ZONE")),
    ("RACK", "Rack", "One bay of racking, shelved or not.",
     40, 0, 0, 0, ("LANE", "ZONE", "FLOOR", "COLD_ROOM")),
    ("REFRIGERATOR", "Refrigerator", "A standing chiller or freezer unit.",
     45, 0, 1, 0, ("COLD_ROOM", "FLOOR", "ZONE", "LANE")),
    ("SHELF", "Shelf", "One level of a rack.",
     50, 0, 0, 0, ("RACK",)),
    ("PALLET", "Pallet position",
     "A marked pallet footprint on the floor or in a rack.",
     55, 1, 0, 0, ("LANE", "ZONE", "FLOOR", "RACK")),
    ("BIN", "Storage bin", "Where stock is counted and picked from.",
     60, 1, 0, 0, ("SHELF", "RACK", "LANE", "ZONE", "FLOOR")),
    ("COLD_STORAGE_BIN", "Cold storage bin",
     "A bin inside a chiller, freezer or cold room.",
     65, 1, 1, 0, ("REFRIGERATOR", "COLD_ROOM", "SHELF", "RACK")),
    ("LOT", "Lot", "A marked-off part of a bay holding one lot.",
     70, 1, 0, 0, ("BIN", "SHELF", "RACK", "ZONE", "FLOOR")),
    ("STORAGE", "General storage", "Somewhere stock is kept that is none of the above.",
     80, 1, 0, 1, ("BLOCK", "FLOOR", "ZONE", "LANE", "RACK", "SHELF")),
)


def _columns(bind, table) -> dict:
    return {c["name"]: c for c in sa.inspect(bind).get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if TYPES not in tables:
        # Only on a database that predates the DB team's table. `create_all` builds it
        # from the model everywhere else.
        op.create_table(
            TYPES,
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("code", sa.String(50), nullable=False),
            sa.Column("name", sa.String(50), nullable=False),
            sa.Column("description", sa.String(200), nullable=True),
            sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
            sa.Column("is_pickable", sa.Boolean, nullable=False, server_default="0"),
            sa.Column("is_temperature_controlled", sa.Boolean, nullable=False,
                      server_default="0"),
            sa.Column("allow_top_level", sa.Boolean, nullable=False, server_default="0"),
            sa.Column("is_active", sa.Boolean, nullable=False, server_default="1"),
        )
    else:
        held = _columns(bind, TYPES)
        for name, column in (
            ("sort_order", sa.Column("sort_order", sa.Integer, nullable=False,
                                     server_default="0")),
            ("is_pickable", sa.Column("is_pickable", sa.Boolean, nullable=False,
                                      server_default="0")),
            ("is_temperature_controlled",
             sa.Column("is_temperature_controlled", sa.Boolean, nullable=False,
                       server_default="0")),
            ("allow_top_level", sa.Column("allow_top_level", sa.Boolean, nullable=False,
                                          server_default="0")),
        ):
            if name not in held:
                op.add_column(TYPES, column)

    if PARENTS not in tables:
        op.create_table(
            PARENTS,
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("storage_type_id", sa.BigInteger, nullable=False),
            sa.Column("parent_storage_type_id", sa.BigInteger, nullable=False),
        )
        op.create_index("ix_whs_storage_type_parents_storage_type_id", PARENTS,
                        ["storage_type_id"])
        op.create_index("ix_whs_storage_type_parents_parent_storage_type_id", PARENTS,
                        ["parent_storage_type_id"])
        op.create_index("uq_whs_storage_type_parent", PARENTS,
                        ["storage_type_id", "parent_storage_type_id"], unique=True)

    # `storage_type` is an ENUM on some deployments, which is what made a kind the
    # database had not been told about a truncation error rather than a validation one.
    # The kinds are rows now, so the column carries whatever code the master holds.
    kind = _columns(bind, LOCATIONS).get("storage_type")
    if kind is not None and not isinstance(kind["type"], sa.String):
        op.execute(f"ALTER TABLE {LOCATIONS} MODIFY storage_type VARCHAR(50) NULL")

    _seed(bind)


def _seed(bind) -> None:
    ids = {
        (code or "").upper(): int(row_id)
        for row_id, code in bind.execute(sa.text(f"SELECT id, code FROM {TYPES}")).all()
    }

    for code, name, description, order, pickable, cold, top, _parents in SEED:
        if code in ids:
            continue
        bind.execute(sa.text(
            f"INSERT INTO {TYPES} (code, name, description, sort_order, is_pickable, "
            f"is_temperature_controlled, allow_top_level, is_active) VALUES "
            f"(:code, :name, :description, :order, :pickable, :cold, :top, 1)"
        ), {"code": code, "name": name, "description": description, "order": order,
            "pickable": pickable, "cold": cold, "top": top})
        ids[code] = int(bind.execute(sa.text("SELECT LAST_INSERT_ID()")).scalar())

    # Every kind the DATA already uses that the ladder above does not name. Without
    # this a location typed LINE on some other deployment would have no master row, so
    # its own form could not offer its own kind back to it.
    found = bind.execute(sa.text(
        f"SELECT DISTINCT UPPER(storage_type) FROM {LOCATIONS} "
        f"WHERE storage_type IS NOT NULL AND storage_type <> ''")).scalars().all()
    for code in found:
        if code in ids:
            continue
        bind.execute(sa.text(
            f"INSERT INTO {TYPES} (code, name, description, sort_order, is_pickable, "
            f"is_temperature_controlled, allow_top_level, is_active) VALUES "
            f"(:code, :name, :description, 90, 0, 0, 1, 1)"
        ), {"code": code, "name": code.replace("_", " ").title()[:50],
            "description": "Found on locations already in this warehouse."})
        ids[code] = int(bind.execute(sa.text("SELECT LAST_INSERT_ID()")).scalar())

    held = {
        (int(a), int(b)) for a, b in bind.execute(sa.text(
            f"SELECT storage_type_id, parent_storage_type_id FROM {PARENTS}")).all()
    }
    for code, _n, _d, _o, _p, _c, _t, parents in SEED:
        child = ids.get(code)
        for parent_code in parents:
            parent = ids.get(parent_code)
            if child is None or parent is None or (child, parent) in held:
                continue
            bind.execute(sa.text(
                f"INSERT INTO {PARENTS} (storage_type_id, parent_storage_type_id) "
                f"VALUES (:child, :parent)"), {"child": child, "parent": parent})
            held.add((child, parent))

    # Point every location at its kind. Only where nothing is set: that column used to
    # hold a refrigeration type, and a value somebody put there is theirs, not ours.
    bind.execute(sa.text(
        f"UPDATE {LOCATIONS} l JOIN {TYPES} t ON UPPER(l.storage_type) = UPPER(t.code) "
        f"SET l.storage_type_id = t.id WHERE l.storage_type_id IS NULL"))


def downgrade() -> None:
    op.drop_table(PARENTS)
    for column in ("allow_top_level", "is_temperature_controlled", "is_pickable",
                   "sort_order"):
        op.drop_column(TYPES, column)
