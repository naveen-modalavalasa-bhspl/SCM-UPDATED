"""Wire shapes for the operational approvals module."""
from datetime import date, datetime

from fastapi import Query
from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator


def _utc_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat().replace("+00:00", "Z")


class ApprovalQuantityIn(BaseModel):
    line_id: int = Field(gt=0)
    # allow_inf_nan: `inf` satisfies `ge=0` and would sail past the ceiling check as
    # Decimal("Infinity"). NaN already fails `ge=0`.
    approved_quantity: float = Field(ge=0, allow_inf_nan=False)


class IndentApprovalActionIn(BaseModel):
    comments: str = ""
    items: list[ApprovalQuantityIn] = Field(min_length=1)


class ConsolidationApprovalLineIn(ApprovalQuantityIn):
    """One line's approved quantity, carrying the indent it belongs to so a single
    batch approval can address lines across many documents."""

    indent_id: int = Field(gt=0)


class ConsolidationApprovalIn(BaseModel):
    """Approve every indent the Consolidation screen is showing, in one act.

    `indent_ids` is the authority on WHAT gets approved — the filtered set the
    approver is looking at. `lines` only says how much: a line the screen never
    edited is simply absent and keeps this approver's ceiling.
    """

    comments: str = ""
    indent_ids: list[int] = Field(min_length=1)
    lines: list[ConsolidationApprovalLineIn] = []


class ConsolidationApprovalFailureOut(BaseModel):
    indent_id: int
    reason: str
    # True when the batch deliberately left this one alone rather than hitting a
    # problem with it. A fully-served indent has nothing left to approve, so not
    # approving it is the correct outcome — reporting that in red as a failure taught
    # approvers to distrust a screen that was doing the right thing.
    skipped: bool = False


class ConsolidationApprovalOut(BaseModel):
    """What the batch actually did. `failed` is never an error response: an indent
    that moved on since the screen loaded is reported, not rolled back over the
    others."""

    approved_count: int
    approved_indent_ids: list[int]
    failed: list[ConsolidationApprovalFailureOut] = []


class IndentRejectionIn(BaseModel):
    comments: str = Field(min_length=1, max_length=2000)

    @field_validator("comments")
    @classmethod
    def rejection_reason_required(cls, value: str) -> str:
        reason = value.strip()
        if not reason:
            raise ValueError("Rejection reason is required")
        return reason


class IndentReturnIn(BaseModel):
    comments: str = Field(min_length=1, max_length=2000)

    @field_validator("comments")
    @classmethod
    def correction_reason_required(cls, value: str) -> str:
        reason = value.strip()
        if not reason:
            raise ValueError("Correction instructions are required")
        return reason


class ApprovalActionIn(BaseModel):
    comments: str = Field(default="", max_length=2000)


class ApprovalRejectionIn(BaseModel):
    comments: str = Field(min_length=1, max_length=2000)

    @field_validator("comments")
    @classmethod
    def reason_required(cls, value: str) -> str:
        reason = value.strip()
        if not reason:
            raise ValueError("Rejection reason is required")
        return reason


class ApprovalActionOut(BaseModel):
    doc_type: str
    doc_id: int
    action: str


class ApprovalReportOut(BaseModel):
    total_decisions: int
    approved: int
    rejected: int
    returned: int
    pending: int
    overdue: int
    average_decision_hours: float


class ReminderOut(BaseModel):
    approver_id: int
    pending_count: int
    notifications_created: int


class ApprovalIndentLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    requested_quantity: float
    approved_quantity: float
    # The ceiling for this approver: the request at the first level, and whatever the
    # level below approved after that. Approvers may only reduce.
    max_quantity: float
    remarks: str | None = None


class ApprovalIndentOut(BaseModel):
    id: int
    indent_no: str
    status: str
    priority: str
    requested_by_name: str | None = None
    position_name: str | None = None
    department_name: str | None = None
    office_name: str | None = None
    current_stage_name: str | None = None
    current_approver_name: str | None = None
    can_return_for_correction: bool = False
    created_at: datetime
    items: list[ApprovalIndentLineOut]

    @field_serializer("created_at", when_used="json")
    def serialize_datetime(self, value: datetime):
        return _utc_iso(value)


class ConsolidatedItemAllocationOut(BaseModel):
    """One indent's share of a consolidated item line.

    Carries the line id so the approver can cut the batch total for an item and
    have that cut land on each contributing indent's own line, through the
    existing per-indent approve endpoint. Nothing is stored here either.
    """

    indent_id: int
    indent_no: str
    line_id: int
    requested_by_name: str | None = None
    requested_quantity: float
    ceiling_quantity: float


class ConsolidatedItemOut(BaseModel):
    """One item, summed across every Monthly indent in a consolidation batch.

    Aggregated purely from ind_indent_items at request time — nothing here is
    stored, so it can never drift from the indents it was computed from.
    """

    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    # Decimal places this unit may carry (app.shared.uom): 0 for anything counted in
    # whole numbers, 3 for anything measured. The screen splits an approved total in
    # steps of this, so a countable item can never be shared out as 5.7.
    uom_decimals: int = 3
    total_requested_quantity: float
    # Sum of each line's approval ceiling — the most this approver could pass on
    # for this item across the whole batch, before touching anything.
    total_ceiling_quantity: float
    # How many of the batch's indents actually carry this item.
    indent_count: int
    # Who asked for it, per indent, so the screen can split an approved total back
    # across the indents that requested the item.
    allocations: list[ConsolidatedItemAllocationOut] = []


class ConsolidationFilters:
    """The dimensions an approver can narrow their Monthly consolidation by.

    Query params rather than a body, and a plain class rather than a BaseModel, for
    the same reason `PageParams` is one: FastAPI reads the `Query` defaults straight
    off `__init__`, so the router stays a single `Depends()`.

    Every field is an id, never a name: two projects can share a display name, and the
    snapshot columns on ind_indents are exactly that — snapshots. `item_id` is the one
    that also narrows the LINES that are summed, because "show me Helmet" means the
    Helmet quantities, not every quantity on an indent that happens to contain Helmet.
    """

    def __init__(
        self,
        cycle: str | None = Query(None, description="Monthly cycle, YYYY-MM or UNDATED"),
        region_id: int | None = Query(None),
        project_id: int | None = Query(None),
        vehicle_id: int | None = Query(None),
        office_id: int | None = Query(None),
        requester_id: int | None = Query(None),
        item_id: int | None = Query(None),
        search: str = Query("", description="Indent no., requester or item"),
        raised_from: date | None = Query(None),
        raised_to: date | None = Query(None),
    ):
        self.search = (search or "").strip()
        self.raised_from = raised_from
        self.raised_to = raised_to
        self.cycle = cycle or None
        self.region_id = region_id
        self.project_id = project_id
        self.vehicle_id = vehicle_id
        self.office_id = office_id
        self.requester_id = requester_id
        self.item_id = item_id

    def as_dict(self) -> dict:
        return {
            "cycle": self.cycle, "region_id": self.region_id,
            "project_id": self.project_id, "vehicle_id": self.vehicle_id,
            "office_id": self.office_id, "requester_id": self.requester_id,
            "item_id": self.item_id, "search": self.search or None,
            "raised_from": self.raised_from.isoformat() if self.raised_from else None,
            "raised_to": self.raised_to.isoformat() if self.raised_to else None,
        }


class ConsolidationFilterOptionOut(BaseModel):
    """One selectable value in a filter dropdown, with how many of the approver's
    Monthly indents carry it. Always derived from the approver's own unfiltered
    pending set, never from a master table — a dropdown must not offer a project
    that would return nothing."""

    value: str
    label: str
    indent_count: int


class ConsolidationFilterOptionsOut(BaseModel):
    """Dropdown contents for every supported dimension, in one payload.

    A dimension with an empty list is one the current data cannot answer (no indent
    in the queue carries a vehicle, say); the screen hides that control rather than
    showing an empty dropdown. `phase` is absent entirely — see the module docstring
    in service.py: `ind_indents` has no phase/sub-project column.
    """

    cycle: list[ConsolidationFilterOptionOut] = []
    region: list[ConsolidationFilterOptionOut] = []
    project: list[ConsolidationFilterOptionOut] = []
    vehicle: list[ConsolidationFilterOptionOut] = []
    office: list[ConsolidationFilterOptionOut] = []
    requester: list[ConsolidationFilterOptionOut] = []
    item: list[ConsolidationFilterOptionOut] = []


class ConsolidationIndentSummaryOut(BaseModel):
    """One original indent's row inside a consolidation batch.

    Header-level totals only, not line items: this is a triage view. Full detail
    and the actual approve/reject/return actions stay on the existing single-indent
    review screen (`GET/POST /api/approvals/indents/{id}/...`), which this batch
    never replaces or merges into.
    """

    id: int
    indent_no: str
    status: str
    requested_by_id: int | None = None
    requested_by_name: str | None = None
    requested_by_code: str | None = None
    region_id: int | None = None
    region_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    # Snapshots already on ind_indents; surfaced here so the row shows the same
    # dimensions the filter bar offers, with no extra call per indent.
    office_id: int | None = None
    office_name: str | None = None
    vehicle_id: int | None = None
    vehicle_number: str | None = None
    current_stage_name: str | None = None
    line_count: int
    total_requested_quantity: float
    # None at the first approval stage, where there is nothing "previous" yet —
    # matches _load_indent_task's has_previous_approval rule.
    previous_approved_quantity: float | None = None
    # What this approver could pass on as-is: equals total_requested_quantity at
    # the first stage, equals previous_approved_quantity at every stage after.
    current_ceiling_quantity: float


class ConsolidationBatchOut(BaseModel):
    """Every Monthly indent from this approver's own reporting subtree in one
    monthly cycle, at the stage currently pending with them.

    The batch is the CYCLE plus the approver — nothing else. Region, project,
    vehicle, office, requester and item are dimensions of the indents inside it,
    offered as filters, and deliberately do not split the workspace into more
    batches: an approver reviewing August reviews one August, however many regions
    it spans.

    Not a stored entity: batch_key is the cycle, and everything below is recomputed
    on every request from live wf_pending/wf_instances/ind_indents rows. There is
    nothing here that can drift from the underlying indents, because there is
    nothing here but the underlying indents, grouped.

    `region_id`/`project_id` survive as "the one value, if the filtered set has only
    one" — a header hint after filtering, not a grouping key.
    """

    batch_key: str
    cycle: str
    #: The consolidation document these indents belong to — the SAME number the
    #: Fulfilment Queue and Allocation Approvals print for this set. Null only for
    #: monthly indents raised before documents existed.
    consolidation_no: str | None = None
    consolidation_status: str | None = None
    month_label: str
    region_id: int | None = None
    region_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    current_stage_name: str | None = None
    indent_count: int
    requester_count: int
    # Distinct dimension counts across the FILTERED indents in this cycle — the
    # "24 indents / 12 requesters / 4 projects / 3 regions" line on the screen.
    project_count: int = 0
    region_count: int = 0
    requesters: list[str]
    consolidated_items: list[ConsolidatedItemOut]
    indents: list[ConsolidationIndentSummaryOut]


class ConsolidationOut(BaseModel):
    """The whole Consolidation workspace in one response.

    Filter choices ship alongside the filtered result so the screen never fans out
    into a request per dropdown: options come from the approver's unfiltered pending
    set (so a filter can always be widened again), while `items` and every total in
    it reflect the filters actually applied.
    """

    items: list[ConsolidationBatchOut]
    filter_options: ConsolidationFilterOptionsOut
    applied: dict
    # Totals across every cycle in `items`, so the header can state the filtered
    # scope without the screen re-adding numbers the service already computed.
    total_indent_count: int = 0
    total_requester_count: int = 0
    # Monthly indents pending with this approver before any filter — lets the screen
    # say "8 of 24" without a second request.
    unfiltered_indent_count: int = 0


# ---------------- Serving an indent from the approver's own stock ----------------

class IssueFromStockLineIn(BaseModel):
    """One line to serve now, and which of the approver's points it comes out of."""
    line_id: int = Field(gt=0)
    warehouse_id: int = Field(gt=0)
    quantity: float = Field(gt=0, allow_inf_nan=False)


class IssueFromStockIn(BaseModel):
    """Issue what you have against an indent, without leaving the approval screen.

    `reason` is free text and is the ONLY thing the user says about the nature of the
    move — whether it is an issue, a transfer or a bin change is derived from the two
    points, never chosen, so it cannot be used to dodge an approval.
    """
    lines: list[IssueFromStockLineIn] = Field(min_length=1)
    reason: str = Field(default="", max_length=500)
    # Send the indent on to the next rung once what is held has been issued. The
    # approved quantities are untouched — only the remainder travels — so the next
    # approver sees exactly what is still owed and nothing is re-decided.
    forward_remainder: bool = False
