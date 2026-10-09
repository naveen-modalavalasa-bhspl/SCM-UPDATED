"""The two rules that stop `sys_attachments` being one open bucket.

No database: everything asserted here is a decision made before a query runs, and the
point of these tests is that they are cheap enough to keep running.
"""
import io

import pytest

from app.core.exceptions import NotFoundError, ValidationError
from app.platform.settings import attachments


# --------------------------------------------------------------------------- #
#  What may be stored
# --------------------------------------------------------------------------- #

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8
PDF = b"%PDF-1.7\n" + b"\x00" * 8


def test_business_types_are_accepted():
    assert attachments._assert_type("invoice.pdf", PDF) == "application/pdf"
    assert attachments._assert_type("qc-photo.PNG", PNG) == "image/png"
    # No signature to check, and none is invented: a CSV is bytes that happen to be
    # commas.
    assert attachments._assert_type("lines.csv", b"a,b,c\n") == "text/csv"


@pytest.mark.parametrize("name", ["payload.exe", "run.sh", "page.html", "icon.svg",
                                  "drawings.zip", "notes"])
def test_executables_scripts_and_containers_are_refused(name):
    # .html and .svg matter as much as .exe here: served back from our own origin they
    # are stored XSS, which is why the whitelist is by extension and not by "is it
    # dangerous to run".
    with pytest.raises(ValidationError):
        attachments._assert_type(name, PDF)


def test_a_renamed_file_is_refused():
    """The extension says PDF and the bytes say PNG. Refused either way round."""
    with pytest.raises(ValidationError):
        attachments._assert_type("invoice.pdf", PNG)


def test_served_type_comes_from_the_extension_not_the_row():
    # `mime_type` is what the uploading client claimed, and rows written before the
    # whitelist existed may claim anything at all.
    assert attachments.safe_mime("scan.pdf") == "application/pdf"
    assert attachments.safe_mime("legacy.bin") == attachments.FALLBACK_MIME
    assert attachments.safe_mime(None) == attachments.FALLBACK_MIME


# --------------------------------------------------------------------------- #
#  Where a file may be acted on
# --------------------------------------------------------------------------- #

class _Row:
    def __init__(self, entity_type, entity_id):
        self.entity_type, self.entity_id = entity_type, entity_id


class _Db:
    """Just enough session to answer `db.get(Attachment, id)`."""

    def __init__(self, row):
        self._row = row

    async def get(self, _model, _id):
        return self._row


@pytest.mark.asyncio
async def test_parent_type_and_id_must_both_match():
    db = _Db(_Row("RECEIPT", 7))
    assert (await attachments.require_attachment(
        db, 1, entity_type="RECEIPT", entity_id=7)).entity_id == 7
    # The type alone, for a caller that will check the parent's scope itself.
    assert await attachments.require_attachment(db, 1, entity_type=("RECEIPT", "ISSUE"))


@pytest.mark.asyncio
async def test_another_modules_file_is_not_found():
    """`indent.acknowledge` must not reach a warehouse receipt's paperwork, and a
    raiser of one return must not reach another document's, whatever id they send."""
    db = _Db(_Row("RECEIPT", 7))
    with pytest.raises(NotFoundError):
        await attachments.require_attachment(db, 1, entity_type="INDENT_ACK")
    with pytest.raises(NotFoundError):
        await attachments.require_attachment(db, 1, entity_type="RECEIPT", entity_id=8)
    with pytest.raises(NotFoundError):
        await attachments.require_attachment(_Db(None), 1, entity_type="RECEIPT")


@pytest.mark.asyncio
async def test_delete_cannot_be_called_without_naming_a_parent():
    """The guard is the signature. A route that cannot say which document the file
    hangs on has authorised nothing, so it must not compile past here."""
    with pytest.raises(TypeError):
        await attachments.delete_attachment(_Db(None), 1, None)
