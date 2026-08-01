"""Authenticated, permission-filtered home dashboard endpoint."""
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
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    return await service.summary(db, user, date_range)
