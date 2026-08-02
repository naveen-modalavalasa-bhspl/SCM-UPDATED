"""Uploaded documents, for every module.

`sys_attachments` is keyed by `(entity_type, entity_id)`, so one panel serves any
document without per-document wiring. This lives in platform/ rather than in the
warehouse module because indents needs it too — a requester acknowledging a delivery
attaches the receipt photo and, when they were given one, the bill — and indents may
not import a module further down the chain (rule 5).

The bytes are written before the row. An earlier version wrote only the row, with
`file_path` pointing at an `/uploads/...` URL nothing served: every upload reported
success and every link was dead.
"""
import os
import re
from pathlib import Path
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.platform.settings.models import Attachment
from app.shared.enums import AuditAction

# Where uploaded documents are stored. The location is deployment configuration, so it
# comes from the environment; the default sits beside the app so a fresh checkout works
# without one more required key. Nothing but this constant knows the path.
UPLOAD_ROOT = Path(os.getenv("UPLOAD_DIR")
                   or Path(__file__).resolve().parents[3] / "var" / "uploads")
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024


def _slug(value: str) -> str:
    """A folder name that cannot climb out of the store."""
    return re.sub(r"[^a-z0-9_-]+", "_", (value or "other").lower()) or "other"


def _name(user) -> str | None:
    return getattr(user, "full_name", None) or getattr(user, "name", None)


async def list_attachments(db: AsyncSession, entity_type: str,
                           entity_id: int) -> list[Attachment]:
    return list((await db.execute(
        select(Attachment)
        .where(Attachment.entity_type == entity_type, Attachment.entity_id == entity_id)
        .order_by(Attachment.id.desc())
    )).scalars().all())


async def add_attachment(db: AsyncSession, *, entity_type: str, entity_id: int,
                         upload, doc_category: str | None, user) -> Attachment:
    """Writes the bytes, then the row.

    The file is stored under a generated name so two invoices called `scan.pdf` cannot
    overwrite each other, and `file_path` is kept relative to the store so the directory
    can move without rewriting the table.
    """
    payload = await upload.read()
    if not payload:
        raise ValidationError("That file is empty — nothing was uploaded.")
    if len(payload) > MAX_ATTACHMENT_BYTES:
        raise ValidationError(
            f"A document must be {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB or smaller.")

    # Only the last segment: a browser may send a full path, and a crafted one must not
    # be able to write outside the store.
    file_name = Path(upload.filename or "file").name
    folder = UPLOAD_ROOT / _slug(entity_type) / str(entity_id)
    folder.mkdir(parents=True, exist_ok=True)
    stored = folder / f"{uuid4().hex}{Path(file_name).suffix.lower()}"
    stored.write_bytes(payload)

    row = Attachment(
        entity_type=entity_type, entity_id=entity_id,
        file_name=file_name,
        file_path=stored.relative_to(UPLOAD_ROOT).as_posix(),
        file_size=len(payload),
        mime_type=upload.content_type, doc_category=doc_category,
        uploaded_by_id=getattr(user, "id", None), uploaded_by_name=_name(user),
    )
    db.add(row)
    await db.flush()

    # Imported here, not at module import time: settings.service imports workflow models,
    # so a top-level import would close a cycle.
    from app.platform.settings.service import write_audit

    await write_audit(db, entity="sys_attachments", entity_id=row.id, entity_no=file_name,
                      action=AuditAction.CREATE, actor=user,
                      after={"entity_type": entity_type, "entity_id": entity_id})
    await db.commit()
    await db.refresh(row)
    return row


async def attachment_file(db: AsyncSession, attachment_id: int) -> tuple[Path, str, str]:
    """The path, download name and type of a stored document."""
    row = await db.get(Attachment, attachment_id)
    if row is None:
        raise NotFoundError(f"Attachment {attachment_id} not found")
    path = UPLOAD_ROOT / (row.file_path or "").lstrip("/")
    if not path.is_file():
        raise NotFoundError(
            f"{row.file_name} is recorded but its file is not on the server. "
            "Upload it again.")
    return path, row.file_name, row.mime_type or "application/octet-stream"


async def delete_attachment(db: AsyncSession, attachment_id: int, user) -> None:
    row = await db.get(Attachment, attachment_id)
    if row is None:
        raise NotFoundError(f"Attachment {attachment_id} not found")

    from app.platform.settings.service import write_audit

    await write_audit(db, entity="sys_attachments", entity_id=row.id,
                      entity_no=row.file_name, action=AuditAction.DEACTIVATE, actor=user,
                      before={"file": row.file_name})
    stored = UPLOAD_ROOT / (row.file_path or "").lstrip("/")
    await db.delete(row)
    await db.commit()
    # After the commit: a file left behind is tidy-up, a row pointing at a deleted file
    # is a broken document.
    stored.unlink(missing_ok=True)
