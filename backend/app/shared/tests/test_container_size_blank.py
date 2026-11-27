"""A container type saved with no size is "not stated", never a refusal (2026-11-21).
The form's empty option arrived as "" and was refused as an unknown size, so a
container type could not be edited at all without picking one."""
from app.shared.masters.defs import PackagingIn


def test_a_blank_size_is_not_stated():
    assert PackagingIn(code="BOX", name="Box", size_class="").size_class is None
    assert PackagingIn(code="BOX", name="Box", size_class="LARGE").size_class.value == "LARGE"
