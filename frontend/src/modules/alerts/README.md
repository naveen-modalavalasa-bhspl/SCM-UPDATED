# Alerts

Popup alerts and confirms. Copy lives in a catalog, not at the call site.

```ts
import { alerts } from "@/modules/alerts";

// Ask before something irreversible. Resolves true only on the primary button.
if (!(await alerts.confirm("po.cancel", { number: po.number }))) return;
await cancelPO(po.id);

// Tell the user it worked. Closes itself after 3s.
alerts.success("grn.posted", { number: grn.grn_no });

// No catalog entry? Pass the copy inline.
alerts.show({ variant: "error", title: "Print failed", message: "…" });
```

`useAlert()` returns the same object for components that prefer a hook.

## The two behaviours

| Mode | Closes itself | Used for |
| --- | --- | --- |
| `alert` | after **3 s**, when the variant is `success` or `info` | "it worked", "heads up" |
| `alert` | never, when the variant is `warning` or `error` | failures, things that must be read |
| `confirm` | never | any question |

A failure or a question that disappeared on its own would read as a success, so
only the informational tones self-close. Every default is overridable per call
(`alerts.success("…", params, { autoCloseMs: null })`).

## Placement

Split at the 768px `md:` breakpoint.

**Below 768px** — always centred over a dimmed, blurred page. There the dialog
*is* the screen.

**768px and up** — always a `max-w-sm` card pinned top-centre, never centred and
never covering the work. Only the backdrop changes, and `autoCloseMs` decides it:

| | Self-closing (`autoCloseMs` set) | Waits for an answer (`autoCloseMs: null`) |
| --- | --- | --- |
| Backdrop | clear — page stays readable | dimmed + blurred |
| Page scroll | free | locked |
| Which codes | `success`, `info` | `danger`, `warning`, `error`, every `confirm` |

A notification must not seize the page. A Delete/Cancel pair must, and the blur is
what pulls the eye onto it instead of the screen behind. Clicking the page still
dismisses an `alert` (it is `isDismissable`); a `confirm` still blocks until
answered.

## Where each code belongs

Codes are defined once in `catalog.ts` and mirrored in
`backend/app/modules/alerts/service.py` (the server's copy wins at runtime; a
backend test fails if the two lists drift).

Every code below maps to an endpoint that exists. A code with no screen behind it
is dead weight that reads as a promise the system does not keep, so it does not
get added until the action it announces is real.

### `danger` — irreversible, confirm first
| Code | What it means | Raise it from |
| --- | --- | --- |
| `vendor.delete` | vendor removed from every price list; existing POs survive | Masters › Vendors |
| `item.delete` | stock, ledger and documents lose the item their code points at | Masters › Items |
| `warehouse.delete` | location and every bin under it go, and cannot be restored | Masters › Locations |
| `user.delete` | sign-in gone; their name stays on documents they raised | RBAC › Users |
| `role.delete` | everyone holding it loses those permissions at once | RBAC › Groups |
| `indent.cancel` | indent closed, its stock reservations released | Indent detail |
| `po.cancel` | no further receipt against a PO already sent to the vendor | PO list, PO detail |
| `grn.discard` | unposted draft GRN thrown away, lines and all | Warehouse › GRN draft |
| `inward.cancel` | inward closed; its inspection and put-away tasks die with it | Warehouse › Material Inward |
| `inspection.cancel` | dropped with no result; the inward waits to be inspected again | Warehouse › Quality Inspection |
| `issue.cancel` | issue closed, reservations released; issued quantity is not clawed back | Warehouse › Material Issues |

### `warning` — moves a document or touches stock
| Code | What it means | Raise it from |
| --- | --- | --- |
| `indent.submit` | locks the indent for editing and starts the approval chain | Indent detail |
| `indent.approve` | reserves the stock and advances a stage | Approvals queue |
| `indent.reject` | sends it back to the raiser, chain over | Approvals queue |
| `indent.return` | back to the raiser to edit; chain restarts on resubmit | Approvals › Correction |
| `po.approve` | commits budget, PO becomes sendable | PO detail |
| `po.send_vendor` | PO locked and sent; receipts need a sent PO | PO detail |
| `grn.post` | writes a ledger row and adds accepted qty to stock | Warehouse › Goods receipt |
| `inspection.complete` | freezes the accept/reject split for the inward | Warehouse › Quality Inspection |
| `putaway.confirm` | stores stock in a bin and makes it pickable | Warehouse › Put-away |
| `putaway.skip` | stock stays unallocated and cannot be picked | Warehouse › Put-away |
| `issue.post` | deducts stock and hands material to a project | Warehouse › Material Issues |
| `dispatch.gate_out` | goods leave the site; stock deducted, doc frozen | Warehouse › Dispatch |
| `stock.transfer` | two ledger rows, effective immediately | Inventory › Transfers |
| `stock.adjust` | changes on-hand qty, logged against your name | Inventory › Adjustments |
| `adjustment.approve` | writes the adjustment to the append-only ledger | Inventory › Adjustments |
| `material_request.approve` | clears the shortage for purchase; reserves nothing | Inventory › Material Requests |
| `allocation.override` | allocating past the suggestion; logged with your reason | Inventory › Allocation Approvals |
| `vendor.deactivate` | no new POs; open ones still receivable | Masters › Vendors |
| `bulk.apply` | runs an action on every selected row, no per-row undo | any multi-select toolbar |
| `workflow.publish` | new submissions route by the new ladder; in-flight ones keep theirs | Settings › Approvals config |

### `info` — one short line, self-closing
| Code | What it means |
| --- | --- |
| `settings.changed` | refresh needed for the change to show |
| `session.expiring` | signing out shortly (sticky — useless if it vanishes) |
| `hcm.sync_running` | employee/position refresh started in the background |

### `success` — self-closing confirmations
| Code | What it means |
| --- | --- |
| `indent.created` / `indent.approved` | indent raised / moved a stage |
| `grn.posted` | receipt complete, stock updated |
| `stock.transferred` | quantity has landed at the destination |
| `adjustment.posted` / `adjustment.approved` | on-hand quantity now reads the new figure |
| `putaway.completed` | item is in its bin |
| `issue.posted` / `issue.acknowledged` | material issued / receipt confirmed by the site |
| `dispatch.gated_out` | dispatch has left the site |
| `indent.deleted` / `indent.rejected` / `indent.returned` | indent removed / sent back / with the raiser to edit |
| `po.approved` | PO cleared and ready to send |
| `material_request.approved` | request approved, cleared for purchase |
| `inspection.completed` | inspected and passed to put-away |
| `reminder.sent` | an approver has been nudged |
| `delegation.created` / `delegation.ended` | someone else approves for you / it is back with you |
| `user.saved` / `role.saved` / `master.saved` | a record's edit landed |
| `excel.exported` | the spreadsheet has downloaded |
| `label.printed` | labels queued at the printer |
| `clipboard.copied` | value copied |

### `error` — stay until dismissed
| Code | What it means |
| --- | --- |
| `request.failed` | server error, nothing saved |
| `network.unreachable` | no connection, nothing saved |
| `permission.denied` | a 403 — your role lacks that permission code |
| `session.expired` | a 401 — token gone, sign in again |
| `hcm.sync_failed` | an HCM entity could not sync, with the reason |
| `stock.insufficient` | requested more than is available |
| `document.duplicate` | that number is already recorded |
| `excel.import_failed` | the uploaded sheet could not be read; nothing imported |
| `print.failed` | label printer did not respond |

## Confirm, or just announce?

Ask only when the answer can still change something. Once the user has clicked
Approve, a "are you sure you approved?" box is a second click for a decision
already made — announce it with a self-closing `success` instead.

- **`confirm`** — deleting, cancelling, anything that moves stock or a document
  past a point it cannot come back from: `indent.cancel`, `item.delete`,
  `grn.post`, `dispatch.gate_out`.
- **`success`, self-closing** — the outcome of a click that already happened:
  `indent.deleted`, `po.approved`, `excel.exported`, `clipboard.copied`.

## When not to use one

- Field-level validation → the field's own error, not a dialog.
- "Saved", "Copied", and other low-stakes confirmations on a busy screen →
  `useToast()` / `useAction()` in `@/shared/components`. A modal steals focus;
  reach for it when the user must read or answer something.
- A failure with somewhere to pin it → `<ErrorBanner>` next to the form.

## Where the wording of a FAILURE comes from

This catalog is for events the app announces on purpose. What a *failed request*
says is not in here — it is decided once, from the response, by
`describeError()` in `shared/api/errors.ts`:

- The server's own reason wins. `{"error": "Only the requester can edit this
  indent"}` is shown word for word; a status code can never say that much.
- Nothing technical is ever shown. SQL, tracebacks, driver codes and axios
  internals are dropped and replaced by the status default. They are already in
  `sys_app_logs`.
- Level follows what the person can do about it. `warning` when they can fix it
  from this screen (a missing field, a duplicate); `error` when they cannot (no
  permission, session gone, server down).

The shared axios interceptor rewrites `error.message` with that sentence, so a
screen rendering `(error as Error).message` gets it without knowing any of this.
`<ErrorBanner>` and `useToast().fromError()` read the structured form, which also
carries `title`, `field` and the backend's `error_code`.

Only two failures raise a DIALOG, both from `apiAlerts.ts` and both because they
belong to no screen: `network.unreachable` and `session.expired`. Everything else
is shown by the screen that asked for it — and `useAction` checks before adding a
toast, so a failure already pinned to an `<ErrorBanner>` is not also announced.

## Files

| File | What it is |
| --- | --- |
| `catalog.ts` | every code, its copy and its behaviour |
| `store.ts` | the queue, outside React, so non-component code can raise a dialog |
| `alerts.ts` | the call-site API |
| `components/AlertDialog.tsx` | the card |
| `components/AlertHost.tsx` | renders the front of the queue |
| `AlertProvider.tsx` | mounts the host, pulls the server catalog (once, in `App.tsx`) |
