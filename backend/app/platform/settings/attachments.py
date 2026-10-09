"""Uploaded documents, for every module.

`sys_attachments` is keyed by `(entity_type, entity_id)`, so one panel serves any
document without per-document wiring. This lives in platform/ rather than in the
warehouse module because indents needs it too — a requester acknowledging a delivery
attaches the receipt photo and, when they were given one, the bill — and indents may
not import a module further down the chain (rule 5).

The bytes are written before the row. An earlier version wrote only the row, with
`file_path` pointing at an `/uploads/...` URL nothing served: every upload reported
success and every link was dead.

**A file belongs to a document, and every route must say which** (2026-09-03).
`entity_type`/`entity_id` are a soft key — nothing in the database ties an attachment
row to the document it hangs on — so a route that takes a bare `attachment_id` and
acts on it is acting on the whole store. Two did: warehouse's `DELETE /attachments/
{id}` and indents' `DELETE /receipt-attachments/{id}` would delete any row in
`sys_attachments` from any module, for anyone holding one unrelated permission code.
The same hole on the way in: warehouse's `POST /attachments` took `entity_type` and
`entity_id` as form fields and filed the bytes wherever it was told.

`require_attachment` is the one check that closes it, and it is not optional —
`delete_attachment` will not run without a stated `entity_type`, so a new route
cannot forget. Naming the type is half the answer; the caller must then run its own
module's visibility check on `row.entity_id`, which is why this returns the row
rather than a bool. Answering 404 rather than 403 throughout: an id that is not
yours must not confirm it exists.

**What may be stored** (2026-09-03). The store used to accept whatever was sent and
keep the extension — a 20 MB `.exe` or `.sh` was a valid GRN attachment, and an
`.html` or `.svg` served back to a browser is stored XSS on our own origin. Uploads
are now whitelisted by extension AND checked against the file's own leading bytes,
because `content_type` is written by the client and means nothing. The cap is
enforced WHILE the bytes stream in, not after `read()` has already put 20 MB (or far
more, from a client that ignores the limit) in the process's memory.
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
#: Read in 1 MB bites so the cap can be enforced before the whole file is in memory.
CHUNK_BYTES = 1024 * 1024

#: extension -> (mime type we will serve it back as, leading bytes it must start with).
#:
#: The business file types and nothing else. Deliberately absent: `.svg` and `.html`
#: (script that would run on our own origin), `.zip`/`.rar` (an unopened container is
#: an unchecked one), and every executable and script extension. An empty signature
#: tuple means the format has no reliable magic number — plain text and CSV — and the
#: extension is all there is to go on; those are also the two that cannot carry code
#: a browser will run, given the download-only disposition below.
ALLOWED_TYPES: dict[str, tuple[str, tuple[bytes, ...]]] = {
    ".pdf": ("application/pdf", (b"%PDF",)),
    ".png": ("image/png", (b"\x89PNG\r\n\x1a\n",)),
    ".jpg": ("image/jpeg", (b"\xff\xd8\xff",)),
    ".jpeg": ("image/jpeg", (b"\xff\xd8\xff",)),
    ".gif": ("image/gif", (b"GIF87a", b"GIF89a")),
    ".webp": ("image/webp", (b"RIFF",)),
    ".bmp": ("image/bmp", (b"BM",)),
    ".tif": ("image/tiff", (b"II*\x00", b"MM\x00*")),
    ".tiff": ("image/tiff", (b"II*\x00", b"MM\x00*")),
    # A phone photograph, which is what half of these attachments are. ISO-BMFF puts
    # its `ftyp` box at offset 4, so there is no leading signature to match on.
    ".heic": ("image/heic", ()),
    ".heif": ("image/heif", ()),
    # OOXML is a zip; the older Office formats are OLE compound documents.
    ".docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              (b"PK\x03\x04",)),
    ".xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              (b"PK\x03\x04",)),
    ".pptx": ("application/vnd.openxmlformats-officedocument.presentationml.presentation",
              (b"PK\x03\x04",)),
    ".doc": ("application/msword", (b"\xd0\xcf\x11\xe0",)),
    ".xls": ("application/vnd.ms-excel", (b"\xd0\xcf\x11\xe0",)),
    ".ppt": ("application/vnd.ms-powerpoint", (b"\xd0\xcf\x11\xe0",)),
    ".csv": ("text/csv", ()),
    ".txt": ("text/plain", ()),
}

#: What a stored file is served back as when its extension is not one we know. Never
#: the `mime_type` column: that is what the uploading client claimed, and a row
#: written before this whitelist existed may claim `text/html`.
FALLBACK_MIME = "application/octet-stream"


def _slug(value: str) -> str:
    """A folder name that cannot climb out of the store."""
    return re.sub(r"[^a-z0-9_-]+", "_", (value or "other").lower()) or "other"


def _name(user) -> str | None:
    return getattr(user, "full_name", None) or getattr(user, "name", None)


def safe_mime(file_name: str | None) -> str:
    """The type to serve a stored file as, decided by us from its extension."""
    return ALLOWED_TYPES.get(Path(file_name or "").suffix.lower(), (FALLBACK_MIME, ()))[0]


def _assert_type(file_name: str, head: bytes) -> str:
    """Extension on the whitelist, and the bytes agree with it."""
    suffix = Path(file_name).suffix.lower()
    allowed = ALLOWED_TYPES.get(suffix)
    if allowed is None:
        raise ValidationError(
            f"{suffix or 'That file type'} cannot be attached. Attach a PDF, an image, "
            "an Office document, a CSV or a text file.")
    mime, signatures = allowed
    if signatures and not any(head.startswith(sig) for sig in signatures):
        # The name says one thing and the content says another. Refused whichever way
        # round it is: a renamed script is the attack, a genuinely corrupt file is a
        # document nobody will be able to open later.
        raise ValidationError(
            f"{file_name} is not a valid {suffix.lstrip('.').upper()} file — its "
            "contents do not match its extension.")
    return mime


async def list_attachments(db: AsyncSession, entity_type: str,
                           entity_id: int) -> list[Attachment]:
    return list((await db.execute(
        select(Attachment)
        .where(Attachment.entity_type == entity_type, Attachment.entity_id == entity_id)
        .order_by(Attachment.id.desc())
    )).scalars().all())


async def require_attachment(db: AsyncSession, attachment_id: int, *,
                             entity_type: str | tuple[str, ...],
                             entity_id: int | None = None) -> Attachment:
    """Load an attachment and prove it hangs where the caller says it does.

    `entity_type` is required and `entity_id` is not: a route that already has the
    parent id in its path passes both and is done, while one that does not (the
    delete routes, which are addressed by attachment id alone) passes the type and
    then runs its module's own visibility check on the `entity_id` this returns. The
    one thing no caller may do is act on an id it has proved nothing about.
    """
    row = await db.get(Attachment, attachment_id)
    types = (entity_type,) if isinstance(entity_type, str) else tuple(entity_type)
    if (row is None
            or (row.entity_type or "").upper() not in {t.upper() for t in types}
            or (entity_id is not None and int(row.entity_id) != int(entity_id))):
        raise NotFoundError(f"Attachment {attachment_id} not found")
    return row


async def add_attachment(db: AsyncSession, *, entity_type: str, entity_id: int,
                         upload, doc_category: str | None, user) -> Attachment:
    """Writes the bytes, then the row.

    The file is stored under a generated name so two invoices called `scan.pdf` cannot
    overwrite each other, and `file_path` is kept relative to the store so the directory
    can move without rewriting the table.

    Streamed to disk a megabyte at a time and abandoned the moment it runs over the
    cap, so an oversized upload costs one chunk of memory rather than its whole size.
    """
    # Only the last segment: a browser may send a full path, and a crafted one must not
    # be able to write outside the store.
    file_name = Path(upload.filename or "file").name
    folder = UPLOAD_ROOT / _slug(entity_type) / str(entity_id)
    folder.mkdir(parents=True, exist_ok=True)
    stored = folder / f"{uuid4().hex}{Path(file_name).suffix.lower()}"

    size = 0
    mime = None
    try:
        with stored.open("wb") as sink:
            while True:
                chunk = await upload.read(CHUNK_BYTES)
                if not chunk:
                    break
                if mime is None:
                    # The first chunk carries the signature. Checked before a single
                    # byte more is accepted, so a rejected type never reaches full size.
                    mime = _assert_type(file_name, chunk[:16])
                size += len(chunk)
                if size > MAX_ATTACHMENT_BYTES:
                    raise ValidationError(
                        "A document must be "
                        f"{MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB or smaller.")
                sink.write(chunk)
        if not size:
            raise ValidationError("That file is empty — nothing was uploaded.")
    except Exception:
        # Nothing half-written survives a refusal, or the store fills with the
        # first megabyte of every rejected upload.
        stored.unlink(missing_ok=True)
        raise

    row = Attachment(
        entity_type=entity_type, entity_id=entity_id,
        file_name=file_name,
        file_path=stored.relative_to(UPLOAD_ROOT).as_posix(),
        file_size=size,
        # Our reading of the file, not the client's claim about it.
        mime_type=mime, doc_category=doc_category,
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
    """The path, download name and type of a stored document.

    Callers hand the third value to `FileResponse`, which defaults to
    `Content-Disposition: attachment` whenever a filename is given — so a stored
    document is downloaded, never rendered on our origin. The type is derived from the
    extension rather than read off the row for the same reason: rows written before
    the upload whitelist carry whatever the client claimed.
    """
    row = await db.get(Attachment, attachment_id)
    if row is None:
        raise NotFoundError(f"Attachment {attachment_id} not found")
    path = UPLOAD_ROOT / (row.file_path or "").lstrip("/")
    if not path.is_file():
        raise NotFoundError(
            f"{row.file_name} is recorded but its file is not on the server. "
            "Upload it again.")
    return path, row.file_name, safe_mime(row.file_name)


async def delete_attachment(db: AsyncSession, attachment_id: int, user, *,
                            entity_type: str | tuple[str, ...],
                            entity_id: int | None = None) -> None:
    """Remove one, once it is proved to belong where the caller says.

    `entity_type` is keyword-only and has no default on purpose — see the module
    docstring. A route that cannot name the document the file hangs on has not
    authorised anything.
    """
    row = await require_attachment(db, attachment_id, entity_type=entity_type,
                                   entity_id=entity_id)

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
