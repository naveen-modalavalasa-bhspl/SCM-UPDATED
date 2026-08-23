import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppErrorBoundary, installGlobalErrorLogging } from "@/shared/errorLogging";
import { applyTheme, watchSystemTheme } from "@/shared/theme";
import "./index.css";

installGlobalErrorLogging();

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
