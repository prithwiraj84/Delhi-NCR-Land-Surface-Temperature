/**
 * Ribbon sparkline (UI_SPEC_v2 §3.3 top band): the NCR mean of the display mode through time.
 *
 *   - frame means as a line whose dash follows the weaker tier of each segment (observed solid,
 *     reconstructed 2-4 dash, modelled dotted — UI_SPEC §4.6), with the tier glyph as marker;
 *   - the thin annual satellite line(s) where the bundle exports them (context, not frames),
 *     one per sensor, drift-flagged stretches dashed;
 *   - SSP strands from NOW, opening at the weather-normalised baseline (hollow marker, D14) —
 *     never at the observed NOW mean: the selected scenario solid at full alpha with its p5–p95 (18 %)
 *     and p25–p75 (32 %) fans, the others at 25 % alpha in their own dash; every strand has a
 *     short end label (colour is never the only cue; ssp245/ssp585 deutan ΔE is only ~11.9);
 *   - the NOW label, and the "strands unfurl at NOW" animation keyed on the crossing counter.
 *
 * Text never wears series colour: labels use ink tokens, the coloured strand beside the label
 * carries identity (dataviz rule). The y-scale spans every scenario's p5–p95, so switching SSP
 * never rescales the chart.
 */
import { memo, useId, useMemo } from "react";
import { motion } from "framer-motion";
import { scaleLinear } from "d3-scale";
import { area as d3area, line as d3line } from "d3-shape";
import { TierShape } from "../design/glyphs.jsx";
import { ssp as SSP_STYLE } from "../design/tokens.js";
import { scopeBaseline } from "../data/series.js";
import { weakerTier } from "../data/timeline.js";
import { annualRuns } from "../viz/fanModel.js";

const finite = (v) => typeof v === "number" && Number.isFinite(v);

const SEGMENT_DASH = Object.freeze({ observed: null, "observed-sparse": null, reconstructed: "2 4", modelled: "1 3", projected: "4 4" });

function shortSsp(label, id) {
  const text = String(label ?? id ?? "");
  return text.replace(/^SSP/i, "");
}

/** y-domain covering frames, fans and annual context (padded, never degenerate). */
function yDomain(ncr) {
  const vals = [];
  for (const f of ncr?.frames ?? []) if (finite(f.mean)) vals.push(f.mean);
  for (const fan of Object.values(ncr?.ssp ?? {})) for (const r of fan) for (const k of ["p05", "p50", "p95"]) if (finite(r[k])) vals.push(r[k]);
  for (const r of ncr?.annual?.satellite ?? []) if (finite(r?.value)) vals.push(r.value);
  if (finite(ncr?.baselineLevel)) vals.push(ncr.baselineLevel);
  if (!vals.length) return [0, 1];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 1) {
    const mid = (lo + hi) / 2;
    lo = mid - 0.5;
    hi = mid + 0.5;
  }
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

/** Spread end labels so they keep `gap` px between them (sorted by y). */
function spreadLabels(items, gap, top, bottom) {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i += 1) if (sorted[i].y - sorted[i - 1].y < gap) sorted[i].y = sorted[i - 1].y + gap;
  const overflow = sorted.length ? sorted[sorted.length - 1].y - bottom : 0;
  if (overflow > 0) for (const s of sorted) s.y = Math.max(top, s.y - overflow);
  return sorted;
}

/**
 * @param {{scale:object, top:number, height:number, ncr:object|null, ticks:Array, ssp:string|null,
 *          scenarios:Array<{id,label}>, now:number|null, unfurlSeq:number, level:string,
 *          showLabels?: boolean, compact?: boolean}} props
 */
export const RibbonSparkline = memo(function RibbonSparkline({ scale, top, height, ncr, ticks, ssp, scenarios, now, unfurlSeq, level, showLabels = true, compact = false }) {
  const clipBase = `spark-${useId().replace(/:/g, "")}`;
  const model = useMemo(() => {
    if (!ncr) return null;
    const y = scaleLinear().domain(yDomain(ncr)).range([top + height - 3, top + 4]);
    const tierOfYear = new Map(ticks.map((t) => [t.year, t.tier]));
    const frames = ncr.frames.filter((f) => finite(f.mean) && f.year >= scale.first && f.year <= scale.last);
    const segments = [];
    for (let i = 1; i < frames.length; i += 1) {
      const a = frames[i - 1];
      const b = frames[i];
      const tier = weakerTier(tierOfYear.get(a.year) ?? a.tier, tierOfYear.get(b.year) ?? b.tier);
      segments.push({ key: `${a.year}-${b.year}`, x1: scale.x(a.year), y1: y(a.mean), x2: scale.x(b.year), y2: y(b.mean), dash: SEGMENT_DASH[tier] ?? null });
    }
    const lineGen = d3line()
      .x((d) => scale.x(d.year))
      .y((d) => y(d.v));
    const anchorYear = finite(now) ? now : frames.at(-1)?.year ?? null;
    const strands = (scenarios ?? [])
      .map((s) => {
        const fan = (ncr.ssp?.[s.id] ?? []).filter((r) => finite(r.p50) && r.year >= scale.first && r.year <= scale.last);
        if (!fan.length) return null;
        // Strands open at NOW from the weather-normalised baseline (D14), never from the observed
        // NOW frame (which carries the 2024–26 weather anomaly).
        const b = scopeBaseline(ncr, s.id);
        const anchor = b && anchorYear !== null && fan[0].year > anchorYear ? { year: anchorYear, mean: b.base } : null;
        const pts = [...(anchor ? [{ year: anchor.year, v: anchor.mean }] : []), ...fan.map((r) => ({ year: r.year, v: r.p50 }))];
        const style = SSP_STYLE[s.id] ?? { color: "var(--ink-muted)", dash: null, width: 1.5 };
        const band = (lo, hi) =>
          d3area()
            .x((d) => scale.x(d.year))
            .y0((d) => y(d.lo))
            .y1((d) => y(d.hi))([
            ...(anchor ? [{ year: anchor.year, lo: anchor.mean, hi: anchor.mean }] : []),
            ...fan.filter((r) => finite(r[lo]) && finite(r[hi])).map((r) => ({ year: r.year, lo: r[lo], hi: r[hi] })),
          ]);
        const last = fan[fan.length - 1];
        return {
          id: s.id,
          label: shortSsp(s.label, s.id),
          selected: s.id === ssp,
          path: lineGen(pts),
          fan90: s.id === ssp ? band("p05", "p95") : null,
          fan50: s.id === ssp ? band("p25", "p75") : null,
          color: style.color,
          dash: style.dash,
          width: style.width,
          endX: scale.x(last.year),
          endY: y(last.p50),
          baseline: anchor ? { x: scale.x(anchor.year), y: y(anchor.mean), value: anchor.mean } : null,
        };
      })
      .filter(Boolean);
    const annual = new Map();
    for (const r of ncr.annual?.satellite ?? []) {
      if (!finite(r?.value) || r.year < scale.first || r.year > scale.last) continue;
      const key = r.sensor ?? "satellite";
      if (!annual.has(key)) annual.set(key, []);
      annual.get(key).push({ year: r.year, v: r.value, drift: r.flag === "drift" });
    }
    // One line per sensor; drift-flagged stretches are dashed (same styling as the FanChart).
    const annualPaths = [...annual.entries()].flatMap(([sensor, pts]) =>
      annualRuns(pts.sort((a, b) => a.year - b.year)).map((run, k) => ({ key: `${sensor}-${k}`, sensor, drift: run.drift, d: lineGen(run.pts) })),
    );
    return { y, frames, segments, strands, annualPaths };
  }, [ncr, ticks, scale, top, height, scenarios, ssp, now]);

  if (!model) {
    return (
      <text x={scale.x0} y={top + height / 2} style={{ font: "11px var(--font-mono)", fill: "var(--ink-faint)" }}>
        NCR series loading…
      </text>
    );
  }

  const nowX = finite(now) && now >= scale.first && now <= scale.last ? scale.x(now) : null;
  const unfurl = level === "full" && unfurlSeq > 0;
  const labels = showLabels ? spreadLabels(model.strands.map((s) => ({ id: s.id, label: s.label, y: s.endY, x: s.endX, selected: s.selected })), 11, top + 6, top + height - 2) : [];
  const tierByYear = new Map(ticks.map((t) => [t.year, t.tier]));

  return (
    <g data-testid="ribbon-sparkline">
      {/* Horizontal hairline at the baseline only (recessive chrome). */}
      <line x1={scale.x0} x2={scale.x1} y1={top + height} y2={top + height} stroke="rgba(160, 185, 225, 0.08)" />

      {model.annualPaths.map((p) => (
        <path key={p.key} d={p.d} fill="none" stroke="var(--ink-faint)" strokeOpacity={0.55} strokeWidth={1} strokeDasharray={p.drift ? "1.5 2.5" : undefined}>
          <title>{`Annual ${p.sensor}${p.drift ? " · drift" : ""} (context, not a frame)`}</title>
        </path>
      ))}

      {model.strands.map((s, i) => (
        <g key={s.id} clipPath={unfurl ? `url(#${clipBase}-${s.id})` : undefined}>
          {unfurl && nowX !== null && (
            <clipPath id={`${clipBase}-${s.id}`}>
              <motion.rect
                key={unfurlSeq}
                x={nowX - 1}
                y={top - 2}
                height={height + 4}
                initial={{ width: 0 }}
                animate={{ width: scale.x1 - nowX + 40 }}
                transition={{ duration: 0.9, delay: 0.12 * i, ease: [0.65, 0, 0.35, 1] }}
              />
            </clipPath>
          )}
          {s.fan90 && <path d={s.fan90} fill={s.color} fillOpacity={0.18} />}
          {s.fan50 && <path d={s.fan50} fill={s.color} fillOpacity={0.32} />}
          <path d={s.path} fill="none" stroke={s.color} strokeOpacity={s.selected ? 1 : 0.25} strokeWidth={s.selected ? Math.max(2, s.width) : s.width} strokeDasharray={s.dash ?? undefined} strokeLinecap="round" strokeLinejoin="round" />
          {s.selected && s.baseline && (
            <circle cx={s.baseline.x} cy={s.baseline.y} r={3} fill="var(--surface-2)" stroke={s.color} strokeWidth={1.5} data-testid="ribbon-baseline">
              <title>{`Weather-normalised baseline ${s.baseline.value.toFixed(1)} °C (projections are changes from it)`}</title>
            </circle>
          )}
        </g>
      ))}

      {model.segments.map((seg) => (
        <line key={seg.key} x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2} stroke="var(--ink)" strokeWidth={1.5} strokeDasharray={seg.dash ?? undefined} strokeLinecap="round" />
      ))}
      {model.frames.map((f) => {
        const size = compact ? 7 : 8;
        return (
          <g key={f.year} style={{ color: "var(--ink)" }}>
            <circle cx={scale.x(f.year)} cy={model.y(f.mean)} r={size / 2 + 2} fill="var(--surface-2)" />
            <TierShape tier={tierByYear.get(f.year) ?? f.tier} size={size} x={scale.x(f.year) - size / 2} y={model.y(f.mean) - size / 2} />
          </g>
        );
      })}

      {labels.map((l) => {
        const s = model.strands.find((x) => x.id === l.id);
        return (
          <g key={l.id} aria-hidden="true">
            <line x1={l.x + 3} x2={l.x + 10} y1={l.y} y2={l.y} stroke={s.color} strokeWidth={2} strokeDasharray={s.dash ?? undefined} strokeOpacity={l.selected ? 1 : 0.55} />
            <text x={l.x + 12} y={l.y + 3.5} style={{ font: `${l.selected ? 600 : 400} 11px var(--font-mono)`, fill: l.selected ? "var(--ink)" : "var(--ink-faint)" }}>
              {l.label}
            </text>
          </g>
        );
      })}
    </g>
  );
});
