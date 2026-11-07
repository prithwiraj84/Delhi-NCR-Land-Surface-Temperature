/**
 * Telemetry strip (UI_SPEC_v2 §3.2 "TELEMETRY 44", §3.13 mobile 32 px):
 *
 *   NCR MEAN 41.2 °C ▁▂▃▅ │ SURFACE UHI (urban−rural) −1.6 °C · day │ HOT CORE 27 % │
 *   HOTTEST Bharatpur 44.0 │ Δ vs 1990 +x.x │ SKILL sp-CV R² 0.xx │ ● OBSERVED · Landsat … · 10:40 IST
 *
 * Values follow the playhead at ≤ 10 Hz (useLiveFrame). Between frames every value is mixed
 * linearly, dimmed, prefixed with "≈" and the strip names the bracket ("2030 ↔ 2035") —
 * interpolated frames are not data. The surface UHI is always signed and mode-tagged (the
 * daytime UHI of the real bundle is negative). Projections carry the scenario and the
 * "model + CMIP6 scenario, not observations" caveat in the tier chip. Overflow scrolls
 * horizontally with snap; 1 px dividers between items.
 */
import { Fragment, useMemo } from "react";
import { TierGlyph } from "../../components/ui/TierGlyph.jsx";
import { cn } from "../../lib/cn.js";
import { fmt, fmtSigned, fmtSsp } from "../../lib/format.js";
import { firstComparableFrame, tierChipText, uhiCopy } from "./controlModel.js";
import { TelemetryItem } from "./TelemetryItem.jsx";
import { useLiveFrame, useSkill } from "./useControlData.js";

const MODE_TAG = { day: "day", night: "night", dtr: "day − night" };

/** @param {{compact?: boolean, className?: string}} props */
export function TelemetryStrip({ compact = false, className }) {
  const live = useLiveFrame();
  const { stats, info, timeline, mode, ssp, ncr } = live;
  const skill = useSkill(mode);
  const interpolating = Boolean(stats?.interpolated);
  const status = (v) => (!stats ? (live.statsStatus === "loading" || live.statsStatus === "idle" ? "loading" : "n/a") : Number.isFinite(v) ? (interpolating ? "interpolating" : "exact") : "n/a");
  const scenario = timeline?.scenarios?.find((s) => s.id === ssp) ?? null;
  const chip = tierChipText(info, { mode, sspLabel: scenario?.label ?? fmtSsp(ssp), nGcm: scenario?.n_gcm });

  const spark = useMemo(() => {
    if (!ncr) return null;
    const obs = ncr.frames.map((f) => f.mean);
    const proj = (ncr.ssp?.[ssp] ?? []).map((r) => r.p50);
    return [...obs, ...proj];
  }, [ncr, ssp]);
  // The first frame with real evidence (observed, sparse or reconstructed): a modelled hindcast
  // (night 1990/1995) is not a baseline for an observed change.
  const first = firstComparableFrame(ncr?.frames);
  // A level difference between frames is only meaningful when the bundle's levels are harmonised
  // across sensors and overpass times (manifest.timeline.harmonised, decision D2). In a v1 bundle
  // the 2025 MODIS Terra frame was acquired ~1 h earlier than 2010-2020 (orbit drift) and each
  // epoch is a single season, so "2025 minus 2010" mixes sensor drift and weather with real change.
  const levelsComparable = timeline?.harmonised === true;
  const deltaFirst = levelsComparable && stats && first && Number.isFinite(stats.mean) ? stats.mean - first.mean : NaN;

  const items = [
    {
      key: "mean",
      label: mode === "dtr" ? "NCR DTR" : "NCR mean",
      value: Number.isFinite(stats?.mean) ? fmt(stats.mean, 1) : null,
      unit: "°C",
      spark,
      status: status(stats?.mean),
      reason: live.statsReason ?? stats?.reason ?? "no NCR statistics for this frame",
      title: stats?.ci ? `NCR mean ${fmt(stats.mean, 2)} °C, interval ${fmt(stats.ci[0], 1)}–${fmt(stats.ci[1], 1)} °C` : undefined,
    },
    {
      key: "uhi",
      label: compact ? "UHI" : "Surface UHI (urban−rural)",
      value: Number.isFinite(stats?.uhi) ? `${fmtSigned(stats.uhi, 1)}` : null,
      unit: `°C · ${MODE_TAG[mode] ?? mode}`,
      status: status(stats?.uhi),
      reason: stats?.uhiReason ?? "surface UHI not exported",
      title: Number.isFinite(stats?.uhi) ? uhiCopy(stats.uhi, mode) : stats?.uhiReason ?? undefined,
    },
    { key: "hot", label: "Hot core", value: Number.isFinite(stats?.hotCorePct) ? fmt(stats.hotCorePct, 0) : null, unit: "%", status: status(stats?.hotCorePct), reason: "hot-core area needs the frame's cube", semantics: "neutral", title: "Share of the area at or above the reference-period p90 of this mode" },
    {
      key: "hottest",
      label: mode === "dtr" ? "Largest DTR" : "Hottest",
      value: stats?.hottestDistrict ? (
        <>
          <span className="font-sans font-medium text-ink">{stats.hottestDistrict.label}</span> {fmt(stats.hottestDistrict.value, 1)}
        </>
      ) : null,
      unit: "°C",
      status: stats?.hottestDistrict ? (interpolating ? "interpolating" : "exact") : status(NaN),
      reason: "no district statistics for this frame",
    },
    {
      key: "delta",
      label: first ? `Δ vs ${first.year}` : "Δ vs first",
      value: Number.isFinite(deltaFirst) ? fmtSigned(deltaFirst, 1) : null,
      unit: "°C",
      status: levelsComparable || !stats ? status(deltaFirst) : "n/a",
      reason: levelsComparable
        ? "no first-frame mean"
        : "levels are not harmonised across sensors/overpass times in this bundle (e.g. MODIS Terra drift), so a frame-to-frame difference is not a trend; compare anomalies instead",
      title: first && levelsComparable ? `NCR mean minus the ${first.year} frame mean (${first.tier ?? "tier n/a"})` : undefined,
    },
    {
      key: "skill",
      label: skill?.short ?? "Skill",
      value: skill ? fmt(skill.r2, 2) : null,
      unit: "",
      status: skill ? "exact" : "n/a",
      reason: "skill metrics not loaded",
      title: skill?.label,
      semantics: "neutral",
    },
  ];

  return (
    <div
      role="region"
      aria-label="Telemetry"
      tabIndex={0}
      className={cn("glass scrollbar-thin focus-ring pointer-events-auto flex min-w-0 snap-x items-stretch overflow-x-auto rounded-panel", compact ? "h-8" : "h-11", className)}
      data-testid="telemetry-strip"
    >
      {interpolating && stats?.bracket && (
        <div className="flex shrink-0 items-center px-3 font-mono text-[11px] text-ink-muted" title="Interpolated between frames: not data">
          <span className="sr-only">Interpolated between </span>
          {stats.bracket.yA} ↔ {stats.bracket.yB}
        </div>
      )}
      {items.map(({ key, ...it }, i) => (
        <Fragment key={key}>
          {(i > 0 || interpolating) && <span aria-hidden="true" className="my-2 w-px shrink-0 bg-hairline" />}
          <TelemetryItem compact={compact} semantics={it.semantics ?? "temperature"} {...it} tier={key === "mean" ? info?.tier ?? null : null} />
        </Fragment>
      ))}
      {!compact && (
        <>
          <span aria-hidden="true" className="my-2 w-px shrink-0 bg-hairline" />
          {/* The provenance chip is the one item allowed to shrink: its detail truncates with an
              ellipsis instead of being cut off mid-word at the strip edge. */}
          <div className="flex min-w-[9rem] shrink snap-start items-center overflow-hidden px-3">
            <TierGlyph tier={chip.tier} variant="chip" detail={chip.detail} title={`${chip.label}: ${chip.detail}`} />
          </div>
        </>
      )}
    </div>
  );
}

export default TelemetryStrip;
