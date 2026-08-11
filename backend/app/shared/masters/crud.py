"""One CRUD implementation, driven by a MasterDef row per master.

Eight masters with a hand-written router each is eight copies of the same list /
create / update / deactivate code. Everything that actually differs between them —
model, input schema, permission, searchable columns, how a row is serialised — is
data, so it lives in `defs.py` and this module stays the only place the behaviour is
written down. Adding a master is a new MasterDef, not a new file.
"""
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.shared.enums import AuditAction
from app.shared.masters.bulk import register_bulk_routes


# A usage declaration names a table and a column. Nothing from a request is ever
# interpolated into SQL, but the check keeps that true if defs.py is edited carelessly.
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


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
    # Applies `scope_to_user` on EVERY read, not only when ?mine=true asks for it.
    # Opt-in narrowing is a UX convenience — a requester picking from a dropdown —
    # and a caller who omits the flag simply sees more. That is the wrong shape for a
    # master whose rows belong to a project: dropping the parameter would be the
    # whole bypass, and hiding a button is not security (rule 6).
    scope_always: bool = False
    # Whether `apply` takes the calling user as a fourth argument. Declared rather
    # than sniffed, and off by default, so the other twenty-odd apply hooks keep
    # their three-argument signature. Needed by masters that must check the caller
    # MAY point at what they are pointing at, not merely that it exists.
    apply_needs_user: bool = False
    # Optional guard for masters whose active rows form an ordered structure. Item
    # packaging, for example, may remove only its highest level.
    before_deactivate: Callable | None = None
    # Where this master is referenced, as (label, table, column). Declared as plain
    # strings rather than models because most referents live in app.modules, and
    # shared may not import a module (rule 5). Powers GET {base}/{id}/usage, so the
    # admin is told "used by 42 items" before deactivating rather than after.
    usage: Sequence[tuple[str, str, str]] = ()


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


async def _apply_fields(db: AsyncSession, defn: MasterDef, row, data: BaseModel,
                        user=None) -> None:
    if defn.apply is not None:
        if defn.apply_needs_user:
            await defn.apply(db, row, data, user)
        else:
            await defn.apply(db, row, data)
        return
    for key, value in data.model_dump().items():
        setattr(row, key, value)


async def _require_in_scope(db: AsyncSession, defn: MasterDef, row_id: int,
                            user) -> None:
    """Refuse a write to a row this caller's list would never have shown them.

    Narrowing the list alone is only half a boundary: the ids are sequential, so a
    login that cannot SEE another project's row could still PUT or DELETE it by
    guessing the number. Re-runs the master's own narrowing against this one id, so
    read and write can never disagree about who owns what.

    Answers "not found" rather than "forbidden" on purpose — a row outside the
    caller's scope should not be confirmed to exist.
    """
    if not (defn.scope_always and defn.scope_to_user is not None):
        return
    stmt = await defn.scope_to_user(
        db, user, select(defn.model.id).where(defn.model.id == row_id))
    if await db.scalar(stmt) is None:
        raise NotFoundError(f"{defn.name} not found")


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

    # Every master gets template/export/import for free, from the same schema the
    # CRUD routes validate against — so a new MasterDef is still just a MasterDef.
    register_bulk_routes(router, defn, write=_write, audit=_audit)

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
        # requester picking from it sees only what their groups allow — unless the
        # master declares scope_always, where the narrowing IS the access rule and a
        # request that leaves ?mine off must not see more.
        if (mine or defn.scope_always) and defn.scope_to_user is not None:
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

    @router.get(base + "/{row_id}/usage", name=f"usage_{defn.path}")
    async def row_usage(
        row_id: int,
        db: AsyncSession = Depends(get_db),
        user=Depends(get_current_user),
    ):
        """Who points at this row. Read before offering to deactivate it, so the
        admin decides knowing the blast radius instead of discovering it later."""
        counts = []
        for label, table, column in defn.usage:
            if not (_IDENTIFIER.match(table) and _IDENTIFIER.match(column)):
                raise ValidationError(f"Bad usage declaration for {defn.path}")
            # Interpolated, not bound: an identifier cannot be a bind parameter. The
            # values are constants from defs.py checked against _IDENTIFIER above —
            # nothing from the request reaches this string.
            total = await db.scalar(
                text(f"SELECT COUNT(*) FROM {table} WHERE {column} = :row_id"),
                {"row_id": row_id},
            )
            if total:
                counts.append({"label": label, "count": int(total)})
        return {"id": row_id, "total": sum(c["count"] for c in counts),
                "used_by": counts}

    if defn.read_only:
        return

    @router.post(base, name=f"create_{defn.path}")
    async def create_row(
        data: schema,
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(defn.manage_perm)),
    ):
        row = defn.model()
        await _apply_fields(db, defn, row, data, user)
        db.add(row)
        await _write(db, defn)
        # A new row has only ever been written, never read, so anything the ORM does
        # not hold in memory — a server default, or a column_property like
        # Bom.line_count — is still unloaded. Reading one inside serialize() would
        # fire a lazy SELECT from async code and raise MissingGreenlet, so the load
        # happens here, before either serialize call, where awaiting IO is allowed.
        await db.refresh(row)
        await _audit(db, entity=defn.model.__tablename__, entity_id=row.id,
                     action=AuditAction.CREATE, actor=user, after=defn.serialize(row))
        await _write(db, defn, commit=True)
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
        await _require_in_scope(db, defn, row_id, user)
        before = defn.serialize(row)
        await _apply_fields(db, defn, row, data, user)
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
        await _require_in_scope(db, defn, row_id, user)
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
