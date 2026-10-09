# Change: allocation is a human decision, not an automatic step

**Date:** 2026-07-26
**Status:** IMPLEMENTED 2026-07-26
**Amends:** `2026-07-26-indent-inventory-design.md` §5 (the fork)

Built: `inv_allocations` + `inv_allocation_items`, `modules/inventory/allocations.py`
(propose / create / act / apply_to_stock), `DocType.ALLOCATION` on the workflow engine,
five endpoints under `/api/allocations` (served from the indents router, since an
allocation is a decision about an indent and inventory must not import indents), and
the `/inventory/allocate/:indentId` screen. Approval now sets `AWAITING_ALLOCATION`
and reserves nothing.

Still open from this document: the **per-item** allocation screen (§4, "60 bags, four
projects, split it"). Only the per-indent screen exists.

---

## 1. What is wrong today

The delivered code auto-allocates. The instant an indent clears approval, the system
reserves everything available and raises an MR for the rest. Nobody is consulted.

That is not how the business works. Balu, 2026-07-26:

> "the inventory manager or the position tagged to inventory ... decides how much to
> send, because if there is a need for the same items in other projects, he might send
> all first to them or any no. of amount to both ... there is never a rule that if 50
> requested, all will agree and approve 50 and move in a simple line and logic, if it
> moves like that, no need of building this ERP SCM software"

Sixty bags of cement on hand and four projects wanting it is a **judgement call**:
who gets what, from which warehouse, and what waits. Automatic first-come allocation
turns the system into a queue. The same judgement recurs at the warehouse and again at
each LIP/MDP hop (flow doc §4, STO/SMO).

## 2. The rule

**The system proposes. A person disposes.**

Approval no longer reserves anything. It puts the indent in front of somebody who
decides, line by line, how much to give and from where.

FEFO survives, with a narrower job: once a person picks a warehouse and a quantity,
FEFO chooses **which batch**. It never chooses **how much**.

## 3. New flow

```
indent approved
  → status AWAITING_ALLOCATION. Nothing reserved. No MR.
  → lands in the Fulfilment Queue
  → inventory executive / supervisor opens it and sees, per line:
        requested 100
        on hand    60   (WH-MAIN 40, LIP-7 20)
        other open demand for this item: 3 indents, 150 total
    and enters decisions:  40 from WH-MAIN
  → submits the allocation  (doc type ALLOCATION)
  → workflow engine: approved by the inventory manager if configured
  → ON APPROVAL ONLY: 40 reserved (FEFO within WH-MAIN), MR raised for the other 60
```

Valid decisions include giving zero, giving more than one warehouse's worth by
splitting across warehouses, and giving nothing now and revisiting tomorrow.

## 4. Answers to the two open questions

**Does the allocator's decision need approval?** Not hardcoded. Flow doc §2 gives
Inventory a Manager, Supervisors and Executives, so a hierarchy exists but its shape
varies by site. `ALLOCATION` becomes a document type on the existing workflow engine,
so each site configures it:

- one stage → the manager's word is final
- two stages → executive proposes, manager approves
- a stage condition → only allocations above a threshold reach the manager

No code change to switch between these. If nobody configures it, the fallback ladder
in `platform/workflow/fallback.py` already covers it.

**One indent at a time, or many at once?** Both, over one service. The service takes a
list of `(indent_item_id, warehouse_id, quantity)` decisions; the two screens are just
different ways of building that list.

| Screen | Purpose | Build order |
|---|---|---|
| Per-indent | "Deal with this one request" | first — simpler, and it lays the plumbing |
| Per-item | "60 bags, 4 projects want it, split it" | second — this is the real decision |

## 5. Code changes

Everything already built is kept. `allocation.reserve/release/consume`, FEFO,
`inv_material_requests` and the fallback all stay — they simply get called by a human
decision instead of automatically.

| File | Change |
|---|---|
| `modules/inventory/service.py` | Split `allocate_for_indent()` into `propose_allocation(indent_id)` (read-only: demand, availability per warehouse, competing demand) and `confirm_allocation(decisions, user)` (writes reservations + MR) |
| `modules/indents/service.py` | `_fulfil()` no longer reserves. Sets `AWAITING_ALLOCATION` and fires the rule so routing still records where it should go |
| `shared/enums.py` | `IndentStatus.AWAITING_ALLOCATION`; `DocType.ALLOCATION` |
| new table `inv_allocations` + `inv_allocation_items` | The decision as a document, so it can be approved, audited and reversed. Without it there is no record of who chose to give 40 rather than 60 |
| `modules/inventory/router.py` | `GET /api/allocations/proposal/{indent_id}`, `POST /api/allocations`, approve/reject |
| Fulfilment Queue screen | From a read-only list to an editable form |
| new per-item screen | Item-centric allocation across all open demand |

## 6. Tests to write

1. Approving an indent reserves **nothing** and raises **no** MR.
2. A confirmed allocation of 40 against a request for 100 reserves exactly 40 and
   raises an MR for exactly 60.
3. An allocation of zero is valid: no reservation, MR for the full 100.
4. Splitting one line across two warehouses reserves from both.
5. A rejected allocation reserves nothing.
6. Two allocators cannot both commit the same 60 bags — the second sees 20 left.
7. Where the workflow is configured with a manager stage, reservations appear only
   after the manager approves, not when the executive submits.

## 7. Note for whoever picks this up

The existing tests in `app/modules/inventory/tests/test_material_requests.py` assert
the automatic behaviour. They are not wrong — they were right for the old
requirement — and they must be **rewritten, not deleted quietly**, with the reason in
the docstring. The same was done for `test_no_active_workflow_fails_loudly` when the
fallback requirement landed.
