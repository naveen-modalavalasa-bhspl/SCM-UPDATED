"""Repair the company-wide ladders that resolve to nobody, and unseat the local posts.

Two things, both data:

1. Every `wf_approval_post_members` row is deactivated. The nine posts were already
   retired on 2026-08-17, and `rbac.service._approval_post_roles` only grants a job
   profile through an ACTIVE post, so nobody loses access by being unseated today.

2. The seven live "All projects" ladders whose only rung is one of those retired posts
   are re-saved on the equivalent HCM RANK, as ROLE_ANY (a shared chair — read off its
   holders, not climbed), which is exactly how the 104-MMU ladders are built.
"""
import asyncio
from types import SimpleNamespace

from sqlalchemy import select, update

from app.core.database import SessionLocal
from app.platform.workflow import custom_ladder
from app.platform.workflow.models import ApprovalPostMember, Stage, Workflow
from app.shared.enums import ApproverType

USER = SimpleNamespace(id=900001, full_name="admin (ladder repair)")

# doc_type -> (rung name, hcm role_id, self-approval policy)
REBUILD = [
    ("REQUISITION", "P O", 185, "CREATOR_ALLOWED"),
    ("RFQ", "CPO", 174, "INDEPENDENT"),
    ("CONSOLIDATION", "SCM HEAD", 186, "INDEPENDENT"),
    ("DISPATCH", "LOGISTICS", 184, "CREATOR_ALLOWED"),
    ("OWN_STOCK_ISSUE", "SCM HEAD", 186, "CREATOR_ALLOWED"),
    ("STOCK_RETURN", "FLOOR INCHARGE", 165, "INDEPENDENT"),
    ("STOCK_RETURN_RECEIPT", "FLOOR INCHARGE", 165, "INDEPENDENT"),
]


async def main() -> None:
    async with SessionLocal() as db:
        unseated = (await db.execute(
            update(ApprovalPostMember)
            .where(ApprovalPostMember.is_active.is_(True))
            .values(is_active=False)
        )).rowcount
        await db.commit()
        print(f"unseated {unseated} approval-post member(s)")

        for doc_type, rung_name, role_id, policy in REBUILD:
            data = SimpleNamespace(
                project_id=None, doc_type=doc_type, raiser_role_id=None,
                self_approval_policy=policy, fallback_position_id=None,
                steps=[SimpleNamespace(name=rung_name, position_id=None,
                                       post_id=None, position_role_id=role_id)],
            )
            saved = await custom_ladder.save_custom(db, data, USER)
            wf_id = saved["workflow_id"] if isinstance(saved, dict) else None
            if wf_id is None:
                wf_id = (await db.execute(
                    select(Workflow.id).where(
                        Workflow.doc_type == doc_type,
                        Workflow.project_id.is_(None),
                        Workflow.is_active.is_(True))
                    .order_by(Workflow.version.desc(), Workflow.id.desc()).limit(1)
                )).scalar()
            # A company-wide desk chair is never on anybody's reporting line, so the
            # rung has to be read off its holders. save_custom picks ROLE (climb) for
            # an unscoped ladder, which for SCM's parentless posts resolves to nobody.
            await db.execute(
                update(Stage)
                .where(Stage.workflow_id == wf_id,
                       Stage.position_role_id.isnot(None))
                .values(approver_type=ApproverType.ROLE_ANY.value)
            )
            await db.commit()
            print(f"{doc_type}: wf {wf_id} -> {rung_name} (rank {role_id}), {policy}")


asyncio.run(main())
