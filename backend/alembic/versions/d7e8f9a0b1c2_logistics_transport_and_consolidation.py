"""The transport leg, the consolidated buying sheet, and quote scoring.

Three things at once because they ship together and share the evaluation columns:

  * `lgs_transport_requests` + items + `lgs_carrier_quotes` + `lgs_shipment_events` —
    the outward transport leg (doc Phase E), which had no tables at all. The old
    `modules/logistics` package owned GRN and issues, not transport.
  * `pro_consolidations` + items + sources — many requisitions rolled into one buying
    sheet (doc B7).
  * `pro_rfqs.evaluation_method`, `pro_rfqs.consolidation_id/_no` and
    `pro_quotations.evaluation_score` — vendor scoring, so an award is justified by a
    stored ranking rather than by whoever sorted the list.

Every step is guarded on what is already there, so this is safe to re-run and safe on
a database that was built by `scripts.bootstrap` (which creates tables from the models
and then stamps head — those tables will already exist and each block skips).

Revision ID: d7e8f9a0b1c2
Revises: a1b2c3d4e5f7
"""
import sqlalchemy as sa
from alembic import op

revision = "d7e8f9a0b1c2"
down_revision = "a1b2c3d4e5f7"
branch_labels = None
depends_on = None

QTY = sa.Numeric(16, 3)
MONEY = sa.Numeric(16, 2)


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _columns(table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _indexes(table: str) -> set[str]:
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    existing = _tables()

    # ------------------------------------------------------------------ #
    #  Logistics — transport
    # ------------------------------------------------------------------ #
    if "lgs_transport_requests" not in existing:
        op.create_table(
            "lgs_transport_requests",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("tr_no", sa.String(50), nullable=False, unique=True),
            sa.Column("tr_date", sa.Date, nullable=True),
            sa.Column("mode", sa.String(30), nullable=False),
            sa.Column("status", sa.String(30), nullable=False, server_default="DRAFT"),

            sa.Column("source_type", sa.String(30), nullable=True),
            sa.Column("source_id", sa.BigInteger, nullable=True),
            sa.Column("source_no", sa.String(50), nullable=True),
            sa.Column("issue_id", sa.BigInteger, nullable=True),
            sa.Column("dispatch_id", sa.BigInteger, nullable=True),
            sa.Column("indent_id", sa.BigInteger, nullable=True),
            sa.Column("indent_no", sa.String(50), nullable=True),

            sa.Column("from_warehouse_id", sa.BigInteger, nullable=True),
            sa.Column("from_warehouse_name", sa.String(200), nullable=True),
            sa.Column("to_location_name", sa.String(200), nullable=True),
            sa.Column("delivery_address", sa.String(500), nullable=True),
            sa.Column("contact_person", sa.String(200), nullable=True),
            sa.Column("contact_phone", sa.String(30), nullable=True),
            sa.Column("distance_km", sa.Numeric(10, 2), nullable=True),
            sa.Column("project_id", sa.BigInteger, nullable=True),
            sa.Column("project_name", sa.String(200), nullable=True),

            sa.Column("total_items", sa.Integer, nullable=False, server_default="0"),
            sa.Column("total_qty", QTY, nullable=False, server_default="0"),
            sa.Column("total_weight_kg", QTY, nullable=False, server_default="0"),
            sa.Column("total_volume_cbm", sa.Numeric(14, 4), nullable=False,
                      server_default="0"),
            sa.Column("total_packages", sa.Integer, nullable=False,
                      server_default="0"),

            sa.Column("carrier_id", sa.BigInteger, nullable=True),
            sa.Column("carrier_name", sa.String(200), nullable=True),
            sa.Column("evaluation_method", sa.String(30), nullable=True),
            sa.Column("freight_amount", MONEY, nullable=True),
            sa.Column("awarded_quote_id", sa.BigInteger, nullable=True),
            sa.Column("awarded_by_id", sa.BigInteger, nullable=True),
            sa.Column("awarded_by_name", sa.String(200), nullable=True),
            sa.Column("awarded_at", sa.DateTime, nullable=True),

            sa.Column("vehicle_number", sa.String(50), nullable=True),
            sa.Column("driver_name", sa.String(200), nullable=True),
            sa.Column("driver_phone", sa.String(30), nullable=True),
            sa.Column("trip_reference", sa.String(200), nullable=True),
            sa.Column("handed_over_by_name", sa.String(200), nullable=True),
            sa.Column("received_by_name", sa.String(200), nullable=True),

            sa.Column("lr_no", sa.String(50), nullable=True),
            sa.Column("docket_no", sa.String(50), nullable=True),
            sa.Column("tracking_url", sa.String(500), nullable=True),
            sa.Column("eway_bill_no", sa.String(50), nullable=True),

            sa.Column("expected_delivery", sa.Date, nullable=True),
            sa.Column("dispatched_at", sa.DateTime, nullable=True),
            sa.Column("delivered_at", sa.DateTime, nullable=True),
            sa.Column("delivered_to_name", sa.String(200), nullable=True),
            sa.Column("pod_url", sa.String(500), nullable=True),
            sa.Column("tracking_shared_at", sa.DateTime, nullable=True),

            sa.Column("remarks", sa.Text, nullable=True),
            sa.Column("requested_by_id", sa.BigInteger, nullable=True),
            sa.Column("requested_by_name", sa.String(200), nullable=True),
            sa.Column("requested_position_id", sa.BigInteger, nullable=True),
            sa.Column("created_at", sa.DateTime, nullable=False,
                      server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime, nullable=True,
                      server_default=sa.func.now()),
        )
        op.create_index("ix_lgs_tr_mode", "lgs_transport_requests", ["mode"])
        op.create_index("ix_lgs_tr_status", "lgs_transport_requests", ["status"])
        op.create_index("ix_lgs_tr_source_id", "lgs_transport_requests", ["source_id"])
        op.create_index("ix_lgs_tr_issue_id", "lgs_transport_requests", ["issue_id"])
        op.create_index("ix_lgs_tr_dispatch_id", "lgs_transport_requests",
                        ["dispatch_id"])
        op.create_index("ix_lgs_tr_indent_id", "lgs_transport_requests", ["indent_id"])
        op.create_index("ix_lgs_tr_carrier_id", "lgs_transport_requests",
                        ["carrier_id"])
        op.create_index("ix_lgs_tr_from_warehouse_id", "lgs_transport_requests",
                        ["from_warehouse_id"])
        op.create_index("ix_lgs_tr_project_id", "lgs_transport_requests",
                        ["project_id"])
        op.create_index("ix_lgs_tr_status_date", "lgs_transport_requests",
                        ["status", "tr_date"])

    if "lgs_transport_request_items" not in existing:
        op.create_table(
            "lgs_transport_request_items",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("tr_id", sa.BigInteger, nullable=False),
            sa.Column("line_no", sa.Integer, nullable=False, server_default="1"),
            sa.Column("item_id", sa.BigInteger, nullable=True),
            sa.Column("item_code", sa.String(50), nullable=True),
            sa.Column("item_name", sa.String(300), nullable=True),
            sa.Column("uom_code", sa.String(20), nullable=True),
            sa.Column("quantity", QTY, nullable=False, server_default="0"),
            sa.Column("delivered_qty", QTY, nullable=False, server_default="0"),
            sa.Column("package_count", sa.Integer, nullable=False,
                      server_default="0"),
            sa.Column("package_type", sa.String(50), nullable=True),
            sa.Column("weight_kg", QTY, nullable=True),
            sa.Column("length_cm", sa.Numeric(10, 2), nullable=True),
            sa.Column("width_cm", sa.Numeric(10, 2), nullable=True),
            sa.Column("height_cm", sa.Numeric(10, 2), nullable=True),
            sa.Column("is_fragile", sa.Boolean, nullable=False, server_default="0"),
            sa.Column("remarks", sa.String(500), nullable=True),
            sa.ForeignKeyConstraint(["tr_id"], ["lgs_transport_requests.id"],
                                    ondelete="CASCADE"),
        )
        op.create_index("ix_lgs_tr_items_tr_id", "lgs_transport_request_items",
                        ["tr_id"])
        op.create_index("ix_lgs_tr_items_item_id", "lgs_transport_request_items",
                        ["item_id"])

    if "lgs_carrier_quotes" not in existing:
        op.create_table(
            "lgs_carrier_quotes",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("tr_id", sa.BigInteger, nullable=False),
            sa.Column("carrier_id", sa.BigInteger, nullable=False),
            sa.Column("carrier_name", sa.String(200), nullable=True),
            sa.Column("status", sa.String(30), nullable=False,
                      server_default="INVITED"),
            sa.Column("freight_amount", MONEY, nullable=True),
            sa.Column("other_charges", MONEY, nullable=False, server_default="0"),
            sa.Column("tax_percent", sa.Numeric(6, 2), nullable=True),
            sa.Column("transit_days", sa.Integer, nullable=True),
            sa.Column("valid_until", sa.Date, nullable=True),
            sa.Column("vehicle_type", sa.String(100), nullable=True),
            sa.Column("remarks", sa.Text, nullable=True),
            sa.Column("invited_at", sa.DateTime, nullable=True),
            sa.Column("submitted_at", sa.DateTime, nullable=True),
            sa.Column("score", sa.Numeric(10, 4), nullable=True),
            sa.Column("rank", sa.Integer, nullable=True),
            sa.ForeignKeyConstraint(["tr_id"], ["lgs_transport_requests.id"],
                                    ondelete="CASCADE"),
        )
        op.create_index("ix_lgs_quotes_tr_id", "lgs_carrier_quotes", ["tr_id"])
        op.create_index("ix_lgs_quotes_carrier_id", "lgs_carrier_quotes",
                        ["carrier_id"])
        # One invitation per carrier per request. Inviting twice is idempotent in the
        # service; this is what makes it impossible at the database too.
        op.create_index("ix_lgs_quote_tr_carrier", "lgs_carrier_quotes",
                        ["tr_id", "carrier_id"], unique=True)

    if "lgs_shipment_events" not in existing:
        op.create_table(
            "lgs_shipment_events",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("tr_id", sa.BigInteger, nullable=False),
            sa.Column("event_type", sa.String(30), nullable=False),
            sa.Column("event_at", sa.DateTime, nullable=False),
            sa.Column("location_name", sa.String(200), nullable=True),
            sa.Column("description", sa.String(500), nullable=True),
            sa.Column("is_exception", sa.Boolean, nullable=False,
                      server_default="0"),
            sa.Column("affected_item_name", sa.String(300), nullable=True),
            sa.Column("affected_qty", QTY, nullable=True),
            sa.Column("claim_amount", MONEY, nullable=True),
            sa.Column("resolution", sa.Text, nullable=True),
            sa.Column("resolved_at", sa.DateTime, nullable=True),
            sa.Column("resolved_by_id", sa.BigInteger, nullable=True),
            sa.Column("resolved_by_name", sa.String(200), nullable=True),
            sa.Column("recorded_by_id", sa.BigInteger, nullable=True),
            sa.Column("recorded_by_name", sa.String(200), nullable=True),
            sa.Column("created_at", sa.DateTime, nullable=False,
                      server_default=sa.func.now()),
            sa.ForeignKeyConstraint(["tr_id"], ["lgs_transport_requests.id"],
                                    ondelete="CASCADE"),
        )
        op.create_index("ix_lgs_events_tr_id", "lgs_shipment_events", ["tr_id"])
        op.create_index("ix_lgs_events_type", "lgs_shipment_events", ["event_type"])
        op.create_index("ix_lgs_events_is_exception", "lgs_shipment_events",
                        ["is_exception"])
        # The Exceptions screen is exactly this pair: open claims.
        op.create_index("ix_lgs_event_open_exception", "lgs_shipment_events",
                        ["is_exception", "resolved_at"])

    # ------------------------------------------------------------------ #
    #  Procurement — the consolidated buying sheet
    # ------------------------------------------------------------------ #
    if "pro_consolidations" not in existing:
        op.create_table(
            "pro_consolidations",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("cons_no", sa.String(30), nullable=False, unique=True),
            sa.Column("cons_date", sa.Date, nullable=True),
            sa.Column("title", sa.String(300), nullable=True),
            sa.Column("period_label", sa.String(100), nullable=True),
            sa.Column("project_id", sa.BigInteger, nullable=True),
            sa.Column("project_name", sa.String(200), nullable=True),
            sa.Column("warehouse_id", sa.BigInteger, nullable=True),
            sa.Column("warehouse_name", sa.String(200), nullable=True),
            sa.Column("status", sa.String(30), nullable=False,
                      server_default="DRAFT"),
            sa.Column("total_items", sa.Integer, nullable=False, server_default="0"),
            sa.Column("source_count", sa.Integer, nullable=False,
                      server_default="0"),
            sa.Column("estimated_value", MONEY, nullable=False, server_default="0"),
            sa.Column("current_approver_name", sa.String(200), nullable=True),
            sa.Column("approved_by_name", sa.String(200), nullable=True),
            sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("remarks", sa.Text, nullable=True),
            sa.Column("created_by_id", sa.BigInteger, nullable=True),
            sa.Column("created_by_name", sa.String(200), nullable=True),
            sa.Column("created_position_id", sa.BigInteger, nullable=True),
            sa.Column("created_at", sa.DateTime, nullable=False,
                      server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime, nullable=True,
                      server_default=sa.func.now()),
        )
        op.create_index("ix_pro_cons_status", "pro_consolidations", ["status"])
        op.create_index("ix_pro_cons_project_id", "pro_consolidations",
                        ["project_id"])
        op.create_index("ix_pro_cons_status_created", "pro_consolidations",
                        ["status", "created_at"])

    if "pro_consolidation_items" not in existing:
        op.create_table(
            "pro_consolidation_items",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("consolidation_id", sa.BigInteger, nullable=False),
            sa.Column("line_no", sa.Integer, nullable=False, server_default="1"),
            sa.Column("item_id", sa.BigInteger, nullable=False),
            sa.Column("item_code", sa.String(50), nullable=True),
            sa.Column("item_name", sa.String(300), nullable=True),
            sa.Column("uom_code", sa.String(20), nullable=True),
            sa.Column("quantity", QTY, nullable=False, server_default="0"),
            sa.Column("approved_qty", QTY, nullable=False, server_default="0"),
            sa.Column("estimated_rate", MONEY, nullable=False, server_default="0"),
            sa.Column("estimated_amount", MONEY, nullable=False, server_default="0"),
            sa.Column("required_date", sa.Date, nullable=True),
            sa.Column("sources", sa.Text, nullable=True),
            sa.Column("source_count", sa.Integer, nullable=False,
                      server_default="0"),
            sa.Column("remarks", sa.Text, nullable=True),
            sa.ForeignKeyConstraint(["consolidation_id"], ["pro_consolidations.id"],
                                    ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["item_id"], ["mst_items.id"]),
        )
        op.create_index("ix_pro_cons_items_cons_id", "pro_consolidation_items",
                        ["consolidation_id"])
        op.create_index("ix_pro_cons_items_item_id", "pro_consolidation_items",
                        ["item_id"])

    if "pro_consolidation_sources" not in existing:
        op.create_table(
            "pro_consolidation_sources",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("consolidation_id", sa.BigInteger, nullable=False),
            sa.Column("requisition_id", sa.BigInteger, nullable=False),
            sa.Column("requisition_no", sa.String(30), nullable=True),
            sa.Column("project_name", sa.String(200), nullable=True),
            sa.Column("item_count", sa.Integer, nullable=False, server_default="0"),
            sa.Column("estimated_value", MONEY, nullable=False, server_default="0"),
            sa.ForeignKeyConstraint(["consolidation_id"], ["pro_consolidations.id"],
                                    ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["requisition_id"], ["pro_requisitions.id"]),
        )
        op.create_index("ix_pro_cons_sources_cons_id", "pro_consolidation_sources",
                        ["consolidation_id"])
        op.create_index("ix_pro_cons_source_req", "pro_consolidation_sources",
                        ["requisition_id"])

    # ------------------------------------------------------------------ #
    #  Vendor scoring
    # ------------------------------------------------------------------ #
    rfq_columns = _columns("pro_rfqs")
    if "evaluation_method" not in rfq_columns:
        op.add_column("pro_rfqs",
                      sa.Column("evaluation_method", sa.String(30), nullable=True))
    if "consolidation_id" not in rfq_columns:
        op.add_column("pro_rfqs",
                      sa.Column("consolidation_id", sa.BigInteger, nullable=True))
        if "ix_pro_rfqs_consolidation_id" not in _indexes("pro_rfqs"):
            op.create_index("ix_pro_rfqs_consolidation_id", "pro_rfqs",
                            ["consolidation_id"])
    if "consolidation_no" not in rfq_columns:
        op.add_column("pro_rfqs",
                      sa.Column("consolidation_no", sa.String(30), nullable=True))

    if "evaluation_score" not in _columns("pro_quotations"):
        op.add_column("pro_quotations",
                      sa.Column("evaluation_score", sa.Numeric(10, 4),
                                nullable=True))


def downgrade() -> None:
    for column in ("consolidation_no", "consolidation_id", "evaluation_method"):
        if column in _columns("pro_rfqs"):
            op.drop_column("pro_rfqs", column)
    if "evaluation_score" in _columns("pro_quotations"):
        op.drop_column("pro_quotations", "evaluation_score")

    existing = _tables()
    # Children first — the FKs are ON DELETE CASCADE, but the tables still have to go
    # in dependency order.
    for table in ("pro_consolidation_sources", "pro_consolidation_items",
                  "pro_consolidations", "lgs_shipment_events", "lgs_carrier_quotes",
                  "lgs_transport_request_items", "lgs_transport_requests"):
        if table in existing:
            op.drop_table(table)
