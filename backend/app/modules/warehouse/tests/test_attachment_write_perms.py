"""A warehouse attachment is gated by the permission that writes its own document
(2026-10-30), not a blanket receipt.create.

The bug this locks in: attaching a gate pass to a material ISSUE demanded
`receipt.create` (the inbound-GRN grant), so a storekeeper who could work the issue but
held no receipt grant was refused. Each attachable document type must map to its OWN
write permission, and every readable type must have one — a new document type that slips
in unmapped would fall back to being unwritable (or, if the guard regressed, to the
wrong permission).
"""
from app.modules.warehouse import service
from app.platform.rbac import permissions as perms


def test_every_attachable_document_has_its_own_write_permission():
    # Read gate and write gate must cover exactly the same document types: a type you
    # can read the files of but cannot (correctly) file against, or vice versa, is a gap.
    assert set(service._ATTACHMENT_WRITE_PERMS) == set(service._ATTACHMENT_PARENTS)


def test_each_type_maps_to_the_grant_that_writes_that_document():
    m = service._ATTACHMENT_WRITE_PERMS
    # The fix: an issue's documents follow issue.create, never receipt.create.
    assert m["ISSUE"] == (perms.ISSUE_CREATE,)
    assert m["RECEIPT"] == (perms.RECEIPT_CREATE,)
    assert m["DISPATCH"] == (perms.DISPATCH_CREATE,)
    assert m["INSPECTION"] == (perms.INSPECTION_EXECUTE,)
    # Outward QC keeps its pair, so neither the creator nor the updater is locked out.
    assert m["OUTBOUND_INSPECTION"] == (perms.QC_OUTWARD_CREATE, perms.QC_OUTWARD_UPDATE)


def test_receipt_create_no_longer_writes_an_issue_document():
    # The regression guard: receipt.create must not appear on ISSUE/DISPATCH/INSPECTION.
    for key in ("ISSUE", "DISPATCH", "INSPECTION"):
        assert perms.RECEIPT_CREATE not in service._ATTACHMENT_WRITE_PERMS[key]
