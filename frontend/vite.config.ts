import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Dev API target comes from env (no hardcoded host); falls back to local backend.
const apiTarget = process.env.VITE_API_PROXY || "http://localhost:8000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    // Listen on every interface so phones and other machines on the LAN can open
    // the app. The /api proxy still points at apiTarget, so a device only needs to
    // reach this port — the backend can stay on localhost.
    host: true,
    port: 5173,
    strictPort: true,
    // Compile the screens BEFORE they are clicked (2026-09-04).
    //
    // App.tsx moved every route behind `React.lazy` so a deployed user downloads one
    // screen instead of all 120. The dev server has no bundle, so the same change
    // moved each screen's transform to the moment it is first navigated to — the
    // route and its whole import tree (HeroUI, recharts, xlsx) compiled on the click.
    // Warmup does that work at startup instead, while the login screen is up.
    //
    // Dev server only. `vite build` is Rollup and never reads `server.*`, so the
    // deployed bundle is byte-identical with or without this.
    warmup: {
      clientFiles: ["./src/pages/*.tsx", "./src/modules/*/pages/**/*.tsx"],
    },
    // Accept any Host header. Vite's DNS-rebinding guard rejects tunnel hostnames
    // (ngrok, Cloudflare) it was not told about, which is what blocks demoing the
    // dev server over a share link. Dev and preview only — `vite build` output is
    // static files and is unaffected, so nothing here reaches production.
    allowedHosts: true,
    // What the dev server must NOT treat as a source change.
    //
    // Vite watches the project root, and two things under it are written while the
    // server is running: `dist/` (every `npm run build`) and the `vite.*.log.*` files
    // the server's own output is piped into. Both were triggering FULL page reloads —
    // 21 of them in one session, every single reload in the log — which throws away
    // React state, so a screen that had just been filled in or had just reported the
    // result of a press went blank and re-mounted from the URL.
    //
    // The log files are the worse half: the server logs a request, the log file
    // changes, the watcher reloads the page, the page makes requests, the server logs
    // them. That is a reload loop feeding itself, with no source file involved.
    watch: {
      ignored: ["**/dist/**", "**/*.log.out", "**/*.log.err"],
    },
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
  preview: {
    host: true,
    port: 4173,
    allowedHosts: true,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
  // The heavy dependencies, prebundled at boot rather than mid-navigation.
  //
  // Vite discovers dependencies by crawling from the entry. Behind lazy routes these
  // five are not reachable until the screen that uses them is opened, and meeting a
  // new dependency then triggers a re-optimisation AND A FULL PAGE RELOAD — which is
  // the worst of what a lazy dev server feels like, because it throws away the state
  // of the screen you just opened. Naming them makes that happen once, at startup.
  //
  // Dev server only, exactly like `server.warmup`: the production build prebundles
  // nothing and ignores this key.
  optimizeDeps: {
    include: ["recharts", "xlsx", "qrcode.react", "react-barcode", "react-to-print"],
  },
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          heroui: ["@heroui/react", "framer-motion"],
          data: ["@tanstack/react-query", "axios"],
        },
      },
    },
  },
});
