"""The alert catalog — one place where every popup's copy and behaviour lives.

Why the server owns the wording: the same event is announced from more than one
screen (a PO is cancelled from the list, the detail page and the approvals queue),
and copy drifts the moment each screen writes its own string. Ops can also correct
a sentence here without a frontend release. The frontend ships the same table as a
local default, so the dialogs work before this call returns and if it fails.

Behaviour rules encoded below:

* `mode=CONFIRM` never auto-closes and always has both labels.
* `mode=ALERT` auto-closes after `AUTO_CLOSE_MS` when it is purely informational
  (success / info). Warnings and failures stay put — a message that vanishes
  after three seconds leaves the person believing the write landed, which is the
  reason `shared/components/Toast.tsx` pins its errors too.
"""
from app.core.exceptions import NotFoundError
from app.modules.alerts.schemas import AlertCatalog, AlertDef, AlertMode, AlertVariant

#: How long a self-closing alert stays on screen.
AUTO_CLOSE_MS = 3000


def _alert(
    code: str,
    variant: AlertVariant,
    title: str,
    message: str,
    *,
    action: str | None = None,
    sticky: bool | None = None,
) -> AlertDef:
    """An announcement. Closes itself unless it is a failure or `sticky` is set."""
    self_closing = variant in (AlertVariant.SUCCESS, AlertVariant.INFO)
    if sticky is not None:
        self_closing = not sticky
    return AlertDef(
        code=code,
        variant=variant,
        mode=AlertMode.ALERT,
        title=title,
        message=message,
        confirm_label=action,
        auto_close_ms=AUTO_CLOSE_MS if self_closing else None,
    )


def _confirm(
    code: str,
    variant: AlertVariant,
    title: str,
    message: str,
    *,
    confirm: str,
    cancel: str = "Cancel",
) -> AlertDef:
    """A question. Waits for an answer."""
    return AlertDef(
        code=code,
        variant=variant,
        mode=AlertMode.CONFIRM,
        title=title,
        message=message,
        confirm_label=confirm,
        cancel_label=cancel,
        auto_close_ms=None,
    )


_DEFINITIONS: list[AlertDef] = [
    # ---------------------------------------------------------------- danger
    # Irreversible, or cascading into documents that already exist.
    _confirm(
        "vendor.delete", AlertVariant.DANGER, "Delete vendor?",
        "Deleting {name} also removes it from every price list it appears on. "
        "Purchase orders already raised against it are kept, but you will not be "
        "able to raise new ones.",
        confirm="Yes, Delete",
    ),
    _confirm(
        "item.delete", AlertVariant.DANGER, "Delete item?",
        "{name} has stock, ledger rows and documents pointing at its item code. "
        "Once deleted, that history can no longer be traced back to an item.",
        confirm="Yes, Delete",
    ),
    _confirm(
        "warehouse.delete", AlertVariant.DANGER, "Delete location?",
        "{name} must be empty before it can go. Any bin mapped under it is removed "
        "with it and cannot be restored.",
        confirm="Yes, Delete",
    ),
    _confirm(
        "user.delete", AlertVariant.DANGER, "Delete user?",
        "{name} loses access immediately. Documents they raised or approved keep "
        "their name, but the sign-in is gone and cannot be restored.",
        confirm="Yes, Delete",
    ),
    _confirm(
        "role.delete", AlertVariant.DANGER, "Delete role?",
        "{count} user(s) currently hold this role and will lose every permission it "
        "grants the moment it is deleted.",
        confirm="Yes, Delete",
    ),
    _confirm(
        "indent.cancel", AlertVariant.DANGER, "Cancel indent?",
        "{number} will be closed and any stock reserved against it released back to "
        "available. This cannot be undone.",
        confirm="Yes, Cancel Indent", cancel="Keep Indent",
    ),
    _confirm(
        "po.cancel", AlertVariant.DANGER, "Cancel purchase order?",
        "{number} has been sent to the vendor. Cancelling stops any further receipt "
        "against it; quantities already received stay in stock.",
        confirm="Yes, Cancel PO", cancel="Keep PO",
    ),
    _confirm(
        "grn.discard", AlertVariant.DANGER, "Discard this receipt?",
        "Nothing on this draft GRN has been posted yet. Discarding it throws away "
        "every line you have entered.",
        confirm="Yes, Discard", cancel="Keep Editing",
    ),
    _confirm(
        "inward.cancel", AlertVariant.DANGER, "Cancel this material inward?",
        "{number} is closed and cannot be reopened. Any quality inspection or "
        "put-away task raised from it is cancelled with it.",
        confirm="Yes, Cancel Inward", cancel="Keep Inward",
    ),
    _confirm(
        "inspection.cancel", AlertVariant.DANGER, "Cancel this quality inspection?",
        "{number} is dropped without a result. The material inward behind it goes "
        "back to awaiting inspection.",
        confirm="Yes, Cancel Inspection", cancel="Keep Inspection",
    ),
    _confirm(
        "issue.cancel", AlertVariant.DANGER, "Cancel this material issue?",
        "{number} is closed and anything reserved against it returns to available "
        "stock. Quantities already issued are not pulled back.",
        confirm="Yes, Cancel Issue", cancel="Keep Issue",
    ),

    # --------------------------------------------------------------- warning
    # Reversible in principle, but they move a document or touch stock.
    _confirm(
        "indent.submit", AlertVariant.WARNING, "Submit for approval?",
        "{number} goes to {approver} and can no longer be edited while it is in "
        "approval.",
        confirm="Submit",
    ),
    _confirm(
        "indent.approve", AlertVariant.WARNING, "Approve this indent?",
        "Approving {number} reserves the requested stock and moves it to the next "
        "stage of the chain.",
        confirm="Approve",
    ),
    _confirm(
        "indent.reject", AlertVariant.WARNING, "Reject this indent?",
        "{number} returns to the raiser. Add a remark so they know what to change.",
        confirm="Reject",
    ),
    _confirm(
        "po.approve", AlertVariant.WARNING, "Approve this purchase order?",
        "{number} commits {amount} against the budget. It becomes ready to send to "
        "the vendor.",
        confirm="Approve",
    ),
    _confirm(
        "po.send_vendor", AlertVariant.WARNING, "Send to vendor?",
        "{number} is sent to {vendor} and locked for editing. Goods can only be "
        "received against a PO that has been sent.",
        confirm="Send",
    ),
    _confirm(
        "indent.return", AlertVariant.WARNING, "Return for correction?",
        "{number} goes back to {raiser} to be edited and resubmitted. The approval "
        "chain restarts from the first stage once it comes back.",
        confirm="Return",
    ),
    _confirm(
        "grn.post", AlertVariant.WARNING, "Post this receipt?",
        "Posting writes a stock ledger row and adds the accepted quantity to "
        "{location}. Ledger rows are never deleted, so corrections have to be made "
        "as an adjustment.",
        confirm="Post Receipt",
    ),
    _confirm(
        "stock.transfer", AlertVariant.WARNING, "Confirm transfer?",
        "Moving {qty} of {item} from {source} to {destination} writes two ledger "
        "rows and takes effect immediately.",
        confirm="Transfer",
    ),
    _confirm(
        "stock.adjust", AlertVariant.WARNING, "Post stock adjustment?",
        "This changes the on-hand quantity of {item} to {qty} and is recorded "
        "against your name in the ledger.",
        confirm="Post Adjustment",
    ),
    _confirm(
        "adjustment.approve", AlertVariant.WARNING, "Approve this adjustment?",
        "Approving writes the counted quantity for {item} into the ledger. The "
        "ledger is append-only, so a mistake has to be corrected with a second "
        "adjustment.",
        confirm="Approve",
    ),
    _confirm(
        "material_request.approve", AlertVariant.WARNING,
        "Approve this material request?",
        "Approving {number} reserves {qty} of {item} against it, so that stock stops "
        "being available to anyone else.",
        confirm="Approve",
    ),
    _confirm(
        "putaway.confirm", AlertVariant.WARNING, "Confirm put-away?",
        "{qty} of {item} is stored in bin {bin} and becomes available to pick from "
        "there.",
        confirm="Confirm",
    ),
    _confirm(
        "putaway.skip", AlertVariant.WARNING, "Skip this put-away?",
        "{number} stays unallocated and the stock cannot be picked from any bin "
        "until someone puts it away.",
        confirm="Skip",
    ),
    _confirm(
        "inspection.complete", AlertVariant.WARNING, "Complete quality inspection?",
        "Accepted quantity goes forward to put-away and rejected quantity is held "
        "back for the vendor. The result cannot be edited afterwards.",
        confirm="Complete Inspection",
    ),
    _confirm(
        "dispatch.gate_out", AlertVariant.WARNING, "Gate out this dispatch?",
        "{number} is recorded as having left the site. Stock is deducted now and the "
        "dispatch can no longer be edited.",
        confirm="Gate Out",
    ),
    _confirm(
        "issue.post", AlertVariant.WARNING, "Issue material?",
        "{qty} of {item} is issued to {project} and deducted from stock now.",
        confirm="Issue",
    ),
    _confirm(
        "allocation.override", AlertVariant.WARNING, "Override allocation?",
        "You are allocating more than the system suggested for {item}. The override "
        "and your reason are logged against the request.",
        confirm="Override",
    ),
    _confirm(
        "vendor.deactivate", AlertVariant.WARNING, "Deactivate vendor?",
        "{name} has {count} open purchase order(s). Deactivating stops new POs; the "
        "open ones can still be received.",
        confirm="Deactivate",
    ),
    _confirm(
        "bulk.apply", AlertVariant.WARNING, "Apply to {count} records?",
        "This runs {action} on every selected record. There is no per-record undo.",
        confirm="Apply",
    ),
    _confirm(
        "workflow.publish", AlertVariant.WARNING, "Publish this ladder?",
        "New submissions route by the updated ladder from now on. Documents already "
        "in approval keep the chain they were frozen with.",
        confirm="Publish",
    ),

    # ------------------------------------------------------------------ info
    # Self-closing, and nothing here needs a decision. These interrupt someone who
    # did not ask for them, so each one stays to a single short line — a nudge
    # that needs a paragraph is a page, not a dialog.
    _alert(
        "settings.changed", AlertVariant.INFO, "Settings updated",
        "Refresh to apply your changes.",
        action="Refresh",
    ),
    _alert(
        "session.expiring", AlertVariant.INFO, "Session expiring",
        "Signing out in {minutes} minutes.",
        # Sticky: it is useless if it disappears before it is read.
        sticky=True,
    ),
    _alert(
        "hcm.sync_running", AlertVariant.INFO, "Sync started",
        "Refreshing employee data now.",
    ),

    # --------------------------------------------------------------- success
    _alert(
        "indent.created", AlertVariant.SUCCESS, "Indent raised",
        "{number} has been created and sent for approval.",
        action="View Indent",
    ),
    _alert(
        "indent.approved", AlertVariant.SUCCESS, "Approved",
        "{number} has moved to the next stage.",
    ),
    _alert(
        "grn.posted", AlertVariant.SUCCESS, "Receipt posted",
        "{number} is complete and stock has been updated.",
        action="View Receipt",
    ),
    _alert(
        "stock.transferred", AlertVariant.SUCCESS, "Transfer complete",
        "{qty} of {item} is now at {destination}.",
    ),
    _alert(
        "issue.posted", AlertVariant.SUCCESS, "Material issued",
        "{number} has been issued and stock deducted.",
        action="View Issue",
    ),
    _alert(
        "adjustment.posted", AlertVariant.SUCCESS, "Adjustment posted",
        "{item} now reads {qty} in stock.",
    ),
    _alert(
        "putaway.completed", AlertVariant.SUCCESS, "Put-away complete",
        "{item} is now stored in {bin}.",
    ),
    _alert(
        "dispatch.gated_out", AlertVariant.SUCCESS, "Dispatch gated out",
        "{number} has left the site.",
        action="Track Dispatch",
    ),
    _alert(
        "master.saved", AlertVariant.SUCCESS, "Saved",
        "Your changes to {name} have been saved.",
    ),

    # Routine outcomes. Each one is the *result* of something the user already
    # clicked, so it announces and gets out of the way after three seconds — a
    # confirm here would be a second click for a decision already made.
    _alert(
        "excel.exported", AlertVariant.SUCCESS, "Export ready",
        "{name} has been downloaded.",
        action="Open File",
    ),
    _alert(
        "indent.deleted", AlertVariant.SUCCESS, "Indent deleted",
        "{number} has been removed.",
    ),
    _alert(
        "indent.rejected", AlertVariant.SUCCESS, "Indent rejected",
        "{number} has gone back to {raiser}.",
    ),
    _alert(
        "indent.returned", AlertVariant.SUCCESS, "Returned for correction",
        "{number} is with {raiser} to edit.",
    ),
    _alert(
        "po.approved", AlertVariant.SUCCESS, "Purchase order approved",
        "{number} is ready to send.",
    ),
    _alert(
        "material_request.approved", AlertVariant.SUCCESS, "Request approved",
        "{number} is approved and stock is reserved.",
    ),
    _alert(
        "adjustment.approved", AlertVariant.SUCCESS, "Adjustment approved",
        "{item} now reads {qty}.",
    ),
    _alert(
        "inspection.completed", AlertVariant.SUCCESS, "Inspection complete",
        "{number} is inspected and sent for put-away.",
    ),
    _alert(
        "issue.acknowledged", AlertVariant.SUCCESS, "Receipt acknowledged",
        "{number} has been confirmed.",
    ),
    _alert(
        "reminder.sent", AlertVariant.SUCCESS, "Reminder sent",
        "{name} has been nudged.",
    ),
    _alert(
        "delegation.created", AlertVariant.SUCCESS, "Delegation active",
        "{name} approves on your behalf.",
    ),
    _alert(
        "delegation.ended", AlertVariant.SUCCESS, "Delegation ended",
        "Approvals come back to you.",
    ),
    _alert(
        "user.saved", AlertVariant.SUCCESS, "User saved",
        "{name} has been updated.",
    ),
    _alert(
        "role.saved", AlertVariant.SUCCESS, "Role saved",
        "{name} has been updated.",
    ),
    _alert(
        "label.printed", AlertVariant.SUCCESS, "Sent to printer",
        "{count} label(s) queued.",
    ),
    _alert(
        "clipboard.copied", AlertVariant.SUCCESS, "Copied",
        "{name} is on your clipboard.",
    ),

    # ----------------------------------------------------------------- error
    # Never self-closing.
    _alert(
        "request.failed", AlertVariant.ERROR, "Something went wrong",
        "The server could not complete your request. Nothing has been saved.",
        action="Retry",
    ),
    _alert(
        "permission.denied", AlertVariant.ERROR, "Not allowed",
        "Your role does not include {permission}. Ask an administrator if you need "
        "it.",
    ),
    _alert(
        "session.expired", AlertVariant.ERROR, "Signed out",
        "Your session has expired. Sign in again to carry on; unsaved work on this "
        "screen is lost.",
        action="Sign In",
    ),
    _alert(
        "network.unreachable", AlertVariant.ERROR, "Can't reach the server",
        "Check your connection. Nothing has been saved.",
        action="Retry",
    ),
    _alert(
        "hcm.sync_failed", AlertVariant.ERROR, "HCM sync failed",
        "{entity} could not be synced: {reason}",
        action="Retry",
    ),
    _alert(
        "stock.insufficient", AlertVariant.ERROR, "Not enough stock",
        "{item} has {available} available but {qty} was requested.",
        action="Adjust Quantity",
    ),
    _alert(
        "document.duplicate", AlertVariant.ERROR, "Already exists",
        "{number} has already been recorded against {vendor}.",
    ),
    _alert(
        "excel.import_failed", AlertVariant.ERROR, "Excel import failed",
        "{count} row(s) in {name} could not be read. Nothing was imported — fix the "
        "file and upload it again.",
        action="View Errors",
    ),
    _alert(
        "print.failed", AlertVariant.ERROR, "Print failed",
        "The label printer did not respond. The job has not been sent.",
        action="Retry",
    ),
]

#: code -> definition. Built once at import; the catalog is a constant.
CATALOG: dict[str, AlertDef] = {item.code: item for item in _DEFINITIONS}


def catalog() -> AlertCatalog:
    return AlertCatalog(items=CATALOG, total=len(CATALOG))


def get(code: str) -> AlertDef:
    """Look one entry up. Raises rather than inventing copy for an unknown code."""
    try:
        return CATALOG[code]
    except KeyError:
        raise NotFoundError(f"No alert is defined for '{code}'") from None
