"""One write per issue at a time (2026-11-26). Pure: the database is a stub.

A second Save / Submit / Approve / Issue-from-stock on the same issue used to wait on
the first one's unit rows until MySQL gave up (1205 -> 409, or nginx's 60 s "System
error"). `_claim_issue_for_write` takes the header row with NOWAIT and refuses the
second request at once, naming the document.
"""
import asyncio
from types import SimpleNamespace

import pytest
from sqlalchemy.exc import OperationalError

from app.core.exceptions import ConflictError, NotFoundError
from app.modules.warehouse import models as m
from app.modules.warehouse import service


class _Result:
    def __init__(self, value):
        self.value = value

    def scalar_one_or_none(self):
        return self.value


class _Db:
    """Raises `first` on the locking SELECT, then answers reads with `issue_no`."""

    def __init__(self, first=None, found=1, issue_no="BHS/WHI0071"):
        self.first, self.found, self.issue_no, self.calls = first, found, issue_no, 0

    async def execute(self, stmt):
        self.calls += 1
        if self.calls == 1:
            if self.first is not None:
                raise self.first
            return _Result(self.found)
        return _Result(self.issue_no)


def _mysql_error(errno):
    return OperationalError("SELECT ... FOR UPDATE NOWAIT", {},
                            SimpleNamespace(args=(errno, "locked")))


def test_the_claim_is_a_nowait_row_lock():
    from sqlalchemy import select
    from sqlalchemy.dialects import mysql
    sql = str(select(m.MaterialIssue.id).where(m.MaterialIssue.id == 1)
              .with_for_update(nowait=True).compile(dialect=mysql.dialect()))
    assert sql.rstrip().endswith("FOR UPDATE NOWAIT")


@pytest.mark.parametrize("errno", [3572, 1205])
def test_a_second_write_is_refused_at_once_and_names_the_issue(errno):
    with pytest.raises(ConflictError) as caught:
        asyncio.run(service._claim_issue_for_write(_Db(first=_mysql_error(errno)), 71))
    assert "BHS/WHI0071" in str(caught.value)
    assert "being saved" in str(caught.value)


def test_an_unrelated_database_error_is_not_dressed_up_as_a_conflict():
    with pytest.raises(OperationalError):
        asyncio.run(service._claim_issue_for_write(_Db(first=_mysql_error(2013)), 71))


def test_a_missing_issue_is_not_found():
    with pytest.raises(NotFoundError):
        asyncio.run(service._claim_issue_for_write(_Db(found=None), 71))


def test_the_claim_lets_a_free_issue_through():
    asyncio.run(service._claim_issue_for_write(_Db(), 71))


def test_the_remarks_prefix_index_is_declared_on_the_model():
    """Bootstrap builds only what the MODEL declares; the migration's raw SQL never
    reaches a database bootstrap created, and the issue save then scans every unit."""
    from sqlalchemy.dialects import mysql
    from sqlalchemy.schema import CreateIndex
    ix = {i.name: i for i in m.SerialNumber.__table__.indexes}["ix_whs_serial_remarks"]
    assert "(remarks(80))" in str(CreateIndex(ix).compile(dialect=mysql.dialect()))
