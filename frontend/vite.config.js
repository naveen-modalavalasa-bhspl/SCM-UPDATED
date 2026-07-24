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
        port: 5173,
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
