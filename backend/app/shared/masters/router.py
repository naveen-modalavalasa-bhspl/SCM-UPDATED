"""Master-data endpoints. CRUD comes from the MasterDef registry; the only things
written by hand here are the two HCM mirrors (read-only, rule 10) and item specs,
whose primary key is item_id rather than a surrogate id."""
from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.core.exceptions import NotFoundError, ValidationError
from app.platform.hcm.models import HcmDepartment, HcmFacility
from app.platform.rbac import permissions as perms
from app.shared.enums import AuditAction, UomClass
from app.shared.limits import MAX_BATCH_IDS
from app.shared.masters import packs
from app.shared.masters.crud import build_router
from app.shared.masters.defs import (
    MASTERS, UOM_SUGGESTIONS, VendorMappingIn, build_item_code, build_item_prefix,
    save_vendor_mapping, vendor_mapping_sources,
    check_hsn_code, hsn_out, packaging_breakdown, peek_item_serial, sibling_item,
)
from app.shared.models.master import GeneralName, HsnCode, Item, ItemCategory, ItemSpec, Uom

router = build_router(MASTERS)

_hcm = APIRouter(tags=["masters"])


@_hcm.get("/api/departments")
async def list_departments(db: AsyncSession = Depends(get_db),
                           user=Depends(get_current_user)):
    rows = (await db.execute(
        select(HcmDepartment).where(HcmDepartment.is_active.is_(True))
        .order_by(HcmDepartment.name)
    )).scalars().all()
    return {"items": [{"id": d.id, "code": d.code, "name": d.name} for d in rows]}


def _ownership_department_options(rows) -> list[dict]:
    """One routing option per department name, despite HCM's office-scoped rows.

    The current HCM feed contains hundreds of separate department IDs named `104`,
    one for each office. Item ownership is a company-level routing choice, so showing
    every office copy makes the selector unusable. Keep one deterministic HCM row per
    normalised name: prefer a row carrying a code, then the lowest HCM ID.

    This intentionally powers only the Item Master ownership selector. The ordinary
    `/api/departments` endpoint remains lossless for screens that need office-specific
    HCM department records.
    """
    chosen: dict[str, HcmDepartment] = {}
    counts: dict[str, int] = {}
    for row in rows:
        name = (row.name or "").strip()
        if not name:
            continue
        key = name.casefold()
        counts[key] = counts.get(key, 0) + 1
        current = chosen.get(key)
        candidate_rank = (0 if row.code else 1, row.id)
        current_rank = ((0 if current.code else 1), current.id) if current else None
        if current is None or candidate_rank < current_rank:
            chosen[key] = row
    return [{
        "id": chosen[key].id,
        "code": chosen[key].code,
        "name": chosen[key].name.strip(),
        "duplicate_count": counts[key],
    } for key in sorted(chosen, key=lambda value: chosen[value].name.casefold())]


@_hcm.get("/api/departments/ownership-options")
async def list_ownership_departments(db: AsyncSession = Depends(get_db),
                                     user=Depends(get_current_user)):
    rows = (await db.execute(
        select(HcmDepartment).where(HcmDepartment.is_active.is_(True))
        .order_by(HcmDepartment.id)
    )).scalars().all()
    return {"items": _ownership_department_options(rows)}


@_hcm.get("/api/facilities")
async def list_facilities(db: AsyncSession = Depends(get_db),
                          user=Depends(get_current_user)):
    rows = (await db.execute(
        select(HcmFacility).where(HcmFacility.is_active.is_(True))
        .order_by(HcmFacility.name)
    )).scalars().all()
    return {"items": [{"id": f.id, "name": f.name,
                       "is_stock_location": f.is_stock_location} for f in rows]}


router.include_router(_hcm)


# --------------------------------------------------------------------------- #
#  Job profiles — the rung a BOM group is handed to
# --------------------------------------------------------------------------- #
_profiles = APIRouter(tags=["masters"])


@_profiles.get("/api/bom-groups/job-profiles")
async def bom_group_job_profiles(
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.MASTER_BOM_MANAGE)),
):
    """The job profiles a BOM can be given to, named and grouped by project.

    Gated on the BOM permission rather than on ADMIN_ROLES_MANAGE, which the RBAC
    screen's own listing uses: naming a profile is not editing one, and a master-data
    maintainer must be able to fill this dropdown without holding the keys to RBAC.

    `user` is passed on, so the dropdown is narrowed to the caller's scope rung — it
    offers exactly the profiles `apply_bom_group` will accept a write for, and a
    district admin is never shown another region's jobs.

    Derived from the HCM mirror on every read (rule 10), so a profile that no longer
    exists after a cutover simply stops being offered.
    """
    from app.platform.rbac.profiles import profile_options

    return {"items": await profile_options(db, user)}


router.include_router(_profiles)


# --------------------------------------------------------------------------- #
#  UOM suggestions — the standard units for a measurement class
# --------------------------------------------------------------------------- #
_uom = APIRouter(tags=["masters"])


@_uom.get("/api/uom/suggestions")
async def uom_suggestions(uom_class: str, db: AsyncSession = Depends(get_db),
                          user=Depends(get_current_user)):
    """The known units for a class, each flagged with whether it already exists.

    Offering the list is what stops "Litre", "litre" and "Ltr" becoming three rows:
    the admin ticks a name rather than typing one.
    """
    if uom_class not in {c.value for c in UomClass}:
        raise ValidationError(
            f"uom_class must be one of {', '.join(c.value for c in UomClass)}")
    taken = set((await db.execute(select(Uom.code))).scalars().all())
    return {"items": [{"code": code, "name": name, "exists": code in taken}
                      for code, name in UOM_SUGGESTIONS[uom_class]]}


class UomBulkIn(BaseModel):
    uom_class: str
    codes: list[str]


@_uom.post("/api/uom/suggestions")
async def create_suggested_uoms(
    data: UomBulkIn, db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.MASTER_UOM_MANAGE)),
):
    """Create the ticked suggestions in one call. Codes that already exist are
    skipped rather than rejected, so ticking the whole list twice is harmless."""
    if data.uom_class not in {c.value for c in UomClass}:
        raise ValidationError(
            f"uom_class must be one of {', '.join(c.value for c in UomClass)}")
    known = dict(UOM_SUGGESTIONS[data.uom_class])
    unknown = [code for code in data.codes if code not in known]
    if unknown:
        raise ValidationError(
            f"Not a suggested unit for {data.uom_class}: {', '.join(unknown)}")

    taken = set((await db.execute(select(Uom.code))).scalars().all())
    created = []
    for code in data.codes:
        if code in taken:
            continue
        db.add(Uom(code=code, name=known[code], uom_class=data.uom_class,
                   is_active=True))
        created.append(code)
    await db.commit()
    return {"created": created, "skipped": [c for c in data.codes if c in taken]}


router.include_router(_uom)


# --------------------------------------------------------------------------- #
#  HSN resolve — item entry may register a provisional zero-rate classification
# --------------------------------------------------------------------------- #
_hsn = APIRouter(tags=["masters"])


class HsnResolveIn(BaseModel):
    code: str = Field(min_length=8, max_length=8)

    # The same reading of a code as the HSN master's own schema, so a number, a
    # grouped "8471 30 10" and the canonical text all resolve to one row.
    @field_validator("code", mode="before")
    @classmethod
    def _code(cls, value):
        return check_hsn_code(value)


@_hsn.post("/api/hsn-codes/resolve")
async def resolve_hsn_code(
    data: HsnResolveIn,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.MASTER_ITEM_MANAGE)),
):
    """Return an existing HSN or create a zero-rate row for later tax maintenance.

    Item maintainers may register the classification code, but only HSN maintainers
    can subsequently edit GST rates through the normal HSN master endpoint.
    """
    existing = await db.scalar(select(HsnCode).where(HsnCode.code == data.code))
    if existing is not None:
        return hsn_out(existing)

    row = HsnCode(code=data.code, gst_rate=0, is_active=True)
    db.add(row)
    await db.flush()

    from app.platform.settings.service import write_audit

    await write_audit(db, entity=HsnCode.__tablename__, entity_id=row.id,
                      action=AuditAction.CREATE, actor=user, after=hsn_out(row))
    await db.commit()
    await db.refresh(row)
    return hsn_out(row)


router.include_router(_hsn)


# --------------------------------------------------------------------------- #
#  Packaging breakdown — the ladder multiplied up
# --------------------------------------------------------------------------- #
_packing = APIRouter(tags=["masters"])


@_packing.get("/api/items/{item_id}/packaging-breakdown")
async def item_packaging_breakdown(item_id: int, hierarchy_id: int | None = None,
                                   db: AsyncSession = Depends(get_db),
                                   user=Depends(get_current_user)):
    """1 tray = 10 L, 1 box = 10 trays = 100 L, 1 container = 10 boxes = 1000 L.

    One hierarchy at a time — the item's default when none is named. Computed from
    the stored rungs on every read rather than kept as a column, so the totals can
    never drift from the quantities they come from.
    """
    return {"items": await packaging_breakdown(db, item_id, hierarchy_id)}


@_packing.get("/api/pack-options")
async def item_pack_options(item_ids: str = Query(..., max_length=4000),
                            db: AsyncSession = Depends(get_db),
                            user=Depends(get_current_user)):
    """Every pack hierarchy of these items, each level with its size in base units and
    its sentence ("Box · 10 Strip (100 TAB)"). One call for a whole document: the pack
    pickers on a PO, a despatch note, a GRN and an issue all read it.

    `item_ids` is a comma-separated list, capped like every other id selection.
    """
    ids = []
    for part in item_ids.split(","):
        part = part.strip()
        if part.isdigit():
            ids.append(int(part))
    if len(ids) > MAX_BATCH_IDS:
        raise ValidationError(f"Ask for at most {MAX_BATCH_IDS} items at once.")
    options = await packs.pack_options(db, ids)
    return {"items": [{"item_id": item_id, "hierarchies": rows}
                      for item_id, rows in options.items()]}


router.include_router(_packing)


# --------------------------------------------------------------------------- #
#  Item specifications — keyed by item_id, so this is an upsert, not a create
# --------------------------------------------------------------------------- #
_specs = APIRouter(tags=["masters"])


class ItemSpecIn(BaseModel):
    description: str | None = None
    brand: str | None = None
    model_no: str | None = None
    part_no: str | None = None
    manufacturer: str | None = None
    # Answers to whatever the item's category requires, keyed by attribute code.
    specifications: dict | None = None
    storage_conditions: str | None = None
    shelf_life_days: int | None = None
    image_url: str | None = None


def _spec_out(s: ItemSpec) -> dict:
    return {"item_id": s.item_id, "description": s.description, "brand": s.brand,
            "model_no": s.model_no, "part_no": s.part_no,
            "manufacturer": s.manufacturer, "specifications": s.specifications or {},
            "storage_conditions": s.storage_conditions,
            "shelf_life_days": s.shelf_life_days, "image_url": s.image_url}


@_specs.get("/api/item-specs/{item_id}")
async def get_item_spec(item_id: int, db: AsyncSession = Depends(get_db),
                        user=Depends(get_current_user)):
    """Returns an empty spec rather than 404 when the item has none yet, so the
    screen can render the form without a special 'not created' branch."""
    if await db.get(Item, item_id) is None:
        raise NotFoundError("Item not found")
    spec = await db.get(ItemSpec, item_id)
    return _spec_out(spec) if spec else {"item_id": item_id, "specifications": {}}


@_specs.put("/api/item-specs/{item_id}")
async def save_item_spec(item_id: int, data: ItemSpecIn,
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.MASTER_SPEC_MANAGE))):
    if await db.get(Item, item_id) is None:
        raise NotFoundError("Item not found")
    if data.shelf_life_days is not None and data.shelf_life_days < 0:
        raise ValidationError("Shelf life cannot be negative")

    spec = await db.get(ItemSpec, item_id)
    if spec is None:
        spec = ItemSpec(item_id=item_id)
        db.add(spec)
    for key, value in data.model_dump().items():
        setattr(spec, key, value)
    await db.commit()
    await db.refresh(spec)
    return _spec_out(spec)


router.include_router(_specs)


# --------------------------------------------------------------------------- #
#  Unit-code tracking — the item form's fifth tracking toggle
# --------------------------------------------------------------------------- #
# It is NOT a column on mst_items (the live schema is frozen), so it cannot ride on
# the item read the way is_batch_tracked does — `MasterDef.serialize` is synchronous
# and has no session. The form asks for it here instead, and writes it back through
# `ItemIn.generate_unit_code` on save.
_tracking = APIRouter(tags=["masters"])


@_tracking.get("/api/items/next-code")
async def next_item_code(category_id: int, general_name_id: int | None = None,
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.MASTER_ITEM_MANAGE))):
    """The code a new item is about to get, for the form's preview.

    Read-only and lock-free: the save re-derives the serial under lock, so the
    preview can be off by one if two people save into the same prefix together.
    The hint beside the field says exactly that.
    """
    category = await db.get(ItemCategory, category_id)
    if category is None or category.level != 3:
        raise ValidationError("Select a Level 3 category first")
    prefix = build_item_prefix(category.path)
    sibling = await sibling_item(db, prefix, category.id, general_name_id)
    if sibling is not None:
        return {"prefix": prefix, "next_serial": sibling.serial_no,
                "preview": sibling.code}
    serial = await peek_item_serial(db, prefix)
    return {"prefix": prefix, "next_serial": serial,
            "preview": build_item_code(category.path, serial)}


@_tracking.get("/api/items/{item_id}/unit-code-tracking")
async def get_unit_code_tracking(item_id: int, db: AsyncSession = Depends(get_db),
                                 user=Depends(get_current_user)):
    from app.platform.settings import codeformat

    item = await db.get(Item, item_id)
    if item is None:
        raise NotFoundError("Item not found")
    tracked = await codeformat.tracked_items(db)
    return {"item_id": item_id,
            # Unconfigured reads as ON: that is what the dock did before the toggle
            # existed, and every unit put away so far was coded.
            "generate_unit_code": True if tracked is None else (item.code or "") in tracked,
            "kind": "asset" if item.is_asset else "consumable"}


# --------------------------------------------------------------------------- #
# Item eligibility needs two dropdowns whose rows live in two unrelated tables:
# `rbac_roles` for a ROLE tag and `hcm_offices` for a REGION one. Served together
# from one route so the screen makes ONE call, and gated on the same permission that
# manages the tagging itself — reaching for /api/rbac/roles would have made the
# masters screen depend on an administrator's role-management permission to render a
# dropdown, which is a wider grant than tagging an item needs.
# --------------------------------------------------------------------------- #

# NOT "/api/item-eligibility/scope-options": the factory registers
# `/api/item-eligibility/{row_id}` (int-typed) before this router is included, so a
# literal segment under that prefix never matches — it 422s trying to read
# "scope-options" as an id. Its own path avoids the collision without reordering
# routes that already work.
@_tracking.get("/api/item-eligibility-scopes")
async def item_eligibility_scope_options(
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.MASTER_ITEM_MANAGE)),
):
    from app.platform.hcm.models import HcmOffice
    from app.platform.rbac.profiles import profile_options

    # REVISED 2026-08-23 — each role now carries HOW MANY PEOPLE HOLD IT.
    #
    # The list is `rbac_roles`, which mixes four populations: the seed roles, the
    # HCM-mirrored ones, the duplicates an HCM re-key leaves behind (`driver_161`,
    # `storekeeper`) and the job-profile ones (`jp_22_store_keeper`). Twelve names are
    # duplicated across them, and 53 of 59 are held by nobody at all — so the screen
    # offered a dozen plausible-looking "Store Keeper" rows of which none would ever
    # match a real login. Every one of the 87 items ended up tagged to three of those
    # dead rows, which restricted the whole catalogue to an audience of zero.
    #
    # The count is the fix. `holders: 0` is the one fact that distinguishes a role that
    # will work from one that cannot, and it is shown rather than filtered on: hiding
    # the empty ones would silently drop a role that is real but not yet granted, and
    # would have explained nothing about why the last attempt did nothing.
    #
    # Eligibility resolves through `rbac_user_roles` (and a job profile where the
    # position has one), which is exactly what this counts — so a non-zero number here
    # means at least one person really does match the tag.
    profiles = [p for p in await profile_options(db, user) if p.get("role_id")]
    offices = (await db.execute(
        select(HcmOffice.id, HcmOffice.name).where(HcmOffice.is_active.is_(True))
        .order_by(HcmOffice.name))).all()
    return {
        # `code` rides along because the NAME alone cannot tell three "Store Keeper"
        # rows apart — `store_keeper`, `jp_22_store_keeper` and `storekeeper` are
        # different ids and only the code says which is which.
        "projects": [{"id": p["project_id"], "name": p["project_name"]}
                     for p in {p["project_id"]: p for p in profiles}.values()],
        "roles": [{"id": p["role_id"], "name": p["name"], "code": p["key"],
                   "holders": p["holder_count"], "project_id": p["project_id"],
                   "project_name": p["project_name"]} for p in profiles],
        "regions": [{"id": o[0], "name": o[1]} for o in offices],
    }


# --------------------------------------------------------------------------- #
# Bulk assignment: one scope, many items.
#
# The row-at-a-time CRUD the factory generates is the right SHAPE for the table and
# the wrong shape for the job. A role serves hundreds of items; tagging them through
# a modal one pair at a time is not a screen anybody would use twice. So the desk
# works the way the question is actually asked — "which items may this role raise?" —
# and this pair of routes reads and replaces that whole answer in one call.
#
# Their own path, NOT under `/api/item-eligibility/…`: the factory registers
# `/{row_id}` (int-typed) before this router is included, so a literal segment there
# never matches and 422s instead.
# --------------------------------------------------------------------------- #

class _AssignIn(BaseModel):
    scope_type: str
    scope_id: int
    #: The COMPLETE set for this scope. Anything already tagged and absent here is
    #: removed — a replace, not a merge, because the screen shows the whole list with
    #: ticks and "untick then save" has to mean something.
    item_ids: list[int]


@_tracking.get("/api/item-eligibility-assignments")
async def item_eligibility_assignments(
    scope_type: str, scope_id: int,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.MASTER_ITEM_MANAGE)),
):
    """The item ids currently tagged to one role or region."""
    from app.shared.models.master import ItemEligibility

    scope = (scope_type or "").strip().upper()
    rows = (await db.execute(
        select(ItemEligibility.item_id).where(
            ItemEligibility.scope_type == scope,
            ItemEligibility.scope_id == scope_id,
            ItemEligibility.is_active.is_(True),
        ))).scalars().all()
    return {"scope_type": scope, "scope_id": scope_id,
            "item_ids": sorted(int(i) for i in rows)}


@_tracking.put("/api/item-eligibility-assignments")
async def set_item_eligibility_assignments(
    body: _AssignIn,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.MASTER_ITEM_MANAGE)),
):
    """Replace everything tagged to one scope, in one call.

    Differences are applied rather than the set being deleted and rebuilt: a tag that
    is staying keeps its row, its id and its created_at, so the audit trail reads as
    "this item was added in March" and not as "everything was recreated today".

    Re-activates rather than inserting a duplicate when a pair is tagged again after
    being switched off — the unique index would refuse the insert, and an admin
    re-ticking a box means "on", not "error".
    """
    from app.shared.enums import ItemScope
    from app.shared.models.master import Item, ItemEligibility

    scope = (body.scope_type or "").strip().upper()
    if scope not in {s.value for s in ItemScope}:
        raise ValidationError(
            f"scope_type must be one of {sorted(s.value for s in ItemScope)}")

    if scope == ItemScope.ROLE.value:
        from app.platform.rbac.models import Role
        scope_name = (await db.execute(
            select(Role.name).where(Role.id == body.scope_id))).scalar_one_or_none()
        if scope_name is None:
            raise NotFoundError(f"Unknown role id: {body.scope_id}")
    else:
        from app.platform.hcm.models import HcmOffice
        scope_name = (await db.execute(
            select(HcmOffice.name).where(
                HcmOffice.id == body.scope_id))).scalar_one_or_none()
        if scope_name is None:
            raise NotFoundError(f"Unknown region (office) id: {body.scope_id}")

    wanted = {int(i) for i in body.item_ids}
    existing = {
        int(row.item_id): row for row in (await db.execute(
            select(ItemEligibility).where(
                ItemEligibility.scope_type == scope,
                ItemEligibility.scope_id == body.scope_id,
            ))).scalars().all()
    }

    # Snapshots, so the register reads without joining — same reason the row-at-a-time
    # hook takes them. One query for every new item rather than one per item.
    new_ids = wanted - set(existing)
    names = {
        int(i): (code, name) for i, code, name in (await db.execute(
            select(Item.id, Item.code, Item.name).where(Item.id.in_(new_ids or [0]))
        )).all()
    }
    unknown = new_ids - set(names)
    if unknown:
        raise ValidationError(f"Unknown item ids: {sorted(unknown)}")

    added = removed = restored = 0
    for item_id in new_ids:
        code, name = names[item_id]
        db.add(ItemEligibility(
            item_id=item_id, item_code=code, item_name=name,
            scope_type=scope, scope_id=body.scope_id, scope_name=scope_name,
            is_active=True))
        added += 1
    for item_id, row in existing.items():
        if item_id in wanted and not row.is_active:
            row.is_active = True
            restored += 1
        elif item_id not in wanted and row.is_active:
            # Deactivated, not deleted: the row is the record that this pair was once
            # allowed, and `eligibility` only ever reads active rows.
            row.is_active = False
            removed += 1
        # A row already active and still wanted is left completely alone.

    await db.commit()
    return {"scope_type": scope, "scope_id": body.scope_id,
            "scope_name": scope_name, "total": len(wanted),
            "added": added, "restored": restored, "removed": removed}


# --------------------------------------------------------------------------- #
#  Item photos (2026-10-01)
# --------------------------------------------------------------------------- #
# Kept in the shared attachment store (sys_attachments, entity_type ITEM), which
# already whitelists file types by their leading bytes, caps the size while it
# streams, and audits deletes. Reading is any signed-in user (the item list is);
# adding and removing needs master.item.manage, like every other item edit.
ITEM_PHOTO = "ITEM"
PHOTO_TYPES = (".jpg", ".jpeg", ".png", ".webp")


async def _item_or_404(db: AsyncSession, item_id: int) -> Item:
    item = await db.get(Item, item_id)
    if item is None:
        raise NotFoundError("Item: that item does not exist.")
    return item


def _photo_out(row) -> dict:
    return {"id": row.id, "file_name": row.file_name,
            "uploaded_at": row.created_at.isoformat() if row.created_at else None,
            "uploaded_by": row.uploaded_by_name}


@_tracking.get("/api/items/{item_id}/photos")
async def item_photos(item_id: int, db: AsyncSession = Depends(get_db),
                      user=Depends(get_current_user)):
    from app.platform.settings import attachments
    await _item_or_404(db, item_id)
    return [_photo_out(r) for r in
            await attachments.list_attachments(db, ITEM_PHOTO, item_id)]


@_tracking.post("/api/items/{item_id}/photos")
async def add_item_photo(item_id: int, file: UploadFile = File(...),
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.MASTER_ITEM_MANAGE))):
    from app.platform.settings import attachments
    await _item_or_404(db, item_id)
    if not (file.filename or "").lower().endswith(PHOTO_TYPES):
        raise ValidationError("Photo: use a JPG, PNG or WEBP picture.")
    row = await attachments.add_attachment(
        db, entity_type=ITEM_PHOTO, entity_id=item_id, upload=file,
        doc_category="PHOTO", user=user)
    await db.commit()
    return _photo_out(row)


@_tracking.get("/api/items/{item_id}/photos/{photo_id}/file")
async def item_photo_file(item_id: int, photo_id: int,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(get_current_user)):
    from app.platform.settings import attachments
    await attachments.require_attachment(db, photo_id, entity_type=ITEM_PHOTO,
                                         entity_id=item_id)
    path, name, mime = await attachments.attachment_file(db, photo_id)
    # Inline: these are pictures (the upload refused anything else), shown in an <img>.
    return FileResponse(path, media_type=mime, filename=name,
                        content_disposition_type="inline")


@_tracking.delete("/api/items/{item_id}/photos/{photo_id}")
async def delete_item_photo(item_id: int, photo_id: int,
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.MASTER_ITEM_MANAGE))):
    from app.platform.settings import attachments
    await attachments.delete_attachment(db, photo_id, user, entity_type=ITEM_PHOTO,
                                        entity_id=item_id)
    await db.commit()
    return {"success": True}


# Vendor material mapping: suppliers x categories/items in one save. Same permission
# as the Vendor Rates rows it writes (master.vendor.manage).
@_tracking.get("/api/vendor-items/mapping-sources")
async def vendor_mapping_sources_route(
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.MASTER_VENDOR_MANAGE))):
    return await vendor_mapping_sources(db)


@_tracking.post("/api/vendor-items/mapping")
async def save_vendor_mapping_route(
        data: VendorMappingIn, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.MASTER_VENDOR_MANAGE))):
    return await save_vendor_mapping(db, data, user)


router.include_router(_tracking)
