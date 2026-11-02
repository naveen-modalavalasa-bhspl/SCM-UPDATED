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
        "indent.delete", AlertVariant.DANGER, "Delete draft indent?",
        "{number} has not been submitted, so nothing downstream points at it yet. "
        "Deleting throws away every line on it and cannot be undone.",
        confirm="Yes, Delete", cancel="Keep Draft",
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
        "po.reject", AlertVariant.WARNING, "Reject this purchase order?",
        "{number} goes back to procurement and nothing is committed against the "
        "budget. Add a comment so they know what to change.",
        confirm="Reject",
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
        "stock.audit.submit", AlertVariant.WARNING, "Submit this stock audit?",
        "{count} counted at {warehouse}; {diff} differ from system stock. Differences "
        "are posted to the ledger once the audit is approved.",
        confirm="Submit Audit",
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
        # {qty}/{item} were never passed by the screen, so the dialog printed the
        # placeholders raw — and the sentence was wrong twice over: approving an MR
        # reserves nothing, because the material does not exist yet. Same wording as
        # the bundled catalog, which this one overlays.
        "Approving {number} clears {lines} to be bought. It reserves no stock — this "
        "material has to be purchased before anyone can be issued it.",
        confirm="Approve",
    ),
    _confirm(
        "material_request.reject", AlertVariant.WARNING,
        "Reject this material request?",
        "{number} is refused and no stock is reserved against it. The shortfall it "
        "was raised for stays unfilled.",
        confirm="Reject",
    ),
    _confirm(
        "master.deactivate", AlertVariant.WARNING, "Deactivate this record?",
        "{name} stops appearing on new documents. Anything that already references "
        "it keeps working — masters are deactivated, never deleted.",
        confirm="Deactivate",
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
    # Gate-out doubles as "send for release approval" when the consignment has not
    # been through its chain yet. Announcing the gate-out copy there told the
    # storekeeper the goods had left while they were still on the bench.
    _alert(
        "dispatch.sent_for_approval", AlertVariant.INFO, "Sent for approval",
        "{number} is with {approver}. The goods stay on the bench until they sign.",
    ),

    # --------------------------------------------------------------- success
    _alert(
        "indent.created", AlertVariant.SUCCESS, "Indent raised",
        "{number} has been created and sent for approval.",
        action="View Indent",
    ),
    _alert(
        "indent.submitted", AlertVariant.SUCCESS, "Sent for approval",
        "{number} is with {approver} and can no longer be edited.",
    ),
    _alert(
        "indent.updated", AlertVariant.SUCCESS, "Indent saved",
        "Your changes to {number} have been saved.",
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
        "stock.transfer_raised", AlertVariant.SUCCESS, "Transfer raised",
        "{number} is waiting for approval before anything moves.",
    ),
    _alert(
        "stock.transfer_advanced", AlertVariant.SUCCESS, "Transfer updated",
        "{number} is now {status}.",
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
        # The stock IS in the bin — this is not a failure and nothing was refused. It
        # is sticky because it is the only record the storekeeper sees of a shelf that
        # is now past what it is rated for, and a message that vanishes after three
        # seconds is a message nobody read.
        #
        # `{reason}` is the sentence the server already wrote for the gate that failed
        # (`warehouse/capacity.py`), because a putaway can breach the cube, the payload,
        # the unit limit or the doorway, and "over capacity" without saying WHICH is
        # advice nobody can act on. Naming the gate here would mean writing the four
        # sentences a second time and letting them drift.
        "putaway.over_capacity", AlertVariant.WARNING,
        "Stored, but {bin} is past what it is rated for",
        "{item} is in {bin}. {reason} The placement is recorded on the task either "
        "way, so restack it or raise the location's limits when you get a moment.",
        sticky=True,
    ),
    _alert(
        # Separate from over_capacity because it is a different problem with a different
        # fix: the load is not too much for the shelf, it does not physically enter it.
        # More space elsewhere in the bin does not help, so "restack it" would be wrong
        # advice — the pallet has to go somewhere else, or be broken down.
        "putaway.wont_fit", AlertVariant.WARNING,
        "Stored, but it does not fit {bin}",
        "{item} is recorded in {bin}. {reason} Move it to a location that takes this "
        "pack, or break the load down — the placement stands until you do.",
        sticky=True,
    ),
    _alert(
        "dispatch.gated_out", AlertVariant.SUCCESS, "Dispatch gated out",
        "{number} has left the site.",
        action="Track Dispatch",
    ),
    # The Dispatch screen raised this code with no entry behind it, which renders as
    # an empty green box: `pushAlert` falls back to "" for a title and message it
    # cannot find.
    _alert(
        "dispatch.decided", AlertVariant.SUCCESS, "Decision recorded",
        "Your decision on {number} is in the shared approval history.",
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
        "po.submitted", AlertVariant.SUCCESS, "Sent for approval",
        "{number} is with its approver. Nothing reaches the vendor until it is signed.",
    ),
    _alert(
        "po.approved", AlertVariant.SUCCESS, "Purchase order approved",
        "{number} is ready to send.",
    ),
    _alert(
        "po.sent_to_vendor", AlertVariant.SUCCESS, "Sent to vendor",
        "{number} has gone to {vendor}. Goods can now be received against it.",
    ),
    _alert(
        "po.rejected", AlertVariant.SUCCESS, "Purchase order rejected",
        "{number} has gone back to procurement.",
    ),
    _alert(
        "allocation.saved", AlertVariant.SUCCESS, "Allocation sent for approval",
        "What you have given is recorded. Nothing is reserved until it is approved.",
    ),
    _alert(
        "allocation.approved", AlertVariant.SUCCESS, "Allocation approved",
        "The allocated stock is now reserved against the indent.",
    ),
    _alert(
        "allocation.rejected", AlertVariant.SUCCESS, "Allocation rejected",
        "It goes back to the store to be allocated again. Nothing was reserved.",
    ),
    _alert(
        "material_request.approved", AlertVariant.SUCCESS, "Request approved",
        "{number} is cleared for purchase. Raise a requisition from it to start "
        "buying.",
    ),
    _alert(
        "material_request.rejected", AlertVariant.SUCCESS, "Request rejected",
        "{number} has been refused and nothing was reserved.",
    ),
    # Four entries the frontend mirror already carried and this catalog did not, so
    # `/api/alerts/catalog` overlaid nothing for them and only the bundled copy showed.
    _alert(
        "receipt.posted_direct", AlertVariant.SUCCESS, "Goods received",
        "{number} needed no inspection, so the stock is in and the receipt is closed.",
    ),
    _alert(
        "receipt.ready_for_putaway", AlertVariant.SUCCESS, "Ready for put-away",
        "{number} needed no inspection. Put the goods away to bring the stock in.",
    ),
    _alert(
        "issue.forwarded", AlertVariant.SUCCESS, "Forwarded to the points below",
        "{number}. Review and submit each one from Material Issues.",
    ),
    _alert(
        "issue.forwarded_none", AlertVariant.INFO, "Nothing to forward",
        "Every indent on this GRN already has an issue at this point.",
    ),
    _alert(
        "material_request.requisition_raised", AlertVariant.SUCCESS,
        "Requisition raised",
        "{number} carries what is still owed on this request. Submit it for approval "
        "and it goes out for quotation.",
    ),
    _alert(
        "material_request.revised", AlertVariant.SUCCESS, "Quantities saved",
        "{number} now asks for the amounts you entered. Approve it to send them to "
        "procurement.",
    ),
    _alert(
        "stock.audit.saved", AlertVariant.SUCCESS, "Stock audit saved",
        "{number} is {status}.",
    ),
    # SCM_0119 (2026-10-31): a stock audit's submit always says how it ended — saved
    # and waiting, saved with nothing short, not ready, or not saved and why.
    _alert(
        "stock.audit.submitted", AlertVariant.SUCCESS, "Stock audit submitted",
        "{number} is saved and waiting for approval. {qty} will be written off once "
        "it is approved.",
    ),
    _alert(
        "stock.audit.recorded", AlertVariant.SUCCESS, "Stock audit recorded",
        "{number} is saved. Every line matched the system, so nothing was written off.",
    ),
    _alert(
        "stock.audit.incomplete", AlertVariant.WARNING, "Stock audit not ready",
        "{reason}",
    ),
    _alert(
        "stock.audit.failed", AlertVariant.ERROR, "Stock audit not saved",
        "{reason} Nothing was saved — correct it and submit again.",
    ),
    _alert(
        "adjustment.action_failed", AlertVariant.ERROR, "Not done",
        "{number} was not {action}: {reason}",
    ),
    _alert(
        "adjustment.approved", AlertVariant.SUCCESS, "Adjustment approved",
        "{item} now reads {qty}.",
    ),
    _alert(
        "adjustment.rejected", AlertVariant.SUCCESS, "Adjustment rejected",
        "The counted quantity was not written to the ledger.",
    ),
    _alert(
        "master.deactivated", AlertVariant.SUCCESS, "Deactivated",
        "{name} no longer appears on new documents.",
    ),
    _alert(
        "receipt.submitted", AlertVariant.SUCCESS, "Sent for inspection",
        "{number} is with quality and cannot be edited until they are done.",
    ),
    _alert(
        "receipt.saved", AlertVariant.SUCCESS, "Receipt saved",
        "{number} has been saved as a draft. Nothing is in stock yet.",
    ),
    _alert(
        "receipt.po_nothing_pending", AlertVariant.INFO, "Nothing left on this order",
        "Every line has already been received. Add lines by hand if something arrived "
        "that the order does not cover.",
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
