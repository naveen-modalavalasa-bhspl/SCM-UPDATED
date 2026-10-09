"""Authenticated, permission-filtered home dashboard endpoint."""
from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user
from app.modules.home import service
from app.modules.home.schemas import DateRange, HomeSummary

router = APIRouter(prefix="/api/home", tags=["home"])


@router.get("/summary", response_model=HomeSummary)
async def summary(
    date_range: DateRange = Query("week"),
    # Read only when `date_range` is "custom"; sending them with any other value is
    # harmless and ignored, so the picker never has to clear them to switch back.
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    return await service.summary(db, user, date_range, date_from, date_to)
