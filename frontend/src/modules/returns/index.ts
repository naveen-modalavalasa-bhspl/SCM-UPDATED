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
export { returnsApi } from "./api";
export * from "./types";
