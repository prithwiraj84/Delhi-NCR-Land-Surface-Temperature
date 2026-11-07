/**
 * Code-split MapLibre basemap for the v2 ThermalStage.
 *
 * MapLibre GL (+ react-map-gl) is ~200 kB gzip, about a third of the map stack. The thermal
 * layers never depend on the basemap (Basemap.jsx already degrades to the void background),
 * so the basemap chunk is fetched in parallel with - not ahead of - the first deck.gl paint:
 * the LST columns render as soon as deck.gl is up and the basemap fades in underneath when its
 * chunk and style arrive (UI_SPEC_v2 §11: initial JS and first-map-paint budgets).
 *
 * DeckGL treats any child element with a `mapStyle` prop as a react-map-gl map and clones it
 * with the synchronised `viewState` and an under-the-canvas `style`. This wrapper carries
 * `mapStyle` itself, so it receives those props and passes them straight through.
 *
 * A failed chunk load (offline, blocked CDN, stale deploy) is reported through `onFailure`
 * exactly like a style failure, and never takes the stage down.
 */
import { Component, lazy, Suspense } from "react";

// The import starts on the first render of DeckGL's children, i.e. right after the engine is
// created - in parallel with deck.gl's device initialisation and the first frame upload.
const Basemap = lazy(() => import("./Basemap.jsx"));

/** Catches a rejected chunk import (React.lazy rethrows it during render). */
class BasemapChunkBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    this.props.onFailure?.(error instanceof Error ? error : new Error("Basemap failed to load"));
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * @param {object} props same props as Basemap.jsx (`mapStyle`, `onFailure`, `onReady`, and the
 *   `viewState` / `style` DeckGL injects)
 */
export default function LazyBasemap(props) {
  return (
    <BasemapChunkBoundary onFailure={props.onFailure}>
      <Suspense fallback={null}>
        <Basemap {...props} />
      </Suspense>
    </BasemapChunkBoundary>
  );
}
