import axios from "axios";
import { reportFrontendError } from "@/shared/errorLogging";

// Backend has one error shape ({success:false, error}); this interceptor rewrites
// every failure's `message` to something the UI can show directly. It rejects the
// ORIGINAL error rather than a fresh `new Error(...)`: a later interceptor (the
// alerts module attaches one) still needs `response`, `config` and `code` to tell
// a 403 from a 500 from a dropped connection. Replacing the object here made every
// failure look like "no response", i.e. "Can't reach the server".
export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || "" });

// The supplier portal is a second audience with a second token. Vendor tokens are
// tab-scoped: logistics commonly opens two carrier accounts side by side while
// checking a tender, and localStorage made both tabs submit as whichever carrier
// signed in last. The old local value is read only as a migration fallback.
export const SUPPLIER_TOKEN_KEY = "supplier_token";

export const vendorToken = () =>
  sessionStorage.getItem(SUPPLIER_TOKEN_KEY)
  ?? localStorage.getItem(SUPPLIER_TOKEN_KEY);

export const setVendorToken = (token: string) => {
  sessionStorage.setItem(SUPPLIER_TOKEN_KEY, token);
  localStorage.removeItem(SUPPLIER_TOKEN_KEY);
};

export const clearVendorToken = () => {
  sessionStorage.removeItem(SUPPLIER_TOKEN_KEY);
  localStorage.removeItem(SUPPLIER_TOKEN_KEY);
};

// Which door that vendor came in by. The TOKEN is deliberately shared — a carrier IS
// a vendor, one account, one password — but the DESTINATION is not. The screens both
// portals share (choose a password, the 401 bounce) used to be hardcoded to the
// supplier side, so a transport provider who changed their password or got bounced
// once was dropped into an RFQ list that will always read "Nothing has been sent to
// you yet", with no way back to their shipments.
export const VENDOR_PORTAL_KEY = "vendor_portal";

export type VendorPortal = "supplier" | "carrier";

export const setVendorPortal = (portal: VendorPortal) => {
  sessionStorage.setItem(VENDOR_PORTAL_KEY, portal);
  localStorage.removeItem(VENDOR_PORTAL_KEY);
};

/** Defaults to supplier: a session that predates this key, and every vendor who never
 *  went near /carrier, belongs on the supplier side. */
export const vendorPortal = (): VendorPortal =>
  (sessionStorage.getItem(VENDOR_PORTAL_KEY)
    ?? localStorage.getItem(VENDOR_PORTAL_KEY)) === "carrier" ? "carrier" : "supplier";

/** Where "you are signed in, get on with it" means for this vendor. */
export const vendorHome = () =>
  vendorPortal() === "carrier" ? "/carrier/jobs" : "/supplier/rfqs";

/** The change-password screen, on the door they came in through.
 *
 *  FIXED 2026-08-21 — there is ONE password screen and it was only ever mounted on
 *  /supplier/password, so a carrier forced to change theirs at first sign-in was
 *  dropped out of the carrier shell into the supplier portal's header and tabs, with
 *  no route back to their shipments. Same bug and the same fix as /carrier/profile:
 *  one implementation, mounted on both paths, reached through here so no screen has to
 *  know which portal it is standing in. `vendorHome()` above already sends them back
 *  to the right side afterwards, which is why only the path was ever wrong. */
export const vendorPasswordPath = () =>
  vendorPortal() === "carrier" ? "/carrier/password" : "/supplier/password";

const isSupplierCall = (url?: string) => Boolean(url?.startsWith("/api/supplier"));

/** Where they are standing beats what they last logged in as — a carrier looking at a
 *  /carrier screen goes back to the carrier door even on a fresh browser. */
const vendorDoor = () =>
  location.pathname.startsWith("/carrier") ? "/carrier/login"
    : location.pathname.startsWith("/supplier") ? "/supplier/login"
      : `/${vendorPortal()}/login`;

api.interceptors.request.use((config) => {
  const token = isSupplierCall(config.url)
    ? vendorToken()
    : localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (error) => {
    // A cancelled request is not a failure: TanStack Query aborts in-flight reads
    // when a screen unmounts or a filter changes, and there is nobody left to tell.
    // Logging it would fill sys_app_logs with normal navigation.
    if (axios.isCancel(error)) return Promise.reject(error);

    const status = error.response?.status;
    const message =
      error.response?.data?.error ??
      error.response?.data?.detail ??
      error.message ??
      "Something went wrong";
    reportFrontendError({
      message: typeof message === "string" ? message : "Request failed",
      error_type: error.name ?? "ApiError",
      status_code: status ?? null,
      http_method: error.config?.method?.toUpperCase() ?? null,
      endpoint: error.config?.url ?? null,
      request_id: error.response?.headers?.["x-request-id"] ?? null,
      stack_trace: error.stack ?? new Error(String(message)).stack,
      context: {
        kind: "api",
        status_text: error.response?.statusText ?? null,
      },
    });
    if (status === 401) {
      // Sign out only the audience that failed, and send them to their own door —
      // which for a vendor means the portal they are actually in, not always the
      // supplier one.
      const vendor = isSupplierCall(error.config?.url)
        || location.pathname.startsWith("/supplier")
        || location.pathname.startsWith("/carrier");
      const door = vendor ? vendorDoor() : "/login";
      if (vendor) clearVendorToken();
      else localStorage.removeItem("token");
      if (location.pathname !== door) location.href = door;
    }
    if (!error.response) {
      const path = error.config?.url ? ` (${error.config.url})` : "";
      error.message =
        `Cannot reach the API${path}. Check that the frontend proxy and backend are running.`;
    } else {
      error.message = typeof message === "string" ? message : "Request failed";
    }
    return Promise.reject(error);
  },
);
