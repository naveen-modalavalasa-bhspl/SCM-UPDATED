"""Every document type is wired consistently across the three places that name one.

No database: all three are module-level tables, and that is the point — each of the
bugs below shipped because a table was built somewhere a wrong name could not fail
until a user pressed a button.

The three tables:

  * `ladder.DOC_TYPE_LABEL` / `MODULE_BY_DOC_TYPE` — what Approvals Config shows.
  * `ladder.configurable_doc_types()` — what the raw Workflows picker offers.
  * `service.RETURN_PERMISSION_BY_DOC_TYPE` — who may send a document back.
"""
import pytest

from app.platform.rbac import permissions as perms
from app.platform.workflow import ladder
from app.platform.workflow import service as workflow_service
from app.shared.enums import DocType

RETURN_PERMS = workflow_service.RETURN_PERMISSION_BY_DOC_TYPE

#: Types that are deliberately NOT configurable, each for a stated reason:
#:
#:   ISSUE         — the legacy value, superseded by WH_ISSUE. Nothing starts a
#:                   workflow with it.
#:   QUOTATION     — the vendor's own document. What gets approved is the award.
#:   DESPATCH_NOTE — also the vendor's: their statement of what went on the vehicle.
#:                   The GRN is where we agree with it or do not.
#:
#: All three are numbering-only. Adding a DocType without deciding which side of this
#: line it falls on fails the test below, which is the point — that decision is easy
#: to make and impossible to notice you skipped.
NOT_CONFIGURABLE = {
    DocType.ISSUE.value,
    DocType.QUOTATION.value,
    DocType.DESPATCH_NOTE.value,
}


def test_every_doc_type_is_either_configurable_or_deliberately_excluded():
    """A new DocType must be a conscious choice, not an omission."""
    configurable = set(ladder.configurable_doc_types())
    everything = {d.value for d in DocType}
    assert configurable | NOT_CONFIGURABLE == everything
    assert not (configurable & NOT_CONFIGURABLE)


def test_the_workflows_picker_offers_only_what_the_engine_reads():
    """A workflow saved against an unread type is written and never used — the
    document then falls through to the reporting-line fallback with no sign why."""
    offered = set(ladder.configurable_doc_types())
    assert DocType.ISSUE.value not in offered
    assert DocType.QUOTATION.value not in offered


def test_every_configurable_type_has_a_label_and_a_module():
    for code in ladder.configurable_doc_types():
        assert ladder.DOC_TYPE_LABEL.get(code), code
        assert ladder.MODULE_BY_DOC_TYPE.get(code), code


def test_every_module_on_the_config_screen_has_a_place_in_the_order():
    """An unordered module renders in an arbitrary position on Approvals Config."""
    modules = {ladder.MODULE_BY_DOC_TYPE[c] for c in ladder.DOC_TYPE_LABEL}
    assert modules <= set(ladder.MODULE_ORDER)


# --------------------------------------------------------------------------- #
#  Return for correction
# --------------------------------------------------------------------------- #

def test_return_permission_map_is_importable_and_complete():
    """The regression this file exists for.

    The map used to be a dict literal built inside `_require_action_permission`, and
    it referenced `perms.ISSUE_APPROVE` — a name that does not exist. Every call
    raised AttributeError before it could index anything, so "Return for correction"
    500'd for EVERY document type. At module level a bad name cannot survive import,
    which is what makes this test a one-line guard rather than a per-type sweep.
    """
    assert RETURN_PERMS, "the map must exist at module level, not inside the function"
    for doc_type, code in RETURN_PERMS.items():
        assert code in perms.ALL_CODES, f"{doc_type} -> {code} is not a real permission"


def test_every_configurable_type_can_be_returned():
    """If Approvals Config lets you configure it, the engine must be able to act on
    it. A configurable type missing here is a 403 on a button the screen offers."""
    missing = [c for c in ladder.configurable_doc_types() if c not in RETURN_PERMS]
    assert not missing, f"configurable but not returnable: {missing}"


def test_no_return_permission_for_an_unconfigurable_type():
    """The reverse: a permission here implies the type is actionable."""
    stray = [c for c in RETURN_PERMS if c in NOT_CONFIGURABLE]
    assert not stray, f"unconfigurable but returnable: {stray}"


@pytest.mark.asyncio
@pytest.mark.parametrize("doc_type", sorted(NOT_CONFIGURABLE))
async def test_returning_an_unactionable_type_refuses_rather_than_crashing(doc_type):
    """Fail closed. A KeyError here read as a broken server; it is a refusal."""
    from app.core.exceptions import PermissionError_

    with pytest.raises(PermissionError_):
        await workflow_service._require_action_permission(None, doc_type, None)


# --------------------------------------------------------------------------- #
#  The permission catalogue
# --------------------------------------------------------------------------- #

def test_no_permission_code_is_declared_twice():
    """`sync_permission_labels` builds `{p.code: p for p in ALL_PERMISSIONS}`, so a
    duplicate is silently resolved by declaration order — the earlier row becomes a
    dead entry that still has to be read to know it does nothing. `return.view`,
    `return.create` and `return.approve` were each listed twice, under two modules."""
    from collections import Counter

    counts = Counter(p.code for p in perms.ALL_PERMISSIONS)
    assert [code for code, n in counts.items() if n > 1] == []


#: Resources that legitimately appear under more than one module, because the same
#: NOUN means two different things to two different teams:
#:
#:   page    — a per-page view permission is filed under the module whose screen it
#:             guards. By design, and it is every module.
#:   report  — `warehouse.report.view` is the warehouse's own reports screen;
#:             `report.view` / `report.export` are the cross-module ledgers.
#:   vendor  — `master.vendor.manage` maintains the vendor master;
#:             `vendor.portal.manage` mints a login for someone outside the company.
#:
#: Anything NOT on this list that is split is the `return.*` bug again: one resource
#: accidentally filed under two modules, opening two half-groups on Job Profiles.
RESOURCES_SPLIT_ON_PURPOSE = {perms.PAGE_RESOURCE, "report", "vendor"}


def test_no_new_resource_is_split_across_two_modules():
    """Job Profiles groups by (module, resource). `return` was split between
    `warehouse` and `returns` — three of its four codes under one module and the
    fourth under the other — which is what this guards against recurring."""
    modules_by_resource: dict[str, set[str]] = {}
    for perm in perms.ALL_PERMISSIONS:
        modules_by_resource.setdefault(perm.resource, set()).add(perm.module)
    split = {
        resource: sorted(modules)
        for resource, modules in modules_by_resource.items()
        if len(modules) > 1 and resource not in RESOURCES_SPLIT_ON_PURPOSE
    }
    assert split == {}, f"resources split across modules: {split}"


def test_the_return_resource_lives_in_one_module():
    """All four `return.*` codes under Returns — the specific fix, pinned."""
    modules = {p.module for p in perms.ALL_PERMISSIONS if p.resource == "return"}
    assert modules == {"returns"}, modules


def test_warehouse_enums_reexports_rather_than_redeclares():
    """`modules/warehouse/enums.py` used to hold its own copy of 25 permission
    strings (rule 6 says codes live only in the catalogue). It now imports them, so
    the two cannot drift — including the ISSUE_POST/ISSUE_ISSUE alias."""
    from app.modules.warehouse import enums as warehouse_enums

    assert warehouse_enums.RETURN_VIEW is perms.RETURN_VIEW
    assert warehouse_enums.RETURN_DELETE is perms.RETURN_DELETE
    assert warehouse_enums.ISSUE_POST is perms.ISSUE_ISSUE
    assert warehouse_enums.WAREHOUSE_REPORT_VIEW is perms.WAREHOUSE_REPORT_VIEW
