import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

// Vite config for the luredash 廣告管理平台 React frontend.
//
// Key decisions:
// - outDir points to ../dist (repo-root) so FastAPI main.py can serve it
//   via StaticFiles(directory="dist") without path gymnastics.
// - API calls are proxied to the FastAPI server on port 8001 during dev,
//   so `fetch('/api/...')` works the same in dev and in production where
//   FastAPI serves both the static bundle and the API.
// - vite-plugin-pwa generates a Workbox service worker that replaces the
//   hand-rolled static/sw.js, with the same #FF6B2C theme color and
//   luredash branding.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.png", "icon-192.png", "icon-512.png"],
      manifest: {
        name: "luredash | Meta AI 廣告智能平台",
        short_name: "luredash",
        description: "Facebook Ads management dashboard",
        theme_color: "#FF6B2C",
        background_color: "#FFFFFF",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        // Explicit scope avoids older iOS Safari defaulting the PWA
        // scope to the manifest path and refusing to control routes
        // like /analytics or /r/:id. Modern browsers infer this from
        // start_url anyway, so it's belt-and-suspenders.
        scope: "/",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any maskable",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // API calls bypass the SW cache entirely. React Query
            // already owns application-level caching with proper
            // invalidation on mutations; a second SW cache in front
            // of it could serve a stale campaign list right after a
            // PAUSE toggle (NetworkFirst falls back to stale-cache on
            // a slow network even when the POST succeeded), which is
            // the "關掉廣告沒反應" symptom we hit in production.
            urlPattern: /\/api\//,
            handler: "NetworkOnly",
          },
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\//,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts",
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // No sourcemaps in the production build. Vite emits ~3MB of
    // .js.map files on top of the ~700KB of real JS, which balloons
    // the Docker image (and the Zeabur cold-start fetch) for zero
    // production benefit — sourcemaps are a devtools-only feature
    // and devs can re-run `pnpm build` locally with a temp flag to
    // get them back when needed. Set VITE_SOURCEMAP=1 to opt back in.
    sourcemap: process.env.VITE_SOURCEMAP === "1",
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          charts: ["chart.js", "react-chartjs-2", "chartjs-plugin-datalabels"],
          query: ["@tanstack/react-query"],
          // Only the two Radix packages we actually import live in
          // this chunk. Unused radix deps were removed from
          // package.json entirely in the 2026-04-15 slim pass.
          ui: ["@radix-ui/react-dialog", "@radix-ui/react-popover"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8001",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
  },
});
