"""QA-5 BUG_006: one login on two PCs, both saving the same material issue.

Each save rewrote every line from its own copy, so the second silently undid the
first, and two saves landing together raced into lock waits. `update_issue` now locks
the header and refuses a save made from a copy that is no longer the latest.

Pure: the guard is driven against a stub session, so no database is needed.
"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.core.exceptions import ConflictError
from app.modules.warehouse.service import _assert_issue_not_stale, _stamp_second

SAVED = datetime(2026, 11, 26, 12, 30, 15)          # naive IST, as MySQL returns it


class _Result:
    def __init__(self, value):
        self._value = value

    def scalar_one(self):
        return self._value


class _Session:
    """Answers the one locked read the guard makes, and records that it locked."""

    def __init__(self, stored):
        self.stored = stored
        self.locked = False

    async def execute(self, stmt):
        self.locked = getattr(stmt, "_for_update_arg", None) is not None
        return _Result(self.stored)


ISSUE = SimpleNamespace(id=7, issue_no="WHI0042")


def test_a_stamp_is_compared_at_the_columns_own_resolution():
    # The copy written in Python carries microseconds; MySQL keeps whole seconds.
    assert _stamp_second(SAVED.replace(microsecond=987654)) == SAVED
    # A client echoing it back with an offset is the same instant (IST = UTC+5:30).
    utc = (SAVED - timedelta(hours=5, minutes=30)).replace(tzinfo=timezone.utc)
    assert _stamp_second(utc) == SAVED


@pytest.mark.asyncio
async def test_a_save_from_the_latest_copy_goes_through_and_locks_the_header():
    db = _Session(SAVED)
    await _assert_issue_not_stale(db, ISSUE, SAVED.replace(microsecond=120))
    assert db.locked


@pytest.mark.asyncio
async def test_a_save_from_an_older_copy_is_refused_with_a_way_out():
    db = _Session(SAVED)
    with pytest.raises(ConflictError) as caught:
        await _assert_issue_not_stale(db, ISSUE, SAVED - timedelta(minutes=3))
    message = str(caught.value)
    assert "WHI0042" in message
    assert "another window" in message
    assert "Reload" in message
    assert "26 Nov 2026" in message


@pytest.mark.asyncio
async def test_a_caller_that_sends_no_stamp_keeps_the_old_behaviour():
    db = _Session(SAVED)
    await _assert_issue_not_stale(db, ISSUE, None)
    assert db.locked          # still queued behind any save in flight
