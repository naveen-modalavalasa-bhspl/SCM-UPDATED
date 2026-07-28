"""Rules engine end to end: matching, priority, fulfillment routing, conflict refusal."""
import pytest

from app.platform.rbac import permissions as perms
from app.platform.rules import evaluator
from app.platform.rules.models import RuleEvent, RuleExecution
from app.shared.enums import ConditionOperator, FulfillmentTarget, RuleActionType

EVENT = "INDENT_SUBMITTED"


@pytest.fixture
async def event(db):
    db.add(RuleEvent(code=EVENT, name="Indent submitted", module="indents",
                     context_schema={"quantity": "number", "category_code": "string"}))
    await db.commit()


@pytest.fixture
async def admin(client, make_user, login, event):
    await make_user(employee_id=1, username="admin", password="pw",
                    permissions=[perms.ADMIN_RULES_MANAGE])
    return await login("admin", "pw")


def rule(name, conditions, target, priority=100, **extra):
    return {"event_code": EVENT, "name": name, "priority": priority,
            "conditions": conditions,
            "actions": [{"action_type": RuleActionType.ROUTE_FULFILLMENT.value,
                         "params": {"target": target}}],
            **extra}


def gt(field, value):
    return {"field_name": field, "operator": ConditionOperator.GT.value,
            "field_value": str(value)}


def eq(field, value):
    return {"field_name": field, "operator": ConditionOperator.EQ.value,
            "field_value": str(value)}


# ------------------------------ CRUD ------------------------------ #
async def test_create_rule_returns_conditions_and_actions(client, admin):
    r = await client.post("/api/rules", headers=admin, json=rule(
        "Bulk to warehouse", [gt("quantity", 100)], FulfillmentTarget.WAREHOUSE.value))
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["conditions"]) == 1
    assert body["actions"][0]["params"] == {"target": "WAREHOUSE"}


async def test_rule_needs_at_least_one_action(client, admin):
    r = await client.post("/api/rules", headers=admin, json={
        "event_code": EVENT, "name": "Empty", "conditions": [], "actions": []})
    assert r.status_code == 422


async def test_unknown_event_is_rejected(client, admin):
    payload = rule("Orphan", [], FulfillmentTarget.INVENTORY.value)
    payload["event_code"] = "NOT_REGISTERED"
    r = await client.post("/api/rules", headers=admin, json=payload)
    assert r.status_code == 422


async def test_unknown_operator_is_rejected(client, admin):
    r = await client.post("/api/rules", headers=admin, json=rule(
        "Bad op", [{"field_name": "quantity", "operator": "ROUGHLY",
                    "field_value": "10"}], FulfillmentTarget.INVENTORY.value))
    assert r.status_code == 422


async def test_between_needs_two_values(client, admin):
    r = await client.post("/api/rules", headers=admin, json=rule(
        "Bad between", [{"field_name": "quantity",
                         "operator": ConditionOperator.BETWEEN.value,
                         "field_value": "10"}], FulfillmentTarget.INVENTORY.value))
    assert r.status_code == 422


async def test_managing_rules_requires_the_permission(client, make_user, login, event):
    await make_user(employee_id=9, username="nobody", password="pw",
                    permissions=["indent.view"])
    headers = await login("nobody", "pw")
    r = await client.post("/api/rules", headers=headers, json=rule(
        "Nope", [], FulfillmentTarget.INVENTORY.value))
    assert r.status_code == 403


async def test_update_replaces_conditions_wholesale(client, admin):
    created = (await client.post("/api/rules", headers=admin, json=rule(
        "R", [gt("quantity", 100)], FulfillmentTarget.WAREHOUSE.value))).json()

    updated = (await client.put(f"/api/rules/{created['id']}", headers=admin, json=rule(
        "R", [eq("category_code", "CAPITAL")],
        FulfillmentTarget.WAREHOUSE.value))).json()

    assert len(updated["conditions"]) == 1
    assert updated["conditions"][0]["field_name"] == "category_code"


async def test_deactivated_rule_stops_matching(client, admin, db):
    created = (await client.post("/api/rules", headers=admin, json=rule(
        "R", [], FulfillmentTarget.WAREHOUSE.value))).json()
    await client.delete(f"/api/rules/{created['id']}", headers=admin)

    assert await evaluator.evaluate(db, EVENT, {"quantity": 500}) == []


# ---------------------------- evaluation ---------------------------- #
async def fresh(db):
    """Start a new read snapshot on the test session.

    `client` requests run on their own session; `db` is a second one that already has
    a transaction open by the time a rule is POSTed. InnoDB is REPEATABLE READ, so
    that snapshot predates the new row and evaluate() sees nothing. Ending the
    transaction first is the difference between testing the evaluator and testing
    MySQL's isolation level.
    """
    await db.rollback()


async def test_matching_rule_returns_its_action(client, admin, db):
    await client.post("/api/rules", headers=admin, json=rule(
        "Bulk", [gt("quantity", 100)], FulfillmentTarget.WAREHOUSE.value))

    await fresh(db)
    actions = await evaluator.evaluate(db, EVENT, {"quantity": 150})
    assert [a.params["target"] for a in actions] == ["WAREHOUSE"]


async def test_non_matching_context_returns_nothing(client, admin, db):
    await client.post("/api/rules", headers=admin, json=rule(
        "Bulk", [gt("quantity", 100)], FulfillmentTarget.WAREHOUSE.value))

    assert await evaluator.evaluate(db, EVENT, {"quantity": 5}) == []


async def test_priority_orders_the_returned_actions(client, admin, db):
    await client.post("/api/rules", headers=admin, json=rule(
        "Second", [], FulfillmentTarget.WAREHOUSE.value, priority=200))
    await client.post("/api/rules", headers=admin, json=rule(
        "First", [], FulfillmentTarget.INVENTORY.value, priority=10))

    await fresh(db)
    actions = await evaluator.evaluate(db, EVENT, {"quantity": 1})
    assert [a.rule_name for a in actions] == ["First", "Second"]


async def test_stop_on_match_suppresses_later_rules(client, admin, db):
    await client.post("/api/rules", headers=admin, json=rule(
        "Exclusive", [], FulfillmentTarget.INVENTORY.value, priority=10,
        stop_on_match=True))
    await client.post("/api/rules", headers=admin, json=rule(
        "Never reached", [], FulfillmentTarget.WAREHOUSE.value, priority=20))

    await fresh(db)
    actions = await evaluator.evaluate(db, EVENT, {"quantity": 1})
    assert [a.rule_name for a in actions] == ["Exclusive"]


async def test_fire_records_an_execution_even_when_nothing_matched(client, admin, db):
    await evaluator.fire(db, EVENT, {"quantity": 1}, doc_type="INDENT", doc_id=7)
    await db.commit()

    from sqlalchemy import select
    rows = (await db.execute(select(RuleExecution))).scalars().all()
    assert len(rows) == 1
    assert rows[0].matched is False
    assert rows[0].doc_id == 7


async def test_fire_serialises_a_decimal_context(client, admin, db):
    """Contexts carry Decimals straight off the ORM; the JSON column rejects them."""
    from decimal import Decimal
    await evaluator.fire(db, EVENT, {"quantity": Decimal("12.500")}, doc_id=1)
    await db.commit()

    from sqlalchemy import select
    row = (await db.execute(select(RuleExecution))).scalars().first()
    assert row.context["quantity"] == "12.500"


async def test_simulate_does_not_record(client, admin, db):
    await client.post("/api/rules", headers=admin, json=rule(
        "Bulk", [gt("quantity", 100)], FulfillmentTarget.WAREHOUSE.value))

    r = await client.post("/api/rules/simulate", headers=admin,
                          json={"event_code": EVENT, "context": {"quantity": 500}})
    assert r.json()["matched"] is True

    from sqlalchemy import select
    assert (await db.execute(select(RuleExecution))).scalars().all() == []


# ---------------------------- conflicts ---------------------------- #
async def test_same_priority_overlap_is_refused(client, admin):
    await client.post("/api/rules", headers=admin, json=rule(
        "To warehouse", [gt("quantity", 100)], FulfillmentTarget.WAREHOUSE.value,
        priority=100))

    r = await client.post("/api/rules", headers=admin, json=rule(
        "To inventory", [gt("quantity", 200)], FulfillmentTarget.INVENTORY.value,
        priority=100))
    assert r.status_code == 422
    # One error shape for the whole system: {"success": false, "error": "<text>"}.
    assert "conflict" in r.json()["error"].lower()


async def test_force_overrides_a_conflict(client, admin):
    await client.post("/api/rules", headers=admin, json=rule(
        "To warehouse", [gt("quantity", 100)], FulfillmentTarget.WAREHOUSE.value))

    payload = rule("To inventory", [gt("quantity", 200)],
                   FulfillmentTarget.INVENTORY.value)
    payload["force"] = True
    assert (await client.post("/api/rules", headers=admin,
                              json=payload)).status_code == 200


async def test_different_priority_overlap_is_only_a_warning(client, admin):
    await client.post("/api/rules", headers=admin, json=rule(
        "To warehouse", [gt("quantity", 100)], FulfillmentTarget.WAREHOUSE.value,
        priority=100))

    r = await client.post("/api/rules", headers=admin, json=rule(
        "To inventory", [gt("quantity", 200)], FulfillmentTarget.INVENTORY.value,
        priority=50))
    assert r.status_code == 200
    assert r.json()["warnings"][0]["severity"] == "warning"


async def test_separate_conditions_do_not_conflict(client, admin):
    await client.post("/api/rules", headers=admin, json=rule(
        "Consumables", [eq("category_code", "CONSUMABLE")],
        FulfillmentTarget.INVENTORY.value))

    r = await client.post("/api/rules", headers=admin, json=rule(
        "Capital", [eq("category_code", "CAPITAL")],
        FulfillmentTarget.WAREHOUSE.value))
    assert r.status_code == 200
    assert r.json()["warnings"] == []


async def test_same_conclusion_is_not_a_conflict(client, admin):
    """Two overlapping rules that route to the same place agree, so nothing is wrong."""
    await client.post("/api/rules", headers=admin, json=rule(
        "A", [gt("quantity", 100)], FulfillmentTarget.WAREHOUSE.value))

    r = await client.post("/api/rules", headers=admin, json=rule(
        "B", [gt("quantity", 200)], FulfillmentTarget.WAREHOUSE.value))
    assert r.status_code == 200


async def test_different_action_types_do_not_conflict(client, admin):
    await client.post("/api/rules", headers=admin, json=rule(
        "Route it", [gt("quantity", 100)], FulfillmentTarget.WAREHOUSE.value))

    r = await client.post("/api/rules", headers=admin, json={
        "event_code": EVENT, "name": "Approve it", "priority": 100,
        "conditions": [gt("quantity", 100)],
        "actions": [{"action_type": RuleActionType.ROUTE_APPROVAL.value,
                     "params": {"workflow_code": "WF_HIGH"}}]})
    assert r.status_code == 200


async def test_editing_a_rule_does_not_conflict_with_itself(client, admin):
    created = (await client.post("/api/rules", headers=admin, json=rule(
        "Solo", [gt("quantity", 100)], FulfillmentTarget.WAREHOUSE.value))).json()

    r = await client.put(f"/api/rules/{created['id']}", headers=admin, json=rule(
        "Solo renamed", [gt("quantity", 150)], FulfillmentTarget.INVENTORY.value))
    assert r.status_code == 200


async def test_events_endpoint_exposes_the_editor_vocabulary(client, admin):
    body = (await client.get("/api/rules/events", headers=admin)).json()
    assert body["items"][0]["code"] == EVENT
    assert ConditionOperator.BETWEEN.value in body["operators"]
    assert RuleActionType.SPLIT_FULFILLMENT.value in body["action_types"]
