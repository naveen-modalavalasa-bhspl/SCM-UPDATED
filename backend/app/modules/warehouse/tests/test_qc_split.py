"""SCM_0124: a QC line starts un-inspected and stays Pending until it is accounted for.

Pure — `qc_split` is the one rule both QC sheets save through.
"""
from decimal import Decimal as D

from app.modules.warehouse.service import qc_split


def test_an_untouched_line_is_not_judged():
    assert qc_split(D(0), D(0), D(0), rejected_sent=True) == (D(0), D(0), False)


def test_counting_alone_decides_nothing():
    # 10 inspected, nothing accepted or rejected yet: still Pending, nothing rejected.
    assert qc_split(D(10), D(0), D(0), rejected_sent=True) == (D(0), D(0), False)
    assert qc_split(D(10), D(6), D(0), rejected_sent=True) == (D(6), D(0), False)


def test_a_full_split_is_judged():
    assert qc_split(D(10), D(10), D(0), rejected_sent=True) == (D(10), D(0), True)
    assert qc_split(D(10), D(7), D(3), rejected_sent=True) == (D(7), D(3), True)
    assert qc_split(D(10), D(0), D(10), rejected_sent=True) == (D(0), D(10), True)


def test_a_caller_sending_only_accepted_keeps_the_old_reading():
    # No rejected sent: the rest of the line is rejected, as before.
    assert qc_split(D(10), D(7), D(0), rejected_sent=False) == (D(7), D(3), True)


def test_accepted_never_passes_inspected():
    assert qc_split(D(5), D(9), D(0), rejected_sent=True) == (D(5), D(0), True)
