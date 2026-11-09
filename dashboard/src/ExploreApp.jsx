"use client";
/**
 * Client root of the interactive explorer (/explore). Replaces the Vite-era src/main.jsx:
 * Next.js mounts it through next/dynamic with ssr: false (deck.gl, MapLibre and the web
 * workers are browser-only). Global CSS (fonts, tokens, index.css) comes from app/layout.jsx;
 * MapLibre's base CSS is only needed here.
 *
 * While mounted, <html data-app="explore"> turns the page into a fixed full-screen app
 * (index.css: no body scroll) and seeds the root attributes the shell keeps up to date.
 */
import { useEffect } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import App from "./App.jsx";
import { DataProvider } from "./state/DataContext.jsx";
import { ErrorBoundary } from "./components/common/ErrorBoundary.jsx";

export default function ExploreApp() {
  useEffect(() => {
    const el = document.documentElement;
    el.dataset.app = "explore";
    if (!el.dataset.motion) el.dataset.motion = "full";
    if (!el.dataset.perfTier) el.dataset.perfTier = "0";
    if (!el.dataset.mode) el.dataset.mode = "day";
    return () => {
      delete el.dataset.app;
    };
  }, []);

  return (
    <ErrorBoundary title="The explorer stopped working">
      <DataProvider>
        <App />
      </DataProvider>
    </ErrorBoundary>
  );
}
