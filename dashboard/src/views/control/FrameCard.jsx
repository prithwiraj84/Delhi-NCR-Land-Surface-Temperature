/**
 * Frame card (UI_SPEC_v2 §3.2 "FRAME / ODOMETER", §8 `FrameCard`):
 *
 *     2 0 2 5                 ← YearOdometer (≈2032 italic between frames)
 *     ● OBSERVED              ← manifest tier (glyph + text), flips (rotateX) when crossing NOW
 *     Day · 10:40 IST         ← mode · overpass
 *     window 2024–26 Apr–Jun  ← multi-year window
 *     1 km grid · 250 m       ← resolution (DOWNSCALED attribute for night rasters)
 *     ±0.4 °C level · AOA 96 %       (projected: "NCR p5–p95 42.5–44.3 °C" of the selected SSP)
 *
 * Props per spec: `year, tier, sensor, overpass, window, res, ci, aoaPct, interpolated`; the
 * container `FrameCardLive` fills them from the hooks. States: observed, sparse,
 * reconstructed, modelled, projected, interpolated, unavailable, loading.
 */
import { motion } from "framer-motion";
import { TierShape } from "../../design/glyphs.jsx";
import { normalizeTier, TIER_META } from "../../design/tiers.js";
import { useMotionLevel } from "../../design/useMotionLevel.js";
import { cn } from "../../lib/cn.js";
import { fmt, fmtPct, fmtSsp } from "../../lib/format.js";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { useAsset } from "../../data/hooks.js";
import { useViewStore } from "../../state/stores/viewStore.js";
import { useNowCrossing } from "../../time/nowCrossing.js";
import { YearOdometer } from "../../time/YearOdometer.jsx";
import { windowLabel } from "./controlModel.js";
import { useLiveFrame, useManifestData } from "./useControlData.js";

const MODE_LABEL = { day: "Day", night: "Night", dtr: "Diurnal range" };

/**
 * @param {{year:number|null, tier:string|null, sensor?:string|null, overpass?:string|null, window?:number[]|null,
 *          res?: string|null, ci?: number[]|null, ciKind?: "level"|"p5–p95"|null, aoaPct?: number|null, interpolated?: boolean, bracket?: object|null,
 *          mode: string, sspLabel?: string|null, available?: boolean, reason?: string|null, loading?: boolean,
 *          moving?: boolean, flipKey?: number, compact?: boolean, className?: string}} props
 */
export function FrameCard({ year, tier, sensor, overpass, window, res, ci, ciKind = "level", aoaPct, interpolated = false, bracket = null, mode, sspLabel, available = true, reason, loading = false, moving = false, flipKey = 0, compact = false, className }) {
  const level = useMotionLevel();
  const id = normalizeTier(tier);
  const label = interpolated ? "Interpolated" : id ? TIER_META[id].label : available ? "Unknown tier" : "Unavailable";
  const flip = level === "full" && flipKey > 0;
  const ciOk = Array.isArray(ci) && ci.length === 2 && ci.every(Number.isFinite);
  // Projected frames carry an asymmetric p5–p95 range of the selected SSP, never "±".
  const range = ciOk && ciKind === "p5–p95" ? `NCR p5–p95 ${fmt(ci[0], 1)}–${fmt(ci[1], 1)} °C` : null;
  const halfCi = ciOk && !range ? (ci[1] - ci[0]) / 2 : null;
  return (
    <HudFrame as="section" aria-label="Current frame" padding="sm" className={cn("pointer-events-auto w-[220px]", compact && "w-auto", className)} data-testid="frame-card" data-state={loading ? "loading" : !available ? "unavailable" : interpolated ? "interpolated" : id ?? "unknown"}>
      <YearOdometer value={year} approx={interpolated} moving={moving} size={compact ? 36 : 64} />
      <motion.p
        key={flip ? flipKey : "static"}
        initial={flip ? { rotateX: 90, opacity: 0 } : false}
        animate={{ rotateX: 0, opacity: 1 }}
        transition={{ duration: 0.36, ease: [0.16, 1, 0.3, 1] }}
        className="mt-1.5 flex items-center gap-1.5 font-mono text-[12px] font-semibold uppercase tracking-[0.1em] text-ink"
        style={{ transformOrigin: "50% 50%" }}
      >
        {!interpolated && <TierShape tier={id} size={11} />}
        {label}
        {id === "projected" && sspLabel && !interpolated && <span className="font-normal normal-case tracking-normal text-ink-muted">· {sspLabel}</span>}
      </motion.p>
      {interpolated && bracket ? (
        <p className="mt-0.5 font-mono text-[11px] text-ink-muted">
          {bracket.yA} ↔ {bracket.yB} · not data, map tweened
        </p>
      ) : !available ? (
        <p className="mt-0.5 text-[12px] leading-snug text-ink-muted">{reason ?? "No data for this frame"}</p>
      ) : (
        !compact && (
          <dl className="mt-1 space-y-0.5 text-[12px] leading-snug text-ink-muted">
            <div>
              <dt className="sr-only">Mode and overpass</dt>
              <dd>
                {MODE_LABEL[mode] ?? mode}
                {overpass ? ` · ${overpass} IST` : ""}
              </dd>
            </div>
            {sensor && (
              <div>
                <dt className="sr-only">Source</dt>
                <dd className="truncate" title={sensor}>
                  {sensor}
                </dd>
              </div>
            )}
            {windowLabel(window) && (
              <div>
                <dt className="sr-only">Window</dt>
                <dd>window {windowLabel(window)}</dd>
              </div>
            )}
            {(res || halfCi !== null || range || Number.isFinite(aoaPct)) && (
              <div>
                <dt className="sr-only">Resolution and uncertainty</dt>
                <dd className="font-mono text-[11px]" data-testid="frame-uncertainty">
                  {[res, range, halfCi !== null ? `level ±${fmt(halfCi, 1)} °C` : null, Number.isFinite(aoaPct) ? `AOA ${fmtPct(aoaPct > 1 ? aoaPct / 100 : aoaPct)}` : null].filter(Boolean).join(" · ")}
                </dd>
              </div>
            )}
          </dl>
        )
      )}
    </HudFrame>
  );
}

/** FrameCard bound to the live playhead and the bundle. */
export function FrameCardLive({ compact = false, className }) {
  const live = useLiveFrame();
  const flipKey = useNowCrossing((s) => s.seq);
  const renderMode = useViewStore((s) => s.renderMode);
  const metrics = useAsset("metrics");
  const manifest = useManifestData();
  const { info, timeline, mode, ssp, stats } = live;
  if (!timeline || !info) {
    return <FrameCard year={null} tier={null} mode={mode} loading available={false} reason="Timeline loading" compact={compact} className={className} />;
  }
  const scenario = timeline.scenarios.find((s) => s.id === ssp);
  const frame = info.frame;
  const hasRaster = mode !== "dtr" && Boolean(frame?.raster?.[mode]);
  const downscaled = hasRaster && mode === "night";
  const resM = Number(manifest?.study_area?.grid?.res ?? manifest?.study_area?.grid_res_m) || 1000;
  const gridRes = `${fmt(resM / 1000, resM % 1000 ? 1 : 0)} km grid`;
  const fineM = Number(manifest?.study_area?.fine_res_m) || resM / 4;
  const res = renderMode === "grid" || !hasRaster ? gridRes : `${gridRes} · ${Math.round(fineM)} m${downscaled ? " · DOWNSCALED" : ""}`;
  const aoaMode = mode === "dtr" ? "day" : mode;
  // Projected frames: the AOA share of the selected SSP (projection_meta); observed: pct_inside.
  const outside = frame?.kind === "projected" && metrics.status === "ready" ? Number(metrics.data?.projection_meta?.[aoaMode]?.[ssp]?.pct_outside_aoa?.[String(frame?.year)]) : NaN;
  const pct = Number.isFinite(outside) ? 1 - outside : metrics.status === "ready" && frame?.kind !== "projected" ? Number(metrics.data?.modes?.[aoaMode]?.aoa?.pct_inside?.[String(frame?.year)]) : NaN;
  return (
    <FrameCard
      year={live.t}
      tier={info.tier}
      sensor={info.sensor}
      overpass={info.overpass}
      window={info.window}
      res={res}
      ci={info.level_ci ?? (stats && !stats.interpolated && info.kind !== "projected" ? stats.ci : null)}
      ciKind={info.level_ci ? info.ci_kind ?? "level" : "level"}
      aoaPct={Number.isFinite(pct) ? pct : null}
      interpolated={info.interpolated}
      bracket={info.bracket}
      mode={mode}
      sspLabel={scenario?.label ?? fmtSsp(ssp)}
      available={info.available}
      reason={info.reason}
      moving={live.moving}
      flipKey={flipKey}
      compact={compact}
      className={className}
    />
  );
}

export default FrameCardLive;
