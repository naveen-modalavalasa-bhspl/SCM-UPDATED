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


class UseExistingRow(Exception):
    """Raised by a master's `apply` when the "new" row is really an existing one —
    an item whose code already exists gets the new brand added to it rather than a
    second row (2026-10-23). The create route answers with that row and a message,
    and writes nothing else."""

    def __init__(self, row, message: str):
        super().__init__(message)
        self.row = row
        self.message = message


# A usage declaration names a table and a column. Nothing from a request is ever
# interpolated into SQL, but the check keeps that true if defs.py is edited carelessly.
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


async def _audit(db: AsyncSession, **kwargs) -> None:
    """Audit lives in platform/settings, which is downstream of shared. The import is
    function-local so the module-level graph still runs one way (rule 5), matching how
    core/dependencies.py reaches models."""
    from app.platform.settings.service import write_audit

    await write_audit(db, **kwargs)


@dataclass(frozen=True)
class Lookup:
    """A foreign key column, stated as the NAME of the thing rather than its id.

    The masters are filled in by people whose job is the goods, not the database.
    Asking for `category_id = 47` meant downloading eight other exports, finding
    "Antibiotics" in one of them and typing the number next to it — for six required
    columns, on every row. The column is the category's NAME now, and the name is
    turned back into the id on the way in.

    The target is a MODEL, not another master's path: `defs.py` already has every
    model in scope, and a path would mean bulk.py reading the registry that is built
    out of the module importing it.

    `match` is tried in order and the first column that answers wins, so a file
    holding codes still imports. A name that matches two rows is REFUSED rather than
    guessed — a master row pointed at the wrong parent is not a typo anybody catches
    later, it is stock counted against the wrong category for a year.
    """
    field: str                                   # "category_id"
    model: type                                  # ItemCategory
    label: str                                   # "Category" — the sheet's header
    match: Sequence[str] = ("name", "code")
    # Which column names the row on screen and in the sheet, first non-empty wins.
    # Not always `name`: an HSN code has only a `code` and a `description`, and a
    # lookup that insisted on `name` served that column no dropdown at all and left
    # its export writing bare ids.
    display: Sequence[str] = ("name", "code")
    # How many options the template is willing to put in a dropdown. Above this the
    # column is free text and the review screen resolves it: Excel chokes on a
    # validation list of nine hundred warehouses, and so does the person reading it.
    max_options: int = 500
    # Turns a cell into the form the target stores, when the two can differ — an HSN
    # code typed into Excel loses its leading zero. Tried only after the cell as
    # typed has failed to match, and only ever to FIND a row, never to create one.
    normalize: Callable[[str], str] | None = None
    # Column values a row must hold to be pickable here, e.g. {"level": 3}: an item
    # sits only in a Level 3 category, and offering the parents let a sheet pass the
    # review and then fail at Save. `where_hint` is what the row is told instead.
    where: dict[str, Any] | None = None
    where_hint: str = ""
    # Rows sharing one name are ONE choice, not an ambiguity. HCM sends a separate
    # department row per office — 503 of them called "104" — and the Item form already
    # offers each name once (`router._ownership_department_options`); the import picks
    # the same row that form does: an active row with a code first, then the lowest id.
    same_name_is_one: bool = False


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
    # Async hook that annotates rows with response-only derived values after they
    # have been loaded. Warehouse locations use it for path/depth: neither value is
    # stored, because both must always follow the current parent tree.
    prepare: Callable | None = None
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
    # Sync hook that narrows the LIST from the query string, for a master whose
    # dropdown means different rows to different callers. Declared per master rather
    # than branched on `path` in the generic handler. Takes (request, stmt) and
    # returns a statement.
    list_filter: Callable | None = None
    # Where this master is referenced, as (label, table, column). Declared as plain
    # strings rather than models because most referents live in app.modules, and
    # shared may not import a module (rule 5). Powers GET {base}/{id}/usage, so the
    # admin is told "used by 42 items" before deactivating rather than after.
    usage: Sequence[tuple[str, str, str]] = ()
    # Columns the blank TEMPLATE leaves out because the system fills them in (a
    # category's number). Still in the export and still accepted on import.
    template_omit: Sequence[str] = ()
    # FK columns this master's spreadsheet states by name instead of by id. Empty
    # means the sheet keeps the raw `*_id` columns, which is still what most masters
    # want — a master with no foreign keys has nothing to look up.
    lookups: Sequence[Lookup] = ()


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
    from app.shared.masters import short_codes
    await short_codes.enforce(db, defn, row, data)
    if defn.apply is not None:
        if defn.apply_needs_user:
            await defn.apply(db, row, data, user)
        else:
            await defn.apply(db, row, data)
        return
    for key, value in data.model_dump().items():
        setattr(row, key, value)


async def _prepare_rows(db: AsyncSession, defn: MasterDef, rows: Sequence[Any]) -> None:
    if defn.prepare is not None and rows:
        await defn.prepare(db, rows)


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

    from app.shared.masters import short_codes
    if short_codes.applies(defn) and not defn.read_only:
        # Registered before /{row_id} so "suggest-code" is never read as an id.
        @router.get(base + "/suggest-code", name=f"suggest_code_{defn.path}")
        async def suggest_code(name: str = "", db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(defn.manage_perm))):
            """The three-letter code a new row with this name would get."""
            return {"code": await short_codes.suggest(db, defn.model, name)}

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
        if defn.list_filter is not None:
            stmt = defn.list_filter(request, stmt)
        if search:
            clause = _search_clause(defn, search)
            if clause is not None:
                stmt = stmt.where(clause)
        stmt = stmt.order_by(getattr(defn.model, defn.order_col))

        if not defn.paginated:
            rows = (await db.execute(stmt)).scalars().all()
            await _prepare_rows(db, defn, rows)
            return {"items": [defn.serialize(r) for r in rows]}

        page = await paginate(db, stmt, params)
        await _prepare_rows(db, defn, page["items"])
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
        try:
            await _apply_fields(db, defn, row, data, user)
        except UseExistingRow as existing:
            await _write(db, defn, commit=True)
            await db.refresh(existing.row)
            await _prepare_rows(db, defn, [existing.row])
            return {**defn.serialize(existing.row), "merged_into_existing": True,
                    "message": existing.message}
        db.add(row)
        await _write(db, defn)
        # A new row has only ever been written, never read, so anything the ORM does
        # not hold in memory — a server default, or a column_property like
        # Bom.line_count — is still unloaded. Reading one inside serialize() would
        # fire a lazy SELECT from async code and raise MissingGreenlet, so the load
        # happens here, before either serialize call, where awaiting IO is allowed.
        await db.refresh(row)
        await _prepare_rows(db, defn, [row])
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
        await _prepare_rows(db, defn, [row])
        before = defn.serialize(row)
        await _apply_fields(db, defn, row, data, user)
        await _write(db, defn)
        # Flush expires SQL expressions such as Bom.line_count. Serializing one here
        # would otherwise start an implicit SELECT from async code and fail with
        # MissingGreenlet/StatementError before the audit or commit can complete.
        # Refresh while IO can be awaited, just as the create path does above.
        await db.refresh(row)
        await _prepare_rows(db, defn, [row])
        await _audit(db, entity=defn.model.__tablename__, entity_id=row.id,
                     action=AuditAction.UPDATE, actor=user,
                     before=before, after=defn.serialize(row))
        await _write(db, defn, commit=True)
        await db.refresh(row)
        await _prepare_rows(db, defn, [row])
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
