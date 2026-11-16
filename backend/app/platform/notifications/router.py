"""The signed-in person's own notifications — what the app shell's bell reads.

No `require_permission` here on purpose. Every row is filtered to
`employee_id == the caller`, so the endpoint cannot expose anyone else's alerts; being
logged in is the whole authorisation. The warehouse module's copy of these routes sits
behind `stock.view`, which meant a requester or an approver could never read a
notification addressed to them.

Kept tiny and self-contained: three queries against one sys_ table does not warrant a
service.py of its own.
"""
from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, computed_field
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user
from app.core.exceptions import NotFoundError
from app.core.pagination import Page, PageParams, paginate
from app.platform.notifications.service import resolve_link
from app.platform.settings.models import Notification

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


class NotificationRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    title: str
    body: str | None = None
    entity_type: str | None = None
    entity_id: int | None = None
    deep_link: str | None = None
    is_read: bool
    created_at: datetime

    @computed_field
    @property
    def target(self) -> str | None:
        """Where a click goes (SCM_0074/0075): the row's own document, resolved on
        read so old rows with a stale or generic link open the right screen too."""
        return resolve_link(self.deep_link, self.entity_type, self.entity_id)


class UnreadCount(BaseModel):
    count: int


def _mine(stmt, user):
    return stmt.where(Notification.employee_id == user.id)


@router.get("", response_model=Page[NotificationRow])
async def list_notifications(params: PageParams = Depends(), unread_only: bool = False,
                             search: str | None = None,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(get_current_user)):
    stmt = _mine(select(Notification), user)
    if unread_only:
        stmt = stmt.where(Notification.is_read.is_(False))
    term = (search or "").strip()
    if term:
        pattern = f"%{term}%"
        stmt = stmt.where(or_(
            Notification.title.ilike(pattern), Notification.body.ilike(pattern)))
    return await paginate(db, stmt.order_by(Notification.id.desc()), params)


@router.get("/unread-count", response_model=UnreadCount)
async def unread_count(db: AsyncSession = Depends(get_db),
                       user=Depends(get_current_user)):
    stmt = _mine(select(func.count(Notification.id)), user).where(
        Notification.is_read.is_(False))
    return {"count": int((await db.execute(stmt)).scalar() or 0)}


@router.post("/{notification_id}/read", response_model=NotificationRow)
async def mark_read(notification_id: int, db: AsyncSession = Depends(get_db),
                    user=Depends(get_current_user)):
    row = (await db.execute(
        _mine(select(Notification).where(Notification.id == notification_id), user)
    )).scalar_one_or_none()
    # Someone else's id is a 404, not a 403: whether it exists is not their business.
    if row is None:
        raise NotFoundError(f"Notification {notification_id} not found")
    row.is_read = True
    await db.commit()
    await db.refresh(row)
    return row


@router.post("/read-all", response_model=UnreadCount)
async def mark_all_read(db: AsyncSession = Depends(get_db),
                        user=Depends(get_current_user)):
    result = await db.execute(
        update(Notification)
        .where(Notification.employee_id == user.id, Notification.is_read.is_(False))
        .values(is_read=True)
    )
    await db.commit()
    return {"count": result.rowcount or 0}
