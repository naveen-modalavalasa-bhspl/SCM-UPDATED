import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppErrorBoundary, installGlobalErrorLogging } from "@/shared/errorLogging";
import { applyTheme, watchSystemTheme } from "@/shared/theme";
import { installNumberGuard } from "@/shared/numberGuard";
import { installTruncationTitles } from "@/shared/truncationTitles";
import { AppSplash } from "@/shared/components/AppSplash";
import {
  BAVYA_SSO_EXPIRED, signInWithBavyaTicket, takeBavyaTicket,
} from "@/shared/auth/bavyaSso";
import { BavyaSsoErrorPage } from "@/pages/BavyaSsoErrorPage";
import "./index.css";

// Bavya SSO: bhsdb.in opens SCM at /#bavya_ticket=<pass>. The pass comes out of the
// address FIRST — before error logging can record the URL and before the router reads
// it — so nothing keeps it and Back or Refresh cannot replay it.
const bavyaTicket = takeBavyaTicket();

installGlobalErrorLogging();
// Every numeric box, in every module: digits only, and no "." in a whole unit.
installNumberGuard();
// Every cut-short text, in every module: the full text on hover (item names, mostly).
installTruncationTitles();

// Before first paint: applying the class later flashes the light theme.
applyTheme();
watchSystemTheme();

const root = createRoot(document.getElementById("root")!);
const show = (node: ReactNode) => root.render(
  <StrictMode>
    <AppErrorBoundary>
      {node}
    </AppErrorBoundary>
  </StrictMode>,
);

if (bavyaTicket === null) {
  show(<App />);
} else {
  // The pass is exchanged before the app mounts. On success the token is where a
  // password sign-in leaves it, so the app starts signed in and lands on the page it
  // was opened at (Home, for bhsdb.in's link). On failure the reason is shown with
  // the way back to bhsdb.in, never the login form.
  // The catch is for what the exchange itself cannot answer — storage refusing the
  // token (a private window, a full quota) — so the splash can never be left spinning.
  show(<AppSplash label="Signing you in" />);
  void signInWithBavyaTicket(bavyaTicket)
    .then((refusal) =>
      show(refusal === null ? <App /> : <BavyaSsoErrorPage message={refusal} />))
    .catch(() => show(<BavyaSsoErrorPage message={BAVYA_SSO_EXPIRED} />));
}
