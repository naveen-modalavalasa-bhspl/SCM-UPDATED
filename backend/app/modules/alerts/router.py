"""Alert catalog endpoint.

Authenticated but not permission-gated, following `modules/home/router.py`: the
catalog is UI copy, identical for every role, and reveals no record. Gating it
would mean inventing a permission code for a string table, which
`platform/rbac/permissions.py` exists to prevent.
"""
from fastapi import APIRouter, Depends

from app.core.dependencies import get_current_user
from app.modules.alerts import service
from app.modules.alerts.schemas import AlertCatalog, AlertDef

router = APIRouter(prefix="/api/alerts", tags=["alerts"])


@router.get("/catalog", response_model=AlertCatalog)
async def catalog(user=Depends(get_current_user)):
    return service.catalog()


@router.get("/catalog/{code}", response_model=AlertDef)
async def get_alert(code: str, user=Depends(get_current_user)):
    return service.get(code)
