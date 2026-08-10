"""RBAC-aware home dashboard read model.

Every section is assembled after resolving the signed-in user's effective
permissions for their active position. The frontend never receives cards, actions,
modules, attention items, or activity for a capability the user cannot access.
"""
from datetime import datetime, timedelta, timezone
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.home.schemas import DateRange
from app.modules.indents import service as indent_service
from app.shared.scope import rung_for, scope_condition
from app.modules.indents.models import Indent
from app.modules.inventory import service as inventory_service
from app.modules.procurement.models import PurchaseOrder
from app.modules.warehouse.enums import ReceiptStatus, ReceiptType
from app.modules.warehouse.models import Receipt
from app.platform.rbac import permissions as perms
from app.platform.rbac.service import (
    get_user_menu, get_user_permissions, warehouse_menu_label,
)
from app.platform.settings.models import AuditLog
from app.platform.workflow import engine
from app.shared.enums import IndentStatus, POStatus, ScopeRung
from app.modules.indents.enums import IndentType
from app.shared.time import now as ist_now, today as ist_today


APPROVE_PERMISSIONS = {
    perms.INDENT_APPROVE,
    perms.PO_APPROVE,
    perms.ALLOCATION_APPROVE,
    perms.MR_APPROVE,
    perms.DISPATCH_APPROVE,
    perms.RETURN_APPROVE,
}

MODULE_DESCRIPTIONS = {
    "grp_indents": "Raise and track material indents",
    "approvals": "Review and approve requests",
    "grp_purchasing": "Manage purchase orders",
    "grp_warehouse": "Manage warehouse operations",
    "grp_inventory": "Track stock and item availability",
    "masters": "Maintain supply chain master data",
    "grp_rbac": "Manage roles and access",
    "grp_settings": "Configure the SCM workspace",
}


def _range_start(value: DateRange) -> datetime:
    now = ist_now()
    if value == "month":
        return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if value == "quarter":
        first_month = ((now.month - 1) // 3) * 3 + 1
        return now.replace(
            month=first_month, day=1, hour=0, minute=0, second=0, microsecond=0,
        )
    return (now - timedelta(days=6)).replace(hour=0, minute=0, second=0, microsecond=0)


async def _count(db: AsyncSession, model, *conditions) -> int:
    stmt = select(func.count()).select_from(model)
    if conditions:
        stmt = stmt.where(*conditions)
    return int(await db.scalar(stmt) or 0)


def _kpi(
    key: str, label: str, value: int, detail: str, href: str, icon: str,
    *, tone: str = "brand", detail_tone: str = "brand",
) -> dict:
    return {
        "key": key, "label": label, "value": value, "detail": detail,
        "detail_tone": detail_tone, "href": href, "icon": icon, "tone": tone,
    }


def _action(
    key: str, label: str, href: str, icon: str, tone: str = "brand",
) -> dict:
    return {"key": key, "label": label, "href": href, "icon": icon, "tone": tone}


def _attention(
    key: str, label: str, count: int, href: str, icon: str, tone: str = "brand",
) -> dict:
    return {
        "key": key, "label": label, "count": count, "href": href,
        "icon": icon, "tone": tone,
    }


async def _stock_counts(db: AsyncSession, user) -> tuple[int, int]:
    """Low / out-of-stock item counts, read from the same list the Replenishment
    screen shows. Counting `stk_balance` rows here instead reported a different
    number than Inventory > Overview ("Items Below Reorder"), because a single item
    has one row per warehouse/bin/batch and rows are warehouse-scoped per user.
    low + out is exactly `items_below_reorder`.
    """
    rows = await inventory_service.get_stock_replenishment(db, user=user)
    low = sum(1 for row in rows if float(row["available_qty"] or 0) > 0)
    return low, len(rows) - low


def _visible_modules(menu: list[dict]) -> list[dict]:
    modules = []
    for item in menu:
        if item["code"] == "home":
            continue
        modules.append({
            "code": item["code"],
            "name": item["name"],
            "description": MODULE_DESCRIPTIONS.get(
                item["code"], f"Open {item['name'].lower()}",
            ),
            "href": item["path"],
            "icon": item.get("icon") or "layout-grid",
        })
    return modules


def _can_see_audit(entity: str, permissions: set[str]) -> bool:
    if entity.startswith("ind_"):
        return perms.INDENT_VIEW in permissions
    if entity.startswith("pro_purchase"):
        return perms.PO_VIEW in permissions
    if entity.startswith(("inb_", "lgs_grn")):
        return bool({perms.RECEIPT_VIEW, perms.GRN_VIEW} & permissions)
    if entity.startswith(("stk_", "inv_")):
        return perms.STOCK_VIEW in permissions
    if entity.startswith(("whs_", "out_")):
        return bool({
            perms.RECEIPT_VIEW, perms.ISSUE_VIEW, perms.DISPATCH_VIEW,
            perms.PICKING_VIEW, perms.RETURN_VIEW,
        } & permissions)
    if entity.startswith("mst_"):
        return any(code.startswith("master.") for code in permissions)
    if entity.startswith(("rbac_", "sys_", "wf_", "rule_")):
        return any(code.startswith("admin.") for code in permissions)
    return False


def _activity_meta(entity: str, entity_id: int) -> tuple[str, str, str]:
    if entity.startswith("ind_"):
        return "file-text", "brand", f"/indents/{entity_id}"
    if entity.startswith("pro_purchase"):
        return "shopping-cart", "purple", "/pos"
    if entity.startswith(("inb_", "lgs_grn")):
        return "package-down", "cyan", "/warehouse/grn"
    if entity.startswith(("stk_", "inv_")):
        return "package", "cyan", "/inventory"
    if entity.startswith(("whs_", "out_")):
        return "warehouse", "orange", "/warehouse"
    if entity.startswith("mst_"):
        return "database", "brand", "/masters"
    return "settings", "neutral", "/admin"


# An audit action is something a person did; a status is what the document became.
# Falling back to the raw action put both in the same slot, so the feed read
# "IND/2026-27/00576 deactivate" as though DEACTIVATE were an indent status.
_ACTION_PHRASES = {
    "CREATE": "created",
    "UPDATE": "updated",
    "DELETE": "deleted",
    "DEACTIVATE": "deactivated",
    "ACTIVATE": "reactivated",
    "APPROVE": "approved",
    "REJECT": "rejected",
    "CANCEL": "cancelled",
    "SUBMIT": "submitted",
}


def _activity_verb(row: AuditLog) -> str:
    changed = row.changed_fields if isinstance(row.changed_fields, dict) else {}
    status = changed.get("status")
    if isinstance(status, dict) and status.get("to"):
        return str(status["to"]).replace("_", " ").lower()
    action = str(row.action or "").upper()
    return _ACTION_PHRASES.get(action, action.replace("_", " ").lower() or "changed")


def _is_overdue(row: dict) -> bool:
    value = row.get("due_at")
    if not value:
        return False
    try:
        due_at = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return False
    if due_at.tzinfo is None:
        due_at = due_at.replace(tzinfo=timezone.utc)
    return due_at < ist_now()


async def _recent_activity(
    db: AsyncSession, user, permissions: set[str], since: datetime,
) -> list[dict]:
    """The feed at the foot of Home, narrowed to what this login may actually know.

    It used to read the last 40 audit rows company-wide and drop only the ones whose
    entity_type the login held no permission for, so a SELF-scoped lab technician
    watched other people's indents move through other people's offices.

    Two bounds now apply, in this order:

      * the rung. At ALL nothing is withheld. Below that, an entry has to be either
        something this login DID, or a change to an indent it may read — those are
        resolved through `indents._indent_visibility`, the same predicate the list and
        the ledger use, so the feed cannot show a document the Indents screen hides.
      * the existing permission check on entity_type, unchanged.

    Rows about other entity types (stock, receipts, masters) survive only when the
    login is their actor. That is deliberately strict: `sys_audit_log` stores an
    entity_type and an id, not an office or a project, so there is nothing to scope a
    warehouse or master row on without loading each one. Showing only your own is the
    honest answer; widening it needs those columns.
    """
    stmt = (
        select(AuditLog)
        .where(AuditLog.created_at >= since)
        .order_by(AuditLog.created_at.desc())
        .limit(40)
    )
    if await rung_for(db, user) is not ScopeRung.ALL:
        visible_indent_ids = select(Indent.id).where(
            await indent_service._indent_visibility(db, user)
        )
        stmt = stmt.where(or_(
            AuditLog.actor_id == user.id,
            and_(AuditLog.entity_type.startswith("ind_"),
                 AuditLog.entity_id.in_(visible_indent_ids)),
        ))
    rows = (await db.execute(stmt)).scalars().all()
    visible = []
    for row in rows:
        if not _can_see_audit(row.entity_type, permissions):
            continue
        icon, tone, href = _activity_meta(row.entity_type, int(row.entity_id))
        subject = row.entity_no or f"Record {row.entity_id}"
        visible.append({
            "id": f"audit:{row.id}",
            "title": f"{subject} {_activity_verb(row)}",
            "subtitle": row.actor_name or "System",
            "occurred_at": row.created_at,
            "href": href,
            "icon": icon,
            "tone": tone,
        })
        if len(visible) == 6:
            break
    return visible


async def summary(db: AsyncSession, user, date_range: DateRange = "week") -> dict:
    permissions = await get_user_permissions(
        db, user, getattr(user, "active_position_id", None),
    )
    since = _range_start(date_range)
    menu = await get_user_menu(db, permissions, await warehouse_menu_label(
        db, user, getattr(user, "active_position_id", None)))
    pending = await engine.pending_for_user(db, user)

    kpis: list[dict] = []
    actions: list[dict] = []
    attention: list[dict] = []

    if perms.INDENT_VIEW in permissions:
        # The one predicate list_indents and indent_stats use. Spelled out here once,
        # it drifted: the tile read 79 while the Indents screen read 2. Sharing the
        # helper is what stops that happening again.
        indent_scope = await indent_service._indent_visibility(db, user)
        # All-time, not date-ranged: the tile has to read the same as "Total indents"
        # on the indent dashboard, which is unfiltered until the user filters it.
        # The date range picker scopes recent activity only.
        indent_count = await _count(db, Indent, indent_scope)
        pending_indents = await _count(
            db, Indent, indent_scope,
            Indent.status == IndentStatus.PENDING_APPROVAL.value,
        )
        kpis.append(_kpi(
            "indents", "INDENTS", indent_count,
            f"{pending_indents} Pending Approval", "/indents", "file-text",
        ))
        if pending_indents:
            attention.append(_attention(
                "my_indents", "Your indents pending approval", pending_indents,
                "/indents", "file-text",
            ))

        # The monthly cycle, as a number somebody can act on. The rest of this screen
        # counts documents; a cycle is the unit the business actually plans in, and
        # with 770 people raising one indent each there was no way to see how the
        # month was going without opening a report. Same visibility predicate as the
        # tile above, so it can never claim more than the list would show.
        cycle = ist_today().strftime("%Y-%m")
        in_cycle = and_(
            indent_scope,
            Indent.indent_type == IndentType.MONTHLY.value,
            func.date_format(Indent.indent_date, "%Y-%m") == cycle,
        )
        cycle_total = await _count(db, Indent, in_cycle)
        if cycle_total:
            cycle_done = await _count(
                db, Indent, in_cycle,
                Indent.status.in_([IndentStatus.CLOSED.value,
                                   IndentStatus.PARTIALLY_FULFILLED.value]),
            )
            kpis.append(_kpi(
                "monthly_cycle", "THIS MONTH'S CYCLE", cycle_total,
                f"{cycle_done} served", "/indents?indent_type=MONTHLY", "calendar-check",
                tone="purple",
                detail_tone="green" if cycle_done == cycle_total else "orange",
            ))
            if cycle_total - cycle_done:
                attention.append(_attention(
                    "monthly_cycle", f"Monthly cycle {cycle} still owed",
                    cycle_total - cycle_done, "/indents?indent_type=MONTHLY",
                    "calendar-check", "orange",
                ))

    # Permission alone, like every other tile here. It used to render whenever the
    # engine had anything waiting — `pending or ...` — and a pending row belongs to the
    # PERSON, not the hat they are wearing, so someone holding both an OE post and a
    # store keeper post carried the OE queue onto the store keeper hat that RBAC had
    # just taken approvals away from.
    if APPROVE_PERMISSIONS & permissions:
        overdue = sum(1 for row in pending if _is_overdue(row))
        kpis.append(_kpi(
            "approvals", "APPROVALS", len(pending), f"{overdue} Overdue",
            "/approvals", "circle-check", tone="green",
            detail_tone="orange" if overdue else "green",
        ))
        if pending:
            attention.append(_attention(
                "approvals", "Requests pending your approval", len(pending),
                "/approvals", "file-text",
            ))

    if perms.PO_VIEW in permissions:
        # Scoped exactly as procurement.list_pos scopes the screen this tile links
        # to. Counting every PO in the company here meant a store keeper's Home read
        # a number they could not find a single row of on /pos — the same mismatch
        # already fixed for the indents tile above.
        po_scope = await scope_condition(
            db, user,
            owner_col=PurchaseOrder.created_by_id,
            office_col=PurchaseOrder.office_id,
        )
        po_count = await _count(db, PurchaseOrder, po_scope)
        awaiting_po = await _count(
            db, PurchaseOrder, po_scope, PurchaseOrder.status.in_([
                POStatus.APPROVED.value,
                POStatus.SENT_TO_VENDOR.value,
                POStatus.PARTIALLY_RECEIVED.value,
            ]),
        )
        kpis.append(_kpi(
            "purchase_orders", "PURCHASE ORDERS", po_count,
            f"{awaiting_po} Awaiting Delivery", "/pos", "shopping-cart",
            tone="purple", detail_tone="purple",
        ))
        if awaiting_po:
            attention.append(_attention(
                "purchase_orders", "Purchase orders awaiting action", awaiting_po,
                "/pos", "shopping-cart", "purple",
            ))

    receipt_visible = bool({perms.RECEIPT_VIEW, perms.GRN_VIEW} & permissions)
    if receipt_visible:
        # Purchase receipts only, and the same "pending" set the warehouse dashboard
        # counts under "GRN to raise" — counting every receipt type here made the two
        # screens disagree.
        is_purchase = Receipt.receipt_type == ReceiptType.PURCHASE.value
        # Same warehouse/office scope warehouse.list_receipts applies, for the same
        # reason as the PO tile: the number has to be one the user can drill into.
        receipt_scope = and_(is_purchase, await scope_condition(
            db, user,
            warehouse_col=Receipt.warehouse_id,
            warehouse_ids=await inventory_service.warehouse_ids_for_user(db, user),
            owner_col=Receipt.created_by_id,
            project_col=Receipt.project_id,
        ))
        receipt_count = await _count(db, Receipt, receipt_scope)
        pending_receipts = await _count(
            db, Receipt, receipt_scope,
            Receipt.status.in_([
                ReceiptStatus.DRAFT.value,
                ReceiptStatus.PENDING_QC.value,
            ]),
        )
        kpis.append(_kpi(
            "goods_receipt", "GOODS RECEIPT", receipt_count,
            f"{pending_receipts} Pending GRN", "/warehouse/grn", "package-down",
            tone="cyan", detail_tone="cyan",
        ))
        if pending_receipts:
            attention.append(_attention(
                "goods_receipt", "Goods receipts pending", pending_receipts,
                "/warehouse/grn", "package-down", "cyan",
            ))

    if perms.STOCK_VIEW in permissions:
        low_stock, out_of_stock = await _stock_counts(db, user)
        kpis.extend([
            _kpi(
                "low_stock", "LOW STOCK ITEMS", low_stock, "Reorder Soon",
                "/inventory/replenishment", "triangle-alert",
                tone="orange", detail_tone="orange",
            ),
            _kpi(
                "out_of_stock", "OUT OF STOCK ITEMS", out_of_stock,
                "Immediate Action", "/inventory/replenishment", "circle-x",
                tone="red", detail_tone="red",
            ),
        ])
        if low_stock:
            attention.append(_attention(
                "low_stock", "Low stock items", low_stock,
                "/inventory/replenishment", "triangle-alert", "orange",
            ))
        if out_of_stock:
            attention.append(_attention(
                "out_of_stock", "Items out of stock", out_of_stock,
                "/inventory/replenishment", "circle-x", "red",
            ))

    if perms.INDENT_CREATE in permissions:
        actions.append(_action(
            "create_indent", "Create Indent", "/indents/new", "file-text",
        ))
    if perms.PO_CREATE in permissions:
        actions.append(_action(
            "create_po", "New Purchase Order", "/pos", "shopping-cart", "purple",
        ))
    if perms.RECEIPT_CREATE in permissions:
        actions.append(_action(
            "goods_receipt", "Goods Receipt", "/warehouse/grn/new",
            "package-down", "cyan",
        ))
    if perms.STOCK_TRANSFER in permissions:
        actions.append(_action(
            "stock_transfer", "Stock Transfer", "/inventory/transfers",
            "arrow-left-right", "orange",
        ))
    if perms.GRN_CREATE in permissions:
        actions.append(_action(
            "create_grn", "Create GRN", "/warehouse/grn/new", "file-plus", "red",
        ))

    return {
        "date_range": date_range,
        "kpis": kpis,
        "quick_actions": actions,
        "modules": _visible_modules(menu),
        "needs_attention": attention,
        "recent_activity": await _recent_activity(db, user, permissions, since),
    }
