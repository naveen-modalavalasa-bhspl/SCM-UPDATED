"""The Attachments dashboard: every file filed against a document, in one register.

`sys_attachments` is keyed by `(entity_type, entity_id)` and nothing else — it is a
flat store, deliberately, so one upload panel serves every module without per-document
wiring (see `platform/settings/attachments.py`). That shape is what makes a dashboard
over it possible at all, and it is also what makes it dangerous: a list that simply
selects the table hands every login every scanned invoice, gate pass, damage photo and
QC report in the company.

So this module is mostly the two things that keep that from happening:

**A file is only as visible as the document it hangs on.** `SOURCES` maps each
`entity_type` to the document it belongs to and to the scope rule that document already
answers to — the warehouse set the inventory screens use, or the exact indent predicate
`/indents` uses. Resolution is delegated, never re-implemented, the same way
`service._scope_conditions` delegates for the ledgers. An entity type that is NOT in
`SOURCES` never appears: a type nobody can map is a document nobody can bound, which is
the rule `warehouse.service._ATTACHMENT_PARENTS` already fails closed on.

**The bytes are never served from here.** A download link points at the OWNING module's
existing download route, which runs its own check (`warehouse.assert_attachment_readable`
scopes by warehouse, transport documents sit behind `transport.view`). A source whose
module has no download route gets no link rather than a new one — adding a second door
to the same files is exactly the hole that was closed on 2026-08-20.

Everything the screen shows about the parent document — its number, status, date and
the path to open it — is read from `traceability.NODES`, and the ladder it ran under
from `traceability.attach_approval`. Nothing here re-derives a document's identity, and
no doc-type map lives in the frontend.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Callable

from sqlalchemy import Select, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.reports import traceability
from app.platform.settings.models import Attachment
from app.shared.enums import ScopeRung
from app.shared.scope import rung_for

#: How a file is grouped on the dashboard's summary strip and its kind filter. Derived
#: from the mime type, falling back to the extension, because `sys_attachments.mime_type`
#: is whatever the browser sent and is sometimes the generic octet-stream.
DOC_EXTS = {".pdf"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".heic"}
OFFICE_EXTS = {".doc", ".docx", ".xls", ".xlsx", ".csv", ".ppt", ".pptx", ".txt",
               ".odt", ".ods", ".rtf"}


def file_kind(mime_type: str | None, file_name: str | None) -> str:
    """`image` | `pdf` | `document` | `other`, mime first and extension second."""
    mime = (mime_type or "").lower()
    if mime.startswith("image/"):
        return "image"
    if mime == "application/pdf":
        return "pdf"
    ext = os.path.splitext(file_name or "")[1].lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in DOC_EXTS:
        return "pdf"
    if ext in OFFICE_EXTS or mime.startswith("text/"):
        return "document"
    if mime.startswith("application/vnd.") or mime.startswith("application/ms"):
        return "document"
    return "other"


@dataclass(frozen=True)
class Source:
    """One `entity_type` of `sys_attachments`, and what bounds it.

    `node_key` names the `traceability.NODES` entry that already knows this document's
    number column, status, date and screen path — so a new source is one row here and
    nothing in the screen.

    `scope` is the rule the PARENT document answers to, resolved by delegating to the
    module that owns it:

    * ``"warehouse"`` — visible only where the login may see the warehouse, using the
      same set the inventory screens use. `warehouse_col` names the column on
      `parent()` that carries the warehouse id.
    * ``"indent"`` — visible only where the login may see the indent, using the exact
      predicate `/indents` applies.
    * ``""`` — no row scope of its own. Its permission is the whole gate, which is what
      the logistics ledger already does for the same documents.

    `download` is a format string over the owning module's OWN download route, or None
    where that module has none. It is never a route in this module.
    """
    entity_type: str
    label: str
    node_key: str
    scope: str = ""
    parent: Callable[[], type] | None = None
    warehouse_col: str | None = None
    download: str | None = None


def _wh(name: str):
    def load():
        from app.modules.warehouse import models as m
        return getattr(m, name)
    return load


#: The entity types this dashboard can bound. Anything else in `sys_attachments` — a
#: type a future module adds, or one nobody mapped — is simply absent, which is the
#: safe direction: an unlisted type means an unbounded document.
SOURCES: tuple[Source, ...] = (
    Source("RECEIPT", "Goods Receipt", "grn", "warehouse", _wh("Receipt"),
           "warehouse_id", "/api/warehouse/attachments/{attachment_id}/download"),
    Source("INSPECTION", "Outward Inspection", "inspection", "warehouse",
           _wh("Inspection"), "warehouse_id",
           "/api/warehouse/attachments/{attachment_id}/download"),
    Source("ISSUE", "Material Issue", "issue", "warehouse", _wh("MaterialIssue"),
           "warehouse_id", "/api/warehouse/attachments/{attachment_id}/download"),
    Source("DISPATCH", "Consignment", "dispatch", "warehouse", _wh("Dispatch"),
           "warehouse_id", "/api/warehouse/attachments/{attachment_id}/download"),
    # STOCK_RETURN is deliberately absent. `pro_returns` has no `traceability.NODES`
    # entry, so this dashboard cannot say what document a return's photos hang on —
    # and a row that cannot name its parent is exactly what an unbounded type looks
    # like. Adding the node is the fix, and it belongs on the Document Trail first.
    # The receipt photo and bill a requester attaches when acknowledging a delivery.
    # Scoped to the indents the login may read, which is the same rung the Indent
    # Ledger beside it answers to.
    Source("INDENT_RECEIPT", "Indent Acknowledgement", "indent", "indent",
           download="/api/indents/{entity_id}/receipt-attachments"
                    "/{attachment_id}/download"),
    # Freight paperwork on a shipment. No row scope: `transport.view` is the gate the
    # Shipments register itself uses, and the ledger over the same rows agrees.
    Source("TRANSPORT_REQUEST", "Shipment", "transport", "",
           download="/api/transport/{entity_id}/documents/{attachment_id}/download"),
)

BY_TYPE: dict[str, Source] = {s.entity_type: s for s in SOURCES}


def sources() -> list[dict]:
    """What the dashboard can group by. Served so the screen's filter cannot drift
    from the entity types this module is actually able to bound."""
    return [{
        "entity_type": s.entity_type,
        "label": s.label,
        "kind": s.node_key,
        "doc_label": (node.label if (node := traceability.BY_KEY.get(s.node_key))
                      else s.label),
    } for s in SOURCES]


async def _visible_ids(db: AsyncSession, source: Source, user) -> Select | None:
    """A SELECT of the parent ids this login may read, or None for "no restriction".

    Delegated in both branches — the point of this function is that it contains no
    policy of its own. A source whose scope column is missing from the live schema is
    left unscoped rather than emptied: that is a mapping mistake to fix here, and
    hiding every row would look identical to the document simply not existing.
    """
    if source.scope == "indent":
        from app.modules.indents.models import Indent
        from app.modules.indents.service import _indent_visibility
        return select(Indent.id).where(await _indent_visibility(db, user))

    if source.scope == "warehouse" and source.parent is not None:
        from app.modules.inventory.service import warehouse_ids_for_user
        allowed = await warehouse_ids_for_user(db, user)
        if allowed is None:            # this login sees every warehouse
            return None
        model = source.parent()
        column = getattr(model, source.warehouse_col or "", None)
        if column is None:
            return None
        # A NULL warehouse stays visible for the same reason the ledgers keep it: a
        # snapshot column that was never filled is a data gap, not a policy.
        return select(model.id).where(
            or_(column.in_(allowed or {0}), column.is_(None)))

    return None


async def _scoped(db: AsyncSession, user, entity_type: str | None) -> list:
    """The whole WHERE for one login: which types, and which rows within each.

    Built as an OR over the sources rather than a single filter, because each type
    answers to its own document's rule. A login on the ALL rung skips row resolution
    entirely and is left with the type list, which is still a real bound — an
    unmappable entity type is out for everybody.
    """
    wanted = [s for s in SOURCES
              if not entity_type or s.entity_type == entity_type]
    if not wanted:
        # A type that is not a source: match nothing rather than fall through to
        # "no condition", which would return the entire table.
        return [Attachment.id.is_(None)]

    if user is not None and await rung_for(db, user) is ScopeRung.ALL:
        return [Attachment.entity_type.in_([s.entity_type for s in wanted])]

    clauses = []
    for source in wanted:
        same_type = Attachment.entity_type == source.entity_type
        ids = None if user is None else await _visible_ids(db, source, user)
        clauses.append(same_type if ids is None
                       else same_type & Attachment.entity_id.in_(ids))
    return [or_(*clauses)]


async def _ids_of_kind(db: AsyncSession, conditions: list, kind: str) -> list[int]:
    """The ids of the files of one kind, within a scoped set.

    A file's kind is DERIVED — mime type first, extension second — so it is not a
    column and cannot be a WHERE clause. Resolving it as a set of ids rather than
    filtering the assembled page is what keeps `total` honest: filtering afterwards
    left the count reporting every document while the page showed none of them, and a
    pager built on that number offers pages that are empty by construction.

    Mirroring `file_kind` in SQL was the alternative and would drift from it the first
    time a mime type is added. One extra query over `(id, mime_type, file_name)` costs
    a row per uploaded file, which the same trade in `summary` already accepts.
    """
    rows = (await db.execute(
        select(Attachment.id, Attachment.mime_type, Attachment.file_name)
        .where(*conditions)
    )).all()
    return [row_id for row_id, mime_type, file_name in rows
            if file_kind(mime_type, file_name) == kind]


def _file(attachment: Attachment, source: Source) -> dict:
    """One stored file.

    `download_url` is present only where the owning module serves one. A row without
    it is not broken — it is a file whose module has no scoped download route, and
    serving the bytes from here instead is the thing this dashboard must not do.
    """
    download = None
    if source.download:
        download = source.download.format(attachment_id=attachment.id,
                                          entity_id=attachment.entity_id)
    return {
        "id": attachment.id,
        "file_name": attachment.file_name,
        "file_kind": file_kind(attachment.mime_type, attachment.file_name),
        "mime_type": attachment.mime_type,
        "file_size": attachment.file_size,
        "doc_category": attachment.doc_category,
        "uploaded_by_id": attachment.uploaded_by_id,
        "uploaded_by_name": attachment.uploaded_by_name,
        "uploaded_at": attachment.created_at,
        "download_url": download,
    }


async def list_documents(db: AsyncSession, user, *, page: int = 1, size: int = 25,
                         entity_type: str | None = None, kind: str | None = None,
                         search: str | None = None) -> dict:
    """One page of DOCUMENTS, each carrying the files filed against it.

    Grouped by document rather than served flat because that is the question the
    dashboard answers — "what paperwork does this GRN have?" — and because a page of
    loose files makes the same document appear six times. `{items, total, page, size}`
    (rule 11), where an item is a document and `total` counts documents.

    The documents are resolved AFTER the page is cut, one query per document type on
    the page rather than one per row, and stamped with the approval ladder they ran
    under in the same pass the tracking screens use — so a file and the document it
    belongs to can never disagree about which ladder signed it.
    """
    conditions = await _scoped(db, user, entity_type)
    if search:
        like = f"%{search.strip()}%"
        conditions.append(or_(Attachment.file_name.ilike(like),
                              Attachment.uploaded_by_name.ilike(like),
                              Attachment.doc_category.ilike(like)))

    if kind:
        conditions.append(Attachment.id.in_(await _ids_of_kind(db, conditions, kind)))

    # One row per document, ordered by its most recent file, so the register leads with
    # whatever paperwork arrived last.
    grouped = (
        select(Attachment.entity_type, Attachment.entity_id,
               func.max(Attachment.id).label("latest"))
        .where(*conditions)
        .group_by(Attachment.entity_type, Attachment.entity_id)
    )
    total = await db.scalar(
        select(func.count()).select_from(grouped.subquery())) or 0
    keys = (await db.execute(
        grouped.order_by(func.max(Attachment.id).desc())
        .offset((page - 1) * size).limit(size)
    )).all()
    if not keys:
        return {"items": [], "total": total, "page": page, "size": size}

    # The files for exactly the documents on this page. `tuple_` would be tidier but
    # MySQL plans a row-value IN badly here; the page is at most `size` documents, so
    # an OR of equalities is both portable and small.
    wanted = or_(*[(Attachment.entity_type == entity) & (Attachment.entity_id == ref)
                   for entity, ref, _ in keys])
    files = list((await db.execute(
        select(Attachment).where(wanted).order_by(Attachment.id.desc())
    )).scalars().all())

    by_doc: dict[tuple[str, int], list[Attachment]] = {}
    for row in files:
        by_doc.setdefault((row.entity_type, int(row.entity_id)), []).append(row)

    by_key: dict[str, list[int]] = {}
    for entity, ref, _ in keys:
        source = BY_TYPE.get(entity)
        if source:
            by_key.setdefault(source.node_key, []).append(int(ref))

    docs: dict[str, dict[int, dict]] = {}
    for node_key, ids in by_key.items():
        found = await traceability.rows_by_id(db, node_key, ids)
        await traceability.attach_approval(db, list(found.values()))
        docs[node_key] = found

    items = []
    for entity, ref, _ in keys:
        source = BY_TYPE.get(entity)
        if source is None:                     # unbounded type — never shown
            continue
        doc = docs.get(source.node_key, {}).get(int(ref)) or {}
        rows = by_doc.get((entity, int(ref)), [])
        attached = [_file(row, source) for row in rows]
        items.append({
            "entity_type": entity,
            "entity_id": int(ref),
            "source_label": source.label,
            "kind": source.node_key,
            # Straight off the trail's own NODES entry — number, status, date and the
            # path that opens it — or None when the parent row has since gone.
            "doc_label": doc.get("label") or source.label,
            "doc_no": doc.get("doc_no"),
            "doc_status": doc.get("status"),
            "doc_date": doc.get("date"),
            "doc_path": doc.get("path"),
            "doctype_code": doc.get("doctype_code"),
            "approval": doc.get("approval"),
            "attachments": attached,
            "attachment_count": len(attached),
        })
    return {"items": items, "total": total, "page": page, "size": size}


async def summary(db: AsyncSession, user, *,
                  entity_type: str | None = None) -> dict:
    """The KPI strip: how many files this login can see, by kind.

    Counted over the SAME scoped set the register runs on, so the tiles can never
    promise more files than the list below them will show. The kinds are derived from
    the mime type, so this reads the rows rather than grouping in SQL — the store is
    one row per uploaded file, which is small enough for that to be the honest trade.
    """
    conditions = await _scoped(db, user, entity_type)
    rows = (await db.execute(
        select(Attachment.mime_type, Attachment.file_name).where(*conditions)
    )).all()
    counts = {"image": 0, "pdf": 0, "document": 0, "other": 0}
    for mime_type, file_name in rows:
        counts[file_kind(mime_type, file_name)] += 1
    return {"total": len(rows), **counts}
