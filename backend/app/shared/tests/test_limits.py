"""Request-size guards. No database: these are decisions made before a query runs.

The failure these prevent is the one the resilience review traced: a quantity of
200,000-300,000 is one harmless decimal, but a serial-tracked line expands it into
that many individual unit records inside one HTTP request, which locks the warehouse
tables, holds the pool and runs past the proxy's 60-second read timeout. The user
sees a dead screen and cannot tell whether it worked.
"""
import datetime

import pytest
from pydantic import ValidationError

from app.shared.limits import (
    MAX_BATCH_IDS,
    MAX_DOCUMENT_LINES,
    MAX_SERIALS_PER_LINE,
    MAX_SERIALS_PER_REQUEST,
)


def _future() -> str:
    return (datetime.date.today() + datetime.timedelta(days=7)).isoformat()


def _lines(count: int) -> list[dict]:
    return [{"item_id": 1, "quantity": 1} for _ in range(count)]


def test_a_document_may_carry_up_to_the_line_limit():
    from app.modules.indents.schemas import IndentCreate

    assert len(IndentCreate(required_date=_future(),
                            items=_lines(MAX_DOCUMENT_LINES)).items) == MAX_DOCUMENT_LINES


def test_one_line_over_the_limit_is_refused_before_any_query_runs():
    from app.modules.indents.schemas import IndentCreate

    with pytest.raises(ValidationError):
        IndentCreate(required_date=_future(), items=_lines(MAX_DOCUMENT_LINES + 1))


def test_a_batch_of_ids_is_bounded():
    """A monthly cycle submit used to accept any number of indent ids and then loop
    them one at a time inside the request."""
    from app.modules.indents.schemas import MonthlySubmitIn

    assert MonthlySubmitIn(indent_ids=list(range(MAX_BATCH_IDS))).indent_ids
    with pytest.raises(ValidationError):
        MonthlySubmitIn(indent_ids=list(range(MAX_BATCH_IDS + 1)))


def test_a_single_line_cannot_carry_an_unbounded_serial_list():
    from app.modules.warehouse.schemas import IssueSerialLineIn

    serials = [f"SN{n}" for n in range(MAX_SERIALS_PER_LINE + 1)]
    with pytest.raises(ValidationError):
        IssueSerialLineIn(id=1, serial_numbers=serials)


def test_serials_are_also_capped_ACROSS_the_whole_request():
    """The per-line cap alone is not enough, and this is the case that actually
    crashed: MAX_DOCUMENT_LINES lines each holding MAX_SERIALS_PER_LINE serials is
    half a million units in one transaction, with every individual line legal."""
    from app.modules.warehouse.schemas import IssueSerialsIn

    per_line = MAX_SERIALS_PER_LINE
    lines_needed = (MAX_SERIALS_PER_REQUEST // per_line) + 1
    payload = [
        {"id": n, "serial_numbers": [f"SN{n}-{i}" for i in range(per_line)]}
        for n in range(lines_needed)
    ]
    with pytest.raises(ValidationError) as caught:
        IssueSerialsIn(lines=payload)
    # The message has to name the limit and the way out, or the person hitting it has
    # no idea what to do next.
    assert "manifest" in str(caught.value)


def test_a_request_inside_the_budget_still_passes():
    from app.modules.warehouse.schemas import IssueSerialsIn

    payload = [{"id": 1,
                "serial_numbers": [f"SN{i}" for i in range(MAX_SERIALS_PER_REQUEST)]}]
    # One line of exactly the per-line cap, well inside the request budget.
    payload[0]["serial_numbers"] = payload[0]["serial_numbers"][:MAX_SERIALS_PER_LINE]
    assert IssueSerialsIn(lines=payload).lines
