# SCM End-to-End Business Process Flow

> Source: business owner (Balu), 2026-07-26. This is the authoritative description of
> how the SCM is meant to work. It sits **above** `03_HCM_AND_DB.md` in the precedence
> chain — where an earlier doc contradicts this flow, this flow wins.
>
> Recorded verbatim apart from section-local renumbering (the original was a single
> running list across sections). No steps added, removed, or reworded.

Delivery order agreed 2026-07-26: **Indent → Inventory → Warehouse.** Warehouse is
planned last and its existing frontend is to be rewritten against this codebase rather
than kept as-is (see "Known deviation" at the end).

---

## 1. Master Configuration

- Configure Warehouse Structure: Warehouse → Floor → Line → Rack → Bin → Lot → Cold Room/Refrigerator.
- Configure Department Users and Roles.
- Configure Inventory Locations: LIP (Local Inventory Point) and MDP (Material Distribution Point).

## 2. Department Roles

| Department | Roles |
|---|---|
| Warehouse | Manager, Floor Supervisors, Store Keepers |
| Procurement | Manager, Chief Procurement Officer, Executives |
| Inventory | Manager, Supervisors, Executives |
| Logistics | Manager, Supervisors, Executives |
| Projects | COO, SPH, RM, DM, OE, DEO, LT, Store Keepers, EMT, Para-vets, Pilots |
| FMS | SFM, FH, DFM |

Roles are **sourced from HCM** (~23 at the time of writing), not seeded locally. The
five roles in `seed.py` are sample/test data only.

## 3. Indent Management Flow

1. Indent Created by Project/User (MMU, Office, RM, DM, OE, etc.)
2. Indent Approval
3. Inventory Availability Check
4. If stock is available, materials are issued from the warehouse.
5. If stock is not available, the request moves to Procurement.
6. During the indent life cycle, damaged, expired, or unwanted materials can be
   processed through the Returns Flow.

## 4. Warehouse Process

1. Material Issue
2. Material Request (MR) Creation — MR should be raised at Inventory / Warehouse level
3. STO (Stock Transfer Order)
4. SMO (Stock Movement Order)
5. Gate Pass OUT Generation (Sequence)
6. Packing
7. Consignment Creation
8. Dispatch Plan
9. Delivery
10. Inventory Stock Updated

## 5. Procurement Process

1. MR Approval
2. RFQ Creation
3. RFQ Approval
4. Send RFQ to Vendors
5. Receive Vendor Quotations
6. Compare Quotations
7. Select Vendor
8. Purchase Order (PO) Creation
9. PO Approval
10. PO Sent to Selected Vendor
11. Vendor Supplies Materials
12. Gate Pass IN
13. Material Inward
14. Goods Receipt Note (GRN)
15. Quality Inspection / Quality Check
16. Inventory Stock Updated
17. Purchase Return (if materials fail quality inspection or are damaged, near-by expiry)
18. Material Issued from Warehouse
19. Gate Pass OUT
20. Packing
21. Consignment
22. Dispatch Plan
23. Delivery

## 6. Returns Flow

- Return initiated for Damaged Materials.
- Return initiated for Expired Materials.
- Unused/Rejected materials returned against Indent.
- Material received back into warehouse.
- Quality verification.
- Stock updated after return.
- Scrap / Disposal or Vendor Return based on business rules.

## 7. Dispatch Methods

- In Person — Requested Indent Person
- In Person — Other Authorized Person
- Self-Owned Fleet
- Courier
- Third-Party Logistics (Courier or Contract Vehicle)

## 8. Complete End-to-End SCM Flow

```
Master Setup → Roles Configuration → Warehouse/LIP/MDP Setup → Indent Creation
  → Indent Approval → Inventory Check
      ├── [Stock Available]     → Material Issue → STO/SMO → Gate Pass OUT
      │                           → Packing → Consignment → Dispatch → Delivery
      └── [Stock Not Available] → MR → RFQ → Vendor Selection → PO → Gate Pass IN
                                  → Material Inward → GRN → Quality Inspection
                                  → Stock Update → Purchase Return (if required)
                                  → Material Issue → Gate Pass OUT → Dispatch
  → Returns Flow (Damaged / Expired / Indent Returns)
  → Final Inventory Update
  → Update to F&A for payment-related flow & material accountability for audit /
    depreciation
```

---

## How this maps onto the two engines

Restated here because the split is the single most common source of confusion when
implementing the flow above.

**`platform/workflow` — who signs off, in what order.** Stateful, human-in-the-loop,
one `wf_instances` row alongside the document. Owns: indent approval, MR approval, RFQ
approval, vendor-selection approval, PO approval, purchase-return approval, STO/SMO
approval, gate-pass approval, scrap/disposal approval.

**`platform/rules` — what the system decides on its own.** Stateless, evaluated in
milliseconds, returns actions and never executes them. Owns: the §3 stock-available
fork (`ROUTE_FULFILLMENT` / `SPLIT_FULFILLMENT` to INVENTORY / WAREHOUSE /
PROCUREMENT), which LIP/MDP fulfils a request, QC-fail disposition, expiry-driven
returns, dispatch-method selection (§7), notification targeting, and field defaulting.

The dividing test: **does a person have to click something?** Yes → workflow. No → rules.

`wf_stage_conditions` and `rule_conditions` share a shape and an operator
implementation, which is why they blur. The distinction: a stage condition decides
whether a stage inside an already-chosen chain applies ("PO above ₹5 lakh also needs
Plant Head"); a rule decides which path the document takes at all.

## Fallback requirement

Both engines are configuration-driven, so a missing or misconfigured row must never
strand a document. If no active workflow matches a document type, approval falls back
to a **hardcoded reporting-manager ladder** (requester → reporting manager → their
manager, up a fixed number of levels) held in code, not in the database. Likewise, if
no rule matches a routing event, the system takes a hardcoded default path rather than
halting. Every fallback activation is recorded so misconfiguration is visible rather
than silent.

## Known deviation to correct

The `frontend/src/modules/warehouse` screens currently in the repo were built by
another developer against a different backend contract (`/api/v1`, its own axios
client and auth handling, antd, endpoints such as `/outbound/picking-orders` and
`/consignment/acknowledge` that do not exist here). They are to be rewritten to match
this codebase's shared client, HeroUI kit, and module pattern when warehouse is picked
up last.
