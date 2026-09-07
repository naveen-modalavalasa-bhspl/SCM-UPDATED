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


class MailComposeIn(BaseModel):
    """One outgoing message as the Compose form posts it. THE WIRE SHAPE.

    `to` is a list, not the comma-separated string the form types: splitting is the
    SCREEN's job, and a list is the only shape that cannot silently send to an address
    somebody meant as two.
    """
    to: list[EmailStr] = Field(min_length=1, max_length=50)
    cc: list[EmailStr] = Field(default_factory=list, max_length=50)
    subject: str = Field(min_length=1, max_length=500)
    #: The plain-text half, always: what a person types, and — for an internal caller
    #: that also supplies html — the fallback a text-only reader and half the spam
    #: filters will see. `service.send_mail` wraps it in the house template.
    body: str = Field(min_length=1)


class MailSendIn(MailComposeIn):
    """The same message, plus an already-built html half. INTERNAL ONLY.

    Kept off `MailComposeIn`, which is what the route binds, so the field cannot
    arrive from the wire: a caller able to post arbitrary html is a caller able to
    dress a message up as any letterhead they like, and `mail.send` is a permission a
    good many desks hold. Procurement's order copy is the one user of it — it builds
    its own table of lines and passes it here rather than typing markup into `body`
    and hoping the transport renders it (which is exactly what used to happen).
    """
    html: str | None = None


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
    #: The sender's `text/html`, empty when they sent none. UNTRUSTED markup from an
    #: outside mailbox: the screen renders it in a sandboxed, script-less frame on a
    #: null origin and never inside our own document.
    body_html: str = ""
    seen: bool


# --------------------------------------------------------------------------- #
#  Password reset
# --------------------------------------------------------------------------- #

class ForgotPasswordIn(BaseModel):
    #: Employee code (HR-EMP-09561) or the numeric employee id — the same handles
    #: sign-in accepts, minus email. The address cannot also be the way in: it is the
    #: thing being established, and the mirror starts with none (see
    #: `service.request_reset`).
    emp_code: str = Field(min_length=1, max_length=50)
    email: EmailStr


class ResetPasswordIn(BaseModel):
    token: str = Field(min_length=16, max_length=200)
    #: Matches `PasswordChangeIn` — one rule for a password, wherever it is set.
    new_password: str = Field(min_length=8, max_length=128)


class EmailClaimOut(BaseModel):
    id: int
    employee_id: int
    employee_code: str | None = None
    employee_name: str | None = None
    email: str
    status: str
    requested_ip: str | None = None
    created_at: datetime | None = None
    decided_at: datetime | None = None
    decided_by_name: str | None = None


class EmailClaimDecisionIn(BaseModel):
    #: True confirms the address belongs to that person AND sends the link; False
    #: refuses it and sends nothing.
    approve: bool
