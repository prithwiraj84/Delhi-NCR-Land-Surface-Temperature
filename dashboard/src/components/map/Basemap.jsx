/**
 * CARTO Dark Matter basemap rendered by MapLibre underneath the deck.gl canvas.
 *
 * DeckGL recognises this element as a react-map-gl map because it carries a `mapStyle`
 * prop, and clones it with the synchronised `viewState` + `style`, so the basemap
 * follows the controlled deck.gl camera without its own interaction handlers.
 *
 * Resilience: the thermal layers must never depend on the basemap. A style that fails
 * to load (offline, blocked CDN), a style that never finishes loading, or MapLibre
 * throwing during construction (e.g. no WebGL context left) all report through
 * `onFailure`; the deck layers keep rendering over the dark page background. If the
 * style arrives after a timeout report, `onReady` lets the parent retract the notice.
 */
import { Component, useEffect, useRef } from "react";
import MapGL from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";

export const BASEMAP_STYLE_URL = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

/**
 * Same Dark Matter style without place labels. Used while the dashboard's own district
 * labels are on, so basemap city names ("PANIPAT", "Rohtak", ...) do not print on top of
 * (or next to duplicates of) the district labels. With district labels off, the labelled
 * style returns to give geographic context.
 */
export const BASEMAP_STYLE_NOLABELS_URL = "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json";

/** A style that has not loaded after this long is reported as unavailable. */
const STYLE_TIMEOUT_MS = 15000;

/** Catches MapLibre construction errors so they cannot take the whole view down. */
class BasemapErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    this.props.onFailure?.(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * @param {object} props
 * @param {string} props.mapStyle          style URL (also DeckGL's react-map-gl marker)
 * @param {object} [props.viewState]       injected by DeckGL
 * @param {object} [props.style]           injected by DeckGL (places the map under the canvas)
 * @param {(error: unknown) => void} props.onFailure
 * @param {() => void} [props.onReady]
 */
export default function Basemap({ mapStyle, viewState, style, onFailure, onReady }) {
  const loadedRef = useRef(false);
  const reportedRef = useRef(false);

  const report = (error) => {
    if (reportedRef.current) return;
    reportedRef.current = true;
    onFailure?.(error);
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!loadedRef.current) report(new Error("Basemap style did not load in time"));
    }, STYLE_TIMEOUT_MS);
    return () => clearTimeout(timer);
    // `report` only closes over refs and the latest onFailure; run once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The style counts as healthy as soon as it is parsed (first `styledata`): MapLibre's
  // `load` additionally waits for every initial tile, which can take long on slow links.
  // A late success also retracts an earlier timeout report via onReady.
  const handleReady = () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    reportedRef.current = false;
    onReady?.();
  };

  const handleError = (event) => {
    // After the style is up, individual tile/sprite errors are cosmetic: ignore them.
    if (loadedRef.current) return;
    report(event?.error ?? event);
  };

  return (
    <BasemapErrorBoundary onFailure={report}>
      <MapGL
        mapStyle={mapStyle}
        viewState={viewState}
        style={style}
        reuseMaps
        interactive={false}
        attributionControl
        onStyleData={handleReady}
        onLoad={handleReady}
        onError={handleError}
      />
    </BasemapErrorBoundary>
  );
}
