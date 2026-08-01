"""rule_ tables — the data-driven event / condition / action engine.

A business rule is three rows, not a branch in Python: a rule bound to an event, the
conditions that must hold, and the actions to take. Adding a rule is an insert, so
routing changes without a deploy.
"""
from sqlalchemy import (
    JSON, BigInteger, Boolean, Column, Date, DateTime, Integer, String, Text,
)

from app.core.database import Base
from app.shared.models.base import utcnow


class RuleEvent(Base):
    """The catalogue of things a rule can react to.

    context_schema documents the fields an event supplies, which is what lets the
    admin GUI offer a field list instead of a free-text box that silently never matches.
    """
    __tablename__ = "rule_events"
    code = Column(String(50), primary_key=True)
    name = Column(String(200), nullable=False)
    module = Column(String(50), nullable=True)
    description = Column(String(300), nullable=True)
    context_schema = Column(JSON, nullable=True)   # {"quantity": "number", ...}
    is_active = Column(Boolean, nullable=False, default=True)


class Rule(Base):
    __tablename__ = "rule_rules"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    event_code = Column(String(50), nullable=False, index=True)
    name = Column(String(200), nullable=False)
    description = Column(String(300), nullable=True)
    # Lower runs first. Two rules that both match still both fire; priority only
    # decides the order their actions come back in.
    priority = Column(Integer, nullable=False, default=100)
    # When set, no later rule is evaluated once this one matches.
    stop_on_match = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True, index=True)
    effective_from = Column(Date, nullable=True)
    effective_to = Column(Date, nullable=True)
    created_by_id = Column(BigInteger, nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)
    updated_at = Column(DateTime, nullable=False, default=utcnow, onupdate=utcnow)


class RuleCondition(Base):
    """Deliberately the same shape as wf_stage_conditions so both engines share
    workflow/conditions.py rather than each growing its own operator table."""
    __tablename__ = "rule_conditions"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    rule_id = Column(BigInteger, index=True, nullable=False)
    field_name = Column(String(50), nullable=False)
    operator = Column(String(10), nullable=False)      # ConditionOperator
    field_value = Column(String(200), nullable=False)
    logic = Column(String(5), nullable=False, default="AND")   # ConditionLogic


class RuleAction(Base):
    __tablename__ = "rule_actions"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    rule_id = Column(BigInteger, index=True, nullable=False)
    seq = Column(Integer, nullable=False, default=1)
    action_type = Column(String(30), nullable=False)   # RuleActionType
    params = Column(JSON, nullable=True)


class RuleExecution(Base):
    """One row per evaluation, matched or not.

    Without this, "why did this indent go to the warehouse" is unanswerable, and a
    misconfigured rule is invisible until someone notices the wrong outcome.
    """
    __tablename__ = "rule_executions"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    event_code = Column(String(50), nullable=False, index=True)
    rule_id = Column(BigInteger, index=True, nullable=True)
    doc_type = Column(String(30), nullable=True)
    doc_id = Column(BigInteger, nullable=True, index=True)
    matched = Column(Boolean, nullable=False, default=False)
    context = Column(JSON, nullable=True)
    actions = Column(JSON, nullable=True)
    error = Column(Text, nullable=True)
    acted_at = Column(DateTime, nullable=False, default=utcnow, index=True)
