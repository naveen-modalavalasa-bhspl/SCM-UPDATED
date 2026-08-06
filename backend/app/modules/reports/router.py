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
from app.modules.reports import service
from app.modules.reports.schemas import ReportLedgerInfo, ReportRows
from app.platform.rbac import permissions as perms

router = APIRouter(prefix="/api/reports", tags=["reports"])


@router.get("/ledgers", response_model=list[ReportLedgerInfo])
async def ledgers(user=Depends(require_permission(perms.REPORT_VIEW))):
    return service.catalog()


@router.get("/{ledger}/filters")
async def ledger_filters(ledger: str, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.REPORT_VIEW))):
    return await service.filter_options(db, ledger)


XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@router.get("/{ledger}/export")
async def export_ledger(ledger: str, request: Request, format: str = "xlsx",
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.REPORT_EXPORT))):
    """Excel by default (styled heading row); `?format=csv` for a plain file."""
    actor = getattr(user, "full_name", None)
    if format == "csv":
        filename, text = await service.export_csv(db, ledger, request.query_params, actor)
        # The BOM is what makes Excel read a CSV as UTF-8 — without it a vendor name
        # with an accent in it opens as mojibake.
        return Response(
            content="﻿" + text,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    filename, body = await service.export_xlsx(db, ledger, request.query_params, actor)
    return Response(
        content=body, media_type=XLSX_MEDIA,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{ledger}", response_model=ReportRows)
async def ledger_rows(ledger: str, request: Request, params: PageParams = Depends(),
                      db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.REPORT_VIEW))):
    return await service.list_rows(db, ledger, params.page, params.size,
                                   request.query_params)
