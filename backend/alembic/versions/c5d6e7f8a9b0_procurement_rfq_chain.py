"""Procurement's RFQ chain: requisitions, RFQs, quotations, supplier logins.

The seven document tables already exist in the QA schema, created there by hand and
never migrated anywhere else. This brings them forward under the SAME names and the
same columns, because those names are the ones the rest of the estate reads and their
columns already follow rule 10 — `item_code`, `item_name`, `vendor_name` and
`warehouse_name` are snapshotted on the row, so a document still reads correctly after
a master is renamed.

Eight columns are added on top of what QA has, each because the code cannot work
without it:

  * `pro_rfq_vendors.access_token`  — the invite link. Without it the only way into
    the portal is a password, and most vendors will never have one.
  * `pro_quotations.revision_count`, `.submitted_at`, `.expected_delivery_date` — a
    vendor may re-quote until the deadline; a buyer has to tell a first offer from a
    fourth without diffing timestamps.
  * `pro_quotation_items.cgst_rate`, `.sgst_rate`, `.igst_rate` — the split the
    VENDOR quoted. Deriving it from the HSN at read time would be wrong: a quotation
    is an offer, and the offer's own numbers are what the PO is raised against.
  * `pro_requisitions.priority` — on the raising form, and what a buyer sorts by.

Plus one new table, `pro_vendor_users`. A vendor is not an employee, so it cannot ride
on `hcm_employees` or on `sys_local_credentials` (keyed on employee id).

Idempotent: every object is created only if it is not already there, so this runs
cleanly on QA (where seven of the eight exist) and on PROD (where none do).

Revision ID: c5d6e7f8a9b0
Revises: b4c5d6e7f8a9
"""
import sqlalchemy as sa
from alembic import op

revision = "c5d6e7f8a9b0"
down_revision = "b4c5d6e7f8a9"
branch_labels = None
depends_on = None


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _columns(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {c["name"] for c in inspector.get_columns(table)}


def _add(table: str, column: sa.Column) -> None:
    """Add a column unless it is already there. QA has most of these."""
    if table in _tables() and column.name not in _columns(table):
        op.add_column(table, column)


def upgrade() -> None:
    existing = _tables()

    # ---------------------------------------------------------------- requisitions
    if "pro_requisitions" not in existing:
        op.create_table(
            "pro_requisitions",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("req_no", sa.String(30), nullable=False),
            sa.Column("req_date", sa.Date(), nullable=True),
            sa.Column("warehouse_id", sa.BigInteger(), nullable=True),
            sa.Column("warehouse_name", sa.String(200), nullable=True),
            sa.Column("project_id", sa.BigInteger(), nullable=True),
            sa.Column("project_name", sa.String(200), nullable=True),
            sa.Column("status", sa.String(30), nullable=False),
            sa.Column("priority", sa.String(20), nullable=True),
            sa.Column("total_items", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("estimated_value", sa.Numeric(16, 2), nullable=False,
                      server_default="0"),
            sa.Column("current_approver_name", sa.String(200), nullable=True),
            sa.Column("approved_by_name", sa.String(200), nullable=True),
            sa.Column("approved_at", sa.DateTime(), nullable=True),
            sa.Column("remarks", sa.Text(), nullable=True),
            sa.Column("created_by_id", sa.BigInteger(), nullable=True),
            sa.Column("created_by_name", sa.String(200), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False,
                      server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("updated_at", sa.DateTime(), nullable=False,
                      server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("req_no"),
        )
        op.create_index("ix_pro_requisitions_status", "pro_requisitions", ["status"])
        op.create_index("ix_pro_requisitions_warehouse_id", "pro_requisitions",
                        ["warehouse_id"])
        op.create_index("ix_pro_requisitions_created_by_id", "pro_requisitions",
                        ["created_by_id"])
        op.create_index("ix_pro_req_status_created", "pro_requisitions",
                        ["status", "created_at"])

    if "pro_requisition_items" not in existing:
        op.create_table(
            "pro_requisition_items",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("requisition_id", sa.BigInteger(), nullable=False),
            sa.Column("line_no", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("indent_id", sa.BigInteger(), nullable=True),
            sa.Column("indent_no", sa.String(30), nullable=True),
            sa.Column("indent_item_id", sa.BigInteger(), nullable=True),
            sa.Column("item_id", sa.BigInteger(), nullable=False),
            sa.Column("item_code", sa.String(50), nullable=True),
            sa.Column("item_name", sa.String(300), nullable=True),
            sa.Column("uom_code", sa.String(20), nullable=True),
            sa.Column("quantity", sa.Numeric(16, 3), nullable=False),
            sa.Column("ordered_qty", sa.Numeric(16, 3), nullable=False,
                      server_default="0"),
            sa.Column("estimated_rate", sa.Numeric(16, 2), nullable=False,
                      server_default="0"),
            sa.Column("estimated_amount", sa.Numeric(16, 2), nullable=False,
                      server_default="0"),
            sa.Column("required_date", sa.Date(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
            sa.ForeignKeyConstraint(["requisition_id"], ["pro_requisitions.id"],
                                    ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["item_id"], ["mst_items.id"]),
        )
        op.create_index("ix_pro_requisition_items_requisition_id",
                        "pro_requisition_items", ["requisition_id"])
        op.create_index("ix_pro_requisition_items_item_id", "pro_requisition_items",
                        ["item_id"])

    # ------------------------------------------------------------------------- RFQ
    if "pro_rfqs" not in existing:
        op.create_table(
            "pro_rfqs",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("rfq_no", sa.String(30), nullable=False),
            sa.Column("rfq_type", sa.String(20), nullable=True),
            sa.Column("rfq_date", sa.Date(), nullable=True),
            sa.Column("due_date", sa.Date(), nullable=True),
            sa.Column("requisition_id", sa.BigInteger(), nullable=True),
            sa.Column("requisition_no", sa.String(30), nullable=True),
            sa.Column("warehouse_id", sa.BigInteger(), nullable=True),
            sa.Column("warehouse_name", sa.String(200), nullable=True),
            sa.Column("project_id", sa.BigInteger(), nullable=True),
            sa.Column("project_name", sa.String(200), nullable=True),
            sa.Column("title", sa.String(300), nullable=True),
            sa.Column("status", sa.String(30), nullable=False),
            sa.Column("total_items", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("vendor_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("response_count", sa.Integer(), nullable=False,
                      server_default="0"),
            sa.Column("awarded_vendor_id", sa.BigInteger(), nullable=True),
            sa.Column("awarded_vendor_name", sa.String(200), nullable=True),
            sa.Column("terms", sa.Text(), nullable=True),
            sa.Column("current_approver_name", sa.String(200), nullable=True),
            sa.Column("created_by_id", sa.BigInteger(), nullable=True),
            sa.Column("created_by_name", sa.String(200), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False,
                      server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("updated_at", sa.DateTime(), nullable=False,
                      server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("rfq_no"),
            sa.ForeignKeyConstraint(["requisition_id"], ["pro_requisitions.id"]),
            sa.ForeignKeyConstraint(["awarded_vendor_id"], ["mst_vendors.id"]),
        )
        op.create_index("ix_pro_rfqs_status", "pro_rfqs", ["status"])
        op.create_index("ix_pro_rfqs_created_by_id", "pro_rfqs", ["created_by_id"])

    if "pro_rfq_items" not in existing:
        op.create_table(
            "pro_rfq_items",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("rfq_id", sa.BigInteger(), nullable=False),
            sa.Column("line_no", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("item_id", sa.BigInteger(), nullable=False),
            sa.Column("item_code", sa.String(50), nullable=True),
            sa.Column("item_name", sa.String(300), nullable=True),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("uom_code", sa.String(20), nullable=True),
            sa.Column("quantity", sa.Numeric(16, 3), nullable=False),
            sa.Column("required_date", sa.Date(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
            sa.ForeignKeyConstraint(["rfq_id"], ["pro_rfqs.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["item_id"], ["mst_items.id"]),
        )
        op.create_index("ix_pro_rfq_items_rfq_id", "pro_rfq_items", ["rfq_id"])
        op.create_index("ix_pro_rfq_items_item_id", "pro_rfq_items", ["item_id"])

    if "pro_rfq_vendors" not in existing:
        op.create_table(
            "pro_rfq_vendors",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("rfq_id", sa.BigInteger(), nullable=False),
            sa.Column("vendor_id", sa.BigInteger(), nullable=False),
            sa.Column("vendor_name", sa.String(200), nullable=True),
            sa.Column("vendor_email", sa.String(200), nullable=True),
            sa.Column("access_token", sa.String(100), nullable=True),
            sa.Column("sent_at", sa.DateTime(), nullable=True),
            sa.Column("responded_at", sa.DateTime(), nullable=True),
            sa.Column("status", sa.String(30), nullable=True),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("access_token"),
            sa.ForeignKeyConstraint(["rfq_id"], ["pro_rfqs.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["vendor_id"], ["mst_vendors.id"]),
        )
        op.create_index("ix_pro_rfq_vendors_rfq_id", "pro_rfq_vendors", ["rfq_id"])
        op.create_index("ix_pro_rfq_vendors_vendor_id", "pro_rfq_vendors",
                        ["vendor_id"])

    # ------------------------------------------------------------------ quotations
    if "pro_quotations" not in existing:
        op.create_table(
            "pro_quotations",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("quotation_no", sa.String(50), nullable=False),
            sa.Column("quotation_type", sa.String(20), nullable=True),
            sa.Column("rfq_id", sa.BigInteger(), nullable=False),
            sa.Column("rfq_no", sa.String(30), nullable=True),
            sa.Column("vendor_id", sa.BigInteger(), nullable=False),
            sa.Column("vendor_name", sa.String(200), nullable=True),
            sa.Column("vendor_ref_no", sa.String(50), nullable=True),
            sa.Column("quotation_date", sa.Date(), nullable=True),
            sa.Column("valid_till", sa.Date(), nullable=True),
            sa.Column("expected_delivery_date", sa.Date(), nullable=True),
            sa.Column("currency", sa.String(10), nullable=True),
            sa.Column("sub_total", sa.Numeric(16, 2), nullable=False,
                      server_default="0"),
            sa.Column("discount_amount", sa.Numeric(16, 2), nullable=False,
                      server_default="0"),
            sa.Column("tax_amount", sa.Numeric(16, 2), nullable=False,
                      server_default="0"),
            sa.Column("freight_amount", sa.Numeric(16, 2), nullable=False,
                      server_default="0"),
            sa.Column("grand_total", sa.Numeric(16, 2), nullable=False,
                      server_default="0"),
            sa.Column("payment_terms", sa.String(200), nullable=True),
            sa.Column("delivery_days", sa.Integer(), nullable=True),
            sa.Column("status", sa.String(30), nullable=False),
            sa.Column("rank_position", sa.Integer(), nullable=True),
            sa.Column("remarks", sa.Text(), nullable=True),
            sa.Column("revision_count", sa.Integer(), nullable=False,
                      server_default="0"),
            sa.Column("submitted_at", sa.DateTime(), nullable=True),
            sa.Column("created_by_id", sa.BigInteger(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False,
                      server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("quotation_no"),
            sa.ForeignKeyConstraint(["rfq_id"], ["pro_rfqs.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["vendor_id"], ["mst_vendors.id"]),
        )
        op.create_index("ix_pro_quotations_rfq_id", "pro_quotations", ["rfq_id"])
        op.create_index("ix_pro_quotations_vendor_id", "pro_quotations", ["vendor_id"])
        op.create_index("ix_pro_quotations_status", "pro_quotations", ["status"])

    if "pro_quotation_items" not in existing:
        op.create_table(
            "pro_quotation_items",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("quotation_id", sa.BigInteger(), nullable=False),
            sa.Column("line_no", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("rfq_item_id", sa.BigInteger(), nullable=True),
            sa.Column("item_id", sa.BigInteger(), nullable=False),
            sa.Column("item_code", sa.String(50), nullable=True),
            sa.Column("item_name", sa.String(300), nullable=True),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("uom_code", sa.String(20), nullable=True),
            sa.Column("quantity", sa.Numeric(16, 3), nullable=False),
            sa.Column("rate", sa.Numeric(16, 2), nullable=False, server_default="0"),
            sa.Column("discount_percent", sa.Numeric(5, 2), nullable=False,
                      server_default="0"),
            sa.Column("tax_percent", sa.Numeric(5, 2), nullable=False,
                      server_default="0"),
            sa.Column("cgst_rate", sa.Numeric(5, 2), nullable=True),
            sa.Column("sgst_rate", sa.Numeric(5, 2), nullable=True),
            sa.Column("igst_rate", sa.Numeric(5, 2), nullable=True),
            sa.Column("amount", sa.Numeric(16, 2), nullable=False, server_default="0"),
            sa.Column("delivery_days", sa.Integer(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
            sa.ForeignKeyConstraint(["quotation_id"], ["pro_quotations.id"],
                                    ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["rfq_item_id"], ["pro_rfq_items.id"]),
            sa.ForeignKeyConstraint(["item_id"], ["mst_items.id"]),
        )
        op.create_index("ix_pro_quotation_items_quotation_id", "pro_quotation_items",
                        ["quotation_id"])
        op.create_index("ix_pro_quotation_items_rfq_item_id", "pro_quotation_items",
                        ["rfq_item_id"])

    # ------------------------------------------------------------ supplier logins
    if "pro_vendor_users" not in existing:
        op.create_table(
            "pro_vendor_users",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("vendor_id", sa.BigInteger(), nullable=False),
            sa.Column("username", sa.String(100), nullable=False),
            sa.Column("password_hash", sa.String(255), nullable=False),
            sa.Column("is_active", sa.Boolean(), nullable=False,
                      server_default=sa.text("1")),
            sa.Column("must_change_password", sa.Boolean(), nullable=False,
                      server_default=sa.text("1")),
            sa.Column("last_login_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False,
                      server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("updated_at", sa.DateTime(), nullable=False,
                      server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("vendor_id"),
            sa.UniqueConstraint("username"),
            sa.ForeignKeyConstraint(["vendor_id"], ["mst_vendors.id"],
                                    ondelete="CASCADE"),
        )

    # --------- the eight columns QA's generation of these tables does not carry ---
    _add("pro_requisitions", sa.Column("priority", sa.String(20), nullable=True))
    _add("pro_rfq_vendors", sa.Column("access_token", sa.String(100), nullable=True))
    _add("pro_rfqs", sa.Column("current_approver_name", sa.String(200), nullable=True))
    _add("pro_quotations", sa.Column("revision_count", sa.Integer(), nullable=False,
                                     server_default="0"))
    _add("pro_quotations", sa.Column("submitted_at", sa.DateTime(), nullable=True))
    _add("pro_quotations", sa.Column("expected_delivery_date", sa.Date(),
                                     nullable=True))
    for gst in ("cgst_rate", "sgst_rate", "igst_rate"):
        _add("pro_quotation_items", sa.Column(gst, sa.Numeric(5, 2), nullable=True))


def downgrade() -> None:
    for table in ("pro_vendor_users", "pro_quotation_items", "pro_quotations",
                  "pro_rfq_vendors", "pro_rfq_items", "pro_rfqs",
                  "pro_requisition_items", "pro_requisitions"):
        if table in _tables():
            op.drop_table(table)
