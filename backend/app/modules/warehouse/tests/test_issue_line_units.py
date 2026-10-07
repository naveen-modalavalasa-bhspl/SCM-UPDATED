"""Which units belong to which issue LINE, and which lines outward QC looks at.

No database: the three rules here are pure. They are what keeps a batch drawn from
two storage locations as two lines all the way to the consignment (2026-10-07):

- `_attribute_units_to_lines` hands a posted issue's units — stamped per DOCUMENT —
  back to the lines that sent them, by the batch AND bay each unit left from. Handed
  out in plain line order, the first line of a batch took every unit of the batch and
  outward QC and the packing grid validated the other bay's codes against it.
- `_line_needs_outward_qc` puts only items that `requires_qi` on the QC sheet.
- `_outbound_qc_verdict` keeps an issue consignable when its sheet failed but it also
  carries goods that never needed a check.
"""
from decimal import Decimal
from types import SimpleNamespace

from app.modules.warehouse import service
from app.modules.warehouse import models as m
from app.modules.warehouse.enums import QcStatus


def line(id, *, item_id=7, batch_id=11, bin_id=None, qty=5):
    return SimpleNamespace(id=id, item_id=item_id, batch_id=batch_id, bin_id=bin_id,
                           issued_qty=Decimal(qty))


def unit(id, *, item_id=7, batch_id=11, bin_id=None):
    return SimpleNamespace(id=id, item_id=item_id, batch_id=batch_id, bin_id=bin_id)


def attribute(lines, units):
    by_line = {row.id: [] for row in lines}
    pool = {}
    for row in units:
        pool.setdefault(row.item_id, []).append(row)
    service._attribute_units_to_lines(lines, pool, by_line)
    return {line_id: [row.id for row in rows] for line_id, rows in by_line.items()}


def test_one_batch_in_two_bays_keeps_each_bays_units_on_its_own_line():
    # Line 1 takes 2 from bay 10, line 2 takes 3 from bay 20. The units are listed
    # bay-20-first, which is what made plain line order hand line 1 the wrong ones.
    lines = [line(1, bin_id=10, qty=2), line(2, bin_id=20, qty=3)]
    units = [unit(101, bin_id=20), unit(102, bin_id=20), unit(103, bin_id=20),
             unit(104, bin_id=10), unit(105, bin_id=10)]
    assert attribute(lines, units) == {1: [104, 105], 2: [101, 102, 103]}


def test_two_batches_are_told_apart_by_batch():
    lines = [line(1, batch_id=11, qty=1), line(2, batch_id=12, qty=1)]
    units = [unit(201, batch_id=12), unit(202, batch_id=11)]
    assert attribute(lines, units) == {1: [202], 2: [201]}


def test_a_unit_moved_off_its_bay_still_lands_on_a_line_of_its_batch():
    # A forwarded or re-slotted unit: right batch, different bay. Exact matches go
    # first, then the batch alone fills what is left — nothing is dropped.
    lines = [line(1, bin_id=10, qty=2)]
    units = [unit(301, bin_id=10), unit(302, bin_id=99)]
    assert attribute(lines, units) == {1: [301, 302]}


def test_no_line_takes_more_units_than_it_issued():
    lines = [line(1, bin_id=10, qty=1)]
    units = [unit(401, bin_id=10), unit(402, bin_id=10)]
    assert attribute(lines, units) == {1: [401]}


def test_the_no_bin_and_no_batch_sentinels_mean_any():
    lines = [line(1, batch_id=m.NO_BATCH, bin_id=m.NO_BIN, qty=2)]
    units = [unit(501, batch_id=11, bin_id=10), unit(502, batch_id=12, bin_id=None)]
    assert attribute(lines, units) == {1: [501, 502]}


def test_only_items_that_require_qi_go_on_the_outward_sheet():
    checked = SimpleNamespace(requires_qi=True)
    unchecked = SimpleNamespace(requires_qi=False)
    assert service._line_needs_outward_qc(checked, line(1, qty=3)) is True
    assert service._line_needs_outward_qc(unchecked, line(1, qty=3)) is False
    # Nothing issued on the line, nothing to inspect.
    assert service._line_needs_outward_qc(checked, line(1, qty=0)) is False


def test_a_failed_sheet_leaves_unchecked_goods_consignable():
    verdict = service._outbound_qc_verdict
    assert verdict(passed=2, failed=0, lines=2, unchecked=False) == QcStatus.PASSED.value
    assert verdict(passed=0, failed=2, lines=2, unchecked=False) == QcStatus.FAILED.value
    assert verdict(passed=0, failed=2, lines=2, unchecked=True) == QcStatus.PARTIAL.value
    assert verdict(passed=1, failed=1, lines=2, unchecked=False) == QcStatus.PARTIAL.value


def test_the_qc_desk_and_the_packing_desk_never_share_an_issue():
    assert QcStatus.NOT_REQUIRED.value in service.CONSIGNABLE_QC
    assert not set(service.CONSIGNABLE_QC) & set(service.INSPECTABLE_QC)
