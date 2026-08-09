"""Role-aware home summary.

The summary is assembled from existing module tables. Each slice is gated by the
user's permissions, so a requester and a plant head naturally see different content.
"""
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.indents.models import Indent
from app.modules.inventory.models import MaterialRequest, Stock
from app.modules.logistics.models import GRN
from app.modules.procurement.models import PurchaseOrder
from app.platform.rbac import permissions as perms
from app.platform.rbac.service import get_user_permissions
from app.platform.workflow import engine
from app.shared.enums import GRNStatus, IndentStatus, MRStatus, POStatus
from app.shared.models.master import Item
from app.shared.time import now as ist_now, today as ist_today


def _item(id_: str, title: str, module: str, href: str, **extra) -> dict:
    return {"id": id_, "title": title, "module": module, "href": href, **extra}


async def _count(db: AsyncSession, stmt) -> int:
    return int(await db.scalar(select(func.count()).select_from(stmt.subquery())) or 0)


async def _open_indents(db: AsyncSession, user) -> list[dict]:
    stmt = (
        select(Indent)
        .where(Indent.requested_by_id == user.id)
        .where(Indent.status.notin_([IndentStatus.CLOSED.value, IndentStatus.REJECTED.value]))
        .order_by(Indent.updated_at.desc())
        .limit(6)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [
        _item(
            f"indent:{row.id}", row.indent_no, "indents", f"/indents/{row.id}",
            subtitle=row.department_name, status=row.status, priority=row.priority,
        )
        for row in rows
    ]


async def _stock_below_reorder(db: AsyncSession) -> list[dict]:
    stmt = (
        select(
            Stock.item_id, Stock.item_code, Stock.item_name, Stock.warehouse_id,
            Stock.warehouse_name, Stock.available_qty, Item.reorder_level,
        )
        .join(Item, Item.id == Stock.item_id)
        .where(Item.reorder_level > 0)
        .where(Stock.available_qty < Item.reorder_level)
        .order_by((Item.reorder_level - Stock.available_qty).desc())
        .limit(6)
    )
    rows = (await db.execute(stmt)).all()
    return [
        _item(
            f"stock:{r.item_id}:{r.warehouse_id}",
            r.item_name or r.item_code or f"Item {r.item_id}",
            "inventory",
            "/inventory/replenishment",
            subtitle=f"{r.warehouse_name or 'Warehouse'}: {float(r.available_qty or 0)} below reorder {float(r.reorder_level or 0)}",
            status="LOW_STOCK",
        )
        for r in rows
    ]


async def _mrs_waiting_procurement(db: AsyncSession) -> list[dict]:
    stmt = (
        select(MaterialRequest)
        .where(MaterialRequest.status == MRStatus.APPROVED.value)
        .order_by(MaterialRequest.approved_at.desc(), MaterialRequest.created_at.desc())
        .limit(6)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [
        _item(
            f"mr:{row.id}", row.mr_no, "inventory",
            f"/inventory/material-requests/{row.id}",
            subtitle=row.department_name, status=row.status, priority=row.priority,
        )
        for row in rows
    ]


async def _pos_due(db: AsyncSession) -> list[dict]:
    due_by = ist_today() + timedelta(days=7)
    stmt = (
        select(PurchaseOrder)
        .where(PurchaseOrder.status.in_([
            POStatus.SENT_TO_VENDOR.value, POStatus.PARTIALLY_RECEIVED.value,
        ]))
        .where(PurchaseOrder.expected_date.is_not(None))
        .where(PurchaseOrder.expected_date <= due_by)
        .order_by(PurchaseOrder.expected_date)
        .limit(6)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [
        _item(
            f"po:{row.id}", row.po_no, "procurement", "/pos",
            subtitle=f"{row.vendor_name or 'Vendor'} due {row.expected_date}",
            status=row.status,
        )
        for row in rows
    ]


async def _grns_pending_qc(db: AsyncSession) -> list[dict]:
    stmt = (
        select(GRN)
        .where(GRN.status == GRNStatus.RECEIVED.value)
        .order_by(GRN.created_at.desc())
        .limit(6)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [
        _item(
            f"grn:{row.id}", row.grn_no, "warehouse", "/warehouse/quality-inspection",
            subtitle=row.vendor_name, status=row.status, count=row.total_items,
        )
        for row in rows
    ]


async def summary(db: AsyncSession, user) -> dict:
    permissions = await get_user_permissions(
        db, user, getattr(user, "active_position_id", None),
    )
    pending = [
        _item(
            f"approval:{row['instance_id']}", row.get("doc_no") or row["doc_type"],
            "workflow", _href(row["doc_type"], row["doc_id"]),
            subtitle=row.get("summary") or row.get("requested_by_name"),
            status="PENDING_APPROVAL",
        )
        for row in await engine.pending_for_user(db, user)
    ]
    open_indents = await _open_indents(db, user) if perms.INDENT_VIEW in permissions else []
    low_stock = await _stock_below_reorder(db) if perms.STOCK_VIEW in permissions else []
    mrs = await _mrs_waiting_procurement(db) if perms.PO_CREATE in permissions else []
    pos = await _pos_due(db) if perms.PO_VIEW in permissions else []
    grns = await _grns_pending_qc(db) if perms.GRN_QC in permissions else []

    kpis = [
        {"key": "pending_approvals", "label": "Pending approvals",
         "value": len(pending), "tone": "warning"},
        {"key": "open_indents", "label": "My open indents",
         "value": len(open_indents), "tone": "brand"},
    ]
    if perms.STOCK_VIEW in permissions:
        kpis.append({"key": "low_stock", "label": "Below reorder",
                     "value": len(low_stock), "tone": "danger"})
    if perms.PO_CREATE in permissions:
        kpis.append({"key": "mrs_waiting", "label": "MRs for procurement",
                     "value": len(mrs), "tone": "neutral"})
    if perms.GRN_QC in permissions:
        kpis.append({"key": "grn_qc", "label": "GRNs pending QC",
                     "value": len(grns), "tone": "warning"})

    attention = [*pending, *open_indents, *low_stock, *mrs, *pos, *grns][:12]
    return {
        "role_context": sorted(permissions),
        "kpis": kpis,
        "needs_attention": attention,
        "pending_approvals": pending,
        "open_indents": open_indents,
        "waiting_on_me": pending,
        "stock_below_reorder": low_stock,
        "mrs_waiting_procurement": mrs,
        "pos_due": pos,
        "grns_pending_qc": grns,
    }


def _href(doc_type: str, doc_id: int) -> str:
    return {
        "INDENT": f"/indents/{doc_id}",
        "MR": f"/inventory/material-requests/{doc_id}",
        "PO": "/pos",
        "GRN": "/warehouse/quality-inspection",
        "ALLOCATION": f"/inventory/allocate/{doc_id}",
    }.get(doc_type, "/approvals")
