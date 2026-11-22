import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/app";

try {
  const savedTheme = localStorage.getItem("memory-forge.theme");
  if (savedTheme === "chrono" || savedTheme === "braun") {
    document.documentElement.dataset.theme = savedTheme;
  }
} catch {}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
