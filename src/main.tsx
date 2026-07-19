import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/app";

const isTauriRuntime = "__TAURI_INTERNALS__" in window;

if (!isTauriRuntime && import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Plain HTTP LAN origins are not service-worker secure contexts.
    });
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
