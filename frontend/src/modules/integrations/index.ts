/** Integrations module — public surface. Routes import from here. */
export { default as ApiClientsPage } from "./pages/ApiClientsPage";
export { default as ApiClientDetailPage } from "./pages/ApiClientDetailPage";
export { default as PlatformLinksPage } from "./pages/PlatformLinksPage";
export { integrationsApi, platformLinksApi } from "./api";
export * from "./types";
