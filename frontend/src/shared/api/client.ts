import axios from "axios";
import { reportFrontendError } from "@/shared/errorLogging";

// Backend has one error shape ({success:false, error}); this interceptor rewrites
// every failure's `message` to something the UI can show directly. It rejects the
// ORIGINAL error rather than a fresh `new Error(...)`: a later interceptor (the
// alerts module attaches one) still needs `response`, `config` and `code` to tell
// a 403 from a 500 from a dropped connection. Replacing the object here made every
// failure look like "no response", i.e. "Can't reach the server".
export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || "" });

// The supplier portal is a second audience with a second token. Kept under its own
// key so a buyer and a vendor can be signed in in two tabs without evicting each
// other, and picked by URL rather than by "whichever is present" — sending an
// employee token to /api/supplier would 401 and log the employee out of SCM.
export const SUPPLIER_TOKEN_KEY = "supplier_token";

const isSupplierCall = (url?: string) => Boolean(url?.startsWith("/api/supplier"));

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(
    isSupplierCall(config.url) ? SUPPLIER_TOKEN_KEY : "token",
  );
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
      // Sign out only the audience that failed, and send them to their own door.
      const supplier = isSupplierCall(error.config?.url)
        || location.pathname.startsWith("/supplier");
      const key = supplier ? SUPPLIER_TOKEN_KEY : "token";
      const door = supplier ? "/supplier/login" : "/login";
      localStorage.removeItem(key);
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
