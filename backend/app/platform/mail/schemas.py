"""Wire shapes for the Mail screen and the password-reset pair."""
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class MailboxStatusOut(BaseModel):
    """What this deployment's mailbox can actually do.

    SERVED rather than assumed by the screen, because sending and reading are two
    separate capabilities: a host may offer SMTP and no IMAP. The screen shows the
    Compose tab off `can_send` and the Inbox tab off `can_read`, so a half-configured
    mailbox renders a notice instead of a tab that only ever errors.
    """
    can_send: bool = False
    can_read: bool = False
    #: The address recipients will see. Shown on Compose so nobody wonders who it is
    #: from; never the password, and never the host.
    from_address: str = ""
    from_name: str = ""


class MailSendIn(BaseModel):
    """One outgoing message.

    `to` is a list, not the comma-separated string the form types: splitting is the
    SCREEN's job, and a list is the only shape that cannot silently send to an address
    somebody meant as two.
    """
    to: list[EmailStr] = Field(min_length=1, max_length=50)
    cc: list[EmailStr] = Field(default_factory=list, max_length=50)
    subject: str = Field(min_length=1, max_length=500)
    body: str = Field(min_length=1)


class MailMessageOut(BaseModel):
    """One row of the Sent log. `body` is present for a manual message and empty for
    a password reset — see `MailKind`."""
    model_config = ConfigDict(from_attributes=True)

    id: int
    to_addrs: str
    cc_addrs: str | None = None
    subject: str | None = None
    body: str | None = None
    status: str
    error: str | None = None
    kind: str
    sent_by_name: str | None = None
    sent_at: datetime | None = None
    created_at: datetime | None = None


class InboxMessageOut(BaseModel):
    """One message in the mailbox. Read live over IMAP and never stored — the mail
    server owns this, we only show it."""
    uid: str
    from_addr: str
    to_addr: str
    subject: str
    date: datetime | None = None
    preview: str
    body: str
    seen: bool


# --------------------------------------------------------------------------- #
#  Password reset
# --------------------------------------------------------------------------- #

class ForgotPasswordIn(BaseModel):
    email: EmailStr


class ResetPasswordIn(BaseModel):
    token: str = Field(min_length=16, max_length=200)
    #: Matches `PasswordChangeIn` — one rule for a password, wherever it is set.
    new_password: str = Field(min_length=8, max_length=128)
