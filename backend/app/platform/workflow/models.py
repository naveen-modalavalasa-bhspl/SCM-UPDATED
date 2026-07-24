"""wf_ tables — mapped to the canonical scm_rebuild schema.

Note vs the old build: stage approver is `employee_id` (not user_id); conditions use
`field_name`/`field_value`; instances track `current_sequence` and have NO context
column (the engine re-evaluates conditions from context passed by the module); pending
approvals are materialised in `wf_pending`.
"""
from sqlalchemy import (
    BigInteger, Boolean, Column, Date, DateTime, Integer, Numeric, String, Text,
)

from app.core.database import Base
from app.shared.models.base import utcnow


class Workflow(Base):
    __tablename__ = "wf_workflows"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    code = Column(String(50), nullable=False, index=True)
    name = Column(String(200), nullable=False)
    doc_type = Column(String(30), nullable=False, index=True)
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
    role_id = Column(BigInteger, nullable=True)
    employee_id = Column(BigInteger, nullable=True)
    approval_mode = Column(String(20), nullable=False, default="ANY_ONE")
    is_optional = Column(Boolean, nullable=False, default=False)
    can_edit_document = Column(Boolean, nullable=False, default=False)
    sla_hours = Column(Integer, nullable=True)


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
