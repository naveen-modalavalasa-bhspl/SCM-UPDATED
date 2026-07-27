"""Home dashboard endpoint."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user
from app.platform.home import service
from app.platform.home.schemas import HomeSummary

router = APIRouter(prefix="/api/home", tags=["home"])


@router.get("/summary", response_model=HomeSummary)
async def summary(db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    return await service.summary(db, user)
