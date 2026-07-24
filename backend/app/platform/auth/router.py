from fastapi import APIRouter, Depends
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user
from app.platform.auth import service
from app.platform.auth.schemas import MeOut, TokenOut

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=TokenOut)
async def login(form: OAuth2PasswordRequestForm = Depends(),
                db: AsyncSession = Depends(get_db)):
    _, token = await service.authenticate(db, form.username, form.password)
    return TokenOut(access_token=token)


@router.get("/me", response_model=MeOut)
async def me(db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    return await service.build_me(db, user)
