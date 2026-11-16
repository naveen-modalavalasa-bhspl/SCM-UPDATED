"""SCM_0128 / SCM_0139: a raiser SEATED in a local chair holds that rung.

The PO ladder is three chairs set up under Settings because HCM has no post for them:
Manager -> CPO -> Director. The two "where is the raiser on this ladder" questions
recognised only HCM posts and ranks, so

  * a CPO raising a PO was sent to the Manager rung BELOW him (SCM_0128), and
  * a Director raising one was not recognised as the end of the ladder; every rung
    then resolved to nobody but himself and the PO fell to the Administrator safety
    net (SCM_0139).
"""
from app.platform.hcm.models import HcmEmployee, HcmPosition, HcmPositionAssignment
from app.platform.workflow import custom_ladder, engine
from app.platform.workflow.models import ApprovalPost, ApprovalPostMember
from app.platform.workflow.schemas import CustomLadderIn, CustomLadderStepIn
from app.shared.enums import InstanceStatus
from app.shared.models.base import utcnow

# A procurement desk under a head office, so nobody is the root of the HCM tree.
POSITIONS = [(701, "Head Office", None), (702, "Procurement Manager", 701),
             (703, "CPO", 701), (704, "Director", 701), (705, "Buyer", 702)]


async def _people(db):
    for pid, name, parent in POSITIONS:
        db.add(HcmPosition(id=pid, name=name, role_id=None, parent_position_id=parent,
                           is_active=True, synced_at=utcnow()))
    await db.flush()
    people = {}
    for pid, name, _parent in POSITIONS:
        person = HcmEmployee(id=pid, full_name=f"{name} person", emp_code=f"P{pid}",
                             is_active=True, synced_at=utcnow())
        db.add(person)
        await db.flush()
        db.add(HcmPositionAssignment(id=pid, employee_id=pid, position_id=pid,
                                     is_active=True, is_primary=True, synced_at=utcnow()))
        person.active_position_id = pid
        people[name] = person
    await db.flush()
    return people


async def _po_ladder(db, people):
    posts = {}
    for code, name, holder in (("MGR", "Manager", "Procurement Manager"),
                               ("CPO", "CPO", "CPO"), ("DIR", "Director", "Director")):
        post = ApprovalPost(code=code, name=name, is_active=True)
        db.add(post)
        await db.flush()
        db.add(ApprovalPostMember(post_id=post.id, employee_id=people[holder].id,
                                  employee_name=people[holder].full_name, is_active=True))
        posts[name] = post.id
    await db.flush()
    await custom_ladder.save_custom(db, CustomLadderIn(
        project_id=None, doc_type="PO",
        steps=[CustomLadderStepIn(post_id=posts[name], name=name)
               for name in ("Manager", "CPO", "Director")],
    ), people["Head Office"])
    await db.flush()


def _rungs(instance) -> list[str]:
    return [link.get("role_name") for link in (instance.resolved_chain or [])]


async def test_a_buyer_climbs_every_chair(db):
    people = await _people(db)
    await _po_ladder(db, people)
    instance = await engine.start(db, "PO", 9001, {"doc_no": "PO-9001"}, people["Buyer"])
    assert _rungs(instance) == ["Manager", "CPO", "Director"]


async def test_a_cpo_skips_the_manager_below_him(db):
    """SCM_0128."""
    people = await _people(db)
    await _po_ladder(db, people)
    instance = await engine.start(db, "PO", 9002, {"doc_no": "PO-9002"}, people["CPO"])
    assert _rungs(instance) == ["Director"]
    assert instance.status == InstanceStatus.IN_PROGRESS.value


async def test_the_director_is_the_end_of_the_ladder_not_the_administrator(db):
    """SCM_0139."""
    people = await _people(db)
    await _po_ladder(db, people)
    instance = await engine.start(db, "PO", 9003, {"doc_no": "PO-9003"}, people["Director"])
    assert instance.status == InstanceStatus.APPROVED.value
    assert not any("fallback" in (name or "").lower() for name in _rungs(instance))
