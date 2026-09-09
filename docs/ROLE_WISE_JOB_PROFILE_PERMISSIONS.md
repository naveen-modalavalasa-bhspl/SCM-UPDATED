# Role-wise Job Profile Permissions

These profiles are designed for **Replace** mode in **RBAC → Job Profiles → Paste Permissions**. Select the project and job profile, paste the complete JSON block, choose **Replace**, then save.

The project selected in Job Profiles remains the hard project boundary. Workflow approval is a second boundary: an action permission never lets a person approve a document unless the configured approval flow is currently waiting for that position.

## Store Keeper

**Purpose:** Raise and track personal indents, view accessible stock, make gate entries and GRNs, acknowledge received indent goods, and read relevant reports.

**Allowed modules/screens/actions:** Indents; stock overview, balance and ledger; Warehouse dashboard, Material Inward, Goods Receipt and reports; relevant report ledgers. GRN access is still subject to the company setting.

**Restricted:** Other users' indents; approvals; procurement; QC; put-away; issues; dispatch; stock adjustment/transfer; masters and administration.

**Approval authority:** None.

**Copy-paste permission list:**

```json
{"v":1,"kind":"scm-job-profile-access","from":"Store Keeper","scope":"SELF","pages":["grp_indents","ind_dashboard","ind_list","ind_deliveries","ind_reports","ind_notifications","grp_inventory","inv_overview","inv_balance","inv_ledger","grp_warehouse","wh_dashboard","wh_inward","wh_grn","wh_notifications","wh_reports","grp_reports","rep_indents","rep_inventory","rep_warehouse","rep_traceability","rep_attachments"],"features":["indent.view","indent.create","indent.edit","indent.delete","indent.submit","indent.acknowledge","stock.view","receipt.view","receipt.create","receipt.post","grn.view","grn.create","warehouse.report.view","report.view","report.export"]}
```

## OE

**Purpose:** Raise personal indents, review reporting-line documents, approve/reject assigned indents, serve an indent from stock held by the reporting line, and perform the Store Keeper receipt work requested for this role.

**Allowed modules/screens/actions:** Indents, Approvals, scoped stock, Material Inward/GRN, and relevant reports.

**Restricted:** Procurement; QC; allocation desk; stock adjustment/transfer; other projects; documents outside the reporting line; masters and administration.

**Approval authority:** Indents only when the workflow is waiting for this position. “Serve from own stock” is included through `indent.approve`; Logistics permission is not required.

**Copy-paste permission list:**

```json
{"v":1,"kind":"scm-job-profile-access","from":"OE","scope":"SUBTREE","pages":["grp_indents","ind_dashboard","ind_list","ind_deliveries","ind_reports","ind_notifications","approvals","approval_overview","approval_consolidation","approval_waiting","approval_decisions","grp_inventory","inv_overview","inv_balance","inv_ledger","grp_warehouse","wh_dashboard","wh_inward","wh_grn","wh_notifications","wh_reports","grp_reports","rep_indents","rep_approvals","rep_inventory","rep_warehouse","rep_traceability","rep_attachments"],"features":["indent.view","indent.create","indent.edit","indent.delete","indent.submit","indent.approve","indent.reject","indent.acknowledge","stock.view","stock.view.subtree","receipt.view","receipt.create","receipt.post","grn.view","grn.create","warehouse.report.view","report.view","report.export"]}
```

## DM

**Purpose:** Same operational access as OE, applied to the DM reporting subtree.

**Allowed modules/screens/actions:** Indents, Approvals, scoped stock, Material Inward/GRN, and relevant reports.

**Restricted:** Procurement; QC; allocation desk; stock adjustment/transfer; other projects; documents outside the reporting line; masters and administration.

**Approval authority:** Indents only when the workflow is waiting for this position; includes serving from own reporting-line stock.

**Copy-paste permission list:**

```json
{"v":1,"kind":"scm-job-profile-access","from":"DM","scope":"SUBTREE","pages":["grp_indents","ind_dashboard","ind_list","ind_deliveries","ind_reports","ind_notifications","approvals","approval_overview","approval_consolidation","approval_waiting","approval_decisions","grp_inventory","inv_overview","inv_balance","inv_ledger","grp_warehouse","wh_dashboard","wh_inward","wh_grn","wh_notifications","wh_reports","grp_reports","rep_indents","rep_approvals","rep_inventory","rep_warehouse","rep_traceability","rep_attachments"],"features":["indent.view","indent.create","indent.edit","indent.delete","indent.submit","indent.approve","indent.reject","indent.acknowledge","stock.view","stock.view.subtree","receipt.view","receipt.create","receipt.post","grn.view","grn.create","warehouse.report.view","report.view","report.export"]}
```

## RM

**Purpose:** Same operational access as OE and DM, applied to the RM reporting subtree.

**Allowed modules/screens/actions:** Indents, Approvals, scoped stock, Material Inward/GRN, and relevant reports.

**Restricted:** Procurement; QC; allocation desk; stock adjustment/transfer; other projects; documents outside the reporting line; masters and administration.

**Approval authority:** Indents only when the workflow is waiting for this position; includes serving from own reporting-line stock.

**Copy-paste permission list:**

```json
{"v":1,"kind":"scm-job-profile-access","from":"RM","scope":"SUBTREE","pages":["grp_indents","ind_dashboard","ind_list","ind_deliveries","ind_reports","ind_notifications","approvals","approval_overview","approval_consolidation","approval_waiting","approval_decisions","grp_inventory","inv_overview","inv_balance","inv_ledger","grp_warehouse","wh_dashboard","wh_inward","wh_grn","wh_notifications","wh_reports","grp_reports","rep_indents","rep_approvals","rep_inventory","rep_warehouse","rep_traceability","rep_attachments"],"features":["indent.view","indent.create","indent.edit","indent.delete","indent.submit","indent.approve","indent.reject","indent.acknowledge","stock.view","stock.view.subtree","receipt.view","receipt.create","receipt.post","grn.view","grn.create","warehouse.report.view","report.view","report.export"]}
```

## SPH

**Purpose:** Same operational access as OE, DM and RM, applied to the SPH reporting subtree.

**Allowed modules/screens/actions:** Indents, Approvals, scoped stock, Material Inward/GRN, and relevant reports.

**Restricted:** Procurement; QC; allocation desk; stock adjustment/transfer; other projects; documents outside the reporting line; masters and administration.

**Approval authority:** Indents only when the workflow is waiting for this position; includes serving from own reporting-line stock.

**Copy-paste permission list:**

```json
{"v":1,"kind":"scm-job-profile-access","from":"SPH","scope":"SUBTREE","pages":["grp_indents","ind_dashboard","ind_list","ind_deliveries","ind_reports","ind_notifications","approvals","approval_overview","approval_consolidation","approval_waiting","approval_decisions","grp_inventory","inv_overview","inv_balance","inv_ledger","grp_warehouse","wh_dashboard","wh_inward","wh_grn","wh_notifications","wh_reports","grp_reports","rep_indents","rep_approvals","rep_inventory","rep_warehouse","rep_traceability","rep_attachments"],"features":["indent.view","indent.create","indent.edit","indent.delete","indent.submit","indent.approve","indent.reject","indent.acknowledge","stock.view","stock.view.subtree","receipt.view","receipt.create","receipt.post","grn.view","grn.create","warehouse.report.view","report.view","report.export"]}
```

## SCM Head

**Purpose:** Control all operational warehouse flows in the selected project, with project-wide indent visibility and workflow approval capability.

**Allowed modules/screens/actions:** Project-wide Indents and Approvals; stock visibility and transfers; all operational Warehouse screens from inward through QC, put-away, movement, picking, issue, dispatch, acknowledgement and return; relevant reports.

**Restricted:** Procurement purchasing actions; master-data maintenance; company/RBAC administration; records outside the selected project. Warehouse Masters is deliberately excluded because it changes configuration rather than operating documents.

**Approval authority:** May perform warehouse/indent approval actions only when the configured workflow assigns the document to this position. May approve cross-project stock transfers, but project data scope still applies to normal lists.

**Copy-paste permission list:**

```json
{"v":1,"kind":"scm-job-profile-access","from":"SCM Head","scope":"PROJECT","pages":["grp_indents","ind_dashboard","ind_list","ind_deliveries","ind_reports","ind_notifications","approvals","approval_overview","approval_consolidation","approval_waiting","approval_decisions","grp_inventory","inv_overview","inv_balance","inv_ledger","inv_transfers","grp_warehouse","wh_dashboard","wh_inward","wh_grn","wh_qc","wh_qc_outward","wh_putaway","wh_segregation","wh_stock_movements","wh_issues","wh_material_returns","wh_ack","wh_picklist","wh_consignments","wh_dispatch","wh_notifications","wh_reports","grp_reports","rep_indents","rep_approvals","rep_inventory","rep_warehouse","rep_traceability","rep_attachments","rep_live_tracking"],"features":["indent.view","indent.create","indent.edit","indent.delete","indent.submit","indent.approve","indent.reject","indent.acknowledge","indent.view.fulfilment","stock.view","stock.view.subtree","stock.transfer","stock.transfer.approve","receipt.view","receipt.create","receipt.post","receipt.delete","grn.view","grn.create","grn.qc","inspection.view","inspection.execute","inspection.delete","qc_outward.view","qc_outward.create","qc_outward.update","qc_outward.approve","qc_outward.export","qc_outward.delete","putaway.view","putaway.execute","putaway.delete","movement.view","movement.create","movement.update","movement.approve","movement.delete","picking.view","picking.pick","picking.delete","issue.view","issue.create","issue.issue","issue.forward","issue.split","issue.delete","dispatch.view","dispatch.create","dispatch.approve","dispatch.gate_out","dispatch.acknowledge","dispatch.delete","return.view","return.create","return.approve","return.decide","return.endorse","return.delete","warehouse.report.view","report.view","report.export"]}
```

## Inventory (Approval Rung)

**Purpose:** This follows the stated requirement: an Inventory-titled approver who raises indents, sees reporting-line indents/stock and approves assigned indents. It is not the central stock-allocation desk.

**Allowed modules/screens/actions:** Indents, Approvals, reporting-line stock visibility, and related reports.

**Restricted:** Fulfilment/allocation; material requests; Warehouse; Logistics; Procurement; stock adjustment/transfer; masters and administration.

**Approval authority:** Indents only when the workflow is waiting for this position; includes serving from stock held in the reporting subtree.

**Copy-paste permission list:**

```json
{"v":1,"kind":"scm-job-profile-access","from":"Inventory","scope":"SUBTREE","pages":["grp_indents","ind_dashboard","ind_list","ind_deliveries","ind_reports","ind_notifications","approvals","approval_overview","approval_consolidation","approval_waiting","approval_decisions","grp_inventory","inv_overview","inv_balance","inv_ledger","grp_reports","rep_indents","rep_approvals","rep_inventory","rep_traceability","rep_attachments"],"features":["indent.view","indent.create","indent.edit","indent.delete","indent.submit","indent.approve","indent.reject","indent.acknowledge","stock.view","stock.view.subtree","report.view","report.export"]}
```

> If “Inventory” is meant to allocate approved indents rather than being an approval rung, do not use this block; that requires the Fulfilment Desk permissions (`indent.view.fulfilment`, `allocation.*`, and usually `mr.*`) as a separate segregation-of-duties profile.

## QC Inward

**Purpose:** Inspect received material against a GRN and record/complete the inward quality result.

**Allowed modules/screens/actions:** Inward Quality Inspection only. Read-only receipt/GRN and stock lookup access is included because the form must load its source document, warehouse and inspector options.

**Restricted:** Creating/posting GRNs; Outward QC; put-away; issue; dispatch; inventory changes; procurement; indents; masters and administration.

**Approval authority:** Complete inward QC. This does not grant general document approval.

**Copy-paste permission list:**

```json
{"v":1,"kind":"scm-job-profile-access","from":"QC Inward","scope":"OFFICE","pages":["grp_warehouse","wh_qc"],"features":["stock.view","receipt.view","grn.view","grn.qc","inspection.view","inspection.execute"]}
```

## QC Outward

**Purpose:** Inspect goods after a Material Issue and before dispatch, update the QC draft, complete it, and export the result.

**Allowed modules/screens/actions:** Outward QC only. Read-only Material Issue and stock lookup access is included so the QC form can select and load its source lines and warehouse/inspector options.

**Restricted:** GRN/inward QC; creating or posting material issues; dispatch; inventory changes; procurement; indents; masters and administration.

**Approval authority:** Complete/approve Outward QC. If an Outward QC approval ladder exists, the workflow still decides who can approve the pending document.

**Copy-paste permission list:**

```json
{"v":1,"kind":"scm-job-profile-access","from":"QC Outward","scope":"OFFICE","pages":["grp_warehouse","wh_qc_outward"],"features":["stock.view","issue.view","qc_outward.view","qc_outward.create","qc_outward.update","qc_outward.approve","qc_outward.export"]}
```

> Outward QC does **not** need `grn.view`: the implemented source document is a Material Issue. Granting `issue.view` is the prerequisite that prevents an empty/broken Outward QC form.

## Logistics

**Purpose:** Run the complete transport workflow and also act as an indent approver across the reporting line.

**Allowed modules/screens/actions:** Indents and Approvals; reporting-line stock; all active Logistics screens; transport request, approval, provider award, tracking, acknowledgement, exceptions and logistics-provider maintenance; relevant reports.

**Restricted:** Procurement purchasing; Warehouse receipt/QC/put-away/issue operations; stock adjustment; masters; RBAC and company administration. Draft transport deletion is included because this is the owning operational desk.

**Approval authority:** Indents when assigned by workflow; transport approvals when assigned by workflow. Provider award is explicitly allowed. “Serve from own stock” comes from Indent Approve, independently of the Logistics module.

**Copy-paste permission list:**

```json
{"v":1,"kind":"scm-job-profile-access","from":"Logistics","scope":"SUBTREE","pages":["grp_indents","ind_dashboard","ind_list","ind_deliveries","ind_reports","ind_notifications","approvals","approval_overview","approval_consolidation","approval_waiting","approval_decisions","grp_inventory","inv_overview","inv_balance","inv_ledger","grp_logistics","logistics_overview","logistics_consignments","logistics_dispatch","logistics_transport","logistics_providers","logistics_activity","settings_logistics_vendors","grp_reports","rep_indents","rep_approvals","rep_inventory","rep_traceability","rep_attachments","rep_live_tracking"],"features":["indent.view","indent.create","indent.edit","indent.delete","indent.submit","indent.approve","indent.reject","indent.acknowledge","stock.view","stock.view.subtree","transport.view","transport.create","transport.approve","transport.award","transport.track","transport.acknowledge","transport.exception","transport.delete","logistics.partner.view","logistics.partner.manage","report.view","report.export"]}
```

## Floor In-Charge

**Purpose:** Work warehouse documents for assigned floors, see the stock on those floors, and act on reporting-line indent approvals.

**Allowed modules/screens/actions:** Indents and Approvals; floor-scoped stock; put-away, segregation, movements, picklists, material issues and returns; relevant Warehouse and approval reports.

**Restricted:** Unassigned floors; receipt/GRN creation; inward/outward QC; dispatch approval/gate-out; cross-project transfers; procurement; masters and administration.

**Approval authority:** Indents only when assigned by workflow. May execute floor operations, but may not approve warehouse movements or commercial return decisions.

**Copy-paste permission list:**

```json
{"v":1,"kind":"scm-job-profile-access","from":"Floor In-Charge","scope":"OFFICE","pages":["grp_indents","ind_dashboard","ind_list","ind_deliveries","ind_reports","ind_notifications","approvals","approval_overview","approval_consolidation","approval_waiting","approval_decisions","grp_inventory","inv_overview","inv_balance","inv_ledger","grp_warehouse","wh_dashboard","wh_putaway","wh_segregation","wh_stock_movements","wh_issues","wh_material_returns","wh_picklist","wh_notifications","wh_reports","grp_reports","rep_indents","rep_approvals","rep_inventory","rep_warehouse","rep_traceability","rep_attachments"],"features":["indent.view","indent.create","indent.edit","indent.delete","indent.submit","indent.approve","indent.reject","indent.acknowledge","stock.view","putaway.view","putaway.execute","movement.view","movement.create","movement.update","picking.view","picking.pick","issue.view","issue.create","issue.issue","issue.forward","return.view","return.create","return.endorse","warehouse.report.view","report.view","report.export"]}
```

The Floor In-Charge JSON does not itself assign floors. The employee/position must also be mapped to the correct warehouse floors/stocking points; those mappings are what restrict the returned rows after the page and action permissions open the screens.

## Final safeguards

- Use **Replace**, not Add, when standardising an existing job profile; Add can retain unintended legacy HCM permissions.
- Confirm the selected project before saving. A profile is saved against that project/job combination.
- Configure the approval ladder separately. RBAC permits an action; the workflow determines whose turn it is.
- Do not add Procurement pages/actions to any profile above.
- Do not grant `stock.view.all` to project roles. It bypasses ordinary warehouse visibility and is intended only for a truly central inventory desk.
