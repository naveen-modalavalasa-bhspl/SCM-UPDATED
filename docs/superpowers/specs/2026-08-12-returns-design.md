# Returns — the two flows, and how to build them

**Date:** 2026-08-12 · **Status:** plan, nothing built
**Sources:** the business owner's walkthrough of both flows + `SCM_Purchase_Roles_Workflow_Updated.docx`
**Rules kept:** no new tables, no schema change, code only inside `modules/returns`.
Anything outside that is listed in §9 for somebody else.

---

## 0. Two different documents

| | **Field return** | **Purchase return** |
|---|---|---|
| Stock comes off | a branch shelf (LIP) | a warehouse |
| Goes to | our own network — MDP, LIP, or written off | the vendor who supplied it |
| Triggered by | a person at the branch | QC rejecting a GRN line, or an over-receipt |
| Ends with | stock on another shelf, or nothing moving | a credit note, or a replacement arriving |
| Stored in | `inv_sto` + marker (working) | `pro_returns` (built, no screen) |

### ⚠ Two blockers, up front

**1. The nine logins in your roles doc do not exist in the system.** HCM carries seven
roles — SPH, Regional Manager, District Manager, OE, Driver, DEO, Store Keeper. No SCM
Head, QC Team, Floor In-charge, Indent Team, Logistics, CPO, Director or Accounts.
Approval ladders are built from roles, so the flows below are correct as a **design** but
**cannot be configured** until those roles exist and people are mapped. Question 11.

**2. `modules/returns/service.py` will not run right now.** A half-finished edit left it
calling a `_hand_to_decision` that was never written, and `journey()` still uses the old
six-leg phase list. Nothing is committed. Revert or finish — your call.

---

## 1. Who does what in a return

Fifteen users. Every screen belongs to a **team**, not a person — `ANY_ONE` of the team
acts, which the receiving ladder already supports.

**SCM / Warehouse — 9 users**

| Login | Users | Their part in a return |
|---|---|---|
| **SCM Head** | 1 | **Decides the return.** He already holds inward/outward movement authority and "resolves escalations raised by any team" — so objections land on him too |
| **Indent Team** | 2 | Validates a field return before the ladder. **Gives the closing acknowledgement** |
| **Floor In-charge** | 3 | Receives and stages returned material. Raises the purchase return off the rejected GRN |
| **QC Team** | 2 | **The trigger** — QC's rejection starts a purchase return. Also checks a return on the way out |
| **Logistics** | 1 | Packs and dispatches whatever travels |

**Purchase — 6 users**

| Login | Users | Their part in a return |
|---|---|---|
| **PO Creation Team** | 3 | **Talks to the vendor.** Records accept/decline and the promised replacement date. Raises the supplementary PO for kept overflow |
| **CPO** | 1 | Owns the commercial terms a return is judged against |
| **Director** | 1 | Approves the supplementary PO for kept overflow |
| **Accounts** | 1 | **Records the credit note.** Pays for kept overflow |

**Three things this changed in my earlier plan:** the decision authority is the **SCM
Head**, not an "inventory manager"; **outward QC** is a real leg I had missed
(`inb_inspections.inspection_type` already exists for it); and the **vendor conversation
belongs to Purchase, the credit note to Accounts** — so a purchase return hands off
between departments twice.

---

## 2. Field return flow

The indent flow run backwards, with the same people in it — so nobody learns a second
process.

| Indent | Field return |
|---|---|
| Field Authority raises | Field Authority raises |
| Indent Team validates | Indent Team validates |
| SCM Head approves | SCM Head **decides where it goes** |
| Floor In-charge stages it | Floor In-charge **receives and stages it** |
| Logistics dispatches | Logistics collects and dispatches |
| Indenter acknowledges | Indent Team acknowledges it closed |

```
  FIELD AUTHORITY  (site / branch — LT, store keeper)
        |
   [1] RAISE
        |  item + qty, from what they actually hold
        |  reason   (damaged / expired / surplus / wrong item / recall ...)
        |  intent   (replacement wanted, or plain return)
        |  photo of the stock  --  MANDATORY
        v
   [2] SUBMIT  ---->  stock RESERVED at the branch
        |             they cannot issue away what they promised to send back
        v
   [3] INDENT TEAM VALIDATES
        |  is the reason right, is the quantity right, is this stock even ours
        |
        +---- SENT BACK ---> raiser corrects it and resubmits
        |
        v
   [4] APPROVAL LADDER (the raiser's own reporting line)
        |  Settings > Approvals Config. Climbs parent positions.
        |  Live HCM today: OE -> DM -> RM -> SPH, whichever rungs are switched on
        |
        +---- REJECTED ---> CLOSED.  Hold released. Branch keeps the stock
        |
        v
   [5] SCM HEAD DECIDES            <-- the leg that does not exist today
        |
        |  He sees: photo, item, qty, batch, expiry, reason, branch, stock value,
        |           which nearby points are short of this item, hazard flags
        |
        |  He picks ONE of six:
        |
        |    a. SEND TO A POINT ....... nearest MDP, or a LIP that needs it
        |    b. SEND TO THE VENDOR .... vendor is liable (warranty / recall)
        |    c. USE AT THE BRANCH ..... fit for use, branch can consume it
        |    d. SCRAP AT THE BRANCH ... beyond use, nothing hazardous
        |    e. CONTROLLED DISPOSAL ... hazardous / cold-chain / regulated
        |    f. REFUSE THE RETURN ..... worth less than the freight
        |
        |  He must type a reason. The floor is about to read it.
        v
   [6] FLOOR IN-CHARGE  --  agrees the decision is workable
        |
        +---- OBJECTS (with a reason) ---> escalates back to [5] SCM Head
        |                                  for a fresh decision
        v  ACCEPTS
        |
   [7] CARRY IT OUT
        |
        |  a  ->  stock OUT at branch, IN at the destination point
        |  b  ->  stock OUT only, leaves our books
        |  c  ->  nothing moves, hold released, document closed
        |  d  ->  stock OUT to scrap
        |  e  ->  stock OUT, disposal certificate required before close
        |  f  ->  nothing moves, hold released, branch told why
        v
   [8] QC TEAM  --  outward check      (only for a, b, d, e)
        |             confirms what leaves matches what the document says
        v
   [9] LOGISTICS  --  pack + dispatch
        |             finalise the transport vendor, pack, gate pass out,
        |             transit events, POD
        v
  [10] INDENT TEAM ACKNOWLEDGES  ->  CLOSED
```

**Two exits before anything moves, and that is the point.** Today every approved return
moves stock. Options (c) and (f) mean nothing moves and no freight is spent — the business
makes that call constantly and the system has no way to say it.

---

## 3. Purchase return flow

Crosses departments twice: Warehouse raises it, Purchase talks to the vendor, Accounts
closes the money.

```
   FLOOR IN-CHARGE enters the GRN against a PO
        |
        v
  [1] QUANTITY CHECK — received vs ordered              (system, automatic)
        |
   +----+---------------------+---------------------+
   |                          |                     |
UNDERFLOW                   MATCH                OVERFLOW
(received < ordered)                          (received > ordered)
   |                          |                     |
short_qty already             |            SCM HEAD DECIDES
recorded on the line          |                     |
No return raised.             |            +--------+--------+
Floor In-charge tells         |            |                 |
SCM Head, who chases          |         KEEP IT         SEND IT BACK
Purchase for the balance      |            |                 |
   |                          |     PO CREATION TEAM         |
   |                          |     raises supplementary PO  |
   |                          |            |                 |
   |                          |     DIRECTOR approves        |
   |                          |            |                 |
   |                          |     ACCOUNTS pays            |
   |                          |            |                 |
   +--------------------------+------------+                 |
                              |                              |
                              v                              |
                     [2] QC TEAM — inward check              |
                              |                              |
                   +----------+----------+                   |
                   |                     |                   |
                PASSED                REJECTED               |
                   |            QC reports the discrepancy   |
        [3] FLOOR IN-CHARGE     +-------+-------------------+
            puts it away        |
                   |            v
       normally no returns  [4] RETURN DRAFT CREATED AUTOMATICALLY
       after this point         |
                   |            |  one draft per GRN per vendor
       only if the PO's         |  pre-filled from the GRN line:
       warranty window          |    item, code, uom
       is still open            |    rejected qty   <-- EDITABLE
                   |            |    rate, amount
                   +--------->  |    batch no, mfg date, expiry date
                                |    serial numbers, IMEI numbers
                                |    invoice no + date
                                |    rejection reason from QC
                                |    po_id, grn_id, vendor_id
                                |    its own RET-PUR-... number
                                v
                    [5] FLOOR IN-CHARGE EDITS THE DRAFT
                                |
                                |  correct the quantity, drop a line,
                                |  add remarks, attach photos of the defect
                                |
                                |  pick the RETURN TYPE:
                                |    REPLACEMENT — same cost, vendor sends it back
                                |    CREDIT NOTE — money back, no replacement
                                v
                    [6] SUBMIT -> SCM HEAD AUTHORISES
                                |    outward movement is his authority
                                |
                                +---- REJECTED ---> CLOSED, stock stays rejected
                                |
                                v
                    [7] PO CREATION TEAM TAKES IT TO THE VENDOR
                                |    they own the vendor relationship
                                |
                  +-------------+-------------+
                  |                           |
           VENDOR ACCEPTS              VENDOR DECLINES
                  |                           |
     PO Team records:                  CPO reviews against the
       authorisation ref                commercial terms
       vehicle + driver coming          |
       pickup date                      +--- pursue it
       expected replacement date        +--- or absorb the loss
                  |                           |
                  v                           v
        [8] QC TEAM — outward check       CLOSED — disputed
                  |    confirms what leaves matches the document
                  v
        [9] LOGISTICS — gate pass out
                  |    vendor's vehicle, our gate pass
                  |    stock leaves our books
                  v
       [10] SETTLEMENT — the loop nobody watches today
                  |
     +------------+------------+
     |                         |
REPLACEMENT              CREDIT NOTE
     |                         |
PO Team watches the      ACCOUNTS records the
promised date            credit note number
     |                         |
arrives as a NEW GRN     matched against the
linked back to this       return value
return  -> back to [1]    (3-way match warning)
     |                         |
     +------------+------------+
                  |
                  v
               CLOSED
```

---

## 4. What exists, what's missing

**Already in the database.** Every field at step [4] is already on `inb_receipt_items`:
`ordered_qty`, `received_qty`, `accepted_qty`, `rejected_qty`, `short_qty`, `rate`,
`amount`, `batch_no`, `mfg_date`, `expiry_date`, `qc_status`, `rejection_reason`,
`serial_numbers`, `imei_numbers` — plus `invoice_no/date/amount`, `vendor_id`, `po_id`,
`vehicle_no`, `transporter_name`, `lr_no`, `eway_bill_no` on the header.

So nothing new is needed to say **what** goes back. Every gap is **why**, **what kind**,
and **what the vendor said**.

| Missing | Detail |
|---|---|
| Auto-draft on QC reject | `returnable_lines()` lists rejected lines, but a human must open a screen and type the return |
| **Overflow is invisible** | The GRN computes `short_qty = ordered − received`. **Excess is computed nowhere.** Receive 120 against an order of 100 and the extra 20 posts to stock silently |
| Overflow cannot be returned | The return cap is `rejected_qty`. Excess is not "rejected", so the system refuses it |
| Return type | No field says replacement vs credit note |
| Expected replacement date | Nowhere to record what the vendor promised |
| Vendor acknowledgement | No accept / decline exists |
| Vendor's vehicle + follow-up | `out_dispatches` has every field, but a purchase return never creates a dispatch |
| PO terms | **`pro_purchase_orders` has zero terms columns** — so "governed by the PO terms" has nothing to be governed by |

---

## 5. PO terms and conditions

What a real SCM ERP carries, and what a return is judged against. All absent today.

- **Quantity** — over-delivery tolerance %, under-delivery tolerance %, part delivery
  allowed, default excess handling (return or supplementary PO)
- **Quality & time** — return window (days from GRN), minimum shelf life on arrival,
  warranty period, replacement lead time, vendor acknowledgement SLA
- **Money & logistics** — return freight borne by *(your "vendor sends the vehicle" rule is
  this field)*, re-inspection cost borne by, default settlement, late-replacement penalty %,
  returnable packaging

They belong **on the PO, defaulted from the vendor master**. `mst_vendors` already carries
`payment_terms_days`, `credit_limit`, `rating` — the habit exists, the return terms are
simply absent. **Procurement's change, not mine.**

---

## 6. What real ERPs do

| Practice | Us? |
|---|---|
| **Reason-code routing** — the reason carries a default disposition, the desk confirms rather than invents | **Adopt. Highest value for least work.** Expired → disposal, wrong item → back to the issuer, surplus → send up. Always overridable |
| **Vendor RMA / authorisation number** — nothing physically moves until the vendor gives one | **Adopt — this is your "vendor must acknowledge".** Gate pass blocked until recorded |
| **Reverse GRN** — the return posts against the original GRN so one PO has one history | Adopt the idea: keep `grn_id`/`po_id` links mandatory |
| **Quarantine before return** — rejected stock sits blocked, never in free stock | Adopt. `BatchStatus.QUARANTINED` exists |
| **Serialised return** — return by scanning serials, not typing a quantity | Adopt where serials exist |
| **Disposal certificate** for hazardous material | Adopt. Attachment mandatory before close |
| **3-way match on the credit note** — return qty × rate vs note amount | Adopt as a **warning**, not a block |
| **Aged-return escalation** | Adopt in the dashboard; auto-escalation later |
| **Tolerance auto-accept**, **return window enforcement** | Need PO terms. Phase 5 |
| **Value-threshold auto-scrap** | Needs costed stock. Every valuation column is zero today |
| **Subsequent debit** (keep the overflow, pay for it) | I can record the decision; raising the PO is Purchase's |
| **Restocking fee** | Record only — a number on the vendor's answer |
| **Debit note** for penalties, **returnable packaging** | Park it |
| **Automatic financial postings** | **Do not copy.** No ledger to post to. Accounts reconciles by hand |

### The one idea worth taking whole: two status clocks

The physical leg and the money leg run at different speeds. Stock can be gone while the
credit note is six weeks out.

```
   physical:    DRAFT -> AUTHORISED -> AT VENDOR -> GONE
   settlement:  NONE  -> EXPECTED -> PART -> SETTLED -> WRITTEN OFF
```

A return reading `GONE / EXPECTED` is the row somebody must chase. One status column today,
so nobody chases anything. Two more department ideas worth copying: **one document, many
owners** (it changes hands, it is not re-keyed per department), and **ageing measured per
desk, not per document** — `wf_actions.acted_at` already holds the data, nothing computes it.

---

## 7. The base to build on

| Option | Verdict |
|---|---|
| **(a)** Everything in `inv_sto` + marker | **No.** No PO, GRN, rate, invoice or credit-note columns — a vendor return loses its link to the purchase order |
| **(b)** Everything in `pro_returns` | **No.** One `warehouse_id`, no from/to pair — a branch → MDP transfer cannot be expressed |
| **(c)** One spine, two backends | **RECOMMENDED** |
| **(d)** Proper `ret_*` tables | The target if the schema ever opens. (c) does not block it |

**(c) in one line:** one shared model in the returns module —

```
   RETURN = kind + reason + intent + decision + movement + settlement
```

— driving every screen, queue and register. Only the storage differs: field returns in
`inv_sto` + marker (already working), purchase returns in `pro_returns` through warehouse's
own endpoints. Zero schema change, nobody else's code edited, one mental model.

**Honest cost:** a purchase return needs a small control record of ours for what
`pro_returns` has no column for — return type, vendor authorisation, expected replacement
date. It goes in `inv_sto` behind the marker with `kind = PURCHASE`, linked both ways. Two
rows for one event. That seam is the price of not touching the schema.

---

## 8. Screens

**Good news:** `return.view`, `return.create`, `return.approve` already exist in
`permissions.py`. Only Accounts needs a new code.
**Bad news:** none of the nine logins exists as a role, so nothing can be granted yet.

| Screen | Team | New? | What's on it |
|---|---|---|---|
| Raise a return | Field Authority | extend | Item + qty from what they hold, reason, **intent**, mandatory photo |
| Validate | Indent Team | **new** | Check reason, quantity, ownership. Send back or pass on |
| **Decision desk** | **SCM Head** | **new** | The heart. Photo, qty, reason, value, batch, expiry, candidate destinations, hazard flags. Six buttons, reason-code default pre-selected, Scrap greyed out on hazardous, justification mandatory |
| Floor acceptance | Floor In-charge | **new** | Shows the decision + its reason. Accept, or object with a reason that escalates back |
| GRN mismatch queue | Floor In-charge → SCM Head | **new** | Every GRN where received ≠ ordered. Excess / short and the value of the difference. Keep-and-pay, or return the extra |
| QC rejection queue | QC flags, Floor edits | **new** | Every rejected line with no return yet, plus the auto-created drafts |
| Purchase return detail | Floor In-charge | **new** | Lines with serial, IMEI, batch, mfg, expiry, rate, invoice ref. Quantity editable while draft. Return type |
| Vendor answer panel | **PO Creation Team** | **new** | Accept/decline, authorisation ref, vehicle + driver, pickup date, expected replacement date, restocking fee. Typed in by us — **no vendor portal** |
| Credit note | **Accounts** | **new** | Note number, amount, 3-way match warning |
| Outward QC | QC Team | **new** | Confirms what leaves matches the document |
| Pack + dispatch | Logistics | reuse | Warehouse's existing dispatch screens |
| Open loops tracker | PO Team + SCM Head | **new** | Replacements promised but not arrived; credit notes expected but not received. Days overdue |
| Returns register | everyone, scoped | **new** | Both families in one table: item, qty, from, to, date, reason, kind, decision, value, status. Filters + Excel/CSV |
| Return detail | all | extend | Journey tracker, decision panel, trail, attachments, value |
| Overview | all | retune | Awaiting decision, awaiting sign-off, written off, refused as uneconomic, oldest waiting, top reasons, top branches |

---

## 9. Implementation phases

Each ships on its own.

| Phase | What | Where |
|---|---|---|
| **0 — Make the roles real** | The nine logins as RBAC roles with permission sets, people mapped to each. **Blocks configuration of everything below** (design is not blocked — flows run on the HCM reporting line until then) | Not my module |
| **1 — Field return decision layer** | Kind + intent on the raise form, Indent Team validation, **settlement status from day one**, value shown as **“—” when not costed** (₹0 would be a lie), decision desk with all six outcomes + reason-code defaults + hazard guard, floor acceptance/objection, register, dashboard. *Half-built, ~40% done* | Returns only |
| **2 — See the purchase-return problem** | GRN mismatch queue + QC rejection queue. **Read-only.** Day one it shows every over-receipt in the system, which nobody can see today | Returns only |
| **3 — Act on purchase returns** | Auto-draft on QC reject, edit the draft, pick return type, submit, record the vendor's answer, push the movement through `/api/warehouse/returns/…` | Returns, calling warehouse |
| **4 — Close the loops** | Replacement tracker, credit-note tracker + 3-way match, pack/gate-pass/dispatch, aged escalation | Returns, calling warehouse |
| **5 — Needs outside decisions** | PO terms on the PO, tolerance auto-accept, supplementary PO for kept overflow, per-item hazardous flag, value-threshold auto-scrap | Procurement + masters |

---

## 10. Outside the returns module

| Change | Why |
|---|---|
| **The nine roles** as RBAC roles with permissions, employees mapped | **Blocks everything.** Phase 0 |
| **Fix a live bug:** `warehouse/service.py` `create_dispatch()` calls `_destination_warehouse(db, issue, wh.id)` — `issue` is undefined there (copy-paste from `_build_consignment`) | **Any dispatch with no `to_warehouse_id` raises `NameError`.** That is exactly the vendor-return case. One line |
| A permission code for Accounts, e.g. `return.settle` | The other three already exist. Recording a credit note is a different authority from approving a return |
| `PAGE_TREE` rows in `scripts/seed.py`, then reseed | Returns has no `rbac_pages` rows — never appears in the left rail |
| `remarks NOT LIKE '[STOCK_RETURN]%'` in inventory's `list_stos` | Keeps returns off the Stock Transfer screen |
| `STOCK_RETURN` + `STOCK_RETURN_RECEIPT` in `ladder.py`'s `DOC_TYPE_LABEL` / `MODULE_BY_DOC_TYPE` | Lets Approvals Config edit the return ladders |
| `stock.view` + `stock.transfer.approve` on whoever plays SCM Head and Floor In-charge — today Siva (INVENTORY MANAGER) and Mahendra (WARE HOUSE MANAGER-1) | They cannot open the decision desk otherwise. Each signs while wearing the configured post |
| A ruling: may QC's rejection auto-create a document? | The system would write a document nobody pressed a button for. Harmless as a draft, but say it out loud |
| PO terms block on `pro_purchase_orders`, defaulted from `mst_vendors` | Phase 5 |
| A per-item hazardous flag in masters | Features attach to a category, not an item, so the Scrap guard is only as precise as the category |

---

## 11. Questions

**The big one — Q11 first:**

**11. The role mismatch.** Your doc names nine SCM/Purchase logins; HCM carries seven
entirely different roles. Which is true?
- Are the nine **new logins to create** and map to people by hand? *(My reading: yes — the
  user counts 1, 2, 3, 2, 1 / 3, 1, 1, 1 look like a list about to be handed out.)*
- Or do they **describe what existing HCM positions already do**? Then tell me which HCM
  post is the SCM Head, the QC Team, the Floor In-charge.

Everything here is designed either way, but nothing can be **configured** until this is
answered.

**The rest:**

1. **Auto-draft granularity** — one per GRN, or one per rejected line? *(Recommend: one per
   GRN per vendor. Ten rejected lines is one conversation, not ten.)*
2. **Who owns the auto-draft** — the Floor In-charge who entered the GRN, or the QC
   inspector who rejected it? Whoever it is gets it in their queue.
3. **Overflow authority** — SCM Head decides and Purchase executes, or does the whole
   keep-or-return question go straight to Purchase? Keeping it means **paying money**, and
   that is a PO the Director approves.
4. **Vendor acknowledgement** — typed in by us from their mail or call? *(Assumed yes; no
   vendor portal planned.)*
5. **Return window** — is there a real number today, e.g. 7 days from GRN, or per vendor?
   Until PO terms exist I can only warn, not block.
6. **Post-putaway returns** — warranty claims only, or also "found damaged three weeks
   later"?
7. **Field return packing** — does the branch pack and hand over, or does the MDP send a
   vehicle to collect?
8. **Value threshold** — a rupee figure below which the business would rather scrap locally
   than ship? Cannot be enforced until stock is costed, but I would build the rule now.
9. **Debit note** — needed for late-replacement penalties, or is a credit note enough?
10. **Replacement GRN** — against the original PO, or a new one? Decides whether Purchase
    must be involved.
12. **Does the Indent Team validate returns too**, or only indents? *(Assumed both — a
    return is an indent run backwards.)*
13. **Outward QC on returns** — does QC's outward check cover a return leaving for a vendor,
    or only normal dispatches?

---

## 12. Three decisions before I start

1. **Revert or finish** the half-built Phase 1 work in `service.py`?
2. **Confirm base (c)** — one spine, two backends, no schema change?
3. **Phase 1 first** (finish field returns), or **Phase 2** (read-only queues that expose
   every over-receipt in the system on day one)?
