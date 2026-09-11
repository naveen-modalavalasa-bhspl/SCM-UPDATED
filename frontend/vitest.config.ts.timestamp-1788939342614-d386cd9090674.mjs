// vitest.config.ts
import { defineConfig as defineConfig2, mergeConfig } from "file:///C:/Users/User-4/Downloads/scm%20-%20naveen/frontend/node_modules/vitest/dist/config.js";

// vite.config.ts
import { defineConfig } from "file:///C:/Users/User-4/Downloads/scm%20-%20naveen/frontend/node_modules/vite/dist/node/index.js";
import react from "file:///C:/Users/User-4/Downloads/scm%20-%20naveen/frontend/node_modules/@vitejs/plugin-react/dist/index.js";
import tailwindcss from "file:///C:/Users/User-4/Downloads/scm%20-%20naveen/frontend/node_modules/@tailwindcss/vite/dist/index.mjs";
import path from "node:path";
var __vite_injected_original_dirname = "C:\\Users\\User-4\\Downloads\\scm - naveen\\frontend";
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
      clientFiles: ["./src/pages/*.tsx", "./src/modules/*/pages/**/*.tsx"]
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
    include: ["recharts", "xlsx", "qrcode.react", "react-barcode", "react-to-print"]
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy50cyIsICJ2aXRlLmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIkM6XFxcXFVzZXJzXFxcXFVzZXItNFxcXFxEb3dubG9hZHNcXFxcc2NtIC0gbmF2ZWVuXFxcXGZyb250ZW5kXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCJDOlxcXFxVc2Vyc1xcXFxVc2VyLTRcXFxcRG93bmxvYWRzXFxcXHNjbSAtIG5hdmVlblxcXFxmcm9udGVuZFxcXFx2aXRlc3QuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9DOi9Vc2Vycy9Vc2VyLTQvRG93bmxvYWRzL3NjbSUyMC0lMjBuYXZlZW4vZnJvbnRlbmQvdml0ZXN0LmNvbmZpZy50c1wiO2ltcG9ydCB7IGRlZmluZUNvbmZpZywgbWVyZ2VDb25maWcgfSBmcm9tIFwidml0ZXN0L2NvbmZpZ1wiO1xyXG5pbXBvcnQgdml0ZUNvbmZpZyBmcm9tIFwiLi92aXRlLmNvbmZpZ1wiO1xyXG5cclxuLy8gRXh0ZW5kcyB0aGUgYXBwJ3MgVml0ZSBjb25maWcgd2l0aCB0ZXN0LW9ubHkgc2V0dGluZ3MuIEtlcHQgc2VwYXJhdGUgZnJvbVxyXG4vLyB2aXRlLmNvbmZpZy50cyBzbyB0aGUgcHJvZHVjdGlvbiBgdHNjIC1iYCB0eXBlY2hlY2sgc3RheXMgY2xlYW4uXHJcbmV4cG9ydCBkZWZhdWx0IG1lcmdlQ29uZmlnKFxyXG4gIHZpdGVDb25maWcsXHJcbiAgZGVmaW5lQ29uZmlnKHtcclxuICAgIHRlc3Q6IHtcclxuICAgICAgZ2xvYmFsczogdHJ1ZSxcclxuICAgICAgZW52aXJvbm1lbnQ6IFwianNkb21cIixcclxuICAgICAgc2V0dXBGaWxlczogXCIuL3NyYy90ZXN0L3NldHVwLnRzXCIsXHJcbiAgICAgIGNzczogZmFsc2UsXHJcbiAgICB9LFxyXG4gIH0pLFxyXG4pO1xyXG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIkM6XFxcXFVzZXJzXFxcXFVzZXItNFxcXFxEb3dubG9hZHNcXFxcc2NtIC0gbmF2ZWVuXFxcXGZyb250ZW5kXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCJDOlxcXFxVc2Vyc1xcXFxVc2VyLTRcXFxcRG93bmxvYWRzXFxcXHNjbSAtIG5hdmVlblxcXFxmcm9udGVuZFxcXFx2aXRlLmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vQzovVXNlcnMvVXNlci00L0Rvd25sb2Fkcy9zY20lMjAtJTIwbmF2ZWVuL2Zyb250ZW5kL3ZpdGUuY29uZmlnLnRzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSBcInZpdGVcIjtcclxuaW1wb3J0IHJlYWN0IGZyb20gXCJAdml0ZWpzL3BsdWdpbi1yZWFjdFwiO1xyXG5pbXBvcnQgdGFpbHdpbmRjc3MgZnJvbSBcIkB0YWlsd2luZGNzcy92aXRlXCI7XHJcbmltcG9ydCBwYXRoIGZyb20gXCJub2RlOnBhdGhcIjtcclxuXHJcbi8vIERldiBBUEkgdGFyZ2V0IGNvbWVzIGZyb20gZW52IChubyBoYXJkY29kZWQgaG9zdCk7IGZhbGxzIGJhY2sgdG8gbG9jYWwgYmFja2VuZC5cclxuY29uc3QgYXBpVGFyZ2V0ID0gcHJvY2Vzcy5lbnYuVklURV9BUElfUFJPWFkgfHwgXCJodHRwOi8vbG9jYWxob3N0OjgwMDBcIjtcclxuXHJcbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XHJcbiAgcGx1Z2luczogW3JlYWN0KCksIHRhaWx3aW5kY3NzKCldLFxyXG4gIHJlc29sdmU6IHtcclxuICAgIGFsaWFzOiB7IFwiQFwiOiBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCBcInNyY1wiKSB9LFxyXG4gIH0sXHJcbiAgc2VydmVyOiB7XHJcbiAgICAvLyBMaXN0ZW4gb24gZXZlcnkgaW50ZXJmYWNlIHNvIHBob25lcyBhbmQgb3RoZXIgbWFjaGluZXMgb24gdGhlIExBTiBjYW4gb3BlblxyXG4gICAgLy8gdGhlIGFwcC4gVGhlIC9hcGkgcHJveHkgc3RpbGwgcG9pbnRzIGF0IGFwaVRhcmdldCwgc28gYSBkZXZpY2Ugb25seSBuZWVkcyB0b1xyXG4gICAgLy8gcmVhY2ggdGhpcyBwb3J0IFx1MjAxNCB0aGUgYmFja2VuZCBjYW4gc3RheSBvbiBsb2NhbGhvc3QuXHJcbiAgICBob3N0OiB0cnVlLFxyXG4gICAgcG9ydDogNTE3MyxcclxuICAgIHN0cmljdFBvcnQ6IHRydWUsXHJcbiAgICAvLyBDb21waWxlIHRoZSBzY3JlZW5zIEJFRk9SRSB0aGV5IGFyZSBjbGlja2VkICgyMDI2LTA5LTA0KS5cclxuICAgIC8vXHJcbiAgICAvLyBBcHAudHN4IG1vdmVkIGV2ZXJ5IHJvdXRlIGJlaGluZCBgUmVhY3QubGF6eWAgc28gYSBkZXBsb3llZCB1c2VyIGRvd25sb2FkcyBvbmVcclxuICAgIC8vIHNjcmVlbiBpbnN0ZWFkIG9mIGFsbCAxMjAuIFRoZSBkZXYgc2VydmVyIGhhcyBubyBidW5kbGUsIHNvIHRoZSBzYW1lIGNoYW5nZVxyXG4gICAgLy8gbW92ZWQgZWFjaCBzY3JlZW4ncyB0cmFuc2Zvcm0gdG8gdGhlIG1vbWVudCBpdCBpcyBmaXJzdCBuYXZpZ2F0ZWQgdG8gXHUyMDE0IHRoZVxyXG4gICAgLy8gcm91dGUgYW5kIGl0cyB3aG9sZSBpbXBvcnQgdHJlZSAoSGVyb1VJLCByZWNoYXJ0cywgeGxzeCkgY29tcGlsZWQgb24gdGhlIGNsaWNrLlxyXG4gICAgLy8gV2FybXVwIGRvZXMgdGhhdCB3b3JrIGF0IHN0YXJ0dXAgaW5zdGVhZCwgd2hpbGUgdGhlIGxvZ2luIHNjcmVlbiBpcyB1cC5cclxuICAgIC8vXHJcbiAgICAvLyBEZXYgc2VydmVyIG9ubHkuIGB2aXRlIGJ1aWxkYCBpcyBSb2xsdXAgYW5kIG5ldmVyIHJlYWRzIGBzZXJ2ZXIuKmAsIHNvIHRoZVxyXG4gICAgLy8gZGVwbG95ZWQgYnVuZGxlIGlzIGJ5dGUtaWRlbnRpY2FsIHdpdGggb3Igd2l0aG91dCB0aGlzLlxyXG4gICAgd2FybXVwOiB7XHJcbiAgICAgIGNsaWVudEZpbGVzOiBbXCIuL3NyYy9wYWdlcy8qLnRzeFwiLCBcIi4vc3JjL21vZHVsZXMvKi9wYWdlcy8qKi8qLnRzeFwiXSxcclxuICAgIH0sXHJcbiAgICAvLyBBY2NlcHQgYW55IEhvc3QgaGVhZGVyLiBWaXRlJ3MgRE5TLXJlYmluZGluZyBndWFyZCByZWplY3RzIHR1bm5lbCBob3N0bmFtZXNcclxuICAgIC8vIChuZ3JvaywgQ2xvdWRmbGFyZSkgaXQgd2FzIG5vdCB0b2xkIGFib3V0LCB3aGljaCBpcyB3aGF0IGJsb2NrcyBkZW1vaW5nIHRoZVxyXG4gICAgLy8gZGV2IHNlcnZlciBvdmVyIGEgc2hhcmUgbGluay4gRGV2IGFuZCBwcmV2aWV3IG9ubHkgXHUyMDE0IGB2aXRlIGJ1aWxkYCBvdXRwdXQgaXNcclxuICAgIC8vIHN0YXRpYyBmaWxlcyBhbmQgaXMgdW5hZmZlY3RlZCwgc28gbm90aGluZyBoZXJlIHJlYWNoZXMgcHJvZHVjdGlvbi5cclxuICAgIGFsbG93ZWRIb3N0czogdHJ1ZSxcclxuICAgIC8vIFdoYXQgdGhlIGRldiBzZXJ2ZXIgbXVzdCBOT1QgdHJlYXQgYXMgYSBzb3VyY2UgY2hhbmdlLlxyXG4gICAgLy9cclxuICAgIC8vIFZpdGUgd2F0Y2hlcyB0aGUgcHJvamVjdCByb290LCBhbmQgdHdvIHRoaW5ncyB1bmRlciBpdCBhcmUgd3JpdHRlbiB3aGlsZSB0aGVcclxuICAgIC8vIHNlcnZlciBpcyBydW5uaW5nOiBgZGlzdC9gIChldmVyeSBgbnBtIHJ1biBidWlsZGApIGFuZCB0aGUgYHZpdGUuKi5sb2cuKmAgZmlsZXNcclxuICAgIC8vIHRoZSBzZXJ2ZXIncyBvd24gb3V0cHV0IGlzIHBpcGVkIGludG8uIEJvdGggd2VyZSB0cmlnZ2VyaW5nIEZVTEwgcGFnZSByZWxvYWRzIFx1MjAxNFxyXG4gICAgLy8gMjEgb2YgdGhlbSBpbiBvbmUgc2Vzc2lvbiwgZXZlcnkgc2luZ2xlIHJlbG9hZCBpbiB0aGUgbG9nIFx1MjAxNCB3aGljaCB0aHJvd3MgYXdheVxyXG4gICAgLy8gUmVhY3Qgc3RhdGUsIHNvIGEgc2NyZWVuIHRoYXQgaGFkIGp1c3QgYmVlbiBmaWxsZWQgaW4gb3IgaGFkIGp1c3QgcmVwb3J0ZWQgdGhlXHJcbiAgICAvLyByZXN1bHQgb2YgYSBwcmVzcyB3ZW50IGJsYW5rIGFuZCByZS1tb3VudGVkIGZyb20gdGhlIFVSTC5cclxuICAgIC8vXHJcbiAgICAvLyBUaGUgbG9nIGZpbGVzIGFyZSB0aGUgd29yc2UgaGFsZjogdGhlIHNlcnZlciBsb2dzIGEgcmVxdWVzdCwgdGhlIGxvZyBmaWxlXHJcbiAgICAvLyBjaGFuZ2VzLCB0aGUgd2F0Y2hlciByZWxvYWRzIHRoZSBwYWdlLCB0aGUgcGFnZSBtYWtlcyByZXF1ZXN0cywgdGhlIHNlcnZlciBsb2dzXHJcbiAgICAvLyB0aGVtLiBUaGF0IGlzIGEgcmVsb2FkIGxvb3AgZmVlZGluZyBpdHNlbGYsIHdpdGggbm8gc291cmNlIGZpbGUgaW52b2x2ZWQuXHJcbiAgICB3YXRjaDoge1xyXG4gICAgICBpZ25vcmVkOiBbXCIqKi9kaXN0LyoqXCIsIFwiKiovKi5sb2cub3V0XCIsIFwiKiovKi5sb2cuZXJyXCJdLFxyXG4gICAgfSxcclxuICAgIHByb3h5OiB7XHJcbiAgICAgIFwiL2FwaVwiOiB7IHRhcmdldDogYXBpVGFyZ2V0LCBjaGFuZ2VPcmlnaW46IHRydWUgfSxcclxuICAgIH0sXHJcbiAgfSxcclxuICBwcmV2aWV3OiB7XHJcbiAgICBob3N0OiB0cnVlLFxyXG4gICAgcG9ydDogNDE3MyxcclxuICAgIGFsbG93ZWRIb3N0czogdHJ1ZSxcclxuICAgIHByb3h5OiB7XHJcbiAgICAgIFwiL2FwaVwiOiB7IHRhcmdldDogYXBpVGFyZ2V0LCBjaGFuZ2VPcmlnaW46IHRydWUgfSxcclxuICAgIH0sXHJcbiAgfSxcclxuICAvLyBUaGUgaGVhdnkgZGVwZW5kZW5jaWVzLCBwcmVidW5kbGVkIGF0IGJvb3QgcmF0aGVyIHRoYW4gbWlkLW5hdmlnYXRpb24uXHJcbiAgLy9cclxuICAvLyBWaXRlIGRpc2NvdmVycyBkZXBlbmRlbmNpZXMgYnkgY3Jhd2xpbmcgZnJvbSB0aGUgZW50cnkuIEJlaGluZCBsYXp5IHJvdXRlcyB0aGVzZVxyXG4gIC8vIGZpdmUgYXJlIG5vdCByZWFjaGFibGUgdW50aWwgdGhlIHNjcmVlbiB0aGF0IHVzZXMgdGhlbSBpcyBvcGVuZWQsIGFuZCBtZWV0aW5nIGFcclxuICAvLyBuZXcgZGVwZW5kZW5jeSB0aGVuIHRyaWdnZXJzIGEgcmUtb3B0aW1pc2F0aW9uIEFORCBBIEZVTEwgUEFHRSBSRUxPQUQgXHUyMDE0IHdoaWNoIGlzXHJcbiAgLy8gdGhlIHdvcnN0IG9mIHdoYXQgYSBsYXp5IGRldiBzZXJ2ZXIgZmVlbHMgbGlrZSwgYmVjYXVzZSBpdCB0aHJvd3MgYXdheSB0aGUgc3RhdGVcclxuICAvLyBvZiB0aGUgc2NyZWVuIHlvdSBqdXN0IG9wZW5lZC4gTmFtaW5nIHRoZW0gbWFrZXMgdGhhdCBoYXBwZW4gb25jZSwgYXQgc3RhcnR1cC5cclxuICAvL1xyXG4gIC8vIERldiBzZXJ2ZXIgb25seSwgZXhhY3RseSBsaWtlIGBzZXJ2ZXIud2FybXVwYDogdGhlIHByb2R1Y3Rpb24gYnVpbGQgcHJlYnVuZGxlc1xyXG4gIC8vIG5vdGhpbmcgYW5kIGlnbm9yZXMgdGhpcyBrZXkuXHJcbiAgb3B0aW1pemVEZXBzOiB7XHJcbiAgICBpbmNsdWRlOiBbXCJyZWNoYXJ0c1wiLCBcInhsc3hcIiwgXCJxcmNvZGUucmVhY3RcIiwgXCJyZWFjdC1iYXJjb2RlXCIsIFwicmVhY3QtdG8tcHJpbnRcIl0sXHJcbiAgfSxcclxuICBidWlsZDoge1xyXG4gICAgY2h1bmtTaXplV2FybmluZ0xpbWl0OiAxMDAwLFxyXG4gICAgcm9sbHVwT3B0aW9uczoge1xyXG4gICAgICBvdXRwdXQ6IHtcclxuICAgICAgICBtYW51YWxDaHVua3M6IHtcclxuICAgICAgICAgIHJlYWN0OiBbXCJyZWFjdFwiLCBcInJlYWN0LWRvbVwiLCBcInJlYWN0LXJvdXRlci1kb21cIl0sXHJcbiAgICAgICAgICBoZXJvdWk6IFtcIkBoZXJvdWkvcmVhY3RcIiwgXCJmcmFtZXItbW90aW9uXCJdLFxyXG4gICAgICAgICAgZGF0YTogW1wiQHRhbnN0YWNrL3JlYWN0LXF1ZXJ5XCIsIFwiYXhpb3NcIl0sXHJcbiAgICAgICAgfSxcclxuICAgICAgfSxcclxuICAgIH0sXHJcbiAgfSxcclxufSk7XHJcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBbVYsU0FBUyxnQkFBQUEsZUFBYyxtQkFBbUI7OztBQ0E5QyxTQUFTLG9CQUFvQjtBQUM1VyxPQUFPLFdBQVc7QUFDbEIsT0FBTyxpQkFBaUI7QUFDeEIsT0FBTyxVQUFVO0FBSGpCLElBQU0sbUNBQW1DO0FBTXpDLElBQU0sWUFBWSxRQUFRLElBQUksa0JBQWtCO0FBRWhELElBQU8sc0JBQVEsYUFBYTtBQUFBLEVBQzFCLFNBQVMsQ0FBQyxNQUFNLEdBQUcsWUFBWSxDQUFDO0FBQUEsRUFDaEMsU0FBUztBQUFBLElBQ1AsT0FBTyxFQUFFLEtBQUssS0FBSyxRQUFRLGtDQUFXLEtBQUssRUFBRTtBQUFBLEVBQy9DO0FBQUEsRUFDQSxRQUFRO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFJTixNQUFNO0FBQUEsSUFDTixNQUFNO0FBQUEsSUFDTixZQUFZO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQVdaLFFBQVE7QUFBQSxNQUNOLGFBQWEsQ0FBQyxxQkFBcUIsZ0NBQWdDO0FBQUEsSUFDckU7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLElBS0EsY0FBYztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLElBYWQsT0FBTztBQUFBLE1BQ0wsU0FBUyxDQUFDLGNBQWMsZ0JBQWdCLGNBQWM7QUFBQSxJQUN4RDtBQUFBLElBQ0EsT0FBTztBQUFBLE1BQ0wsUUFBUSxFQUFFLFFBQVEsV0FBVyxjQUFjLEtBQUs7QUFBQSxJQUNsRDtBQUFBLEVBQ0Y7QUFBQSxFQUNBLFNBQVM7QUFBQSxJQUNQLE1BQU07QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOLGNBQWM7QUFBQSxJQUNkLE9BQU87QUFBQSxNQUNMLFFBQVEsRUFBRSxRQUFRLFdBQVcsY0FBYyxLQUFLO0FBQUEsSUFDbEQ7QUFBQSxFQUNGO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQVdBLGNBQWM7QUFBQSxJQUNaLFNBQVMsQ0FBQyxZQUFZLFFBQVEsZ0JBQWdCLGlCQUFpQixnQkFBZ0I7QUFBQSxFQUNqRjtBQUFBLEVBQ0EsT0FBTztBQUFBLElBQ0wsdUJBQXVCO0FBQUEsSUFDdkIsZUFBZTtBQUFBLE1BQ2IsUUFBUTtBQUFBLFFBQ04sY0FBYztBQUFBLFVBQ1osT0FBTyxDQUFDLFNBQVMsYUFBYSxrQkFBa0I7QUFBQSxVQUNoRCxRQUFRLENBQUMsaUJBQWlCLGVBQWU7QUFBQSxVQUN6QyxNQUFNLENBQUMseUJBQXlCLE9BQU87QUFBQSxRQUN6QztBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNGLENBQUM7OztBRHJGRCxJQUFPLHdCQUFRO0FBQUEsRUFDYjtBQUFBLEVBQ0FDLGNBQWE7QUFBQSxJQUNYLE1BQU07QUFBQSxNQUNKLFNBQVM7QUFBQSxNQUNULGFBQWE7QUFBQSxNQUNiLFlBQVk7QUFBQSxNQUNaLEtBQUs7QUFBQSxJQUNQO0FBQUEsRUFDRixDQUFDO0FBQ0g7IiwKICAibmFtZXMiOiBbImRlZmluZUNvbmZpZyIsICJkZWZpbmVDb25maWciXQp9Cg==
