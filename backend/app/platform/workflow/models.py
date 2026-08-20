"""wf_ tables — mapped to the canonical scm_rebuild schema.

Note vs the old build: stage approver is `employee_id` (not user_id); conditions use
`field_name`/`field_value`; instances track `current_sequence` and have NO context
column (the engine re-evaluates conditions from context passed by the module); pending
approvals are materialised in `wf_pending`.
"""
from sqlalchemy import (
    JSON, BigInteger, Boolean, Column, Date, DateTime, Integer, Numeric, String, Text,
)

from app.core.database import Base
from app.shared.models.base import utcnow


class Workflow(Base):
    __tablename__ = "wf_workflows"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    code = Column(String(50), nullable=False, index=True)
    name = Column(String(200), nullable=False)
    doc_type = Column(String(30), nullable=False, index=True)
    # A ladder is scoped to one project; NULL means the company-wide default, used by
    # any project that has no ladder of its own. See workflow/ladder.py.
    project_id = Column(BigInteger, index=True, nullable=True)
    project_name = Column(String(200), nullable=True)
    # Which RANK of raiser this chain is for (hcm_positions.role_id), or NULL for the
    # default used by everyone else. A Store Keeper's indent and an RM's are the same
    # document travelling different distances — the same ladder cannot say both, so a
    # chain may be pinned to the rank that raised it. NULL is what every chain saved
    # before this existed carries, and it keeps behaving exactly as it did.
    raiser_role_id = Column(BigInteger, index=True, nullable=True)
    # Snapshotted at save (rule 10): HCM re-keys its roles at a cutover, and a chain
    # must still be able to say which rank it was built for.
    raiser_role_name = Column(String(200), nullable=True)
    module = Column(String(30), nullable=True)
    version = Column(Integer, nullable=False, default=1)
    is_active = Column(Boolean, nullable=False, default=True)
    effective_from = Column(Date, nullable=True)
    effective_to = Column(Date, nullable=True)
    created_by_id = Column(BigInteger, nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)


class Stage(Base):
    __tablename__ = "wf_stages"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    workflow_id = Column(BigInteger, index=True, nullable=False)
    sequence = Column(Integer, nullable=False)
    name = Column(String(200), nullable=False)
    approver_type = Column(String(30), nullable=False)
    position_id = Column(BigInteger, index=True, nullable=True)
    # A stage carrying position_role_id is a LADDER RUNG: it names a rank
    # (hcm_positions.role_id — COO, SPH, REGIONAL MANAGER…), not a person and not a
    # position row, and the engine finds the holder by walking up the raiser's own
    # reporting line. Stages without it behave exactly as before.
    position_role_id = Column(BigInteger, index=True, nullable=True)
    # A stage carrying post_id is a LOCAL POST rung — a chair this system owns because
    # HCM has no position for it (SCM Head, Indent Team, Logistics…). Resolved from
    # wf_approval_post_members, never from the HCM mirror. See workflow/posts.py.
    post_id = Column(BigInteger, index=True, nullable=True)
    is_enabled = Column(Boolean, nullable=False, default=True)
    role_id = Column(BigInteger, nullable=True)
    employee_id = Column(BigInteger, nullable=True)
    approval_mode = Column(String(20), nullable=False, default="ANY_ONE")
    is_optional = Column(Boolean, nullable=False, default=False)
    can_edit_document = Column(Boolean, nullable=False, default=False)
    sla_hours = Column(Integer, nullable=True)


class ApprovalPost(Base):
    """A chair this system owns, for the steps HCM has no position for.

    The org chart the approval flow needs (SCM Head, Indent Team, Logistics, Director,
    Accounts) does not exist in the HCM mirror and cannot be made to: those posts were
    never created there, and the six warehouse posts that DO exist arrive with no
    project and no parent, so nothing can be climbed to reach them.

    So a rung may name one of these instead. It is still a POST, not a person — seats
    are filled by `ApprovalPostMember` and the chair outlives whoever sits in it.

    `hcm_position_id` is the escape hatch: the day HCM finally creates the real
    position, point the local post at it and every saved ladder keeps working.
    """
    __tablename__ = "wf_approval_posts"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    code = Column(String(50), nullable=False, index=True)
    name = Column(String(200), nullable=False)
    # Free text, shown as a grouping header on the config screen (e.g. "SCM",
    # "Purchase"). Not an FK — HCM's departments are the wrong shape for these.
    department = Column(String(120), nullable=True)
    hcm_position_id = Column(BigInteger, index=True, nullable=True)
    # The job profile this chair carries. Seating somebody grants it; unseating them
    # takes it away again, so access follows the chair rather than being handed to each
    # person by hand. Optional — a post used only as a ladder rung needs none.
    rbac_role_id = Column(BigInteger, index=True, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)


class ApprovalPostMember(Base):
    """Who currently sits in a local post. Soft FK to hcm_employees (rule 10)."""
    __tablename__ = "wf_approval_post_members"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    post_id = Column(BigInteger, index=True, nullable=False)
    employee_id = Column(BigInteger, index=True, nullable=False)
    # Snapshotted at seating time so a retired employee still reads back (rule 10).
    employee_name = Column(String(200), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)


class StageCondition(Base):
    __tablename__ = "wf_stage_conditions"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    stage_id = Column(BigInteger, index=True, nullable=False)
    field_name = Column(String(50), nullable=False)
    operator = Column(String(10), nullable=False)
    field_value = Column(String(200), nullable=False)
    logic = Column(String(5), nullable=False, default="AND")


class Instance(Base):
    __tablename__ = "wf_instances"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    doc_type = Column(String(30), nullable=False, index=True)
    doc_id = Column(BigInteger, nullable=False)
    doc_no = Column(String(50), nullable=True)
    workflow_id = Column(BigInteger, index=True, nullable=False)
    project_id = Column(BigInteger, index=True, nullable=True)
    # The ladder resolved to real positions at submit time and frozen here, so editing
    # a ladder can never move a document that is already in approval. A list of
    # {sequence, position_id, position_name, level_id, level_name}.
    resolved_chain = Column(JSON, nullable=True)
    current_sequence = Column(Integer, nullable=False, default=0)
    current_stage_name = Column(String(200), nullable=True)
    status = Column(String(20), nullable=False, default="IN_PROGRESS", index=True)
    started_by_id = Column(BigInteger, nullable=True)
    started_by_name = Column(String(200), nullable=True)
    started_at = Column(DateTime, nullable=False, default=utcnow)
    completed_at = Column(DateTime, nullable=True)
    due_at = Column(DateTime, nullable=True)


class Action(Base):
    __tablename__ = "wf_actions"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    instance_id = Column(BigInteger, index=True, nullable=False)
    stage_sequence = Column(Integer, nullable=False)
    stage_name = Column(String(200), nullable=True)
    actor_id = Column(BigInteger, index=True, nullable=True)
    actor_name = Column(String(200), nullable=True)
    actor_position = Column(String(200), nullable=True)
    action = Column(String(20), nullable=False)
    comments = Column(Text, nullable=True)
    acted_at = Column(DateTime, nullable=False, default=utcnow)


class Delegation(Base):
    __tablename__ = "wf_delegations"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    from_employee_id = Column(BigInteger, index=True, nullable=False)
    from_employee_name = Column(String(200), nullable=True)
    to_employee_id = Column(BigInteger, nullable=False)
    to_employee_name = Column(String(200), nullable=True)
    doc_type = Column(String(30), nullable=True)
    valid_from = Column(Date, nullable=False)
    valid_to = Column(Date, nullable=False)
    reason = Column(String(300), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)


class Pending(Base):
    """Who owes a decision on a document right now.

    NOT FIXED, and it cannot be fixed in a query — recorded here because this is where
    the answer would have to live.

    There is no position column. The resolver picks an approver BY POSITION and then
    writes only `approver_id`, so an employee holding two positions sees their approvals
    from either session: the driver hat shows the storekeeper hat's queue. Every other
    reader in the app can hat-scope because its table carries a position (`ind_indents`)
    or a position-name snapshot (`wf_actions.actor_position`, which is what "My
    Decisions" now matches on). This one carries neither.

    WITHOUT a `position_id` written here at resolve time, the approval inbox is
    permanently person-scoped and no RBAC setting can change that. Adding it is a
    migration plus one line in the resolver — deliberately not done as part of the
    2026-08-20 scoping pass, because it changes an approval path and that needs its own
    test run.
    """
    __tablename__ = "wf_pending"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    instance_id = Column(BigInteger, index=True, nullable=False)
    stage_sequence = Column(Integer, nullable=False)
    approver_id = Column(BigInteger, index=True, nullable=False)
    doc_type = Column(String(30), nullable=False)
    doc_id = Column(BigInteger, nullable=False)
    doc_no = Column(String(50), nullable=True)
    doc_summary = Column(String(300), nullable=True)
    requested_by_name = Column(String(200), nullable=True)
    amount = Column(Numeric(16, 2), nullable=True)
    due_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)
