// vitest.config.ts
import { defineConfig as defineConfig2, mergeConfig } from "file:///C:/Users/SUBRAMANYAM/Downloads/scm-erp-22-08/frontend/node_modules/vitest/dist/config.js";

// vite.config.ts
import { defineConfig } from "file:///C:/Users/SUBRAMANYAM/Downloads/scm-erp-22-08/frontend/node_modules/vite/dist/node/index.js";
import react from "file:///C:/Users/SUBRAMANYAM/Downloads/scm-erp-22-08/frontend/node_modules/@vitejs/plugin-react/dist/index.js";
import tailwindcss from "file:///C:/Users/SUBRAMANYAM/Downloads/scm-erp-22-08/frontend/node_modules/@tailwindcss/vite/dist/index.mjs";
import path from "node:path";
var __vite_injected_original_dirname = "C:\\Users\\SUBRAMANYAM\\Downloads\\scm-erp-22-08\\frontend";
var apiTarget = process.env.VITE_API_PROXY || "http://localhost:8000";
var vite_config_default = defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__vite_injected_original_dirname, "src") }
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
      ignored: ["**/dist/**", "**/*.log.out", "**/*.log.err"]
    },
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true }
    }
  },
  preview: {
    host: true,
    port: 4173,
    allowedHosts: true,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true }
    }
  },
  build: {
    chunkSizeWarningLimit: 1e3,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          heroui: ["@heroui/react", "framer-motion"],
          data: ["@tanstack/react-query", "axios"]
        }
      }
    }
  }
});

// vitest.config.ts
var vitest_config_default = mergeConfig(
  vite_config_default,
  defineConfig2({
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
      css: false
    }
  })
);
export {
  vitest_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy50cyIsICJ2aXRlLmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIkM6XFxcXFVzZXJzXFxcXFNVQlJBTUFOWUFNXFxcXERvd25sb2Fkc1xcXFxzY20tZXJwLTIyLTA4XFxcXGZyb250ZW5kXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCJDOlxcXFxVc2Vyc1xcXFxTVUJSQU1BTllBTVxcXFxEb3dubG9hZHNcXFxcc2NtLWVycC0yMi0wOFxcXFxmcm9udGVuZFxcXFx2aXRlc3QuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9DOi9Vc2Vycy9TVUJSQU1BTllBTS9Eb3dubG9hZHMvc2NtLWVycC0yMi0wOC9mcm9udGVuZC92aXRlc3QuY29uZmlnLnRzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnLCBtZXJnZUNvbmZpZyB9IGZyb20gXCJ2aXRlc3QvY29uZmlnXCI7XHJcbmltcG9ydCB2aXRlQ29uZmlnIGZyb20gXCIuL3ZpdGUuY29uZmlnXCI7XHJcblxyXG4vLyBFeHRlbmRzIHRoZSBhcHAncyBWaXRlIGNvbmZpZyB3aXRoIHRlc3Qtb25seSBzZXR0aW5ncy4gS2VwdCBzZXBhcmF0ZSBmcm9tXHJcbi8vIHZpdGUuY29uZmlnLnRzIHNvIHRoZSBwcm9kdWN0aW9uIGB0c2MgLWJgIHR5cGVjaGVjayBzdGF5cyBjbGVhbi5cclxuZXhwb3J0IGRlZmF1bHQgbWVyZ2VDb25maWcoXHJcbiAgdml0ZUNvbmZpZyxcclxuICBkZWZpbmVDb25maWcoe1xyXG4gICAgdGVzdDoge1xyXG4gICAgICBnbG9iYWxzOiB0cnVlLFxyXG4gICAgICBlbnZpcm9ubWVudDogXCJqc2RvbVwiLFxyXG4gICAgICBzZXR1cEZpbGVzOiBcIi4vc3JjL3Rlc3Qvc2V0dXAudHNcIixcclxuICAgICAgY3NzOiBmYWxzZSxcclxuICAgIH0sXHJcbiAgfSksXHJcbik7XHJcbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiQzpcXFxcVXNlcnNcXFxcU1VCUkFNQU5ZQU1cXFxcRG93bmxvYWRzXFxcXHNjbS1lcnAtMjItMDhcXFxcZnJvbnRlbmRcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIkM6XFxcXFVzZXJzXFxcXFNVQlJBTUFOWUFNXFxcXERvd25sb2Fkc1xcXFxzY20tZXJwLTIyLTA4XFxcXGZyb250ZW5kXFxcXHZpdGUuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9DOi9Vc2Vycy9TVUJSQU1BTllBTS9Eb3dubG9hZHMvc2NtLWVycC0yMi0wOC9mcm9udGVuZC92aXRlLmNvbmZpZy50c1wiO2ltcG9ydCB7IGRlZmluZUNvbmZpZyB9IGZyb20gXCJ2aXRlXCI7XHJcbmltcG9ydCByZWFjdCBmcm9tIFwiQHZpdGVqcy9wbHVnaW4tcmVhY3RcIjtcclxuaW1wb3J0IHRhaWx3aW5kY3NzIGZyb20gXCJAdGFpbHdpbmRjc3Mvdml0ZVwiO1xyXG5pbXBvcnQgcGF0aCBmcm9tIFwibm9kZTpwYXRoXCI7XHJcblxyXG4vLyBEZXYgQVBJIHRhcmdldCBjb21lcyBmcm9tIGVudiAobm8gaGFyZGNvZGVkIGhvc3QpOyBmYWxscyBiYWNrIHRvIGxvY2FsIGJhY2tlbmQuXHJcbmNvbnN0IGFwaVRhcmdldCA9IHByb2Nlc3MuZW52LlZJVEVfQVBJX1BST1hZIHx8IFwiaHR0cDovL2xvY2FsaG9zdDo4MDAwXCI7XHJcblxyXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xyXG4gIHBsdWdpbnM6IFtyZWFjdCgpLCB0YWlsd2luZGNzcygpXSxcclxuICByZXNvbHZlOiB7XHJcbiAgICBhbGlhczogeyBcIkBcIjogcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgXCJzcmNcIikgfSxcclxuICB9LFxyXG4gIHNlcnZlcjoge1xyXG4gICAgLy8gTGlzdGVuIG9uIGV2ZXJ5IGludGVyZmFjZSBzbyBwaG9uZXMgYW5kIG90aGVyIG1hY2hpbmVzIG9uIHRoZSBMQU4gY2FuIG9wZW5cclxuICAgIC8vIHRoZSBhcHAuIFRoZSAvYXBpIHByb3h5IHN0aWxsIHBvaW50cyBhdCBhcGlUYXJnZXQsIHNvIGEgZGV2aWNlIG9ubHkgbmVlZHMgdG9cclxuICAgIC8vIHJlYWNoIHRoaXMgcG9ydCBcdTIwMTQgdGhlIGJhY2tlbmQgY2FuIHN0YXkgb24gbG9jYWxob3N0LlxyXG4gICAgaG9zdDogdHJ1ZSxcclxuICAgIHBvcnQ6IDUxNzMsXHJcbiAgICBzdHJpY3RQb3J0OiB0cnVlLFxyXG4gICAgLy8gQWNjZXB0IGFueSBIb3N0IGhlYWRlci4gVml0ZSdzIEROUy1yZWJpbmRpbmcgZ3VhcmQgcmVqZWN0cyB0dW5uZWwgaG9zdG5hbWVzXHJcbiAgICAvLyAobmdyb2ssIENsb3VkZmxhcmUpIGl0IHdhcyBub3QgdG9sZCBhYm91dCwgd2hpY2ggaXMgd2hhdCBibG9ja3MgZGVtb2luZyB0aGVcclxuICAgIC8vIGRldiBzZXJ2ZXIgb3ZlciBhIHNoYXJlIGxpbmsuIERldiBhbmQgcHJldmlldyBvbmx5IFx1MjAxNCBgdml0ZSBidWlsZGAgb3V0cHV0IGlzXHJcbiAgICAvLyBzdGF0aWMgZmlsZXMgYW5kIGlzIHVuYWZmZWN0ZWQsIHNvIG5vdGhpbmcgaGVyZSByZWFjaGVzIHByb2R1Y3Rpb24uXHJcbiAgICBhbGxvd2VkSG9zdHM6IHRydWUsXHJcbiAgICAvLyBXaGF0IHRoZSBkZXYgc2VydmVyIG11c3QgTk9UIHRyZWF0IGFzIGEgc291cmNlIGNoYW5nZS5cclxuICAgIC8vXHJcbiAgICAvLyBWaXRlIHdhdGNoZXMgdGhlIHByb2plY3Qgcm9vdCwgYW5kIHR3byB0aGluZ3MgdW5kZXIgaXQgYXJlIHdyaXR0ZW4gd2hpbGUgdGhlXHJcbiAgICAvLyBzZXJ2ZXIgaXMgcnVubmluZzogYGRpc3QvYCAoZXZlcnkgYG5wbSBydW4gYnVpbGRgKSBhbmQgdGhlIGB2aXRlLioubG9nLipgIGZpbGVzXHJcbiAgICAvLyB0aGUgc2VydmVyJ3Mgb3duIG91dHB1dCBpcyBwaXBlZCBpbnRvLiBCb3RoIHdlcmUgdHJpZ2dlcmluZyBGVUxMIHBhZ2UgcmVsb2FkcyBcdTIwMTRcclxuICAgIC8vIDIxIG9mIHRoZW0gaW4gb25lIHNlc3Npb24sIGV2ZXJ5IHNpbmdsZSByZWxvYWQgaW4gdGhlIGxvZyBcdTIwMTQgd2hpY2ggdGhyb3dzIGF3YXlcclxuICAgIC8vIFJlYWN0IHN0YXRlLCBzbyBhIHNjcmVlbiB0aGF0IGhhZCBqdXN0IGJlZW4gZmlsbGVkIGluIG9yIGhhZCBqdXN0IHJlcG9ydGVkIHRoZVxyXG4gICAgLy8gcmVzdWx0IG9mIGEgcHJlc3Mgd2VudCBibGFuayBhbmQgcmUtbW91bnRlZCBmcm9tIHRoZSBVUkwuXHJcbiAgICAvL1xyXG4gICAgLy8gVGhlIGxvZyBmaWxlcyBhcmUgdGhlIHdvcnNlIGhhbGY6IHRoZSBzZXJ2ZXIgbG9ncyBhIHJlcXVlc3QsIHRoZSBsb2cgZmlsZVxyXG4gICAgLy8gY2hhbmdlcywgdGhlIHdhdGNoZXIgcmVsb2FkcyB0aGUgcGFnZSwgdGhlIHBhZ2UgbWFrZXMgcmVxdWVzdHMsIHRoZSBzZXJ2ZXIgbG9nc1xyXG4gICAgLy8gdGhlbS4gVGhhdCBpcyBhIHJlbG9hZCBsb29wIGZlZWRpbmcgaXRzZWxmLCB3aXRoIG5vIHNvdXJjZSBmaWxlIGludm9sdmVkLlxyXG4gICAgd2F0Y2g6IHtcclxuICAgICAgaWdub3JlZDogW1wiKiovZGlzdC8qKlwiLCBcIioqLyoubG9nLm91dFwiLCBcIioqLyoubG9nLmVyclwiXSxcclxuICAgIH0sXHJcbiAgICBwcm94eToge1xyXG4gICAgICBcIi9hcGlcIjogeyB0YXJnZXQ6IGFwaVRhcmdldCwgY2hhbmdlT3JpZ2luOiB0cnVlIH0sXHJcbiAgICB9LFxyXG4gIH0sXHJcbiAgcHJldmlldzoge1xyXG4gICAgaG9zdDogdHJ1ZSxcclxuICAgIHBvcnQ6IDQxNzMsXHJcbiAgICBhbGxvd2VkSG9zdHM6IHRydWUsXHJcbiAgICBwcm94eToge1xyXG4gICAgICBcIi9hcGlcIjogeyB0YXJnZXQ6IGFwaVRhcmdldCwgY2hhbmdlT3JpZ2luOiB0cnVlIH0sXHJcbiAgICB9LFxyXG4gIH0sXHJcbiAgYnVpbGQ6IHtcclxuICAgIGNodW5rU2l6ZVdhcm5pbmdMaW1pdDogMTAwMCxcclxuICAgIHJvbGx1cE9wdGlvbnM6IHtcclxuICAgICAgb3V0cHV0OiB7XHJcbiAgICAgICAgbWFudWFsQ2h1bmtzOiB7XHJcbiAgICAgICAgICByZWFjdDogW1wicmVhY3RcIiwgXCJyZWFjdC1kb21cIiwgXCJyZWFjdC1yb3V0ZXItZG9tXCJdLFxyXG4gICAgICAgICAgaGVyb3VpOiBbXCJAaGVyb3VpL3JlYWN0XCIsIFwiZnJhbWVyLW1vdGlvblwiXSxcclxuICAgICAgICAgIGRhdGE6IFtcIkB0YW5zdGFjay9yZWFjdC1xdWVyeVwiLCBcImF4aW9zXCJdLFxyXG4gICAgICAgIH0sXHJcbiAgICAgIH0sXHJcbiAgICB9LFxyXG4gIH0sXHJcbn0pO1xyXG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQWlXLFNBQVMsZ0JBQUFBLGVBQWMsbUJBQW1COzs7QUNBOUMsU0FBUyxvQkFBb0I7QUFDMVgsT0FBTyxXQUFXO0FBQ2xCLE9BQU8saUJBQWlCO0FBQ3hCLE9BQU8sVUFBVTtBQUhqQixJQUFNLG1DQUFtQztBQU16QyxJQUFNLFlBQVksUUFBUSxJQUFJLGtCQUFrQjtBQUVoRCxJQUFPLHNCQUFRLGFBQWE7QUFBQSxFQUMxQixTQUFTLENBQUMsTUFBTSxHQUFHLFlBQVksQ0FBQztBQUFBLEVBQ2hDLFNBQVM7QUFBQSxJQUNQLE9BQU8sRUFBRSxLQUFLLEtBQUssUUFBUSxrQ0FBVyxLQUFLLEVBQUU7QUFBQSxFQUMvQztBQUFBLEVBQ0EsUUFBUTtBQUFBO0FBQUE7QUFBQTtBQUFBLElBSU4sTUFBTTtBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sWUFBWTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFLWixjQUFjO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFhZCxPQUFPO0FBQUEsTUFDTCxTQUFTLENBQUMsY0FBYyxnQkFBZ0IsY0FBYztBQUFBLElBQ3hEO0FBQUEsSUFDQSxPQUFPO0FBQUEsTUFDTCxRQUFRLEVBQUUsUUFBUSxXQUFXLGNBQWMsS0FBSztBQUFBLElBQ2xEO0FBQUEsRUFDRjtBQUFBLEVBQ0EsU0FBUztBQUFBLElBQ1AsTUFBTTtBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sY0FBYztBQUFBLElBQ2QsT0FBTztBQUFBLE1BQ0wsUUFBUSxFQUFFLFFBQVEsV0FBVyxjQUFjLEtBQUs7QUFBQSxJQUNsRDtBQUFBLEVBQ0Y7QUFBQSxFQUNBLE9BQU87QUFBQSxJQUNMLHVCQUF1QjtBQUFBLElBQ3ZCLGVBQWU7QUFBQSxNQUNiLFFBQVE7QUFBQSxRQUNOLGNBQWM7QUFBQSxVQUNaLE9BQU8sQ0FBQyxTQUFTLGFBQWEsa0JBQWtCO0FBQUEsVUFDaEQsUUFBUSxDQUFDLGlCQUFpQixlQUFlO0FBQUEsVUFDekMsTUFBTSxDQUFDLHlCQUF5QixPQUFPO0FBQUEsUUFDekM7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFDRixDQUFDOzs7QUQzREQsSUFBTyx3QkFBUTtBQUFBLEVBQ2I7QUFBQSxFQUNBQyxjQUFhO0FBQUEsSUFDWCxNQUFNO0FBQUEsTUFDSixTQUFTO0FBQUEsTUFDVCxhQUFhO0FBQUEsTUFDYixZQUFZO0FBQUEsTUFDWixLQUFLO0FBQUEsSUFDUDtBQUFBLEVBQ0YsQ0FBQztBQUNIOyIsCiAgIm5hbWVzIjogWyJkZWZpbmVDb25maWciLCAiZGVmaW5lQ29uZmlnIl0KfQo=
