# SCM ERP v1 — Tester Guide

One page. Test the full loop: **Indent → Inventory → Warehouse → Indent**.

## Before you start
Get your login, role and position from the SCM team. Use Chrome, and test the same flow once on a phone.

## 1. Log in
Sign in and check the left menu only shows the modules your role should see.

## 2. Switch position
If your name holds more than one position, use the position switcher — approvals depend on which position you are wearing.

## 3. Raise an indent
Indents → New. Add items, set required date and priority, submit. Note the indent number.

## 4. Approve the indent
Log in as the approver. Approvals → find the indent → approve. Repeat for every step in the ladder until status changes.

## 5. Allocate stock
Inventory → Fulfilment Queue. Open the approved indent, give quantities, submit for allocation approval.

## 6. Approve the allocation
Inventory → Allocation Approvals → approve. Stock should reduce and the indent status should move forward.

## 7. Warehouse
Warehouse → raise the Material Issue / Dispatch / Consignment for that indent, and take it to its final status.

## 8. Back to indent
Open the same indent again. Status, quantities and history must match everything you did above.

## What to check on every screen
Correct numbers, no blank pages, no error toast, buttons work, and the list looks right on mobile.

## Reporting a bug
Log it in the bug sheet with: screen name, document number, login used, steps, what you expected, what happened, and a screenshot.

## Do not
Do not test with someone else's login, and do not delete master data.
