import React from "react";
import { createRoot } from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import { storage } from "./storage.js";
import SpotOn from "./SpotOn.jsx";

// The game calls window.storage.* (the artifact API). Provide a real one.
window.storage = storage;

// Register the service worker so the app is installable to a home screen.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <SpotOn />
    <Analytics />
  </React.StrictMode>
);
