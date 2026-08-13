"""Provision employee portal pages and the reporting-manager indent workflow.

This is intentionally data-only: it updates rows in the frozen schema and never
creates or alters database objects.

Run with:
    .venv/Scripts/python.exe -m scripts.provision_employee_portal
"""
import asyncio

from sqlalchemy import select

from app.core.database import SessionLocal, engine
from app.platform.rbac.models import Page
from app.platform.settings.models import DocSeries
from app.platform.workflow.models import Stage, Workflow
from app.shared.enums import ApprovalMode, ApproverType, DocType
from app.shared.numbering import _fiscal_year
from app.shared.models.base import utcnow


PAGE_NAMES = {
    "grp_indents": "Indents",
    "ind_dashboard": "Overview",
    "ind_list": "All Requests",
    "ind_board": "Status Board",
    "ind_reports": "Activity Ledger",
    "ind_notifications": "Notifications",
}


async def provision() -> dict:
    async with SessionLocal() as db:
        pages = (await db.execute(
            select(Page).where(Page.code.in_(PAGE_NAMES))
        )).scalars().all()
        for page in pages:
            page.name = PAGE_NAMES[page.code]

        workflows = (await db.execute(
            select(Workflow).where(Workflow.doc_type == DocType.INDENT.value)
        )).scalars().all()
        for workflow in workflows:
            workflow.is_active = False

        workflow = next(
            (row for row in workflows if row.code == "WF-INDENT-REPORTING-MANAGER"),
            None,
        )
        if workflow is None:
            workflow = Workflow(
                code="WF-INDENT-REPORTING-MANAGER",
                name="Indent Reporting Manager Approval",
                doc_type=DocType.INDENT.value,
                version=max([row.version for row in workflows] or [0]) + 1,
                effective_from=utcnow().date(),
            )
            db.add(workflow)
            await db.flush()
        workflow.is_active = True
        stage = (await db.execute(
            select(Stage).where(Stage.workflow_id == workflow.id, Stage.sequence == 1)
        )).scalar_one_or_none()
        if stage is None:
            stage = Stage(workflow_id=workflow.id, sequence=1)
            db.add(stage)
        stage.name = "Reporting Manager"
        stage.approver_type = ApproverType.REPORTING_MANAGER.value
        stage.approval_mode = ApprovalMode.ANY_ONE.value
        stage.sla_hours = 24

        series = (await db.execute(
            select(DocSeries).where(
                DocSeries.doc_type == DocType.INDENT.value,
                DocSeries.is_active.is_(True),
            )
        )).scalars().first()
        if series is None:
            series = DocSeries(
                doc_type=DocType.INDENT.value,
                fiscal_year=_fiscal_year(),
                prefix="IND",
                pattern="{PREFIX}/{FY}/{SEQ:5}",
                last_number=0,
                is_active=True,
                reset_policy="YEARLY",
                last_reset_period=_fiscal_year(),
            )
            db.add(series)
        await db.commit()
        return {
            "pages_renamed": len(pages),
            "workflow_id": workflow.id,
            "number_series_id": series.id,
        }


async def main() -> None:
    result = await provision()
    await engine.dispose()
    print(result)


if __name__ == "__main__":
    asyncio.run(main())
