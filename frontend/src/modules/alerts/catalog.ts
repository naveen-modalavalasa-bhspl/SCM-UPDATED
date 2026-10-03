import type { AlertDef, AlertVariant } from "./types";

/**
 * Local mirror of `backend/app/modules/alerts/service.py` `CATALOG`.
 *
 * The server owns the wording, but a dialog cannot wait for a network round trip
 * — a delete confirm has to be right the first time it opens, including on the
 * login screen and when the API is down. So the table ships with the bundle and
 * `AlertProvider` overlays whatever `/api/alerts/catalog` returns once it lands.
 *
 * The two copies are kept honest by `backend/app/modules/alerts/tests/
 * test_alerts.py::test_frontend_mirror_has_the_same_codes`.
 */

const AUTO_CLOSE_MS = 3000;

/** An announcement. Closes itself unless it is a failure or a warning. */
function alert(
  code: string,
  variant: AlertVariant,
  title: string,
  message: string,
  action?: string,
  sticky?: boolean,
): AlertDef {
  const selfClosing = sticky === undefined
    ? variant === "success" || variant === "info"
    : !sticky;
  return {
    code, variant, mode: "alert", title, message,
    confirm_label: action ?? null,
    cancel_label: null,
    auto_close_ms: selfClosing ? AUTO_CLOSE_MS : null,
  };
}

/** A question. Waits for an answer, never closes itself. */
function confirm(
  code: string,
  variant: AlertVariant,
  title: string,
  message: string,
  confirmLabel: string,
  cancelLabel = "Cancel",
): AlertDef {
  return {
    code, variant, mode: "confirm", title, message,
    confirm_label: confirmLabel,
    cancel_label: cancelLabel,
    auto_close_ms: null,
  };
}

const DEFINITIONS: AlertDef[] = [
  // ------------------------------------------------------------------ danger
  confirm(
    "vendor.delete", "danger", "Delete vendor?",
    "Deleting {name} also removes it from every price list it appears on. Purchase orders already raised against it are kept, but you will not be able to raise new ones.",
    "Yes, Delete",
  ),
  confirm(
    "item.delete", "danger", "Delete item?",
    "{name} has stock, ledger rows and documents pointing at its item code. Once deleted, that history can no longer be traced back to an item.",
    "Yes, Delete",
  ),
  confirm(
    "warehouse.delete", "danger", "Delete location?",
    "{name} must be empty before it can go. Any bin mapped under it is removed with it and cannot be restored.",
    "Yes, Delete",
  ),
  confirm(
    "user.delete", "danger", "Delete user?",
    "{name} loses access immediately. Documents they raised or approved keep their name, but the sign-in is gone and cannot be restored.",
    "Yes, Delete",
  ),
  confirm(
    "role.delete", "danger", "Delete role?",
    "{count} user(s) currently hold this role and will lose every permission it grants the moment it is deleted.",
    "Yes, Delete",
  ),
  confirm(
    "indent.delete", "danger", "Delete draft indent?",
    "{number} has not been submitted, so nothing downstream points at it yet. Deleting throws away every line on it and cannot be undone.",
    "Yes, Delete", "Keep Draft",
  ),
  confirm(
    "indent.cancel", "danger", "Cancel indent?",
    "{number} will be closed and any stock reserved against it released back to available. This cannot be undone.",
    "Yes, Cancel Indent", "Keep Indent",
  ),
  confirm(
    "po.cancel", "danger", "Cancel purchase order?",
    "{number} has been sent to the vendor. Cancelling stops any further receipt against it; quantities already received stay in stock.",
    "Yes, Cancel PO", "Keep PO",
  ),
  confirm(
    "grn.discard", "danger", "Discard this receipt?",
    "Nothing on this draft GRN has been posted yet. Discarding it throws away every line you have entered.",
    "Yes, Discard", "Keep Editing",
  ),
  confirm(
    "inward.cancel", "danger", "Cancel this material inward?",
    "{number} is closed and cannot be reopened. Any quality inspection or put-away task raised from it is cancelled with it.",
    "Yes, Cancel Inward", "Keep Inward",
  ),
  confirm(
    "inspection.cancel", "danger", "Cancel this quality inspection?",
    "{number} is dropped without a result. The material inward behind it goes back to awaiting inspection.",
    "Yes, Cancel Inspection", "Keep Inspection",
  ),
  confirm(
    "issue.cancel", "danger", "Cancel this material issue?",
    "{number} is closed and anything reserved against it returns to available stock. Quantities already issued are not pulled back.",
    "Yes, Cancel Issue", "Keep Issue",
  ),

  // ----------------------------------------------------------------- warning
  confirm(
    "indent.submit", "warning", "Submit for approval?",
    "{number} goes to {approver} and can no longer be edited while it is in approval.",
    "Submit",
  ),
  confirm(
    "indent.approve", "warning", "Approve this indent?",
    "Approving {number} reserves the requested stock and moves it to the next stage of the chain.",
    "Approve",
  ),
  confirm(
    "indent.reject", "warning", "Reject this indent?",
    "{number} returns to the raiser. Add a remark so they know what to change.",
    "Reject",
  ),
  confirm(
    "po.approve", "warning", "Approve this purchase order?",
    "{number} commits {amount} against the budget. It becomes ready to send to the vendor.",
    "Approve",
  ),
  confirm(
    "po.reject", "warning", "Reject this purchase order?",
    "{number} goes back to procurement and nothing is committed against the budget. Add a comment so they know what to change.",
    "Reject",
  ),
  confirm(
    "po.send_vendor", "warning", "Send to vendor?",
    "{number} is sent to {vendor} and locked for editing. Goods can only be received against a PO that has been sent.",
    "Send",
  ),
  confirm(
    "indent.return", "warning", "Return for correction?",
    "{number} goes back to {raiser} to be edited and resubmitted. The approval chain restarts from the first stage once it comes back.",
    "Return",
  ),
  confirm(
    "grn.post", "warning", "Post this receipt?",
    "Posting writes a stock ledger row and adds the accepted quantity to {location}. Ledger rows are never deleted, so corrections have to be made as an adjustment.",
    "Post Receipt",
  ),
  confirm(
    "stock.transfer", "warning", "Confirm transfer?",
    "Moving {qty} of {item} from {source} to {destination} writes two ledger rows and takes effect immediately.",
    "Transfer",
  ),
  confirm(
    "stock.adjust", "warning", "Post stock adjustment?",
    "This changes the on-hand quantity of {item} to {qty} and is recorded against your name in the ledger.",
    "Post Adjustment",
  ),
  confirm(
    "stock.audit.submit", "warning", "Submit this stock audit?",
    "{count} counted at {warehouse}; {diff} differ from system stock. Differences are posted to the ledger once the audit is approved.",
    "Submit Audit",
  ),
  confirm(
    "adjustment.approve", "warning", "Approve this adjustment?",
    "Approving writes the counted quantity for {item} into the ledger. The ledger is append-only, so a mistake has to be corrected with a second adjustment.",
    "Approve",
  ),
    // An MR reserves nothing — it exists because there was nothing on the shelf to
    // reserve. Approving releases the shortage to procurement to be bought.
  confirm(
    "material_request.approve", "warning", "Approve this material request?",
    "Approving {number} clears {lines} to be bought. It reserves no stock — this material has to be purchased before anyone can be issued it.",
    "Approve",
  ),
  confirm(
    "material_request.reject", "warning", "Reject this material request?",
    "{number} is refused and nothing will be bought against it. The shortfall it was raised for stays unfilled.",
    "Reject",
  ),
  confirm(
    "master.deactivate", "warning", "Deactivate this record?",
    "{name} stops appearing on new documents. Anything that already references it keeps working — masters are deactivated, never deleted.",
    "Deactivate",
  ),
  confirm(
    "putaway.confirm", "warning", "Confirm put-away?",
    "{qty} of {item} is stored in bin {bin} and becomes available to pick from there.",
    "Confirm",
  ),
  confirm(
    "putaway.skip", "warning", "Skip this put-away?",
    "{number} stays unallocated and the stock cannot be picked from any bin until someone puts it away.",
    "Skip",
  ),
  confirm(
    "inspection.complete", "warning", "Complete quality inspection?",
    "Accepted quantity goes forward to put-away and rejected quantity is held back for the vendor. The result cannot be edited afterwards.",
    "Complete Inspection",
  ),
  confirm(
    "dispatch.gate_out", "warning", "Gate out this dispatch?",
    "{number} is recorded as having left the site. Stock is deducted now and the dispatch can no longer be edited.",
    "Gate Out",
  ),
  confirm(
    "issue.post", "warning", "Issue material?",
    "{qty} of {item} is issued to {project} and deducted from stock now.",
    "Issue",
  ),
  confirm(
    "allocation.give_nothing", "warning", "Approve without giving anything?",
    "{free} is free on the shelf and you are giving 0 of the {requested} asked for. The request stays open and nothing is reserved — nobody is buying this, so it will come back to you unchanged.",
    "Approve anyway",
  ),
  confirm(
    "allocation.override", "warning", "Override allocation?",
    "You are allocating more than the system suggested for {item}. The override and your reason are logged against the request.",
    "Override",
  ),
  confirm(
    "vendor.deactivate", "warning", "Deactivate vendor?",
    "{name} has {count} open purchase order(s). Deactivating stops new POs; the open ones can still be received.",
    "Deactivate",
  ),
  confirm(
    "bulk.apply", "warning", "Apply to {count} records?",
    "This runs {action} on every selected record. There is no per-record undo.",
    "Apply",
  ),
  confirm(
    "workflow.publish", "warning", "Publish this ladder?",
    "New submissions route by the updated ladder from now on. Documents already in approval keep the chain they were frozen with.",
    "Publish",
  ),

  // -------------------------------------------------------------------- info
  // These interrupt someone who did not ask for them, so they stay to one short
  // line. A nudge that needs a paragraph is a page, not a dialog.
  alert(
    "settings.changed", "info", "Settings updated",
    "Refresh to apply your changes.",
    "Refresh",
  ),
  alert(
    "session.expiring", "info", "Session expiring",
    "Signing out in {minutes} minutes.",
    undefined, true,
  ),
  alert(
    "hcm.sync_running", "info", "Sync started",
    "Refreshing employee data now.",
  ),
  // Gate-out doubles as "send for release approval" when the consignment has not
  // been through its chain yet. Announcing the gate-out copy there told the
  // storekeeper the goods had left while they were still on the bench.
  alert(
    "dispatch.sent_for_approval", "info", "Sent for approval",
    "{number} is with {approver}. The goods stay on the bench until they sign.",
  ),

  // ----------------------------------------------------------------- success
  alert(
    "indent.created", "success", "Indent raised",
    "{number} has been created and sent for approval.",
    "View Indent",
  ),
  alert(
    "indent.submitted", "success", "Sent for approval",
    "{number} is with {approver} and can no longer be edited.",
  ),
  alert(
    "indent.updated", "success", "Indent saved",
    "Your changes to {number} have been saved.",
  ),
  alert("indent.approved", "success", "Approved", "{number} has moved to the next stage."),
  alert(
    "grn.posted", "success", "Receipt posted",
    "{number} is complete and stock has been updated.",
    "View Receipt",
  ),
  alert(
    "stock.transfer_raised", "success", "Transfer raised",
    "{number} is waiting for approval before anything moves.",
  ),
  alert(
    "stock.transfer_advanced", "success", "Transfer updated",
    "{number} is now {status}.",
  ),
  alert(
    "stock.transferred", "success", "Transfer complete",
    "{qty} of {item} is now at {destination}.",
  ),
  alert(
    "issue.posted", "success", "Material issued",
    "{number} has been issued and stock deducted.",
    "View Issue",
  ),
  alert(
    "adjustment.posted", "success", "Adjustment posted",
    "{item} now reads {qty} in stock.",
  ),
  alert(
    "putaway.completed", "success", "Put-away complete",
    "{item} is now stored in {bin}.",
  ),
  alert(
    // The stock IS in the bin — nothing was refused. Sticky because it is the only
    // record the storekeeper sees of a shelf now past what it is rated for, and a
    // message that vanishes after three seconds is a message nobody read.
    //
    // `{reason}` is the sentence the server wrote for the gate that failed: a putaway
    // can breach the cube, the payload, the unit limit or the doorway, and naming the
    // gate here would mean writing those four sentences a second time.
    "putaway.over_capacity", "warning", "Stored, but {bin} is past what it is rated for",
    "{item} is in {bin}. {reason} The placement is recorded on the task either " +
      "way, so restack it or raise the location's limits when you get a moment.",
    undefined,
    true,
  ),
  alert(
    // A different problem with a different fix: the load is not too much for the shelf,
    // it does not physically enter it. Free space elsewhere in the bin does not help.
    "putaway.wont_fit", "warning", "Stored, but it does not fit {bin}",
    "{item} is recorded in {bin}. {reason} Move it to a location that takes this " +
      "pack, or break the load down — the placement stands until you do.",
    undefined,
    true,
  ),
  alert(
    "dispatch.gated_out", "success", "Dispatch gated out",
    "{number} has left the site.",
    "Track Dispatch",
  ),
  // The Dispatch screen raised this code with no entry behind it, which renders as
  // an empty green box: `pushAlert` falls back to "" for a title and message it
  // cannot find.
  alert(
    "dispatch.decided", "success", "Decision recorded",
    "Your decision on {number} is in the shared approval history.",
  ),
  alert("master.saved", "success", "Saved", "Your changes to {name} have been saved."),

  // Routine outcomes. Each one is the *result* of something the user already
  // clicked, so it announces and gets out of the way after three seconds —
  // a confirm here would be a second click for a decision already made.
  alert("excel.exported", "success", "Export ready", "{name} has been downloaded.", "Open File"),
  alert("indent.deleted", "success", "Indent deleted", "{number} has been removed."),
  alert("indent.rejected", "success", "Indent rejected", "{number} has gone back to {raiser}."),
  alert("indent.returned", "success", "Returned for correction", "{number} is with {raiser} to edit."),
  alert(
    "po.submitted", "success", "Sent for approval",
    "{number} is with its approver. Nothing reaches the vendor until it is signed.",
  ),
  alert("po.approved", "success", "Purchase order approved", "{number} is ready to send."),
  alert(
    "po.sent_to_vendor", "success", "Sent to vendor",
    "{number} has gone to {vendor}. Goods can now be received against it.",
  ),
  alert("po.rejected", "success", "Purchase order rejected", "{number} has gone back to procurement."),
  alert(
    "allocation.saved", "success", "Allocation sent for approval",
    "What you have given is recorded. Nothing is reserved until it is approved.",
  ),
  alert(
    "allocation.approved", "success", "Allocation approved",
    "The allocated stock is now reserved against the indent.",
  ),
  alert(
    "allocation.rejected", "success", "Allocation rejected",
    "It goes back to the store to be allocated again. Nothing was reserved.",
  ),
  alert(
    "material_request.raised", "success", "Material request raised",
    "{number} is with its approver. Procurement can buy against it once it is signed.",
  ),
  alert(
    "material_request.approved", "success", "Request approved",
    "{number} is cleared for purchase. Raise a requisition from it to start buying.",
  ),
  alert(
    "material_request.rejected", "success", "Request rejected",
    "{number} has been refused and nothing will be bought against it.",
  ),
  alert(
    "material_request.requisition_raised", "success", "Requisition raised",
    "{number} carries what is still owed on this request. Submit it for approval and it goes out for quotation.",
  ),
  alert(
    "material_request.revised", "success", "Quantities saved",
    "{number} now asks for the amounts you entered. Approve it to send them to procurement.",
  ),
  alert("stock.audit.saved", "success", "Stock audit saved", "{number} is {status}."),
  alert("adjustment.approved", "success", "Adjustment approved", "{item} now reads {qty}."),
  alert(
    "adjustment.rejected", "success", "Adjustment rejected",
    "The counted quantity was not written to the ledger.",
  ),
  alert("master.deactivated", "success", "Deactivated", "{name} no longer appears on new documents."),
  alert(
    "receipt.submitted", "success", "Sent for inspection",
    "{number} is with quality and cannot be edited until they are done.",
  ),
  // A receipt only reaches QC when one of its items is flagged "requires QI". With
  // none flagged the server posts the stock there and then, and saying "sent for
  // inspection" sent storekeepers hunting for a draft on the QC screen that was
  // never going to exist. These two say what actually happened.
  alert(
    "receipt.posted_direct", "success", "Goods received",
    "{number} needed no inspection, so the stock is in and the receipt is closed.",
  ),
  alert(
    "receipt.ready_for_putaway", "success", "Ready for put-away",
    "{number} needed no inspection. Put the goods away to bring the stock in.",
  ),
  alert(
    "receipt.saved", "success", "Receipt saved",
    "{number} has been saved as a draft. Nothing is in stock yet.",
  ),
  alert(
    "receipt.po_nothing_pending", "info", "Nothing left on this order",
    "Every line has already been received. Add lines by hand if something arrived that the order does not cover.",
  ),
  alert(
    "inspection.completed", "success", "Inspection complete",
    "{number} is inspected and sent for put-away.",
  ),
  alert("issue.acknowledged", "success", "Receipt acknowledged", "{number} has been confirmed."),
  // Forwarding an arrived consignment on to the points below. The screen fired
  // "issue.created", which is not a key in here, so the toast showed a green tick and
  // no words — the storekeeper had no idea whether anything had been created.
  alert(
    "issue.forwarded", "success", "Forwarded to the points below",
    "{number}. Review and submit each one from Material Issues.",
  ),
  alert(
    "issue.forwarded_none", "info", "Nothing to forward",
    "Every indent on this GRN already has an issue at this point.",
  ),
  alert("reminder.sent", "success", "Reminder sent", "{name} has been nudged."),
  alert("delegation.created", "success", "Delegation active", "{name} approves on your behalf."),
  alert("delegation.ended", "success", "Delegation ended", "Approvals come back to you."),
  alert("user.saved", "success", "User saved", "{name} has been updated."),
  alert("role.saved", "success", "Role saved", "{name} has been updated."),
  alert("label.printed", "success", "Sent to printer", "{count} label(s) queued."),
  alert("clipboard.copied", "success", "Copied", "{name} is on your clipboard."),

  // ------------------------------------------------------------------- error
  alert(
    "request.failed", "error", "Could not save",
    "Something went wrong. Your work was not saved. Press Retry.",
    "Retry",
  ),
  alert(
    "permission.denied", "error", "Not allowed",
    "Your login cannot do this. Ask your admin to give you access. {permission}",
  ),
  alert(
    "session.expired", "error", "You have been logged out",
    "You were away too long. Log in again. Anything you did not save is lost.",
    "Sign In",
  ),
  alert(
    "network.unreachable", "error", "No internet",
    "The app cannot connect. Check your internet or Wi-Fi, then press Retry. Nothing was saved.",
    "Retry",
  ),
  alert(
    "hcm.sync_failed", "error", "Employee data not updated",
    "{entity} could not be brought in from HCM. Reason: {reason}. Press Retry.",
    "Retry",
  ),
  alert(
    "stock.insufficient", "error", "Not enough stock",
    "You asked for {qty} {item}, but only {available} are free. Lower the quantity.",
    "Adjust Quantity",
  ),
  alert(
    "document.duplicate", "error", "Already entered",
    "{number} is already saved for {vendor}. Do not enter it again.",
  ),
  alert(
    "excel.import_failed", "error", "Upload failed",
    "{count} rows in {name} have mistakes. Nothing was uploaded. Press View Errors, fix those rows, and upload again.",
    "View Errors",
  ),
  alert(
    "print.failed", "error", "Printer not responding",
    "Check the printer is on and has paper, then press Retry.",
    "Retry",
  ),
];

export const DEFAULT_CATALOG: Record<string, AlertDef> = Object.fromEntries(
  DEFINITIONS.map((item) => [item.code, item]),
);

/** Every code the catalog knows, for autocomplete at the call site. */
export type AlertCode = string;

export { AUTO_CLOSE_MS };
