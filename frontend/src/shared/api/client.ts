import axios from "axios";
import { reportFrontendError } from "@/shared/errorLogging";

// Backend has one error shape ({success:false, error}); this interceptor turns
// every failure into an Error whose message the UI can show directly.
export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || "" });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (error) => {
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
      localStorage.removeItem("token");
      if (!location.pathname.startsWith("/login")) location.href = "/login";
    }
    if (!error.response) {
      const path = error.config?.url ? ` (${error.config.url})` : "";
      return Promise.reject(new Error(
        `Cannot reach the API${path}. Check that the frontend proxy and backend are running.`,
      ));
    }
    return Promise.reject(new Error(typeof message === "string" ? message : "Request failed"));
  },
);
