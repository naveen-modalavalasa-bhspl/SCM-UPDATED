/** Returns module — public surface. Routes import from here. */
export { default as ReturnsOverviewPage } from "./pages/ReturnsOverviewPage";
export { default as ReturnsListPage } from "./pages/ReturnsListPage";
export { default as ReturnFormPage } from "./pages/ReturnFormPage";
export { default as ReturnDetailPage } from "./pages/ReturnDetailPage";
export { default as ReceivingConfigPage } from "./pages/ReceivingConfigPage";
// One component for both desks' queues — they differ only in the `queue` parameter.
export { default as DecisionQueuePage } from "./pages/DecisionQueuePage";
export { default as PurchaseReturnsPage } from "./pages/PurchaseReturnsPage";
export { returnsApi } from "./api";
export * from "./types";
