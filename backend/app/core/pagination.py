"""page/size params + the one standard list response wrapper."""
from typing import Generic, TypeVar

from fastapi import Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

T = TypeVar("T")


class PageParams:
    def __init__(
        self,
        page: int = Query(1, ge=1),
        size: int = Query(20, ge=1, le=100),
    ):
        self.page = page
        self.size = size

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.size


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    size: int


async def paginate(db: AsyncSession, stmt, params: PageParams) -> dict:
    """Runs a COUNT + the page slice and returns {items, total, page, size}."""
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    result = await db.execute(stmt.offset(params.offset).limit(params.size))
    items = result.scalars().all()
    return {"items": items, "total": total or 0, "page": params.page, "size": params.size}
