"""The scope contract.

`shared/scope.py` only works if every list query actually calls it. The first
module that writes its own visibility predicate reopens the hole silently, and no
functional test catches it — the screen still returns rows, just too many.

So this file has two halves:

  * unit tests over `scope_condition`, which need no database
  * one static test that reads the source of every module's list service and fails
    if a paginated list query does not go through `scope_condition`

The static test is the one that matters. Add a list endpoint without a scope
filter and it goes red naming your function.
"""
import ast
import inspect
import re
from pathlib import Path

import pytest
from sqlalchemy import Column, Integer, select

from app.core.database import Base
from app.shared import scope
from app.shared.enums import ScopeRung


class _Doc(Base):
    """A stand-in document with the four columns scope_condition understands."""
    __tablename__ = "test_scope_doc"
    id = Column(Integer, primary_key=True)
    requested_by_id = Column(Integer)
    position_id = Column(Integer)
    office_id = Column(Integer)
    project_id = Column(Integer)


class _User:
    def __init__(self, id=1, position_id=10, office_id=100, project_id=4):
        self.id = id
        self.active_position_id = position_id
        self.office_id = office_id
        self.project_id = project_id


class _FakeDb:
    """Stands in for the session: scope_condition only ever reads the rung and,
    for SUBTREE, the descendant positions."""


def _sql(condition) -> str:
    return str(condition.compile(compile_kwargs={"literal_binds": True}))


@pytest.fixture
def patched(monkeypatch):
    def _apply(rung: ScopeRung, descendants: list[int] | None = None):
        async def fake_rung(db, user):
            return rung

        async def fake_descendants(db, position_id):
            return descendants or []

        monkeypatch.setattr(scope, "rung_for", fake_rung)
        monkeypatch.setattr(scope, "descendant_position_ids", fake_descendants)
    return _apply


def _condition(**kwargs):
    import asyncio
    return asyncio.get_event_loop().run_until_complete(
        scope.scope_condition(
            _FakeDb(), kwargs.pop("user", _User()),
            owner_col=_Doc.requested_by_id,
            position_col=_Doc.position_id,
            office_col=_Doc.office_id,
            project_col=_Doc.project_id,
            **kwargs,
        )
    )


@pytest.mark.asyncio
async def test_all_does_not_filter(patched):
    patched(ScopeRung.ALL)
    condition = await scope.scope_condition(
        _FakeDb(), _User(), owner_col=_Doc.requested_by_id,
    )
    assert "true" in _sql(condition).lower()


@pytest.mark.asyncio
async def test_self_is_owner_and_position(patched):
    """SELF is not just "mine" — it is mine IN THIS CAPACITY.

    An indent raised as a storekeeper must not appear in the same person's lab
    technician session, which is the whole point of the position switcher.
    """
    patched(ScopeRung.SELF)
    sql = _sql(await scope.scope_condition(
        _FakeDb(), _User(), owner_col=_Doc.requested_by_id,
        position_col=_Doc.position_id,
    ))
    assert "requested_by_id = 1" in sql
    assert "position_id = 10" in sql


@pytest.mark.asyncio
async def test_subtree_includes_descendants(patched):
    patched(ScopeRung.SUBTREE, descendants=[11, 12])
    sql = _sql(await scope.scope_condition(
        _FakeDb(), _User(), owner_col=_Doc.requested_by_id,
        position_col=_Doc.position_id,
    ))
    assert "position_id IN (11, 12)" in sql.replace("  ", " ")


@pytest.mark.asyncio
async def test_subtree_without_descendants_falls_back_to_own(patched):
    """A manager with nobody under them sees their own rows, not everybody's."""
    patched(ScopeRung.SUBTREE, descendants=[])
    sql = _sql(await scope.scope_condition(
        _FakeDb(), _User(), owner_col=_Doc.requested_by_id,
        position_col=_Doc.position_id,
    ))
    assert "true" not in sql.lower()
    assert "requested_by_id = 1" in sql


@pytest.mark.asyncio
async def test_missing_column_narrows_instead_of_opening(patched):
    """OFFICE on a table with no office column must mean SELF, never everything.

    A rung whose column is absent is a configuration gap. Reading a gap as "show
    all" is how a scope filter becomes decorative.
    """
    patched(ScopeRung.OFFICE)
    sql = _sql(await scope.scope_condition(
        _FakeDb(), _User(), owner_col=_Doc.requested_by_id,
        position_col=_Doc.position_id,
    ))
    assert "true" not in sql.lower()
    assert "requested_by_id = 1" in sql


@pytest.mark.asyncio
async def test_unreadable_rung_is_narrowest():
    """A corrupt SCOPE: marker must fail closed."""
    class _Role:
        description = "PROFILE:DM|SCOPE:NONSENSE"

    import app.platform.rbac.profiles as profiles_module

    async def fake_role(db, position_id):
        return _Role()

    original = profiles_module.profile_role_for_position
    profiles_module.profile_role_for_position = fake_role
    try:
        assert await scope.rung_for(_FakeDb(), _User()) is ScopeRung.SELF
    finally:
        profiles_module.profile_role_for_position = original


# --------------------------------------------------------------------------- #
#  The contract test
# --------------------------------------------------------------------------- #
MODULES_ROOT = Path(__file__).resolve().parents[2] / "modules"

# Functions that list documents but are legitimately unscoped, with the reason.
# Adding a name here is a deliberate, reviewable act — that is the point.
#
# An entry must say WHY. "It has no user parameter" is not a reason: the original
# version of this test skipped any list without a `user` argument, on the theory
# that such a list cannot leak per-user data. That was backwards — those functions
# had no `user` because nobody had ever scoped them. The test passed while
# nineteen endpoints returned every row in the company. The `user` shortcut is
# gone; a list is either scoped or named here.
SCOPE_EXEMPT = {
    # Reference and configuration reads, not documents about people.
    "list_office_options",
    # Aggregations already constrained by the caller's own document scope.
    "list_notifications",
    # Stock is a per-WAREHOUSE fact, not a document about a person, so the person
    # rungs (SELF, SUBTREE) do not apply to it. Both already narrow to the login's
    # warehouses through inventory._scoped_warehouse_ids(), which is that module's
    # equivalent guard and is what stock.view vs stock.view.all switches.
    "list_stock",
    "list_movements",
    # Reference data with no owner and no location: the row IS the configuration.
    # Reading the list of warehouses or batch numbers tells you nothing about
    # anyone's documents, and the page permission already gates the screen.
    "list_warehouses",
    "list_batches",
    "list_stock_movements",
    # NOT safe — known debt. lgs_grn and lgs_issues carry no owner, position,
    # office, project or warehouse column, so there is nothing to scope ON. They
    # are exempt because the filter is impossible today, not because the data is
    # harmless: anyone holding the page sees every GRN and every issue.
    # Fixing this needs columns on the tables, which needs a migration.
    "list_grn",
    "list_issues",
    # Personal by construction: every row is filtered on Action.actor_id == user.id,
    # so there is no wider set for a rung to narrow.
    "report_summary",
    # Stock aggregates, bounded by _scoped_warehouse_ids for the same reason
    # list_stock is: a balance is a fact about a warehouse, not about a person.
    "get_overview_kpis",
    # Pass-through: it counts the rows of inventory.get_stock_replenishment, which
    # is already warehouse-scoped for this user. Scoping again here would be a
    # second, divergent filter over the same data — the very thing this test exists
    # to prevent.
    "_stock_counts",
    # Personal by construction, like report_summary: every row is counted off
    # wf_pending.approver_id == user.id, so there is no wider set for a rung to
    # narrow. Measured against workflow.pending_for_user for a SELF login: both 0.
    "pending_summary",
    # The tiles above list_stock / list_movements, built from the SAME
    # _stock_query / _movement_query the lists use, with the same `user`. Those two
    # lists are exempt above (a balance is a fact about a warehouse, not a person);
    # scoping the tile but not the grid under it is the mismatch this file exists to
    # catch, so the tile follows its list.
    "stock_summary",
    "movement_summary",
    # Queue depths for the warehouse rail: receipts at the gate, GRNs to raise, QC,
    # put-away, picks, issues, dispatches, returns. Every one is a fact about a
    # LOCATION, so it is bounded by warehouse_ids_for_user — the same set the lists
    # those tiles link to use — not by the person rungs. It only became visible to
    # this test once it took a `user` at all: before that it counted the whole
    # company and the test could not see it, which is how "At gate: 2" reached a
    # storekeeper holding one gate entry.
    "dashboard",
}

# Helpers that apply scope_condition on a module's behalf. A reader that calls one
# is scoped — the point of the rule is that the rung is applied, not that every
# query spells it out. Anything named here must itself call scope_condition.
SCOPE_DELEGATES = {
    # indents: access rule AND rung, shared by list_indents and indent_stats so the
    # dashboard can never disagree with the list under it.
    "_indent_visibility",
    # home.summary is a cache wrapper (2026-09-03): it keys on
    # (employee, active_position, date_range) and hands the actual build to
    # `_build_summary`, which applies every scope the tiles need. The position is in
    # the cache key precisely BECAUSE the answer is scoped — caching on the employee
    # alone would serve one hat's dashboard to another, which is a permissions leak
    # and not a stale number. Named here so the guard follows the delegation instead
    # of reading the wrapper and concluding the scope was dropped.
    "_build_summary",
}


# A KPI card and the list under it answer the same question two ways, so an
# aggregate that misses a predicate the list applies contradicts itself on screen.
# That is exactly what happened: the indent dashboard read 79 while All Requests
# read 2, because indent_stats had the access rule but not the scope rung.
AGGREGATE_HINTS = ("stats", "summary", "counts", "kpi", "dashboard", "overview")


def _list_functions(path: Path):
    """Every service function that reads a set of documents for a user.

    Two shapes count: a paginated `list_*`, and any aggregate (stats/summary/KPI)
    that takes a `user`. Both have to apply the same scope, or the screen shows two
    different answers to one question.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if not isinstance(node, ast.AsyncFunctionDef):
            continue
        source = ast.unparse(node)
        takes_user = "user" in [
            a.arg for a in node.args.args + node.args.kwonlyargs
        ]
        is_list = node.name.startswith("list_") and "paginate(" in source
        # No `select(` requirement: home.summary counts through a helper and was
        # missed by exactly that shortcut, while reading 79 against the list's 2.
        is_aggregate = takes_user and any(
            hint in node.name.lower() for hint in AGGREGATE_HINTS
        )
        if not (is_list or is_aggregate):
            continue
        yield node.name, source


def test_every_list_query_applies_the_scope_filter():
    """Fails when a paginated list service skips shared.scope.

    This is the guard rail for rule 12. If it goes red, either pass
    `scope_condition` into your query or add the function to SCOPE_EXEMPT with a
    comment saying why it is safe.
    """
    offenders: list[str] = []
    for service in sorted(MODULES_ROOT.glob("*/service.py")):
        for name, source in _list_functions(service):
            if name in SCOPE_EXEMPT:
                continue
            applies = "scope_condition" in source or any(
                helper in source for helper in SCOPE_DELEGATES
            )
            if not applies:
                offenders.append(f"{service.parent.name}.{name}")
    assert not offenders, (
        "These paginated list services do not apply shared.scope.scope_condition, "
        "so they return rows from outside the login's scope: "
        + ", ".join(offenders)
        + ". Pass scope_condition(...) into the query, or add the name to "
          "SCOPE_EXEMPT in this file with the reason."
    )


# Readers of ONE document. A list that narrows while its detail does not is the
# leak that keeps coming back: All Requests hid 77 indents and /indents/<id>
# served every one of them. The detail is the worse half — it returns a specific
# document rather than a page — so it gets its own rule.
DETAIL_EXEMPT = {
    # lgs_grn / lgs_issues carry no owner, office, project or warehouse column, so
    # there is nothing to scope on. Known debt, same as their list counterparts;
    # fixing it needs a migration.
    "get_grn",
    "get_issue",
    # Reference and stock reads, bounded by warehouse rather than by person.
    "get_stock_detail",
    "get_item_availability",
    # Not single-document readers despite the name: they take a warehouse_id filter
    # and return a set, already bounded by _scoped_warehouse_ids for this user.
    "get_stock_replenishment",
    "get_stock_valuation",
}


def _detail_readers(path: Path):
    """`get_*(db, <something>_id, ...)` functions that fetch a single row."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if not isinstance(node, ast.AsyncFunctionDef):
            continue
        if not re.match(r"^(get|fetch)_", node.name):
            continue
        args = [a.arg for a in node.args.args + node.args.kwonlyargs]
        if not any(re.search(r"(^|_)id$", a) for a in args):
            continue
        source = ast.unparse(node)
        if not re.search(r"(scalar_one_or_none|db\.get\(|\.first\(\))", source):
            continue
        yield node.name, args, source


def test_every_detail_reader_applies_the_scope_filter():
    """Fails when a single-document reader can be called without a scope check."""
    offenders: list[str] = []
    for service in sorted(MODULES_ROOT.glob("*/service.py")):
        for name, args, source in _detail_readers(service):
            if name in DETAIL_EXEMPT:
                continue
            takes_user = "user" in args
            delegates = "_assert_can_view" in source or "access_condition" in source
            scoped = "scope_condition" in source or delegates
            if not (takes_user and scoped):
                offenders.append(f"{service.parent.name}.{name}")
    assert not offenders, (
        "These single-document readers do not scope, so a document hidden from the "
        "list is still readable by id: " + ", ".join(offenders)
        + ". Take a `user` and apply scope_condition, or add the name to "
          "DETAIL_EXEMPT with the reason."
    )


def test_scope_delegates_really_apply_the_rung():
    """A name in SCOPE_DELEGATES must itself call scope_condition.

    Without this, adding a helper to that set is a way to switch the rule off for a
    whole module by accident.
    """
    sources = "\n".join(
        p.read_text(encoding="utf-8") for p in MODULES_ROOT.glob("*/service.py")
    )
    for helper in SCOPE_DELEGATES:
        tree = ast.parse(sources)
        body = next(
            (ast.unparse(n) for n in ast.walk(tree)
             if isinstance(n, ast.AsyncFunctionDef) and n.name == helper),
            None,
        )
        assert body is not None, f"SCOPE_DELEGATES names {helper}, which does not exist"
        assert "scope_condition" in body, (
            f"{helper} is trusted to apply the rung but never calls scope_condition"
        )


def test_scope_condition_signature_is_stable():
    """Modules call this by keyword; renaming a parameter breaks them silently."""
    params = set(inspect.signature(scope.scope_condition).parameters)
    assert {"owner_col", "position_col", "office_col", "project_col"} <= params
