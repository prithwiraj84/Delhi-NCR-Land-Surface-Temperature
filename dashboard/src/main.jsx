import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css";
import "./index.css";
import App from "./App.jsx";
import { DataProvider } from "./state/DataContext.jsx";
import { ErrorBoundary } from "./components/common/ErrorBoundary.jsx";

const container = document.getElementById("root");
if (!container) throw new Error('index.html is missing the <div id="root"> mount point.');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary title="The dashboard crashed">
      <DataProvider>
        <App />
      </DataProvider>
    </ErrorBoundary>
  </StrictMode>,
);
