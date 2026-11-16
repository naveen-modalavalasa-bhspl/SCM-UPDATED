/**
 * Stock Transfer's scoped grants, as the screens see them.
 *
 * Inventory > Stock Transfer works legs that live in other modules — the STR's
 * approval (an indent), serving it (an allocation), its material issue and outward QC
 * (warehouse), and its receipt. Each of those screens gates its buttons on its own
 * module's code. A `stock.transfer.*` code is a narrower grant over the same button:
 * the server passes it only on an STR / STO document (`core.dependencies.
 * require_permission_or`) and refuses it everywhere else.
 *
 * So `can()` treats holding the scoped code as holding the button's code. That is
 * safe precisely because the scoping is on the server: a Stock-Transfer-only login
 * cannot even load an ordinary indent, issue or QC to press anything on. Keep this in
 * step with `backend/app/platform/rbac/permissions.py` (the STOCK_TRANSFER_* codes).
 */
// No material-issue entries (2026-11-03): `stock.transfer.issue` / `issue_post` were
// retired because reading them as issue.view/create/issue put Warehouse > Material
// Issues' New issue button in front of logins that had no "Create issues". A
// transfer's material issue is worked under the Warehouse issue codes alone.
export const SCOPED_GRANTS: Record<string, string> = {
  "indent.create": "stock.transfer.request",
  "indent.submit": "stock.transfer.request",
  "indent.edit": "stock.transfer.request",
  "indent.approve": "stock.transfer.str_approve",
  "indent.reject": "stock.transfer.str_approve",
  "indent.acknowledge": "stock.transfer.receive",
  "allocation.view": "stock.transfer.serve",
  "allocation.create": "stock.transfer.serve",
  "allocation.submit": "stock.transfer.serve",
  "allocation.approve": "stock.transfer.serve_approve",
  "allocation.approve_reserve": "stock.transfer.serve_approve",
  "allocation.reject": "stock.transfer.serve_approve",
  "qc_outward.view": "stock.transfer.qc",
  "qc_outward.create": "stock.transfer.qc",
  "qc_outward.update": "stock.transfer.qc",
  "qc_outward.delete": "stock.transfer.qc",
  "qc_outward.approve": "stock.transfer.qc_approve",
};
