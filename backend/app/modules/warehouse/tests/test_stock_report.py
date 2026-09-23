"""Stock by storage location: the scope is the report.

"Download what is on Floor 1" is two different files — what is booked to the floor
row itself, and what is on the floor including every bay under it — and on a real
building the first is usually empty while the second is the answer. So the arithmetic
that decides which locations a download covers, and the sentences that tell somebody
which of the two they are about to pull, are what these tests hold.

All pure: the tree walk, the wording and both file builders run on a machine with no
MySQL. That is deliberate — `descendants` is the whole feature, and a rule that needs
a database to check is a rule nobody checks.
"""
from datetime import date, timedelta
from decimal import Decimal
from types import SimpleNamespace as NS

import pytest

from app.core.exceptions import ValidationError
from app.modules.warehouse import stock_report as sr


def location(id_, parent, code, name=None):
    return NS(id=id_, parent_id=parent, code=code, name=name,
              storage_type_id=None, bin_type=None)


# A building: two floors, one of which is racked out.
#   F1 ─ F1-A1 ─ F1-A1-R1 ─ B1, B2
#   F2
BUILDING = [
    location(1, None, "F1", "Ground floor"),
    location(2, 1, "F1-A1", "Aisle 1"),
    location(3, 2, "F1-A1-R1", "Rack 1"),
    location(4, 3, "F1-A1-R1-B1"),
    location(5, 3, "F1-A1-R1-B2"),
    location(6, None, "F2", "First floor"),
]
KIDS = sr.child_index(BUILDING)
BY_ID = {int(row.id): row for row in BUILDING}


# ---------------- which locations a scope covers ----------------

def test_a_floor_reaches_every_rung_beneath_it():
    # The point of the hierarchy scope: four levels down, not one.
    assert sr.descendants(KIDS, 1) == {2, 3, 4, 5}


def test_a_bay_has_nothing_inside_it():
    assert sr.descendants(KIDS, 4) == set()


def test_a_floor_does_not_reach_a_sibling_floor():
    # The obvious one, and the one that quietly turns a floor report into a site
    # report if `descendants` is ever written as "everything below the root depth".
    assert 6 not in sr.descendants(KIDS, 1)


def test_the_root_is_not_its_own_descendant():
    # `scope_location_ids` adds the root back deliberately; if `descendants` also
    # returned it, a location holding stock would be counted twice in the tally.
    assert 1 not in sr.descendants(KIDS, 1)


def test_a_mis_parented_row_does_not_hang_the_report():
    # Two rows pointing at each other is a data defect somebody will create. The
    # report it breaks should be this one, not the whole request.
    cycle = sr.child_index([location(1, 2, "A"), location(2, 1, "B")])
    assert sr.descendants(cycle, 1) == {2}


def test_the_narrow_scope_is_exactly_one_location():
    assert sr.scope_location_ids(KIDS, 1, sr.SCOPE_LOCATION) == {1}


def test_the_wide_scope_is_the_location_and_everything_under_it():
    assert sr.scope_location_ids(KIDS, 1, sr.SCOPE_HIERARCHY) == {1, 2, 3, 4, 5}


def test_no_location_chosen_means_the_whole_warehouse():
    # None, not the empty set: "nothing to narrow to" and "narrow to nothing" are
    # opposite instructions, and the second one returns an empty file.
    assert sr.scope_location_ids(KIDS, None, sr.SCOPE_HIERARCHY) is None
    assert sr.scope_location_ids(KIDS, None, sr.SCOPE_LOCATION) is None


# ---------------- where a row sits ----------------

def test_the_trail_runs_from_the_top_of_the_building_down():
    assert [row.code for row in sr.ancestry(BY_ID, 4)] == [
        "F1", "F1-A1", "F1-A1-R1", "F1-A1-R1-B1"]


def test_depth_counts_rungs_not_the_warehouse():
    assert sr.depth_of(BY_ID, 1) == 1
    assert sr.depth_of(BY_ID, 4) == 4
    assert sr.depth_of(BY_ID, None) == 0


# ---------------- the wording, which is served and not composed in a screen ----------------

def test_the_two_scopes_never_read_the_same():
    place = "F1 — Ground floor"
    wide = sr.scope_sentence(place, sr.SCOPE_HIERARCHY, descendant_count=4)
    narrow = sr.scope_sentence(place, sr.SCOPE_LOCATION, descendant_count=4)
    assert wide != narrow
    assert "4 locations" in wide
    assert "only" in narrow


def test_a_location_with_nothing_inside_says_so_rather_than_counting_zero():
    # "and all 0 locations inside it" is how a sentence built by formatting alone
    # reads, and it makes a bay look like a container somebody forgot to fill.
    said = sr.scope_sentence("B1", sr.SCOPE_HIERARCHY, descendant_count=0)
    assert "0 locations" not in said
    assert "nothing is stored inside" in said.lower()


def test_a_floor_holding_nothing_itself_warns_before_the_empty_file_is_pulled():
    # THE case this feature exists for. A floor is not where anybody puts a carton
    # down, so the narrow file is empty — and an empty spreadsheet with no
    # explanation is read as an empty floor.
    hint = sr._location_hint(
        {"rows": 0, "items": 0, "locations": 0, "total_qty": Decimal(0)},
        {"rows": 120, "items": 40, "locations": 12, "total_qty": Decimal(3204)},
        "F1 — Ground floor", inside={2, 3, 4, 5})
    assert "would be empty" in hint
    assert "12 locations" in hint


def test_the_wide_scope_is_recommended_when_the_stock_is_underneath():
    # Landing the screen on the empty file is how somebody concludes a full floor is
    # empty, so the recommendation follows the stock.
    hint = sr._hierarchy_hint(
        {"rows": 120, "items": 40, "locations": 12, "total_qty": Decimal(3204)},
        "F1", inside={2, 3})
    assert "12 locations" in hint and "40 items" in hint


def test_one_of_something_is_not_pluralised():
    assert sr._plural(1, "location") == "1 location"
    assert sr._plural(2, "location") == "2 locations"


# ---------------- what a row says about itself ----------------

def test_expiry_is_bucketed_into_a_decision_not_arithmetic_homework():
    assert "ended" in sr._shelf_life(-3)
    assert sr._shelf_life(0).endswith("today")
    assert "Within 30 days" in sr._shelf_life(12)
    assert "Within 90 days" in sr._shelf_life(60)
    assert sr._shelf_life(None) == "No expiry recorded"


def test_an_asset_has_a_warranty_and_a_consumable_an_expiry():
    assert "Warranty" in sr._shelf_life(-3, is_asset=True)
    assert "Expiry" in sr._shelf_life(-3, is_asset=False)


def test_a_lot_of_five_hundred_units_does_not_become_one_unreadable_cell():
    rendered = sr._serials([f"SN{i}" for i in range(500)])
    assert rendered.count(",") == sr.SERIALS_SHOWN - 1
    assert "+488 more" in rendered


def test_a_short_list_is_shown_whole():
    assert sr._serials(["A", "B"]) == "A, B"


def test_no_units_is_blank_not_an_empty_bracket():
    assert sr._serials(None) is None
    assert sr._serials([]) is None


# ---------------- the file ----------------

def _row(loc_id, code, batch, avail, res, total, days=None):
    return {
        "location_id": loc_id, "location_code": code, "location_name": "Bay",
        "location_kind": "Bin", "depth": 4, "parent_code": "F1-A1-R1",
        "location_path": f"Main › F1 › Aisle 1 › Rack 1 › {code}",
        "item_id": 7, "item_code": "ITM-0001", "item_name": "Paracetamol 500mg",
        "uom_code": "BOX", "batch_no": batch,
        "expiry_date": date.today() + timedelta(days=days) if days is not None else None,
        "days_to_expiry": days, "shelf_life": sr._shelf_life(days),
        "project_name": None, "asset_code": None, "serial_numbers": None,
        "available_qty": Decimal(avail), "reserved_qty": Decimal(res),
        "total_qty": Decimal(total),
    }


ROWS = [
    _row(4, "F1-A1-R1-B1", "B-001", 10, 5, 15, days=12),
    _row(4, "F1-A1-R1-B1", "B-002", 40, 0, 40, days=200),
    _row(5, "F1-A1-R1-B2", "B-003", 0, 25, 25, days=-4),
]


def _meta(scope=sr.SCOPE_HIERARCHY, **over):
    meta = {
        "warehouse_id": 1, "warehouse_name": "Main Warehouse", "location_id": 1,
        "location_code": "F1", "location_label": "F1 — Ground floor",
        "location_kind": "Floor", "location_path": "Main Warehouse › Ground floor",
        "scope": scope,
        "scope_sentence": sr.scope_sentence("F1 — Ground floor", scope,
                                            descendant_count=4),
        "item_filter": None, "locations_with_stock": 2, "items": 1,
        "total_qty": Decimal(80), "available_qty": Decimal(50),
        "reserved_qty": Decimal(30), "truncated": False, "floor_restricted": False,
        "row_count": len(ROWS),
    }
    meta.update(over)
    return meta


def test_the_file_states_its_own_scope():
    # A stock extract with no scope on it is a column of numbers somebody will later
    # attribute to the wrong floor.
    block = sr.header_block(_meta(), actor="Naveen K")
    flat = {row[0]: (row[1] if len(row) > 1 else "") for row in block if row}
    assert flat["Storage location"] == "F1 — Ground floor"
    assert flat["Scope"] == "This location and everything inside it"
    assert flat["Generated by"] == "Naveen K"


def test_the_narrow_file_says_it_is_narrow():
    block = sr.header_block(_meta(scope=sr.SCOPE_LOCATION), actor=None)
    flat = {row[0]: (row[1] if len(row) > 1 else "") for row in block if row}
    assert flat["Scope"] == "This location only"


def test_the_file_admits_that_it_counts_reserved_stock():
    # This is the one figure on which the file and the grid it was pulled from
    # disagree, so it is said on the file's face rather than left to be discovered.
    notes = " ".join(row[1] for row in sr.header_block(_meta(), actor=None)
                     if row and row[0] == "Note")
    assert "reserved" in notes.lower()


def test_a_truncated_file_admits_it():
    # A cut-off extract that does not say so is read as a complete one.
    block = sr.header_block(_meta(truncated=True), actor=None)
    assert any(row and row[0] == "TRUNCATED" for row in block)


def test_a_floor_restricted_pull_says_another_person_may_get_more():
    block = sr.header_block(_meta(floor_restricted=True), actor=None)
    notes = " ".join(row[1] for row in block if row and row[0] == "Note")
    assert "access" in notes.lower()


def test_the_roll_up_totals_each_location_once():
    summary = sr.summarise(ROWS)
    assert len(summary) == 2
    first = next(s for s in summary if s["location_code"] == "F1-A1-R1-B1")
    assert first["lines"] == 2
    assert first["items"] == 1          # both lines are the same item, in two batches
    assert first["total_qty"] == Decimal(55)


def test_the_workbook_carries_the_rows_and_the_roll_up():
    import io

    from openpyxl import load_workbook

    name, body = sr._build_xlsx(_meta(), ROWS, "Naveen K")
    assert name.endswith(".xlsx") and "F1" in name
    book = load_workbook(io.BytesIO(body))
    assert book.sheetnames == ["Stock", "By location"]
    sheet = book["Stock"]
    # Frozen panes and an autofilter, because the first thing anybody does with a
    # stock extract is sort it.
    assert sheet.freeze_panes and sheet.auto_filter.ref
    assert sheet["A1"].value == sr._TITLE


def test_a_single_location_file_has_no_roll_up_sheet():
    # It would be one line restating the header.
    import io

    from openpyxl import load_workbook

    _name, body = sr._build_xlsx(
        _meta(scope=sr.SCOPE_LOCATION, locations_with_stock=1), ROWS, None)
    assert load_workbook(io.BytesIO(body)).sheetnames == ["Stock"]


def test_the_csv_carries_the_same_columns_as_the_workbook():
    _name, text = sr._build_csv(_meta(), ROWS, None)
    lines = text.splitlines()
    heading = next(line for line in lines if line.startswith("Location,"))
    assert heading.split(",")[0:3] == ["Location", "Location name", "Kind"]
    assert len(lines) - lines.index(heading) - 1 == len(ROWS)


def test_a_location_code_with_a_slash_in_it_still_makes_a_filename():
    # Windows refuses these outright, and a location code is free text.
    name = sr._filename(_meta(location_code="F1/A1"), "xlsx")
    assert "/" not in name and "F1-A1" in name


def test_an_unknown_scope_is_refused_rather_than_guessed():
    with pytest.raises(ValidationError):
        sr.scope_location_ids(KIDS, 1, "EVERYTHING")  # type: ignore[arg-type]


# ---------------- the download header ----------------
#
# FIXED 2026-09-23 -- every export answered 500. The filename carries an em dash,
# HTTP headers are LATIN-1, and Starlette encodes them with no fallback — so
# `Response.__init__` raised UnicodeEncodeError AFTER the workbook had been built,
# which reaches the screen as a bare 500 on a request that had already done all of
# its work. A warehouse name and a location code are free text, so pinning the dash
# would not have been a fix; the header carries both spellings of the name instead.

def test_the_download_header_is_encodable_as_a_header():
    name = sr._filename(_meta(), "xlsx")
    assert "—" in name, "the display name is the one that broke; keep it typographic"
    # The assertion that is the bug: this raised UnicodeEncodeError.
    sr.content_disposition(name).encode("latin-1")


@pytest.mark.parametrize("code", [
    "F1", "Dépôt Café", "गोदाम", "F1 — Ground floor", "Ф1", "倉庫",
])
def test_any_location_code_still_produces_a_sendable_header(code):
    # Location codes and warehouse names are free text in a system with sites across
    # several scripts. Every one of them has to produce a header that can be sent.
    header = sr.content_disposition(sr._filename(_meta(location_code=code), "xlsx"))
    header.encode("latin-1")


def test_the_header_carries_the_real_name_as_well_as_the_plain_one():
    # The ASCII half is a fallback nobody modern uses; RFC 5987 `filename*` is what
    # actually names the saved file, so the em dash survives to the download.
    header = sr.content_disposition("SCM Stock — Café.xlsx")
    assert 'filename="SCM Stock - Cafe.xlsx"' in header
    assert "filename*=UTF-8''" in header
    assert "%E2%80%94" in header          # the em dash, percent-encoded


def test_an_unrenderable_name_never_becomes_an_empty_filename():
    # `filename=""` is a download the browser names "download".
    assert sr.ascii_filename("गोदाम") == "stock-report"


def test_a_quote_in_a_name_cannot_end_the_header_early():
    # Otherwise the rest of the name is read as header parameters.
    assert '"' not in sr.ascii_filename('F1" ; evil=1.xlsx')
