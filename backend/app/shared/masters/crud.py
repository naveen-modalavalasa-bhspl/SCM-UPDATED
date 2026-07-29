"""One CRUD implementation, driven by a MasterDef row per master.

Eight masters with a hand-written router each is eight copies of the same list /
create / update / deactivate code. Everything that actually differs between them —
model, input schema, permission, searchable columns, how a row is serialised — is
data, so it lives in `defs.py` and this module stays the only place the behaviour is
written down. Adding a master is a new MasterDef, not a new file.
"""
from dataclasses import dataclass
from typing import Any, Callable, Sequence

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.shared.enums import AuditAction


async def _audit(db: AsyncSession, **kwargs) -> None:
    """Audit lives in platform/settings, which is downstream of shared. The import is
    function-local so the module-level graph still runs one way (rule 5), matching how
    core/dependencies.py reaches models."""
    from app.platform.settings.service import write_audit

    await write_audit(db, **kwargs)


@dataclass
class MasterDef:
    """Everything that differs between one master and the next."""
    path: str                                   # URL segment, e.g. "items"
    name: str                                   # human label used in error messages
    model: type
    schema: type[BaseModel]
    manage_perm: str
    serialize: Callable[[Any], dict]
    search_cols: Sequence[str] = ()
    order_col: str = "name"
    # Async hook for masters that snapshot a parent's name/code onto the row.
    apply: Callable | None = None
    # Masters used as dropdown sources hide inactive rows unless asked; masters managed
    # on the admin screen show everything so a deactivated row can be reactivated.
    default_active_only: bool = False
    paginated: bool = True
    # Columns exposed as optional ?column=value query filters. Child masters use this
    # so BOM lines can be fetched for one BOM instead of all of them.
    filters: Sequence[str] = ()
    # Masters owned by an upstream system register only the list route. Hiding the
    # button is not enough (rule 6): the write endpoints must not exist at all, or a
    # local edit would be silently overwritten by the next sync.
    read_only: bool = False
    # Async hook that narrows the list to what this caller may see, applied only when
    # the request asks for it with ?mine=true. Declared data rather than a branch in
    # the handler, because only the item master has anything to narrow by.
    scope_to_user: Callable | None = None
    # Optional guard for masters whose active rows form an ordered structure. Item
    # packaging, for example, may remove only its highest level.
    before_deactivate: Callable | None = None


async def _write(db: AsyncSession, defn: MasterDef, commit: bool = False) -> None:
    """Flush (or commit), turning a database constraint error into a readable 400.

    MySQL raises the duplicate-key error on the FLUSH, not the commit, so both go
    through here. Without it the admin sees a bare 500 when they reuse a code, which
    says nothing about what went wrong or how to fix it.
    """
    try:
        await (db.commit() if commit else db.flush())
    except IntegrityError as exc:
        await db.rollback()
        detail = str(getattr(exc, "orig", exc))
        label = defn.name.lower()
        article = "An" if label[:1] in "aeiou" else "A"
        if "Duplicate entry" in detail or "UNIQUE" in detail.upper():
            # Not always the code: mappings clash on attribute + target, price lines
            # on list + item + quantity. So the message stays about the whole row.
            raise ValidationError(
                f"{article} {label} with these details already exists.") from exc
        if "foreign key" in detail.lower():
            raise ValidationError(
                f"That {label} points at a record that does not exist.") from exc
        raise


async def _apply_fields(db: AsyncSession, defn: MasterDef, row, data: BaseModel) -> None:
    if defn.apply is not None:
        await defn.apply(db, row, data)
        return
    for key, value in data.model_dump().items():
        setattr(row, key, value)


def _search_clause(defn: MasterDef, search: str):
    cols = [getattr(defn.model, c) for c in defn.search_cols]
    return or_(*[c.ilike(f"%{search}%") for c in cols]) if cols else None


def build_router(defs: Sequence[MasterDef]) -> APIRouter:
    router = APIRouter(tags=["masters"])
    for defn in defs:
        _register(router, defn)
    return router


def _register(router: APIRouter, defn: MasterDef) -> None:
    """One call per master, so each handler closes over its own `defn`."""
    schema = defn.schema
    base = f"/api/{defn.path}"

    # Reading masters is open to any authenticated user: every module's dropdowns
    # depend on them. Writing needs the master's own manage permission (rule 6).
    @router.get(base, name=f"list_{defn.path}")
    async def list_rows(
        request: Request,
        params: PageParams = Depends(),
        search: str | None = None,
        include_inactive: bool = False,
        mine: bool = False,
        db: AsyncSession = Depends(get_db),
        user=Depends(get_current_user),
    ):
        stmt = select(defn.model)
        if defn.default_active_only and not include_inactive:
            stmt = stmt.where(defn.model.is_active.is_(True))
        # Opt-in, so an admin managing the master still sees everything while a
        # requester picking from it sees only what their groups allow.
        if mine and defn.scope_to_user is not None:
            stmt = await defn.scope_to_user(db, user, stmt)
        # Declared filters are read off the query string rather than being separate
        # parameters, because each master declares a different set of them.
        for column in defn.filters:
            raw = request.query_params.get(column)
            if raw not in (None, ""):
                stmt = stmt.where(getattr(defn.model, column) == raw)
        if search:
            clause = _search_clause(defn, search)
            if clause is not None:
                stmt = stmt.where(clause)
        stmt = stmt.order_by(getattr(defn.model, defn.order_col))

        if not defn.paginated:
            rows = (await db.execute(stmt)).scalars().all()
            return {"items": [defn.serialize(r) for r in rows]}

        page = await paginate(db, stmt, params)
        page["items"] = [defn.serialize(r) for r in page["items"]]
        return page

    if defn.read_only:
        return

    @router.post(base, name=f"create_{defn.path}")
    async def create_row(
        data: schema,
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(defn.manage_perm)),
    ):
        row = defn.model()
        await _apply_fields(db, defn, row, data)
        db.add(row)
        await _write(db, defn)
        await _audit(db, entity=defn.model.__tablename__, entity_id=row.id,
                     action=AuditAction.CREATE, actor=user, after=defn.serialize(row))
        await _write(db, defn, commit=True)
        await db.refresh(row)
        return defn.serialize(row)

    @router.put(base + "/{row_id}", name=f"update_{defn.path}")
    async def update_row(
        row_id: int,
        data: schema,
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(defn.manage_perm)),
    ):
        row = await db.get(defn.model, row_id)
        if not row:
            raise NotFoundError(f"{defn.name} not found")
        before = defn.serialize(row)
        await _apply_fields(db, defn, row, data)
        await _write(db, defn)
        await _audit(db, entity=defn.model.__tablename__, entity_id=row.id,
                     action=AuditAction.UPDATE, actor=user,
                     before=before, after=defn.serialize(row))
        await _write(db, defn, commit=True)
        await db.refresh(row)
        return defn.serialize(row)

    @router.delete(base + "/{row_id}", name=f"deactivate_{defn.path}")
    async def deactivate_row(
        row_id: int,
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(defn.manage_perm)),
    ):
        """Deactivate, never delete. Historical documents snapshot master names, but
        they still carry the id, and a hard delete would orphan those references."""
        row = await db.get(defn.model, row_id)
        if not row:
            raise NotFoundError(f"{defn.name} not found")
        if not hasattr(row, "is_active"):
            raise ValidationError(f"{defn.name} cannot be deactivated")
        if defn.before_deactivate is not None:
            await defn.before_deactivate(db, row)
        row.is_active = False
        await db.flush()
        await _audit(db, entity=defn.model.__tablename__, entity_id=row.id,
                     action=AuditAction.DEACTIVATE, actor=user)
        await _write(db, defn, commit=True)
        return {"success": True, "id": row_id, "is_active": False}
