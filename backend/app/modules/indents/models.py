"""ind_ tables — Indents. Owned by modules/indents.

Soft FK + snapshot for HCM people/org; hard FK to mst_items; hard FK with CASCADE
to the parent indent for line items.

The header below is the FULL `ind_indents` shape as it exists in the database. It
used to map a subset, which left columns the DB enforces (`indent_type` is NOT NULL)
invisible to this module and to Alembic autogenerate. Every column here already
exists in the live schema, so mapping them needs no migration — only the ORM was
behind. Columns the module does not yet write are marked; they are mapped so the
model tells the truth about the table, not because this module owns them yet.
"""
from sqlalchemy import (
    Column, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, Index,
)
from sqlalchemy.orm import relationship

from app.core.database import Base
from app.modules.indents.enums import ConsolidationStatus, IndentType
from app.shared.enums import IndentItemStatus
from app.shared.models.base import (
    BigIntPortable, created_at_col, pk, soft_fk, updated_at_col,
)


class Consolidation(Base):
    """A monthly cycle as a DOCUMENT, with frozen membership.

    "August 2026 — consolidated" used to be a live GROUP BY on `indent_date`, recomputed
    by every screen from whatever happened to match at that instant. Nothing was wrong
    with any single query, but they asked different questions of the same month — the
    fulfilment queue counted indents still owed stock, the approval screen counted
    indents whose allocations were awaiting a signature — and both printed the answer
    under the word "indents". One row said 9, the screen it opened said 43.

    A consolidation is minted when the first monthly indent of a month finishes
    approval, and sealed when the storekeeper submits the allocation batch. After that
    its member list never changes, so every screen counting "indents in this cycle"
    reaches the same number. Indents approved later start the next consolidation for
    that same month instead of joining work already decided.
    """

    __tablename__ = "ind_consolidations"
    id = pk()
    consolidation_no = Column(String(50), unique=True, nullable=False)
    #: The month it serves, `YYYY-MM`, or `UNDATED`. NOT the identity — two
    #: consolidations for the same month is the normal case, not a fault.
    cycle = Column(String(10), nullable=False, index=True)
    status = Column(String(20), nullable=False,
                    default=ConsolidationStatus.OPEN.value,
                    server_default=ConsolidationStatus.OPEN.value, index=True)
    sealed_at = Column(DateTime(timezone=True), nullable=True)
    sealed_by_id = soft_fk()
    sealed_by_name = Column(String(200), nullable=True)
    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()


# "Which consolidation is still open for this month" is the one question the mint path
# asks, on every monthly approval.
Index("ix_ind_cons_cycle_status", Consolidation.cycle, Consolidation.status)


class Indent(Base):
    __tablename__ = "ind_indents"
    id = pk()
    indent_no = Column(String(50), unique=True, nullable=False)
    # What kind of request this is. NOT NULL in the database with a REGULAR default,
    # which is why the unmapped column never broke inserts — and why every indent
    # raised before this field existed reads back as REGULAR.
    indent_type = Column(String(30), nullable=False,
                         default=IndentType.REGULAR.value,
                         server_default=IndentType.REGULAR.value)
    indent_date = Column(Date, nullable=False)
    required_date = Column(Date, nullable=True)

    # who / where (soft FK + snapshot)
    requested_by_id = soft_fk()
    requested_by_name = Column(String(200), nullable=True)
    requested_by_code = Column(String(50), nullable=True)
    position_id = soft_fk()
    position_name = Column(String(200), nullable=True)
    department_id = soft_fk()
    department_name = Column(String(200), nullable=True)
    section_id = soft_fk()
    office_id = soft_fk()
    office_name = Column(String(200), nullable=True)
    # Region/Location: the HCM location the REQUESTER is tagged to
    # (`hcm_employees.office_id`), snapshotted at create. Deliberately separate from
    # `office_id` above, which resolves through the position/assignment chain and
    # therefore answers a different question ("which office does this role sit in")
    # than the one monthly grouping asks ("where is this person"). Nullable because
    # 33 of 296 live indents were raised by employees HCM has no location for, and an
    # indent must never be blocked on that.
    region_id = soft_fk()
    region_name = Column(String(200), nullable=True)
    warehouse_id = Column(BigIntPortable, nullable=True)      # written by warehouse
    warehouse_name = Column(String(200), nullable=True)
    project_id = soft_fk()
    project_name = Column(String(200), nullable=True)

    # Transport. `trn_vehicles` belongs to the transport team, so this is an
    # unconstrained id plus the snapshot registration number — the same treatment
    # every cross-team reference gets, and the number survives a vehicle being retired.
    vehicle_id = Column(BigIntPortable, nullable=True)
    vehicle_number = Column(String(50), nullable=True)

    bom_id = Column(BigIntPortable, nullable=True)            # not written yet
    bom_name = Column(String(200), nullable=True)

    # Which consolidation document this indent belongs to — set once, when approval
    # finishes, and never moved afterwards. NULL for every REGULAR indent (a one-off
    # request is not part of a cycle) and for monthly indents still in approval, which
    # are a working set on the approver's screen rather than a document yet.
    # Hard FK: both tables belong to this module, and RESTRICT because a consolidation
    # that still has members must not be deletable out from under them.
    consolidation_id = Column(
        BigIntPortable, ForeignKey("ind_consolidations.id", ondelete="RESTRICT"),
        nullable=True, index=True)

    # state
    status = Column(String(30), nullable=False, index=True)
    priority = Column(String(20), nullable=False, default="NORMAL")
    total_items = Column(Integer, nullable=False, default=0)
    total_qty = Column(Numeric(16, 3), nullable=False, default=0)
    # Header roll-ups the DB keeps NOT NULL DEFAULT 0. The line rows remain the
    # source of truth; nothing in this module assigns to these yet.
    approved_qty = Column(Numeric(16, 3), nullable=False, default=0, server_default="0")
    issued_qty = Column(Numeric(16, 3), nullable=False, default=0, server_default="0")
    ordered_qty = Column(Numeric(16, 3), nullable=False, default=0, server_default="0")
    estimated_value = Column(Numeric(16, 2), nullable=False, default=0,
                             server_default="0")
    remarks = Column(Text, nullable=True)
    rejected_reason = Column(String(500), nullable=True)

    # approval summary (denormalised from wf_ so list screens need no join)
    current_stage_name = Column(String(200), nullable=True)
    current_approver_name = Column(String(200), nullable=True)
    approved_by_name = Column(String(200), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    is_bookmarked = Column(String(3), nullable=False, default="NO")

    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship(
        "IndentItem", back_populates="indent",
        cascade="all, delete-orphan", lazy="selectin",
    )


Index("ix_ind_indents_dept_status", Indent.department_id, Indent.status)
Index("ix_ind_indents_created", Indent.created_at.desc())
# Mirrors the live composite indexes for the newly mapped columns, so filtering a
# list by type stays an index scan rather than a table scan.
Index("ix_ind_type", Indent.indent_type, Indent.status)
Index("ix_ind_wh", Indent.warehouse_id, Indent.status)
Index("ix_ind_bom", Indent.bom_id)
# Region is a list/statistics/ledger filter, and the monthly grouping reads it with a
# status alongside, so the composite is the shape every one of those queries wants.
Index("ix_ind_region_status", Indent.region_id, Indent.status)


class IndentItem(Base):
    __tablename__ = "ind_indent_items"
    id = pk()
    indent_id = Column(ForeignKey("ind_indents.id", ondelete="CASCADE"), index=True, nullable=False)
    line_no = Column(Integer, nullable=False, default=1)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)   # snapshot
    item_name = Column(String(300), nullable=True)  # snapshot
    uom_code = Column(String(20), nullable=True)     # snapshot
    quantity = Column("requested_qty", Numeric(16, 3), nullable=False)
    approved_quantity = Column("approved_qty", Numeric(16, 3), nullable=False, default=0)
    ordered_quantity = Column("ordered_qty", Numeric(16, 3), nullable=False, default=0)
    received_quantity = Column("received_qty", Numeric(16, 3), nullable=False, default=0)
    # Set by inventory allocation after approval: how much of this line came out of
    # stock. The remainder becomes an MR line. Flow doc §3 steps 3-5.
    allocated_quantity = Column("allocated_qty", Numeric(16, 3), nullable=False, default=0)
    status = Column(String(20), nullable=False,
                    default=IndentItemStatus.PENDING.value)
    remarks = Column(String(500), nullable=True)

    indent = relationship("Indent", back_populates="items")
