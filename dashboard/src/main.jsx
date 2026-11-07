/**
 * Entry point. Order matters for CSS: self-hosted variable fonts (latin glyphs are fetched
 * on demand through unicode-range), MapLibre's base CSS, the generated design tokens, then
 * the app styles that compose them.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/space-grotesk/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./design/tokens.css";
import "./index.css";
import App from "./App.jsx";
import { DataProvider } from "./state/DataContext.jsx";
import { ErrorBoundary } from "./components/common/ErrorBoundary.jsx";

const container = document.getElementById("root");
if (!container) throw new Error('index.html is missing the <div id="root"> mount point.');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary title="NCR THERMAL/OPS crashed">
      <DataProvider>
        <App />
      </DataProvider>
    </ErrorBoundary>
  </StrictMode>,
);
