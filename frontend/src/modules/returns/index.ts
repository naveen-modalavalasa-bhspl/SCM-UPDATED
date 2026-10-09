/** Returns module — public surface. Routes import from here. */
export { default as ReturnsOverviewPage } from "./pages/ReturnsOverviewPage";
export { default as ReturnsListPage } from "./pages/ReturnsListPage";
export { default as ReturnFormPage } from "./pages/ReturnFormPage";
export { default as ReturnDetailPage } from "./pages/ReturnDetailPage";
// The whole road the return travelled, at step level — the detail page's eight-dot
// tracker opened out, drawn with the indent journey's own chrome.
export { default as ReturnJourneyPage } from "./pages/ReturnJourneyPage";
// The material's whole history — every document raised against the returned items, from
// the indent they were asked for on to the load carrying them back. A page of its own
// because it is a dozen other modules' documents and the detail screen keeps a summary.
export { default as ReturnTrailPage } from "./pages/ReturnTrailPage";
export { default as ReceivingConfigPage } from "./pages/ReceivingConfigPage";
// One component for both desks' queues — they differ only in the `queue` parameter.
export { default as DecisionQueuePage } from "./pages/DecisionQueuePage";
export { default as PurchaseReturnsPage } from "./pages/PurchaseReturnsPage";
/**
 * The purchase return's own form and review screen, re-exported so the register can
 * open them WITHOUT walking the reader out of the Returns module.
 *
 * `pro_returns` is still the warehouse module's table and the implementation still
 * lives there — this is the same arrangement Consignments already has, where the
 * warehouse owns `out_dispatches` and logistics serves the screen at
 * `/logistics/consignments`. Nothing is re-implemented here and nothing of the
 * warehouse's own `/warehouse/purchase-returns/*` door changes; both paths render the
 * same component, and the component keeps every route it pushes on the side it was
 * opened from.
 *
 * Legal in the import chain: returns sits AFTER warehouse
 * (inventory → indents → procurement → logistics → warehouse → returns), so returns
 * may import warehouse. The reverse would not be.
 */
export { default as PurchaseReturnFormPage } from "@/modules/warehouse/pages/PurchaseReturnForm";
export { default as PurchaseReturnDetailPage } from "@/modules/warehouse/pages/PurchaseReturnDetail";
export { returnsApi } from "./api";
export * from "./types";
