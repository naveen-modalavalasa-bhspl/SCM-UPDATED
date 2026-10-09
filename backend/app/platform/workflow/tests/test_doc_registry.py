"""The approver-snapshot registry, and the guard that keeps it honest.

No database. These run in milliseconds and catch the thing that actually goes wrong:
somebody adds a document type with a `current_approver_name` column, forgets to
register it, and an admin's Move silently stops updating that document — which is
exactly the defect this registry was written to fix, reappearing in a new module.
"""
import app.main  # noqa: F401 - imports every module, which is what registers them

from app.core.database import Base
from app.platform.workflow import doc_registry


def test_every_registered_table_and_column_actually_exists():
    """A registration is three strings. A typo in any of them is a silent no-op at
    runtime — the UPDATE would hit nothing and `sync_approver` would report False —
    so it has to fail here instead."""
    tables = Base.metadata.tables
    for doc_type, spec in doc_registry.registered().items():
        assert spec.table_name in tables, (
            f"{doc_type} is registered against '{spec.table_name}', which is not a "
            f"table in the metadata")
        columns = tables[spec.table_name].columns.keys()
        assert spec.id_column in columns, (
            f"{doc_type}: {spec.table_name} has no column '{spec.id_column}'")
        assert spec.approver_column in columns, (
            f"{doc_type}: {spec.table_name} has no column '{spec.approver_column}'")


def test_every_table_with_a_snapshot_column_is_reachable():
    """Every table carrying `current_approver_name` should be registered by SOME doc
    type — otherwise a Move onto another ladder version leaves that document naming
    the approver from the version it was just taken off.

    Listed rather than asserted blindly: a table may legitimately be absent because
    its document type never goes through `move_to_workflow` (a legacy stage-walking
    workflow is refused by the engine outright). Anything new turning up here is a
    prompt to decide which of the two it is, not an automatic failure.
    """
    with_snapshot = {
        name for name, table in Base.metadata.tables.items()
        if "current_approver_name" in table.columns.keys()
    }
    registered = {spec.table_name for spec in doc_registry.registered().values()}
    unreachable = with_snapshot - registered

    # Empty, and meant to stay that way. `out_issues` was the last gap: its three
    # ladders (WH_ISSUE / OWN_STOCK_ISSUE / FORWARD_ISSUE) are chosen per document by
    # `warehouse.service._issue_doc_type`, so all three register against the same
    # table — registering one would have updated some issues and not others.
    allowed: set[str] = set()
    assert unreachable <= allowed, (
        "These tables keep a current_approver_name that an admin Move would leave "
        f"stale: {sorted(unreachable - allowed)}. Register them in the owning "
        "module's models.py, or add them here with a note saying why not."
    )


def test_unregistered_doc_type_is_a_no_op_not_an_error():
    """The failure mode is deliberate: a doc type nobody registered must leave a Move
    working exactly as it did before, never break it."""
    assert doc_registry.lookup("NO_SUCH_DOC_TYPE") is None


def test_indent_is_registered_against_its_own_table():
    """The document the original defect was found on."""
    spec = doc_registry.lookup("INDENT")
    assert spec is not None
    assert spec.table_name == "ind_indents"
    assert spec.approver_column == "current_approver_name"
