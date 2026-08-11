import axios from "axios";
import { api } from "@/shared/api/client";
import { alerts } from "./alerts";

/**
 * Raises the four failures that can happen on any screen, from one place.
 *
 * These belong to no module — a dropped connection or an expired token is not an
 * indent problem — so wiring them into each page would mean the same four handlers
 * copied across every screen in the app, and forgotten on the next one added.
 *
 * It lives here rather than in `shared/api/client.ts` on purpose: `shared` must not
 * import from `modules` (CLAUDE.md rule 5, imports run modules -> platform -> shared
 * -> core). Attaching from this side keeps the arrow pointing the right way — the
 * alerts module depends on the shared client, never the reverse.
 *
 * The interceptor only announces. It re-rejects untouched, so every existing
 * `onError` handler and error banner keeps behaving exactly as it did.
 */

/** 4xx the user caused: the screen's own inline message says it better. */
const HANDLED_LOCALLY = new Set([400, 404, 409, 422]);

let installed = false;

export function installApiAlerts(): void {
  // React 18 StrictMode mounts effects twice in development; without this the
  // second mount adds a second interceptor and every failure shows two dialogs.
  if (installed) return;
  installed = true;

  api.interceptors.response.use(
    (response) => response,
    (error) => {
      // Nobody cancelled anything by hand: TanStack Query aborts a read when the
      // screen unmounts or a filter changes, which is every navigation and every
      // keystroke in a search box. An abort carries no response, so without this
      // it lands in the `!error.response` branch below and announces a dropped
      // connection on a page that is working perfectly.
      if (axios.isCancel(error)) return Promise.reject(error);

      const status = error.response?.status;

      // The catalog fetch is a silent best-effort read behind the bundled defaults
      // (see AlertProvider). Announcing its failure would be the alert system
      // complaining about itself on a screen that is working fine.
      if (String(error.config?.url ?? "").includes("/api/alerts/catalog")) {
        return Promise.reject(error);
      }

      if (!error.response) {
        alerts.error("network.unreachable");
      } else if (status === 401) {
        // A rejected sign-in is not an expired session. The login form shows
        // "Invalid credentials" inline, which is the whole story; raising "Signed
        // out — your session has expired" on top of it told the user they had been
        // logged out of an account they had never got into.
        const url = String(error.config?.url ?? "");
        const signingIn = url.includes("/api/auth/login") || !localStorage.getItem("token");
        if (!signingIn) {
          // The shared interceptor is already sending the browser to /login. This
          // only explains why, so the redirect does not look like a random bounce.
          alerts.error("session.expired");
        }
      } else if (status === 403) {
        // Disabled by request: the "Not allowed" popup is not raised any more.
        // Screens keep their own inline error handling, and the 403 still reaches
        // every onError below via the re-reject.
        // const detail = error.response?.data?.error ?? error.response?.data?.detail;
        // alerts.error("permission.denied", {
        //   permission: typeof detail === "string" && detail.includes(":")
        //     ? detail.split(":").pop()?.trim()
        //     : "this action",
        // });
      } else if (status >= 500) {
        // Disabled by request: the generic "Something went wrong" popup is not
        // raised any more. Screens keep their own inline error handling, and the
        // failure still reaches every onError below via the re-reject.
        // alerts.error("request.failed");
      } else if (!HANDLED_LOCALLY.has(status)) {
        // Disabled by request — see above.
        // alerts.error("request.failed");
      }

      return Promise.reject(error);
    },
  );
}
