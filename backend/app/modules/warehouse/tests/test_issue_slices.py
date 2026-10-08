"""Where an unreserved issue line draws its stock from (`_issue_slices`).

No database: the one query is faked. Guards WHI0001 — a direct issue carrying a
project over UNSCOPED stock (project 0) ignored the bin and batch the storekeeper
named and drew FEFO from other bays, so the serials left one bay and the balance
was taken off another.
"""
import asyncio
from decimal import Decimal
from types import SimpleNamespace

from app.modules.warehouse import service


class _Db:
    def __init__(self, rows):
        self.rows = rows

    async def execute(self, _stmt):
        rows = self.rows
        return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: rows))


def stock(bin_id, batch_id, available, project_id=0):
    return SimpleNamespace(bin_id=bin_id, batch_id=batch_id, project_id=project_id,
                           available_qty=Decimal(available))


def slices(rows, *, bin_id, batch_id, qty, project_id=7):
    issue = SimpleNamespace(warehouse_id=982, project_id=project_id)
    line = SimpleNamespace(item_id=68, bin_id=bin_id, batch_id=batch_id)
    return asyncio.run(service._issue_slices(_Db(rows), issue, line, Decimal(qty)))


# FEFO order as the query returns it: the earlier-expiring bay first.
SHELF = [stock(1, 48, 10), stock(35, 51, 94)]


def test_a_project_issue_draws_the_named_bay_of_unscoped_stock():
    assert slices(SHELF, bin_id=35, batch_id=51, qty=5) == [(35, 51, 0, Decimal(5))]


def test_the_projects_own_row_is_drawn_before_unscoped_stock():
    rows = [stock(35, 51, 3, project_id=0), stock(35, 51, 3, project_id=7)]
    assert slices(rows, bin_id=35, batch_id=51, qty=5) == [
        (35, 51, 7, Decimal(3)), (35, 51, 0, Decimal(2))]


def test_another_projects_stock_is_never_the_named_bay():
    rows = [stock(1, 48, 10), stock(35, 51, 94, project_id=9)]
    assert slices(rows, bin_id=35, batch_id=51, qty=5) == [(1, 48, 0, Decimal(5))]


def test_a_named_bay_too_short_falls_back_to_fefo():
    rows = [stock(1, 48, 10), stock(35, 51, 2)]
    assert slices(rows, bin_id=35, batch_id=51, qty=5) == [(1, 48, 0, Decimal(5))]
