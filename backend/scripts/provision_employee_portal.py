"""Provision employee portal access and the reporting-manager indent workflow.

This is intentionally data-only: it updates rows in the frozen schema and never
creates or alters database objects.

Run with:
    .venv/Scripts/python.exe -m scripts.provision_employee_portal
"""
import asyncio

from sqlalchemy import select

from app.core.database import SessionLocal, engine
from app.core.security import hash_password
from app.platform.auth.service import DEFAULT_EMPLOYEE_PASSWORD
from app.platform.hcm.models import HcmEmployee
from app.platform.rbac.models import Page
from app.platform.settings.models import DocSeries, UserCredential
from app.platform.workflow.models import Stage, Workflow
from app.shared.enums import ApprovalMode, ApproverType, DocType
from app.shared.numbering import _fiscal_year
from app.shared.models.base import utcnow


PAGE_NAMES = {
    "grp_indents": "Indents",
    "ind_dashboard": "Overview",
    "ind_list": "All Requests",
    "ind_board": "Status Board",
    "ind_ack": "Acknowledgments",
    "ind_reports": "Activity Ledger",
    "ind_notifications": "Notifications",
}


async def provision() -> dict:
    password_hash = hash_password(DEFAULT_EMPLOYEE_PASSWORD)
    async with SessionLocal() as db:
        employees = (await db.execute(
            select(HcmEmployee).where(HcmEmployee.is_active.is_(True))
        )).scalars().all()
        created = updated = 0
        for employee in employees:
            credential = await db.get(UserCredential, employee.id)
            if credential is None:
                db.add(UserCredential(
                    employee_id=employee.id,
                    password_hash=password_hash,
                    must_change=False,
                ))
                created += 1
            else:
                credential.password_hash = password_hash
                credential.must_change = False
                credential.failed_attempts = 0
                credential.locked_until = None
                updated += 1

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
            "active_employees": len(employees),
            "credentials_created": created,
            "credentials_reset": updated,
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
