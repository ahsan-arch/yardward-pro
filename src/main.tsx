import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { initPwaUpdater } from "./lib/pwa-updater";
import "leaflet/dist/leaflet.css";
import "./styles.css";

// Kick off SW registration before React mounts so onNeedRefresh can fire as
// soon as a new build is detected. The PwaUpdateBanner subscribes to the
// module-scoped emitter exposed by lib/pwa-updater.
initPwaUpdater();

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found in index.html");

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
