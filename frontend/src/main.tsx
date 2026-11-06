import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppErrorBoundary, installGlobalErrorLogging } from "@/shared/errorLogging";
import { applyTheme, watchSystemTheme } from "@/shared/theme";
import { installNumberGuard } from "@/shared/numberGuard";
import { installTruncationTitles } from "@/shared/truncationTitles";
import "./index.css";

installGlobalErrorLogging();
// Every numeric box, in every module: digits only, and no "." in a whole unit.
installNumberGuard();
// Every cut-short text, in every module: the full text on hover (item names, mostly).
installTruncationTitles();

// Before first paint: applying the class later flashes the light theme.
applyTheme();
watchSystemTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
