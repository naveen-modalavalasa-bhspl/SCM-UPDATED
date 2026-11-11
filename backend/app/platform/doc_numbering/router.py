"""The number card on every document form.

Reads take a signed-in user, as `/api/departments` does: whoever raises a document needs
these whether or not they can open Settings, and nothing here is more than a name, a code
and the shape of a number. Nothing is drawn or written.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user
from app.platform.doc_numbering import service

router = APIRouter(prefix="/api/document-numbering", tags=["document-numbering"])


@router.get("/{doc_type}/card")
async def card(doc_type: str, db: AsyncSession = Depends(get_db),
               user=Depends(get_current_user)):
    return await service.card(db, doc_type, user)


@router.get("/{doc_type}/preview")
async def preview(doc_type: str, organization_id: int | None = None,
                  project_id: int | None = None, org_department_id: int | None = None,
                  project_name: str | None = None, fiscal_year: str | None = None,
                  db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    return await service.preview(
        db, doc_type, organization_id=organization_id, project_id=project_id,
        org_department_id=org_department_id, project_name=project_name,
        fiscal_year=fiscal_year)
