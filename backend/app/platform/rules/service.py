"""Rules engine business logic: rule CRUD with conflict checking, and the catalogue."""
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.platform.rules import conflicts as conflict_check
from app.platform.rules.models import (
    Rule, RuleAction, RuleCondition, RuleEvent, RuleExecution,
)
from app.platform.rules.schemas import RuleIn
from app.platform.settings.service import write_audit
from app.shared.enums import (
    AuditAction, ConditionLogic, ConditionOperator, RuleActionType,
)


def rule_out(rule: Rule, conditions: list[RuleCondition] | None = None,
             actions: list[RuleAction] | None = None) -> dict:
    out = {
        "id": rule.id, "event_code": rule.event_code, "name": rule.name,
        "description": rule.description, "priority": rule.priority,
        "stop_on_match": rule.stop_on_match, "is_active": rule.is_active,
        "effective_from": rule.effective_from.isoformat() if rule.effective_from else None,
        "effective_to": rule.effective_to.isoformat() if rule.effective_to else None,
    }
    if conditions is not None:
        out["conditions"] = [{"id": c.id, "field_name": c.field_name,
                              "operator": c.operator, "field_value": c.field_value,
                              "logic": c.logic} for c in conditions]
    if actions is not None:
        out["actions"] = [{"id": a.id, "seq": a.seq, "action_type": a.action_type,
                           "params": a.params or {}} for a in actions]
    return out


async def _children(db: AsyncSession, rule_id: int):
    conditions = (await db.execute(
        select(RuleCondition).where(RuleCondition.rule_id == rule_id)
        .order_by(RuleCondition.id))).scalars().all()
    actions = (await db.execute(
        select(RuleAction).where(RuleAction.rule_id == rule_id)
        .order_by(RuleAction.seq, RuleAction.id))).scalars().all()
    return list(conditions), list(actions)


def _validate(data: RuleIn) -> None:
    operators = {o.value for o in ConditionOperator}
    logics = {l.value for l in ConditionLogic}
    action_types = {a.value for a in RuleActionType}

    if not data.actions:
        raise ValidationError("A rule needs at least one action")
    if data.effective_from and data.effective_to and data.effective_to < data.effective_from:
        raise ValidationError("effective_to cannot be before effective_from")

    for cond in data.conditions:
        if cond.operator not in operators:
            raise ValidationError(
                f"Unknown operator '{cond.operator}'. "
                f"Valid: {', '.join(sorted(operators))}")
        if cond.logic not in logics:
            raise ValidationError(f"Unknown logic '{cond.logic}'")
        if cond.operator == ConditionOperator.BETWEEN.value \
                and len(cond.field_value.split(",")) != 2:
            raise ValidationError(
                f"BETWEEN on '{cond.field_name}' needs two values, e.g. \"10,50\"")

    for action in data.actions:
        if action.action_type not in action_types:
            raise ValidationError(
                f"Unknown action_type '{action.action_type}'. "
                f"Valid: {', '.join(sorted(action_types))}")


async def _assert_event_exists(db: AsyncSession, event_code: str) -> None:
    if await db.get(RuleEvent, event_code) is None:
        raise ValidationError(
            f"Unknown event '{event_code}'. Register it in rule_events first.")


def _rows(data: RuleIn, rule_id: int | None):
    conditions = [RuleCondition(rule_id=rule_id, field_name=c.field_name,
                                operator=c.operator, field_value=c.field_value,
                                logic=c.logic) for c in data.conditions]
    actions = [RuleAction(rule_id=rule_id, seq=a.seq, action_type=a.action_type,
                          params=a.params) for a in data.actions]
    return conditions, actions


async def check_conflicts(db: AsyncSession, data: RuleIn,
                          exclude_rule_id: int | None = None) -> list[dict]:
    _validate(data)
    conditions, actions = _rows(data, exclude_rule_id)
    found = await conflict_check.find_conflicts(
        db, data.event_code, data.priority, conditions, actions, exclude_rule_id)
    return [c.as_dict() for c in found]


async def _guard_conflicts(db: AsyncSession, data: RuleIn,
                           exclude_rule_id: int | None) -> list[dict]:
    found = await check_conflicts(db, data, exclude_rule_id)
    blocking = [c for c in found if c["severity"] == "error"]
    if blocking and not data.force:
        raise ValidationError(
            "This rule conflicts with an existing one: "
            + " ".join(c["message"] for c in blocking)
            + " Save with force=true to override.")
    return found


async def list_rules(db: AsyncSession, params: PageParams,
                     event_code: str | None = None) -> dict:
    stmt = select(Rule)
    if event_code:
        stmt = stmt.where(Rule.event_code == event_code)
    page = await paginate(db, stmt.order_by(Rule.event_code, Rule.priority, Rule.id),
                          params)
    page["items"] = [rule_out(r) for r in page["items"]]
    return page


async def get_rule(db: AsyncSession, rule_id: int) -> dict:
    rule = await db.get(Rule, rule_id)
    if rule is None:
        raise NotFoundError("Rule not found")
    conditions, actions = await _children(db, rule_id)
    return rule_out(rule, conditions, actions)


async def create_rule(db: AsyncSession, data: RuleIn, actor) -> dict:
    _validate(data)
    await _assert_event_exists(db, data.event_code)
    warnings = await _guard_conflicts(db, data, None)

    rule = Rule(event_code=data.event_code, name=data.name,
                description=data.description, priority=data.priority,
                stop_on_match=data.stop_on_match, is_active=data.is_active,
                effective_from=data.effective_from, effective_to=data.effective_to,
                created_by_id=getattr(actor, "id", None))
    db.add(rule)
    await db.flush()

    conditions, actions = _rows(data, rule.id)
    for row in conditions + actions:
        db.add(row)
    await db.flush()

    await write_audit(db, entity="rule_rules", entity_id=rule.id,
                      action=AuditAction.CREATE, actor=actor,
                      after=rule_out(rule, conditions, actions))
    await db.commit()

    result = await get_rule(db, rule.id)
    result["warnings"] = warnings
    return result


async def update_rule(db: AsyncSession, rule_id: int, data: RuleIn, actor) -> dict:
    rule = await db.get(Rule, rule_id)
    if rule is None:
        raise NotFoundError("Rule not found")
    _validate(data)
    await _assert_event_exists(db, data.event_code)
    warnings = await _guard_conflicts(db, data, rule_id)

    before_conditions, before_actions = await _children(db, rule_id)
    before = rule_out(rule, before_conditions, before_actions)

    for key in ("event_code", "name", "description", "priority", "stop_on_match",
                "is_active", "effective_from", "effective_to"):
        setattr(rule, key, getattr(data, key))

    # Conditions and actions are replaced wholesale. Diffing them would leave stale
    # rows behind whenever the admin GUI reorders or removes one.
    await db.execute(delete(RuleCondition).where(RuleCondition.rule_id == rule_id))
    await db.execute(delete(RuleAction).where(RuleAction.rule_id == rule_id))
    conditions, actions = _rows(data, rule_id)
    for row in conditions + actions:
        db.add(row)
    await db.flush()

    await write_audit(db, entity="rule_rules", entity_id=rule_id,
                      action=AuditAction.UPDATE, actor=actor,
                      before=before, after=rule_out(rule, conditions, actions))
    await db.commit()

    result = await get_rule(db, rule_id)
    result["warnings"] = warnings
    return result


async def deactivate_rule(db: AsyncSession, rule_id: int, actor) -> dict:
    rule = await db.get(Rule, rule_id)
    if rule is None:
        raise NotFoundError("Rule not found")
    rule.is_active = False
    await db.flush()
    await write_audit(db, entity="rule_rules", entity_id=rule_id,
                      action=AuditAction.DEACTIVATE, actor=actor)
    await db.commit()
    return {"success": True, "id": rule_id, "is_active": False}


# --------------------------------------------------------------------------- #
#  Catalogue + history — what the admin GUI builds its editor from
# --------------------------------------------------------------------------- #
async def list_events(db: AsyncSession) -> dict:
    rows = (await db.execute(
        select(RuleEvent).where(RuleEvent.is_active.is_(True)).order_by(RuleEvent.code)
    )).scalars().all()
    return {
        "items": [{"code": e.code, "name": e.name, "module": e.module,
                   "description": e.description,
                   "context_schema": e.context_schema or {}} for e in rows],
        "operators": [o.value for o in ConditionOperator],
        "logics": [l.value for l in ConditionLogic],
        "action_types": [a.value for a in RuleActionType],
    }


async def list_executions(db: AsyncSession, params: PageParams,
                          event_code: str | None = None,
                          doc_id: int | None = None) -> dict:
    stmt = select(RuleExecution)
    if event_code:
        stmt = stmt.where(RuleExecution.event_code == event_code)
    if doc_id is not None:
        stmt = stmt.where(RuleExecution.doc_id == doc_id)
    page = await paginate(db, stmt.order_by(RuleExecution.acted_at.desc()), params)
    page["items"] = [{
        "id": r.id, "event_code": r.event_code, "rule_id": r.rule_id,
        "doc_type": r.doc_type, "doc_id": r.doc_id, "matched": r.matched,
        "context": r.context, "actions": r.actions, "error": r.error,
        "acted_at": r.acted_at.isoformat() if r.acted_at else None,
    } for r in page["items"]]
    return page
