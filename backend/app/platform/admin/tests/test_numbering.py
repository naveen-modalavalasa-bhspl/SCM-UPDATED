"""Document numbering: reset periods, pattern validation and preview. No database."""
from datetime import datetime
from types import SimpleNamespace

import pytest

from app.core.exceptions import ValidationError
from app.platform.admin.numbering import preview, _validate
from app.shared.enums import DocType, ResetPolicy
from app.shared.numbering import _fiscal_year, current_period


def series(prefix="IND", fiscal_year="2026-27", pattern="{prefix}/{fy}/{num:04d}",
           last_number=0):
    return SimpleNamespace(prefix=prefix, fiscal_year=fiscal_year, pattern=pattern,
                           last_number=last_number)


def payload(doc_type=DocType.INDENT.value, fiscal_year="2026-27", prefix="IND",
            pattern="{prefix}/{fy}/{num:04d}", reset_policy=ResetPolicy.NEVER.value):
    return SimpleNamespace(doc_type=doc_type, fiscal_year=fiscal_year, prefix=prefix,
                           pattern=pattern, reset_policy=reset_policy)


# ------------------------------ fiscal year ------------------------------ #
@pytest.mark.parametrize("when,expected", [
    (datetime(2026, 4, 1), "2026-27"),    # first day of the Indian FY
    (datetime(2026, 12, 31), "2026-27"),
    (datetime(2027, 3, 31), "2026-27"),   # last day of the same FY
    (datetime(2027, 4, 1), "2027-28"),    # rolls over
    (datetime(2026, 1, 15), "2025-26"),   # January belongs to the previous FY
])
def test_fiscal_year_boundaries(when, expected):
    assert _fiscal_year(when) == expected


# ------------------------------ reset periods ------------------------------ #
def test_never_policy_has_no_period():
    assert current_period(ResetPolicy.NEVER.value, datetime(2026, 7, 25)) is None
    assert current_period(None, datetime(2026, 7, 25)) is None


def test_yearly_period_follows_the_fiscal_year():
    assert current_period(ResetPolicy.YEARLY.value, datetime(2026, 7, 25)) == "2026-27"
    assert current_period(ResetPolicy.YEARLY.value, datetime(2027, 3, 31)) == "2026-27"
    assert current_period(ResetPolicy.YEARLY.value, datetime(2027, 4, 1)) == "2027-28"


def test_monthly_period_is_zero_padded():
    assert current_period(ResetPolicy.MONTHLY.value, datetime(2026, 7, 25)) == "2026-07"
    assert current_period(ResetPolicy.MONTHLY.value, datetime(2026, 12, 1)) == "2026-12"


def test_monthly_period_changes_across_a_month_boundary():
    july = current_period(ResetPolicy.MONTHLY.value, datetime(2026, 7, 31))
    august = current_period(ResetPolicy.MONTHLY.value, datetime(2026, 8, 1))
    assert july != august


# ------------------------------ preview ------------------------------ #
def test_preview_shows_the_next_number_not_the_last():
    assert preview(series(last_number=41)) == "IND/2026-27/0042"


def test_preview_pads_to_the_pattern_width():
    assert preview(series(last_number=0)) == "IND/2026-27/0001"


def test_preview_supports_a_custom_pattern():
    assert preview(series(pattern="{prefix}-{num:06d}", last_number=7)) == "IND-000008"


def test_preview_reports_a_bad_pattern_instead_of_raising():
    assert preview(series(pattern="{nope}/{num}")) == "invalid pattern"


# ------------------------------ validation ------------------------------ #
def test_valid_payload_passes():
    _validate(payload())


def test_unknown_doc_type_is_rejected():
    with pytest.raises(ValidationError, match="doc_type"):
        _validate(payload(doc_type="INVOICE"))


def test_unknown_reset_policy_is_rejected():
    with pytest.raises(ValidationError, match="reset_policy"):
        _validate(payload(reset_policy="WEEKLY"))


def test_pattern_without_a_placeholder_is_rejected():
    """A constant pattern would hand every document the same number."""
    with pytest.raises(ValidationError, match="placeholder|prefix"):
        _validate(payload(pattern="FIXED-STRING"))


def test_pattern_with_an_unknown_placeholder_is_rejected():
    with pytest.raises(ValidationError, match="format string"):
        _validate(payload(pattern="{prefix}/{quarter}/{num:04d}"))
