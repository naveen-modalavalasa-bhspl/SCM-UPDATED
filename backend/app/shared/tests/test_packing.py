"""Pack hierarchy arithmetic — pure, no database."""
from decimal import Decimal as D

import pytest

from app.shared import packing as p


def _ladder():
    # Strip of 10: Strip = 10 TAB, Box = 10 Strip (100), Carton = 12 Box (1,200)
    return p.build_ladder(hierarchy_id=1, hierarchy_name="Strip of 10", base_uom="TAB",
                          rungs=[
                              {"id": 13, "level": 3, "quantity": 12, "package_name": "Carton"},
                              {"id": 11, "level": 1, "quantity": 10, "package_name": "Strip"},
                              {"id": 12, "level": 2, "quantity": 10, "package_name": "Box"},
                          ])


def test_ladder_multiplies_up_in_order():
    ladder = _ladder()
    assert [lv.size for lv in ladder.levels] == [1, 10, 100, 1200]
    assert ladder.top == 3
    assert ladder.label(2) == "Box · 10 Strip (100 TAB)"
    assert ladder.label(1) == "Strip (10 TAB)"
    assert ladder.label(0) == "Loose TAB"


def test_a_gap_in_the_ladder_drops_everything_above_it():
    ladder = p.build_ladder(hierarchy_id=1, hierarchy_name="x", base_uom="TAB", rungs=[
        {"id": 1, "level": 1, "quantity": 10, "package_name": "Strip"},
        {"id": 3, "level": 3, "quantity": 12, "package_name": "Carton"},
    ])
    assert ladder.top == 1


def test_normalize_snapshots_merges_and_orders_biggest_first():
    ladder = _ladder()
    out = p.normalize(ladder, [
        {"item_packaging_id": 11, "qty": 20},
        {"item_packaging_id": 13, "qty": 1},
        {"level": 2, "qty": 4},
        {"item_packaging_id": 12, "qty": 6},
        {"level": 0, "qty": 0},
    ])
    assert [(e["name"], e["qty"]) for e in out] == [("Carton", "1"), ("Box", "10"),
                                                   ("Strip", "20")]
    assert p.base_of(out) == D(2400)
    assert p.describe(out, "TAB") == "1 Carton + 10 Box + 20 Strip = 2,400 TAB"


def test_packs_come_whole_and_never_from_another_hierarchy():
    ladder = _ladder()
    with pytest.raises(p.PackError, match="packs come whole"):
        p.normalize(ladder, [{"item_packaging_id": 12, "qty": "2.5"}])
    with pytest.raises(p.PackError, match="not part of the Strip of 10"):
        p.normalize(ladder, [{"item_packaging_id": 99, "qty": 1}])


def test_normalize_refuses_a_level_below_the_coded_one():
    with pytest.raises(p.PackError, match="cannot be split"):
        p.normalize(_ladder(), [{"level": 1, "qty": 3}], min_level=2)


def test_greedy_fills_the_biggest_pack_first():
    ladder = _ladder()
    out = p.greedy(ladder, 2745)
    assert p.counts(out) == {3: 2, 2: 3, 1: 4, 0: 5}
    assert p.base_of(out) == D(2745)
    assert p.counts(p.greedy(ladder, 2400, max_level=2)) == {2: 24}
    with pytest.raises(p.PackError, match="cannot be split smaller"):
        p.greedy(ladder, 150, min_level=2)


def test_rescale_keeps_the_shape_under_the_largest_level_used():
    ladder = _ladder()
    entries = p.normalize(ladder, [{"level": 2, "qty": 24}])
    assert p.counts(p.rescale(ladder, entries, 2000)) == {2: 20}


# --------------------------------------------------------------------------- #
#  Repack planning
# --------------------------------------------------------------------------- #

def _boxes(n, *, atom=True, start=1):
    return [p.Node(id=i, level=2, atom=atom) for i in range(start, start + n)]


def test_twelve_coded_boxes_become_one_carton_and_keep_their_codes():
    plan = p.plan_repack(_ladder(), _boxes(12), 0, {3: 1})
    assert plan.opened == []
    assert len(plan.created) == 1 and plan.created[0].level == 3
    assert sorted(plan.created[0].children) == list(range(1, 13))
    assert plan.top == ["new-3-1"]


def test_opening_a_carton_back_to_its_coded_boxes_is_allowed():
    carton = p.Node(id="C1", level=3, children=_boxes(12))
    plan = p.plan_repack(_ladder(), [carton], 0, {2: 12})
    assert plan.opened == ["C1"]
    assert plan.created == []
    assert sorted(plan.top) == list(range(1, 13))


def test_a_coded_box_cannot_be_opened_into_strips():
    with pytest.raises(p.PackError, match="cannot be split"):
        p.plan_repack(_ladder(), _boxes(1), 0, {1: 10})


def test_uncoded_packs_open_and_reform_freely():
    # 2 uncoded boxes + 50 loose -> 25 strips
    plan = p.plan_repack(_ladder(), _boxes(2, atom=False), 50, {1: 25})
    assert sorted(plan.opened) == [1, 2]
    # The 20 strips inside the two boxes are carved out of them; only the 50 loose
    # tablets have to be formed into new strips.
    assert len(plan.carved) == 20
    assert len([c for c in plan.created if c.level == 1]) == 5
    assert plan.loose == 0


def test_a_partial_wrap_keeps_what_it_can():
    # 13 coded boxes -> 1 carton + 1 box: twelve go in, one stays out
    plan = p.plan_repack(_ladder(), _boxes(13), 0, {3: 1, 2: 1})
    assert plan.opened == []
    assert len(plan.created) == 1 and len(plan.created[0].children) == 12
    assert len(plan.top) == 2


def test_a_repack_never_changes_the_quantity():
    with pytest.raises(p.PackError, match="never changes the quantity"):
        p.plan_repack(_ladder(), _boxes(12), 0, {3: 2})


def test_a_box_shelved_whole_is_carved_into_its_strips_when_opened():
    # One uncoded box with no recorded strips -> 7 strips + 30 loose
    plan = p.plan_repack(_ladder(), _boxes(1, atom=False), 0, {1: 7, 0: 30})
    assert plan.opened == [1] + [f"cut-1-{k}" for k in (8, 9, 10)] or set(plan.opened) >= {1}
    assert len(plan.carved) == 7
    assert plan.loose == 30


def test_a_short_delivery_is_read_inside_the_declared_packs():
    ladder = _ladder()
    declared = p.normalize(ladder, [{"level": 3, "qty": 1}, {"level": 2, "qty": 10},
                                    {"level": 1, "qty": 20}])
    assert p.counts(p.shrink_to(ladder, declared, 2300)) == {3: 1, 2: 10, 1: 10}
    assert p.counts(p.shrink_to(ladder, declared, 2305)) == {3: 1, 2: 10, 1: 10, 0: 5}
    with pytest.raises(p.PackError, match="more than"):
        p.shrink_to(ladder, declared, 2500)


def test_a_count_may_be_short_but_never_a_different_packing():
    ladder = _ladder()
    declared = p.normalize(ladder, [{"level": 2, "qty": 10}])
    p.assert_within(ladder, p.normalize(ladder, [{"level": 2, "qty": 9}]), declared)
    with pytest.raises(p.PackError, match="did not send any Carton"):
        p.assert_within(ladder, p.normalize(ladder, [{"level": 3, "qty": 1}]), declared)
    with pytest.raises(p.PackError, match="never over"):
        p.assert_within(ladder, p.normalize(ladder, [{"level": 2, "qty": 11}]), declared)


# --------------------------------------------------------------------------- #
#  Part packs and the minimum fill (2026-10-11)
# --------------------------------------------------------------------------- #

def _carton_ladder(min_fill=400):
    # Carton of 600 NOS with a floor of 400; Box of 100 below it.
    return p.build_ladder(hierarchy_id=7, hierarchy_name="Carton of 600", base_uom="NOS",
                          rungs=[
                              {"id": 71, "level": 1, "quantity": 100, "package_name": "Box"},
                              {"id": 72, "level": 2, "quantity": 6, "package_name": "Carton",
                               "min_fill_qty": min_fill},
                          ])


def test_a_carton_of_600_may_hold_500_and_says_so():
    ladder = _carton_ladder()
    out = p.normalize(ladder, [{"level": 2, "qty": 1, "fill": 500}])
    assert out[0]["fill"] == "500"
    assert p.base_of(out) == D(500)
    assert p.describe(out, "NOS") == "1 Carton (500 of 600) = 500 NOS"


def test_one_line_holds_full_and_part_packs_side_by_side():
    ladder = _carton_ladder()
    out = p.normalize(ladder, [{"level": 2, "qty": 1, "fill": 400}, {"level": 2, "qty": 1}])
    assert [(e["qty"], e.get("fill")) for e in out] == [("1", None), ("1", "400")]
    assert p.base_of(out) == D(1000)


def test_the_size_is_a_ceiling():
    with pytest.raises(p.PackError, match="holds at most 600"):
        p.normalize(_carton_ladder(), [{"level": 2, "qty": 1, "fill": 650}])


def test_a_full_fill_is_simply_a_full_pack():
    out = p.normalize(_carton_ladder(), [{"level": 2, "qty": 1, "fill": 600}])
    assert "fill" not in out[0]


def test_the_minimum_refuses_only_where_a_pack_is_made():
    ladder = _carton_ladder()
    with pytest.raises(p.PackError, match="at least 400"):
        p.normalize(ladder, [{"level": 2, "qty": 1, "fill": 300}], enforce_min=True)
    # Anywhere else (a short carton at the gate) it is allowed, and only warned about.
    out = p.normalize(ladder, [{"level": 2, "qty": 1, "fill": 300}])
    assert any("below the 400" in w for w in p.warnings(out, ladder))


def test_two_part_packs_on_one_line_warn_but_pass():
    ladder = _carton_ladder(min_fill=None)
    out = p.normalize(ladder, [{"level": 2, "qty": 2, "fill": 500}])
    assert p.base_of(out) == D(1000)
    assert any("2 part-filled Carton" in w for w in p.warnings(out, ladder))


def test_a_short_delivery_counts_the_part_pack_at_what_it_holds():
    declared = p.normalize(_carton_ladder(), [{"level": 2, "qty": 1},
                                              {"level": 2, "qty": 1, "fill": 400}])
    counted = p.shrink_snapshot(declared, 1000)
    assert p.base_of(counted) == D(1000)
    assert sorted(p.held(e) for e in counted) == [D(400), D(600)]


def test_a_part_carton_is_kept_when_the_target_names_it():
    ladder = _carton_ladder()
    nodes = [p.Node(id=1, level=2, content=D(350)), p.Node(id=2, level=2)]
    full, part = p.split_target([{"level": 2, "qty": "1", "size": "600"},
                                 {"level": 2, "qty": "1", "size": "600", "fill": "350"}])
    plan = p.plan_repack(ladder, nodes, D(0), full, partial=part)
    assert plan.opened == [] and plan.created == []


def test_repacking_a_short_carton_into_boxes_carves_what_it_really_holds():
    ladder = _carton_ladder()
    # A carton of 600 that an issue left holding 350 -> 3 Box + 50 loose.
    plan = p.plan_repack(ladder, [p.Node(id=1, level=2, content=D(350))], D(0),
                         {1: D(3), 0: D(50)})
    assert plan.opened == [1]
    assert len(plan.carved) == 3
    assert plan.loose == D(50)


def test_a_repack_may_make_a_part_carton_from_loose():
    ladder = _carton_ladder()
    plan = p.plan_repack(ladder, [], D(450), {}, partial=[(2, D(450))])
    assert [(c.level, c.fill, c.loose_units) for c in plan.created] == [(2, D(450), D(450))]
    assert plan.loose == D(0)


def test_a_part_repack_still_never_changes_the_quantity():
    with pytest.raises(p.PackError, match="never changes the quantity"):
        p.plan_repack(_carton_ladder(), [p.Node(id=1, level=2, content=D(350))], D(0),
                      {2: D(1)})
