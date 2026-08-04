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
    // Accept any Host header. Vite's DNS-rebinding guard rejects tunnel hostnames
    // (ngrok, Cloudflare) it was not told about, which is what blocks demoing the
    // dev server over a share link. Dev and preview only — `vite build` output is
    // static files and is unaffected, so nothing here reaches production.
    allowedHosts: true,
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
