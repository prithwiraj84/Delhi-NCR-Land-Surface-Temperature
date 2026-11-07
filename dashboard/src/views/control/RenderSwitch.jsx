/**
 * Render switch (UI_SPEC_v2 §3.2 VIEW, §5.2 F, §6.3): GRID 1 km | RASTER 250 m | AUTO.
 * RASTER is offered only when the current frame has a 250 m raster for the mode (manifest
 * `frames[].raster[mode]`); otherwise it stays visible with the reason ("1990: not
 * downscaled", or "rerun notebook v2" on v1 bundles). While the raster for the frame is
 * still loading a ring loader spins on the chip and the map stays at 1 km (the engine decides).
 */
import { Loader2 } from "lucide-react";
import { Segmented } from "../../components/ui/Segmented.jsx";
import { useRaster } from "../../data/hooks.js";
import { cn } from "../../lib/cn.js";
import { useTimeStore } from "../../state/stores/timeStore.js";
import { useViewStore } from "../../state/stores/viewStore.js";
import { announce } from "../../shell/announcer.js";
import { rasterAvailability } from "./layerModel.js";
import { useManifestData, useTimelineData } from "./useControlData.js";

/** @param {{compact?: boolean, className?: string}} props */
export function RenderSwitch({ compact = false, className }) {
  const renderMode = useViewStore((s) => s.renderMode);
  const year = useTimeStore((s) => s.year);
  const mode = useTimeStore((s) => s.mode ?? "day");
  const timeline = useTimelineData();
  const manifest = useManifestData();
  const fine = Math.round(Number(manifest?.study_area?.fine_res_m) || 250);
  const coarse = Number(manifest?.study_area?.grid?.res ?? manifest?.study_area?.grid_res_m) || 1000;
  const raster = rasterAvailability(timeline, year, mode);
  const rasterState = useRaster(raster.available ? `${mode}_${year}` : null, { enabled: false });
  const loading = renderMode !== "grid" && raster.available && rasterState.status === "loading";
  const coarseLabel = coarse >= 1000 ? `${Math.round(coarse / 100) / 10} km` : `${coarse} m`;
  return (
    <div className={cn("flex shrink-0 items-center gap-1.5 whitespace-nowrap", className)}>
      <Segmented
        ariaLabel="Map resolution"
        layoutId="render-switch"
        size="sm"
        value={renderMode}
        options={[
          { value: "grid", label: compact ? "Grid" : `GRID ${coarseLabel}`, title: `${coarseLabel} prisms (model grid)` },
          { value: "raster", label: compact ? `${fine} m` : `RASTER ${fine} m`, disabled: !raster.available, reason: raster.reason ?? undefined, title: mode === "night" ? `${fine} m night LST, downscaled` : `${fine} m day LST (Landsat, observed)` },
          { value: "auto", label: "AUTO", title: `Grid when zoomed out, ${fine} m raster from zoom 9.5 where available` },
        ]}
        onChange={(v) => {
          useViewStore.getState().setRenderMode(v);
          announce(v === "auto" ? "Render mode automatic" : v === "grid" ? `Render mode grid ${coarseLabel}` : `Render mode raster ${fine} m`);
        }}
      />
      {loading && (
        <span role="status" className="inline-flex items-center text-ink-muted" title={`${fine} m raster loading`}>
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
          <span className="sr-only">{`${fine} m raster loading`}</span>
        </span>
      )}
    </div>
  );
}

export default RenderSwitch;
