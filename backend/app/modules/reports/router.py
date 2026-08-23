"""Reports endpoints. No logic here — every route calls the service.

`/ledgers` is declared before `/{ledger}` so the literal wins over the path param.
Filters arrive as ordinary query params and are matched against the ledger's own
filter list in the service, which is why one route serves four ledgers.
"""
from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.core.pagination import PageParams
from app.modules.reports import service, traceability
from app.modules.reports.schemas import ReportLedgerInfo, ReportRows
from app.platform.rbac import permissions as perms

router = APIRouter(prefix="/api/reports", tags=["reports"])


@router.get("/ledgers", response_model=list[ReportLedgerInfo])
async def ledgers(db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.REPORT_VIEW))):
    # Only the ledgers this login holds the permission for. The catalogue used to
    # list all nine, so a profile granted the Indent Ledger alone still saw tabs for
    # Stock and Warehouse and hit an error opening them.
    from app.platform.rbac.service import get_user_permissions

    held = await get_user_permissions(db, user, getattr(user, "active_position_id", None))
    return [row for row in service.catalog() if row["permission"] in held]


@router.get("/{ledger}/filters")
async def ledger_filters(ledger: str, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.REPORT_VIEW))):
    return await service.filter_options(db, ledger, user=user)


XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@router.get("/{ledger}/export")
async def export_ledger(ledger: str, request: Request, format: str = "xlsx",
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.REPORT_EXPORT))):
    """Excel by default (styled heading row); `?format=csv` for a plain file."""
    actor = getattr(user, "full_name", None)
    if format == "csv":
        filename, text = await service.export_csv(db, ledger, request.query_params, actor, user=user)
        # The BOM is what makes Excel read a CSV as UTF-8 — without it a vendor name
        # with an accent in it opens as mojibake.
        return Response(
            content="﻿" + text,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    filename, body = await service.export_xlsx(db, ledger, request.query_params, actor, user=user)
    return Response(
        content=body, media_type=XLSX_MEDIA,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --------------------------------------------------------------------------- #
# Document traceability — one number in, the whole chain out.
#
# Declared ABOVE `/{ledger}`, which is a catch-all string path: a literal segment
# registered after it never matches, so "traceability" would be read as the name of a
# ledger and 404.
# --------------------------------------------------------------------------- #

@router.get("/traceability/kinds")
async def traceability_kinds(user=Depends(require_permission(perms.REPORT_VIEW))):
    """What the trail can find. Served so the screen's filter cannot drift from the
    document types the walker actually knows about."""
    return traceability.doc_kinds()


@router.get("/traceability/search")
async def traceability_search(q: str, limit: int = 25,
                              db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(perms.REPORT_VIEW))):
    """Every document whose number matches, across every kind on the trail. A partial
    number is enough — somebody reading a printed gate pass types the tail of it."""
    return await traceability.search(db, q, limit=min(max(limit, 1), 50))


@router.get("/traceability/chain")
async def traceability_chain(kind: str, doc_id: int,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.REPORT_VIEW))):
    """The whole chain around one document — both directions, each node with its
    status and its full approval history."""
    return await traceability.trace(db, kind, doc_id)


@router.get("/{ledger}", response_model=ReportRows)
async def ledger_rows(ledger: str, request: Request, params: PageParams = Depends(),
                      db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.REPORT_VIEW))):
    return await service.list_rows(db, ledger, params.page, params.size,
                                   request.query_params, user=user)
