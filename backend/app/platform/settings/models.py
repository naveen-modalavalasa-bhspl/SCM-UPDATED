"""sys_ tables — mapped to the canonical scm_rebuild schema (database-first)."""
from sqlalchemy import (
    JSON, BigInteger, Boolean, Column, DateTime, Integer, String, Text,
)

from app.core.database import Base
from app.shared.enums import EmailClaimStatus
from app.shared.models.base import utcnow


class Setting(Base):
    __tablename__ = "sys_settings"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    # 150, not 100: `apis.endpoint.<CLIENT>.<slug>` worst-cases at 105 (see
    # `integrations/store.MAX_KEY`). Widened by `d3c4b5a6f7e8`.
    setting_key = Column(String(150), unique=True, nullable=False)
    setting_value = Column(Text, nullable=True)
    value_type = Column(String(20), nullable=False, default="string")
    category = Column(String(50), nullable=True)
    description = Column(String(500), nullable=True)
    is_editable = Column(Boolean, nullable=False, default=True)
    updated_by_id = Column(BigInteger, nullable=True)
    updated_at = Column(DateTime, nullable=False, default=utcnow, onupdate=utcnow)


class DocSeries(Base):
    __tablename__ = "sys_doc_series"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    doc_type = Column(String(30), nullable=False, index=True)
    fiscal_year = Column(String(10), nullable=False)
    prefix = Column(String(20), nullable=False)
    # 100, not 50: a pattern naming company, project and a date runs past 50 characters.
    pattern = Column(String(100), nullable=False)  # e.g. {prefix}/{fy}/{num:04d}
    last_number = Column(BigInteger, nullable=False, default=0)
    is_active = Column(Boolean, nullable=False, default=True)
    # Added by the Admin build. NULL is read as NEVER, so a live row written before the
    # ALTER TABLE still numbers correctly. The column must exist in the live table or
    # every SELECT on this model raises 1054 — see docs/sql/2026-07-25_admin_masters.sql.
    reset_policy = Column(String(10), nullable=True)          # ResetPolicy
    last_reset_period = Column(String(10), nullable=True)     # "2026" or "2026-07"
    # NULL = the series an admin configures (one per doc_type/fiscal year). A non-NULL
    # value is a COUNTER auto-created per company/project when the pattern names those
    # tokens — "COMPANY:TIRUMALA|PROJECT:MEDAK" — so each project runs its own
    # sequence. Counters carry no prefix/pattern of their own: they are rendered with
    # the parent series' pattern, so editing the pattern once still moves every project.
    scope_key = Column(String(60), nullable=True, index=True)


class AuditLog(Base):
    """Who changed what, and when. Append-only: nothing updates or deletes a row.

    Columns mirror the DB team's live sys_audit_log. Note the shape they chose: one
    `changed_fields` JSON rather than separate before/after columns, so this build
    writes {"field": {"from": x, "to": y}} into it. Only the fields that actually
    changed go in, keeping the log from becoming a second copy of every table.
    """
    __tablename__ = "sys_audit_log"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    entity_type = Column(String(50), nullable=False, index=True)   # "mst_items"
    entity_id = Column(BigInteger, nullable=False, index=True)
    entity_no = Column(String(50), nullable=True)     # human-facing code or doc number
    action = Column(String(30), nullable=False)       # AuditAction
    changed_fields = Column(JSON, nullable=True)
    actor_id = Column(BigInteger, nullable=True, index=True)
    actor_name = Column(String(200), nullable=True)
    ip_address = Column(String(45), nullable=True)
    # Where from and on what. Captured off the request by the middleware (see
    # `settings/clientinfo.py`): the user-agent is parsed locally, the location is
    # resolved from the address. Snapshots, like every other display field in this
    # build — a device that is renamed or an address that is reassigned never
    # rewrites history. All nullable: every row written before these columns existed
    # keeps its blanks, and the screen shows a dash rather than inventing a place.
    location = Column(String(200), nullable=True)
    device_type = Column(String(30), nullable=True)    # Desktop | Mobile | Tablet
    browser = Column(String(50), nullable=True)
    os = Column(String(50), nullable=True)
    user_agent = Column(String(500), nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow, index=True)


class AppLog(Base):
    """Operational errors captured from the API and browser.

    Request bodies and authorization headers are deliberately absent.  The log
    keeps only the information needed to locate a failure in the codebase.
    """
    __tablename__ = "sys_app_logs"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    request_id = Column(String(64), nullable=False, index=True)
    source = Column(String(20), nullable=False, index=True)  # BACKEND | FRONTEND
    level = Column(String(20), nullable=False, index=True)   # ERROR | WARNING
    message = Column(Text, nullable=False)
    error_type = Column(String(200), nullable=True)
    status_code = Column(Integer, nullable=True, index=True)
    http_method = Column(String(10), nullable=True)
    endpoint = Column(String(500), nullable=True)
    page_url = Column(String(1000), nullable=True)
    source_file = Column(String(500), nullable=True)
    function_name = Column(String(200), nullable=True)
    line_number = Column(Integer, nullable=True)
    column_number = Column(Integer, nullable=True)
    stack_trace = Column(Text, nullable=True)
    actor_id = Column(BigInteger, nullable=True, index=True)
    actor_name = Column(String(200), nullable=True)
    ip_address = Column(String(45), nullable=True)
    user_agent = Column(String(500), nullable=True)
    context_data = Column(JSON, nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow, index=True)


class NotificationRule(Base):
    """Who to tell when a workflow reaches a stage, or when a rule fires."""
    __tablename__ = "sys_notification_rules"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    event_code = Column(String(50), nullable=False, index=True)
    stage = Column(String(100), nullable=True)      # NULL = every stage of the event
    recipient_type = Column(String(20), nullable=False)   # RecipientType
    recipient_id = Column(BigInteger, nullable=True)
    recipient_name = Column(String(200), nullable=True)   # snapshot for the admin list
    channel = Column(String(20), nullable=False, default="IN_APP")   # NotificationChannel
    template = Column(Text, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)


class HcmSyncLog(Base):
    __tablename__ = "sys_hcm_sync_log"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    entity = Column(String(50), nullable=False, index=True)
    source = Column(String(20), nullable=False, default="HCM")
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    status = Column(String(20), nullable=False)
    records_fetched = Column(Integer, nullable=True, default=0)
    records_upserted = Column(Integer, nullable=True, default=0)
    error_message = Column(Text, nullable=True)


class UserCredential(Base):
    """Local login secret. PK is the HCM employee id (no username column)."""
    __tablename__ = "sys_local_credentials"
    employee_id = Column(BigInteger, primary_key=True, autoincrement=False)
    password_hash = Column(String(255), nullable=False)
    must_change = Column(Boolean, nullable=False, default=False)
    failed_attempts = Column(Integer, nullable=False, default=0)
    locked_until = Column(DateTime, nullable=True)
    last_login_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)
    updated_at = Column(DateTime, nullable=False, default=utcnow, onupdate=utcnow)


class Notification(Base):
    """`sys_notifications`. Raised when a document, or a stock level, needs someone.

    Lives here rather than in the warehouse module that first wrote it: it is a sys_
    table, the app shell's notification bell reads it, and inventory writes to it —
    none of which may import a module further down the chain (rule 5).
    """
    __tablename__ = "sys_notifications"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    employee_id = Column(BigInteger, index=True, nullable=False)
    title = Column(String(200), nullable=False)
    body = Column(String(1000), nullable=True)
    entity_type = Column(String(50), nullable=True)
    entity_id = Column(BigInteger, nullable=True)
    deep_link = Column(String(300), nullable=True)
    is_read = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False, default=utcnow)


class Attachment(Base):
    """`sys_attachments`, keyed by `(entity_type, entity_id)` so one panel serves every
    document without per-document wiring.

    Lives here rather than in the warehouse module for the same reason `sys_notifications`
    does: indents needs it too, to hold the receipt photo and bill a requester attaches
    when acknowledging a delivery, and indents may not import a module further down the
    chain (rule 5).
    """
    __tablename__ = "sys_attachments"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    entity_type = Column(String(50), index=True, nullable=False)
    entity_id = Column(BigInteger, index=True, nullable=False)
    file_name = Column(String(300), nullable=False)
    file_path = Column(String(500), nullable=False)
    file_size = Column(BigInteger, nullable=True)
    mime_type = Column(String(100), nullable=True)
    doc_category = Column(String(50), nullable=True)
    uploaded_by_id = Column(BigInteger, index=True, nullable=True)
    uploaded_by_name = Column(String(200), nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)


class UserSession(Base):
    __tablename__ = "sys_sessions"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    employee_id = Column(BigInteger, nullable=False, index=True)
    token_jti = Column(String(64), unique=True, nullable=False)
    issued_at = Column(DateTime, nullable=False, default=utcnow)
    expires_at = Column(DateTime, nullable=False)
    revoked_at = Column(DateTime, nullable=True)
    ip_address = Column(String(45), nullable=True)
    user_agent = Column(String(300), nullable=True)


class PasswordReset(Base):
    """`sys_password_resets` — one issued "forgot password" link.

    The RAW token is never stored, only its SHA-256. A reset link is a bearer secret:
    anyone holding the row would otherwise be able to take over any account whose link
    is still live, and a database backup would carry live credentials.

    Rows are kept after use rather than deleted, so "this link was already used" is a
    different answer from "this link never existed" — one is a person clicking twice,
    the other is worth looking at.
    """
    __tablename__ = "sys_password_resets"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    employee_id = Column(BigInteger, index=True, nullable=False)
    #: SHA-256 hex of the token that went out in the link. Unique: two live links can
    #: never collide, and a lookup is a single indexed equality.
    token_hash = Column(String(64), unique=True, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime, nullable=True)
    #: Where the request came from. Not used to decide anything — recorded so a burst
    #: of requests against one account can be read after the fact.
    requested_ip = Column(String(45), nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)


class EmailClaim(Base):
    """`sys_email_claims` — an address a person typed into "forgot password", waiting
    for an admin to confirm it is theirs.

    THE REASON THIS TABLE EXISTS. `request_reset` finds the account by
    `hcm_employees.email`, and the rebuilt HCM serves no employee email at all — the
    only address anywhere in its payload is `position.reporting_to[0].employee_email`,
    which belongs to the person's MANAGER. All 1,933 mirrored employees therefore hold
    NULL, so every reset request matched nobody and the deliberate unconditional 204
    made that look exactly like a mail that was sent and lost.

    The obvious repair — take the address the typist supplies — is an account takeover:
    emp codes are on every user list, approval and document in the app, so anyone could
    enter somebody else's code with their OWN address and be handed that person's reset
    link. So the FIRST address for an account is held here until a human says it
    belongs to them. Approving writes it onto the employee row, and every later reset
    for that person is immediate because the address then matches on sight.

    Rows are kept after a decision rather than deleted: a rejected claim is the record
    of somebody trying to point another person's reset link at their own inbox, which
    is the one thing here worth being able to read back.
    """
    __tablename__ = "sys_email_claims"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    employee_id = Column(BigInteger, index=True, nullable=False)
    #: Snapshot, so the queue reads as a person rather than an id even after a sync
    #: re-keys the mirror (CLAUDE.md rule 10: display fields are stamped at creation).
    employee_code = Column(String(50), nullable=True)
    employee_name = Column(String(200), nullable=True)
    email = Column(String(255), nullable=False)
    status = Column(String(20), nullable=False, index=True,
                    default=EmailClaimStatus.PENDING.value)
    #: Where the request came from. Decides nothing — recorded so a run of claims
    #: against different accounts from one address can be read after the fact.
    requested_ip = Column(String(45), nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)
    decided_at = Column(DateTime, nullable=True)
    decided_by_id = Column(BigInteger, nullable=True)
    decided_by_name = Column(String(200), nullable=True)


class MailMessage(Base):
    """`sys_mail_messages` — every message this app has SENT, and what came of it.

    This is the Sent tab, deliberately rather than the mailbox's own Sent folder:
    the folder only ever holds what the provider accepted, so a message that failed
    to send leaves no trace anywhere — which is the one case somebody goes looking.
    A row is written BEFORE the send and updated after, so a crash mid-send is still
    visible as QUEUED rather than vanishing.

    Received mail is NOT stored here. The Inbox reads IMAP live; copying a mailbox
    into our database would mean a sync, a schedule and a second source of truth for
    something the mail server already owns.
    """
    __tablename__ = "sys_mail_messages"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    #: Comma-separated, as typed. Stored as sent rather than normalised into rows —
    #: this is a log of what happened, not an address book.
    to_addrs = Column(String(1000), nullable=False)
    cc_addrs = Column(String(1000), nullable=True)
    subject = Column(String(500), nullable=True)
    body = Column(Text, nullable=True)
    #: QUEUED -> SENT | FAILED. See `shared.enums.MailStatus`.
    status = Column(String(20), nullable=False, index=True)
    error = Column(Text, nullable=True)
    #: What raised it: a person on the Mail screen, or the system. Password-reset mail
    #: is logged with `kind='PASSWORD_RESET'` and NO body — the body carries a live
    #: reset link, and the Sent tab is readable by anyone holding `mail.view`.
    kind = Column(String(30), nullable=False, default="MANUAL", index=True)
    sent_by_id = Column(BigInteger, index=True, nullable=True)
    sent_by_name = Column(String(200), nullable=True)
    sent_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow, index=True)
