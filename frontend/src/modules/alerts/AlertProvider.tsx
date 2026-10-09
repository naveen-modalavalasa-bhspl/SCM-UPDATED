import { useEffect, type ReactNode } from "react";
import { alerts } from "./alerts";
import { installApiAlerts } from "./apiAlerts";
import { fetchAlertCatalog } from "./api";
import { DEFAULT_CATALOG } from "./catalog";
import { AlertHost } from "./components/AlertHost";
import { hydrateCatalog } from "./store";

/**
 * Mounts the dialog host and pulls the server's copy over the bundled defaults.
 *
 * There is no context: the queue lives in `store.ts` so `alerts.confirm(...)`
 * works from axios interceptors and other non-component code. This component is
 * only the render surface plus the one-off catalog fetch, which is why call
 * sites never need a provider in scope — just this mounted once, in `App.tsx`.
 */
export function AlertProvider({ children }: { children: ReactNode }) {
  // Before the catalog fetch below, so a failure on that very request is announced.
  useEffect(() => { installApiAlerts(); }, []);

  useEffect(() => {
    let cancelled = false;
    // Signed out, so skip it: the endpoint needs a token, and the 401 would send
    // the shared axios interceptor bouncing the browser to /login. The bundled
    // catalog covers the login screen on its own.
    if (!localStorage.getItem("token")) return;
    // Deliberately not TanStack Query: this runs once, feeds a module store
    // rather than a component, and must not retry loudly. The bundled catalog
    // is a complete fallback, so a failure here is invisible by design.
    fetchAlertCatalog()
      .then((data) => {
        if (!cancelled) hydrateCatalog(data.items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Dev-only console handle, so any dialog can be raised on any screen without a
  // document to raise it from. Stripped from a production build by the constant
  // `import.meta.env.DEV`, which Vite folds to `false` before tree-shaking.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const preview = Object.assign(alerts, {
      /** Every code the catalog knows, grouped by variant. */
      codes: () =>
        Object.values(DEFAULT_CATALOG).reduce<Record<string, string[]>>((acc, def) => {
          (acc[def.variant] ??= []).push(def.code);
          return acc;
        }, {}),
      /** Raise one of each variant, one after the other, to eyeball the set. */
      demo: async () => {
        for (const def of Object.values(DEFAULT_CATALOG)) {
          await alerts.from(def.code, { number: "DEMO-001", name: "Demo", vendor: "Demo Vendor" });
        }
      },
    });
    (window as unknown as { alerts: typeof preview }).alerts = preview;
  }, []);

  return (
    <>
      {children}
      <AlertHost />
    </>
  );
}
