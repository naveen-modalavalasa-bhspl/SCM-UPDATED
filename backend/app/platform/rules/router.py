"""Rules engine endpoints. Routers stay thin; the logic is in service.py (rule 2)."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.core.pagination import PageParams
from app.platform.rbac import permissions as perms
from app.platform.rules import evaluator, service
from app.platform.rules.schemas import RuleIn, SimulateIn

router = APIRouter(prefix="/api/rules", tags=["rules"])


@router.get("/events")
async def list_events(db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    return await service.list_events(db)


@router.get("")
async def list_rules(params: PageParams = Depends(), event_code: str | None = None,
                     db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    return await service.list_rules(db, params, event_code)


@router.get("/executions")
async def list_executions(params: PageParams = Depends(), event_code: str | None = None,
                          doc_id: int | None = None,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(perms.ADMIN_RULES_MANAGE))):
    return await service.list_executions(db, params, event_code, doc_id)


@router.get("/{rule_id}")
async def get_rule(rule_id: int, db: AsyncSession = Depends(get_db),
                   user=Depends(get_current_user)):
    return await service.get_rule(db, rule_id)


@router.post("")
async def create_rule(data: RuleIn, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ADMIN_RULES_MANAGE))):
    return await service.create_rule(db, data, user)


@router.put("/{rule_id}")
async def update_rule(rule_id: int, data: RuleIn, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ADMIN_RULES_MANAGE))):
    return await service.update_rule(db, rule_id, data, user)


@router.delete("/{rule_id}")
async def deactivate_rule(rule_id: int, db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(perms.ADMIN_RULES_MANAGE))):
    return await service.deactivate_rule(db, rule_id, user)


@router.post("/check-conflicts")
async def check_conflicts(data: RuleIn, rule_id: int | None = None,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(perms.ADMIN_RULES_MANAGE))):
    """Called by the rule builder before saving, so conflicts surface while editing."""
    return {"conflicts": await service.check_conflicts(db, data, rule_id)}


@router.post("/simulate")
async def simulate(data: SimulateIn, db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.ADMIN_RULES_MANAGE))):
    """Dry run a context against the live rules without recording an execution."""
    actions = await evaluator.evaluate(db, data.event_code, data.context)
    return {"matched": bool(actions), "actions": [a.as_dict() for a in actions]}
