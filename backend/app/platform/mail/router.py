"""Mail endpoints. No logic — every route calls the service (rule 2).

Two groups, gated very differently on purpose:

  * `/api/mail/**` — the Settings > Mail screen. Every route carries
    `require_permission`: `mail.view` to read the mailbox and the Sent log,
    `mail.send` to put a message out under the company's address. Two codes, because
    reading what the company has sent and sending as the company are not the same
    right.

  * `/api/auth/forgot-password` and `/api/auth/reset-password` — UNAUTHENTICATED by
    necessity: somebody who cannot sign in is the only caller these have. They are
    safe because neither one ever confirms anything about an account. See
    `service.request_reset`.
"""
from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.core.pagination import Page, PageParams
from app.platform.mail import service
from app.platform.mail.schemas import (
    ForgotPasswordIn, InboxMessageOut, MailMessageOut, MailSendIn, MailboxStatusOut,
    ResetPasswordIn,
)
from app.platform.rbac import permissions as perms

router = APIRouter(prefix="/api/mail", tags=["mail"])
#: The reset pair sits under /api/auth so it reads as part of signing in, which is
#: what it is. Exported separately because it carries no permission dependency.
auth_router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/status", response_model=MailboxStatusOut)
async def mailbox_status(user=Depends(require_permission(perms.MAIL_VIEW))):
    """What this deployment's mailbox can do. Served so the screen shows the tabs the
    mailbox actually supports instead of one that only ever errors."""
    return service.mailbox_status()


@router.get("/inbox", response_model=list[InboxMessageOut])
async def inbox(search: str | None = None, limit: int = 50,
                user=Depends(require_permission(perms.MAIL_VIEW))):
    """The mailbox, live over IMAP and READ-ONLY — opening this screen never marks a
    message seen and never moves one."""
    return await service.inbox(search=search, limit=min(max(limit, 1), 100))


@router.get("/sent", response_model=Page[MailMessageOut])
async def sent(params: PageParams = Depends(), search: str | None = None,
               db: AsyncSession = Depends(get_db),
               user=Depends(require_permission(perms.MAIL_VIEW))):
    """Everything this app has sent, failures included — see `service.list_sent`."""
    return await service.list_sent(db, params, search)


@router.post("", response_model=MailMessageOut, status_code=201)
async def send(body: MailSendIn, db: AsyncSession = Depends(get_db),
               user=Depends(require_permission(perms.MAIL_SEND))):
    return await service.send_mail(db, body, user)


# --------------------------------------------------------------------------- #
#  Password reset — unauthenticated by necessity
# --------------------------------------------------------------------------- #

@auth_router.post("/forgot-password", status_code=204)
async def forgot_password(body: ForgotPasswordIn, request: Request,
                          db: AsyncSession = Depends(get_db)):
    """Always 204, whatever happens.

    An unknown address, a disabled employee, an account with no local login and a
    mailbox that refused the message all answer identically. Anything else would let
    a stranger walk a list of addresses and learn which ones are real.
    """
    await service.request_reset(
        db, body.email,
        ip_address=request.client.host if request.client else None,
    )


@auth_router.post("/reset-password", status_code=204)
async def reset_password(body: ResetPasswordIn, db: AsyncSession = Depends(get_db)):
    """Spend a reset link. An expired, used or invented token all say the same thing;
    only a password that is too short is described, because that is the caller's own
    input and they have to be able to fix it."""
    await service.reset_password(db, body.token, body.new_password)
