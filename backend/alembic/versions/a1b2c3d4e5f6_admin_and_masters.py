"""admin and masters: locations, uom conversions, user groups, rules engine,
audit log, notification rules, and the stock ledger's location/project dimensions.

Revision ID: a1b2c3d4e5f6
Revises: edfd2d748191
Create Date: 2026-07-25

The widened tables (stk_stock, stk_movements, sys_doc_series) already hold live data,
so those steps add nullable columns, backfill, then tighten. The equivalent statements
for a database Alembic does not manage are in docs/sql/2026-07-25_admin_masters.sql.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, None] = "edfd2d748191"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

BigInt = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade() -> None:
    # ------------------------------------------------------------------ #
    #  New master tables
    # ------------------------------------------------------------------ #
    op.create_table(
        "mst_locations",
        sa.Column("id", BigInt, autoincrement=True, nullable=False),
        sa.Column("code", sa.String(50), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("location_type", sa.String(20), nullable=False),
        sa.Column("parent_id", BigInt, nullable=True),
        sa.Column("parent_name", sa.String(200), nullable=True),
        sa.Column("hcm_facility_id", BigInt, nullable=True),
        sa.Column("address", sa.String(300), nullable=True),
        sa.Column("city", sa.String(100), nullable=True),
        sa.Column("state", sa.String(100), nullable=True),
        sa.Column("is_stock_point", sa.Boolean(), nullable=False,
                  server_default=sa.text("0")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["parent_id"], ["mst_locations.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code"),
    )
    op.create_index("ix_mst_locations_parent_id", "mst_locations", ["parent_id"])
    op.create_index("ix_mst_locations_hcm_facility_id", "mst_locations",
                    ["hcm_facility_id"])
    op.create_index("ix_mst_locations_type_active", "mst_locations",
                    ["location_type", "is_active"])

    op.create_table(
        "mst_uom_conversions",
        sa.Column("id", BigInt, autoincrement=True, nullable=False),
        sa.Column("from_uom_id", BigInt, nullable=False),
        sa.Column("from_uom_code", sa.String(20), nullable=True),
        sa.Column("to_uom_id", BigInt, nullable=False),
        sa.Column("to_uom_code", sa.String(20), nullable=True),
        sa.Column("factor", sa.Numeric(16, 6), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.ForeignKeyConstraint(["from_uom_id"], ["mst_uom.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["to_uom_id"], ["mst_uom.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("from_uom_id", "to_uom_id", name="uq_uom_conversion_pair"),
    )

    # ------------------------------------------------------------------ #
    #  User groups
    # ------------------------------------------------------------------ #
    op.create_table(
        "rbac_user_groups",
        sa.Column("id", BigInt, autoincrement=True, nullable=False),
        sa.Column("code", sa.String(50), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.String(300), nullable=True),
        sa.Column("parent_id", BigInt, nullable=True),
        sa.Column("group_type", sa.String(20), nullable=False),
        sa.Column("role_id", BigInt, nullable=True),
        sa.Column("position_id", BigInt, nullable=True),
        sa.Column("location_id", BigInt, nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code"),
    )
    # Membership is resolved by querying on these three, so each is indexed.
    for column in ("parent_id", "role_id", "position_id", "location_id"):
        op.create_index(f"ix_rbac_user_groups_{column}", "rbac_user_groups", [column])

    op.create_table(
        "rbac_user_group_members",
        sa.Column("group_id", BigInt, nullable=False),
        sa.Column("employee_id", BigInt, nullable=False),
        sa.Column("added_by_id", BigInt, nullable=True),
        sa.Column("added_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("group_id", "employee_id"),
    )

    # ------------------------------------------------------------------ #
    #  Rules engine
    # ------------------------------------------------------------------ #
    op.create_table(
        "rule_events",
        sa.Column("code", sa.String(50), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("module", sa.String(50), nullable=True),
        sa.Column("description", sa.String(300), nullable=True),
        sa.Column("context_schema", sa.JSON(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.PrimaryKeyConstraint("code"),
    )

    op.create_table(
        "rule_rules",
        sa.Column("id", BigInt, autoincrement=True, nullable=False),
        sa.Column("event_code", sa.String(50), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.String(300), nullable=True),
        sa.Column("priority", sa.Integer(), nullable=False, server_default=sa.text("100")),
        sa.Column("stop_on_match", sa.Boolean(), nullable=False,
                  server_default=sa.text("0")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("effective_from", sa.Date(), nullable=True),
        sa.Column("effective_to", sa.Date(), nullable=True),
        sa.Column("created_by_id", BigInt, nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    # fire() filters on exactly this pair on the document-submission path.
    op.create_index("ix_rule_rules_event_active", "rule_rules",
                    ["event_code", "is_active"])

    op.create_table(
        "rule_conditions",
        sa.Column("id", BigInt, autoincrement=True, nullable=False),
        sa.Column("rule_id", BigInt, nullable=False),
        sa.Column("field_name", sa.String(50), nullable=False),
        sa.Column("operator", sa.String(10), nullable=False),
        sa.Column("field_value", sa.String(200), nullable=False),
        sa.Column("logic", sa.String(5), nullable=False, server_default="AND"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_rule_conditions_rule_id", "rule_conditions", ["rule_id"])

    op.create_table(
        "rule_actions",
        sa.Column("id", BigInt, autoincrement=True, nullable=False),
        sa.Column("rule_id", BigInt, nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column("action_type", sa.String(30), nullable=False),
        sa.Column("params", sa.JSON(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_rule_actions_rule_id", "rule_actions", ["rule_id"])

    op.create_table(
        "rule_executions",
        sa.Column("id", BigInt, autoincrement=True, nullable=False),
        sa.Column("event_code", sa.String(50), nullable=False),
        sa.Column("rule_id", BigInt, nullable=True),
        sa.Column("doc_type", sa.String(30), nullable=True),
        sa.Column("doc_id", BigInt, nullable=True),
        sa.Column("matched", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("context", sa.JSON(), nullable=True),
        sa.Column("actions", sa.JSON(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("acted_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    for column in ("event_code", "rule_id", "doc_id", "acted_at"):
        op.create_index(f"ix_rule_executions_{column}", "rule_executions", [column])

    # ------------------------------------------------------------------ #
    #  Audit log and notification rules
    # ------------------------------------------------------------------ #
    # edfd2d748191 creates sys_audit_log too. On the live databases this migration was
    # applied to, the table came from an unmanaged create and this ran fine; from an
    # empty database it is a duplicate and stops the whole chain here.
    if not sa.inspect(op.get_bind()).has_table("sys_audit_log"):
        op.create_table(
            "sys_audit_log",
            sa.Column("id", BigInt, autoincrement=True, nullable=False),
            sa.Column("entity", sa.String(50), nullable=False),
            sa.Column("entity_id", BigInt, nullable=True),
            sa.Column("action", sa.String(20), nullable=False),
            sa.Column("actor_id", BigInt, nullable=True),
            sa.Column("actor_name", sa.String(200), nullable=True),
            sa.Column("summary", sa.String(300), nullable=True),
            sa.Column("before", sa.JSON(), nullable=True),
            sa.Column("after", sa.JSON(), nullable=True),
            sa.Column("ip_address", sa.String(45), nullable=True),
            sa.Column("at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_sys_audit_log_entity", "sys_audit_log",
                        ["entity", "entity_id"])
        op.create_index("ix_sys_audit_log_actor_id", "sys_audit_log", ["actor_id"])
        op.create_index("ix_sys_audit_log_at", "sys_audit_log", ["at"])

    op.create_table(
        "sys_notification_rules",
        sa.Column("id", BigInt, autoincrement=True, nullable=False),
        sa.Column("event_code", sa.String(50), nullable=False),
        sa.Column("stage", sa.String(100), nullable=True),
        sa.Column("recipient_type", sa.String(20), nullable=False),
        sa.Column("recipient_id", BigInt, nullable=True),
        sa.Column("recipient_name", sa.String(200), nullable=True),
        sa.Column("channel", sa.String(20), nullable=False, server_default="IN_APP"),
        sa.Column("template", sa.Text(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_sys_notification_rules_event_code", "sys_notification_rules",
                    ["event_code"])

    # ------------------------------------------------------------------ #
    #  Document numbering: reset policy
    # ------------------------------------------------------------------ #
    op.add_column("sys_doc_series", sa.Column("reset_policy", sa.String(10),
                                              nullable=True))
    op.add_column("sys_doc_series", sa.Column("last_reset_period", sa.String(10),
                                              nullable=True))
    # NULL already reads as NEVER, but writing it makes the admin screen show a value.
    op.execute("UPDATE sys_doc_series SET reset_policy = 'NEVER' "
               "WHERE reset_policy IS NULL")

    # ------------------------------------------------------------------ #
    #  Stock ledger: location and project dimensions
    # ------------------------------------------------------------------ #
    # One location per active facility, so existing balances have somewhere to point.
    op.execute("""
        INSERT INTO mst_locations
            (code, name, location_type, hcm_facility_id, is_stock_point, is_active,
             created_at, updated_at)
        SELECT CONCAT('FAC-', f.id), f.name, 'WAREHOUSE', f.id, 1, 1, NOW(), NOW()
        FROM hcm_facilities f
        WHERE f.is_active = 1
          AND NOT EXISTS (SELECT 1 FROM mst_locations l WHERE l.hcm_facility_id = f.id)
    """)

    for table in ("stk_stock", "stk_movements"):
        op.add_column(table, sa.Column("location_id", BigInt, nullable=True))
        op.add_column(table, sa.Column("project_id", BigInt, nullable=True))
        op.execute(f"""
            UPDATE {table} t
            JOIN mst_locations l ON l.hcm_facility_id = t.facility_id
            SET t.location_id = l.id
            WHERE t.location_id IS NULL
        """)
        # Any row whose facility has no location (an inactive facility) still needs a
        # value, or the NOT NULL below fails. 0 is an explicit "unknown location".
        op.execute(f"UPDATE {table} SET location_id = 0 WHERE location_id IS NULL")
        op.execute(f"UPDATE {table} SET project_id = 0 WHERE project_id IS NULL")
        op.alter_column(table, "location_id", existing_type=BigInt, nullable=False)
        op.alter_column(table, "project_id", existing_type=BigInt, nullable=False,
                        server_default=sa.text("0"))
        op.create_index(f"ix_{table}_location_id", table, ["location_id"])
        op.create_index(f"ix_{table}_project_id", table, ["project_id"])

    op.add_column("stk_stock", sa.Column("location_name", sa.String(200), nullable=True))

    # The balance key changes from item+facility to item+location+project.
    op.drop_constraint("uq_stock_facility_item", "stk_stock", type_="unique")
    op.create_unique_constraint("uq_stock_item_loc_proj", "stk_stock",
                                ["item_id", "location_id", "project_id"])


def downgrade() -> None:
    op.drop_constraint("uq_stock_item_loc_proj", "stk_stock", type_="unique")
    op.create_unique_constraint("uq_stock_facility_item", "stk_stock",
                                ["facility_id", "item_id"])
    op.drop_column("stk_stock", "location_name")
    for table in ("stk_stock", "stk_movements"):
        op.drop_index(f"ix_{table}_project_id", table_name=table)
        op.drop_index(f"ix_{table}_location_id", table_name=table)
        op.drop_column(table, "project_id")
        op.drop_column(table, "location_id")

    op.drop_column("sys_doc_series", "last_reset_period")
    op.drop_column("sys_doc_series", "reset_policy")

    for table in ("sys_notification_rules", "sys_audit_log", "rule_executions",
                  "rule_actions", "rule_conditions", "rule_rules", "rule_events",
                  "rbac_user_group_members", "rbac_user_groups",
                  "mst_uom_conversions", "mst_locations"):
        op.drop_table(table)
