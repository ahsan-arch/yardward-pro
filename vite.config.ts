import { defineConfig } from "vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    tsConfigPaths(),
    tailwindcss(),
    TanStackRouterVite({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "src/routes",
      generatedRouteTree: "src/routeTree.gen.ts",
    }),
    viteReact(),
    VitePWA({
      // We deliberately use "prompt" + manual registration so drivers in the
      // middle of a work order don't get the SW hot-swapped under them. The
      // PwaUpdateBanner consumes the registerSW() hooks in main.tsx and only
      // calls updateSW(true) when the user clicks Reload.
      registerType: "prompt",
      injectRegister: false,
      strategies: "generateSW",
      includeAssets: ["favicon.ico", "manifest.webmanifest"],
      // The manifest in public/manifest.webmanifest is the source of truth.
      // We disable plugin manifest generation so it doesn't overwrite ours.
      manifest: false,
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webp}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api/, /^\/functions/],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: {
    port: 5173,
    host: true,
  },
  preview: {
    port: 4173,
    host: true,
  },
  resolve: {
    dedupe: ["react", "react-dom", "@tanstack/react-router"],
  },
});
