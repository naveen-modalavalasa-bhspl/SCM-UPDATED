"""The code tree and the Issue-within-Storage rule (2026-10-27). Pure, no database.

A unit-tracked item is split at putaway all the way down — carton, the boxes in it,
the strips in those — so a strip INSIDE a box of the Issue level is exactly right and
must never make the issue desk re-box the lot. And an item is never issued in a
container bigger than the smallest one it is stored in.
"""
from types import SimpleNamespace

import pytest

from app.core.exceptions import ValidationError
from app.modules.warehouse.box_codes import needs_rebox
from app.shared.masters.packs import _assert_issue_within_storage


def _hu(id_, level, parent=None):
    return SimpleNamespace(id=id_, level=level, parent_id=parent)


def test_strips_inside_boxes_inside_a_carton_need_no_rebox():
    # carton(3) → box(2) ×2 → strip(1) ×2 each; issued by the BOX (level 2)
    live = [_hu(1, 3), _hu(2, 2, 1), _hu(3, 2, 1),
            _hu(4, 1, 2), _hu(5, 1, 2), _hu(6, 1, 3), _hu(7, 1, 3)]
    assert needs_rebox(live, 2) is False


def test_a_carton_never_split_into_boxes_needs_rebox():
    assert needs_rebox([_hu(1, 3)], 2) is True


def test_a_strip_standing_on_its_own_needs_rebox():
    # a loose strip with no box above it cannot be issued as a box
    assert needs_rebox([_hu(1, 3), _hu(2, 2, 1), _hu(9, 1)], 2) is True


USAGE = {"containers": [
    {"package_id": 10, "name": "Carton", "used_in": [
        {"hierarchy_id": 1, "hierarchy": "Box of 10", "level": 2, "size": 100}]},
    {"package_id": 20, "name": "Box", "used_in": [
        {"hierarchy_id": 1, "hierarchy": "Box of 10", "level": 1, "size": 10}]},
]}


def test_issue_in_a_smaller_container_than_storage_is_fine():
    _assert_issue_within_storage(USAGE, {(10, "STORAGE"), (20, "ISSUE")})


def test_issue_in_the_storage_container_itself_is_fine():
    _assert_issue_within_storage(USAGE, {(10, "STORAGE"), (10, "ISSUE")})


def test_issue_bigger_than_the_smallest_storage_container_is_refused():
    with pytest.raises(ValidationError, match="Carton cannot be an Issue container"):
        _assert_issue_within_storage(USAGE, {(10, "STORAGE"), (20, "STORAGE"), (10, "ISSUE")})


def test_nothing_mapped_for_storage_constrains_nothing():
    _assert_issue_within_storage(USAGE, {(10, "ISSUE")})
