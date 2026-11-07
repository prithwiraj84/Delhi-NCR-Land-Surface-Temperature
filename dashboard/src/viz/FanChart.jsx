/**
 * FanChart (UI_SPEC §3.5, §4.6, §8 "FanChart: series, mode, ssps, selectedSsp, showAnnual,
 * cursorRef; states loading, empty, partial"): one mode per panel (Day and Night are never
 * drawn in one panel when fans are present), observed frames with their evidence-tier
 * encoding, the level CI band (hatched for reconstructed / modelled frames), the thin
 * satellite annual context line, the NOW rule, and SSP fans (p5–p95 @ 18 %, p25–p75 @ 32 %)
 * for the selected SSP with the other SSPs as 25 %-alpha strands in their own dash. Every
 * strand carries an end label. The playhead cursor follows `timeStore.scrubT` imperatively.
 *
 * Interaction: hover shows a crosshair + glass tooltip (tier glyph, value, CI, source, n);
 * between frames it says "between A and B: no data at this x". Arrow keys walk the data
 * years, Enter / click commits the year (snapped to the frame). The hover year is shared
 * with sibling charts (synced crosshair).
 */
import { useId, useMemo, useRef, useState } from "react";
import { TierGlyph } from "../components/ui/TierGlyph.jsx";
import { fmt, fmtInterval, MISSING } from "../lib/format.js";
import { cn } from "../lib/cn.js";
import { CHART, MODE_STYLE, bandPath, bracketYears, hatchUrl, linePath, linearScale, linearTicks, nearestYear, sspStyle, svgId, tierStyle, yearTicks } from "./chartTheme.js";
import { annualRuns, buildFanModel, SENSOR_DASH } from "./fanModel.js";
import { ChartTip } from "./ChartTip.jsx";
import { HatchDefs } from "./Hatch.jsx";
import { commitChartYear, useLinkStore, useYearCursor } from "./linking.js";
import { useSize } from "./useSize.js";

const M = { top: 14, right: 74, bottom: 24, left: 42 };

/** Tier marker at (cx, cy). */
export function TierMarker({ cx, cy, tier, color, r = 4 }) {
  const s = tierStyle(tier);
  if (s.marker === "diamond") {
    const d = r + 1;
    return <path d={`M${cx},${cy - d}L${cx + d},${cy}L${cx},${cy + d}L${cx - d},${cy}Z`} fill={CHART.surface} stroke={color} strokeWidth={1.5} />;
  }
  if (s.marker === "half") {
    return (
      <g>
        <circle cx={cx} cy={cy} r={r} fill={CHART.surface} stroke={color} strokeWidth={1.5} />
        <path d={`M${cx},${cy - r}A${r},${r} 0 0 0 ${cx},${cy + r}Z`} fill={color} />
      </g>
    );
  }
  const filled = s.marker === "filled";
  return <circle cx={cx} cy={cy} r={r} fill={filled ? color : CHART.surface} stroke={filled ? CHART.surface : color} strokeWidth={filled ? 2 : 1.5} />;
}

/**
 * @param {{series: object|null, status?: string, reason?: string|null, mode?: "day"|"night"|"dtr",
 *          metric?: string, ssps?: string[], selectedSsp?: string|null, showAnnual?: boolean,
 *          now?: number|null, xDomain?: [number, number], height?: number, label?: string,
 *          cursorRef?: React.RefObject}} props
 */
export function FanChart({ series, status = "ready", reason = null, mode = "day", metric = "mean", ssps = [], selectedSsp = null, showAnnual = true, now = null, xDomain = [1990, 2050], height = 220, label, cursorRef }) {
  const boxRef = useRef(null);
  const ownCursor = useRef(null);
  const cursor = cursorRef ?? ownCursor;
  const { width } = useSize(boxRef, { width: 640, height });
  const rid = svgId(useId(), "fan");
  const hoverYear = useLinkStore((s) => s.hoverYear);
  const setHoverYear = useLinkStore((s) => s.setHoverYear);
  const [hoverPx, setHoverPx] = useState(null);
  const model = useMemo(() => buildFanModel({ series, metric, ssps, now, showAnnual }), [series, metric, ssps, now, showAnnual]);
  const accent = MODE_STYLE[mode]?.accent ?? CHART.ink;
  const innerW = Math.max(120, width - M.left - M.right);
  const innerH = Math.max(60, height - M.top - M.bottom);
  const x = useMemo(() => linearScale([xDomain[0] - 1, xDomain[1] + 1], [M.left, M.left + innerW]), [xDomain, innerW]);
  const y = useMemo(() => linearScale(model.yDomain, [M.top + innerH, M.top]), [model.yDomain, innerH]);
  useYearCursor(cursor, x);

  if (status === "loading" || status === "idle") {
    return <div ref={boxRef} className="h-[180px] animate-pulse rounded-md bg-surface-3/40" aria-busy="true" aria-label={`Loading ${label ?? "chart"}`} />;
  }
  if (status !== "ready" || model.status === "empty") {
    return (
      <div ref={boxRef} className="grid min-h-[120px] place-items-center rounded-md border border-dashed border-hairline p-4 text-center text-xs text-ink-muted" role="status">
        {reason ?? (status === "ready" ? `No ${model.metric.label.toLowerCase()} values for this scope.` : "Unavailable")}
      </div>
    );
  }

  const order = [...ssps].sort((a, b) => (a === selectedSsp ? 1 : 0) - (b === selectedSsp ? 1 : 0));
  const sensors = Object.keys(model.annualBySensor ?? {});
  const obsPts = model.obs.filter((p) => Number.isFinite(p.y));
  const yTicks = linearTicks(model.yDomain, Math.max(3, Math.round(innerH / 45)));
  const xTicks = yearTicks(xDomain[0], xDomain[1], innerW < 360 ? 20 : 10);
  const reconPts = model.obs.filter((p) => tierStyle(p.tier).hatchCi);
  const solidCi = model.obs.map((p) => (tierStyle(p.tier).hatchCi ? { ...p, lo: NaN, hi: NaN } : p));
  // Observed line in tier-styled segments: a segment takes the weaker (dashed) style of its ends.
  const segments = [];
  for (let k = 1; k < model.obs.length; k += 1) {
    const a = model.obs[k - 1];
    const b = model.obs[k];
    if (!Number.isFinite(a.y) || !Number.isFinite(b.y)) continue;
    const dash = tierStyle(a.tier).dash ?? tierStyle(b.tier).dash;
    segments.push({ a, b, dash });
  }
  const fmtV = (v) => (Number.isFinite(v) ? `${fmt(v, model.metric.dp)}${model.metric.unit === "°C" ? " °C" : ` ${model.metric.unit}`}` : MISSING);

  const activeYear = hoverYear;
  const hoverData = (() => {
    if (activeYear === null) return null;
    const exact = nearestYear(model.years, activeYear, 0.01);
    if (exact === null) {
      const [a, b] = bracketYears(model.years, activeYear);
      return { between: [a, b] };
    }
    const o = model.obs.find((p) => p.x === exact);
    const proj = ssps.map((id) => ({ id, row: model.fans[id]?.find((r) => r.x === exact && !r.anchor) })).filter((r) => r.row);
    return { year: exact, obs: o, proj };
  })();

  const onMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const t = x.invert(px);
    const snap = nearestYear(model.years, t, 1.25);
    setHoverYear(snap ?? Math.round(t * 10) / 10);
    setHoverPx({ x: px, y: event.clientY - rect.top });
  };
  const onLeave = () => {
    setHoverYear(null);
    setHoverPx(null);
  };
  const onKey = (event) => {
    const yrs = model.years;
    if (!yrs.length) return;
    const i = activeYear === null ? -1 : yrs.indexOf(nearestYear(yrs, activeYear, 100));
    let next = null;
    if (event.key === "ArrowRight") next = yrs[Math.min(yrs.length - 1, i + 1)];
    else if (event.key === "ArrowLeft") next = yrs[Math.max(0, i < 0 ? yrs.length - 1 : i - 1)];
    else if (event.key === "Home") next = yrs[0];
    else if (event.key === "End") next = yrs[yrs.length - 1];
    else if ((event.key === "Enter" || event.key === " ") && activeYear !== null) {
      event.preventDefault();
      commitChartYear(activeYear);
      return;
    } else if (event.key === "Escape") {
      onLeave();
      return;
    }
    if (next === null || next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    setHoverYear(next);
    setHoverPx({ x: x(next), y: M.top + 10 });
  };

  const summary = `${label ?? "Fan chart"}: ${obsPts.length} observed frames${ssps.length ? `, projections for ${ssps.map((s) => sspStyle(s).label).join(", ")}` : ""}. Use the table view for exact values.`;

  return (
    <div ref={boxRef} className="relative w-full">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={summary}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={onLeave}
        className="focus-ring block cursor-crosshair touch-pan-y rounded-md"
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        onClick={() => activeYear !== null && commitChartYear(activeYear)}
      >
        <HatchDefs prefix={rid} />
        {/* grid + y axis */}
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={M.left + innerW} y1={y(t)} y2={y(t)} stroke={CHART.grid} />
            <text x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fill={CHART.axis} fontSize={CHART.fontSize} fontFamily={CHART.font}>
              {fmt(t, Math.abs(t) < 10 && !Number.isInteger(t) ? 1 : 0)}
            </text>
          </g>
        ))}
        {model.metric.signed && model.yDomain[0] < 0 && model.yDomain[1] > 0 && <line x1={M.left} x2={M.left + innerW} y1={y(0)} y2={y(0)} stroke={CHART.axisLine} />}
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={height - 6} textAnchor="middle" fill={CHART.axis} fontSize={CHART.fontSize} fontFamily={CHART.font}>
            {t}
          </text>
        ))}
        {/* projection region tint + NOW rule */}
        {Number.isFinite(now) && Object.keys(model.fans).length > 0 && <rect x={x(now)} y={M.top} width={Math.max(0, M.left + innerW - x(now))} height={innerH} fill={CHART.fog} />}
        {Number.isFinite(now) && (
          <g>
            <line x1={x(now)} x2={x(now)} y1={M.top - 4} y2={M.top + innerH} stroke={CHART.now} strokeWidth={1} />
            <text x={x(now) + 3} y={M.top + 2} fill={CHART.inkMuted} fontSize={10} fontFamily={CHART.font}>
              NOW
            </text>
          </g>
        )}
        {/* CI bands: solid tint for observed tiers, hatched for reconstructed / modelled */}
        <path d={bandPath(solidCi, x, y)} fill={accent} fillOpacity={0.14} />
        {reconPts.length > 0 && (
          <path
            d={bandPath(
              model.obs.map((p, k) => {
                const hatch = tierStyle(p.tier).hatchCi || tierStyle(model.obs[k + 1]?.tier).hatchCi;
                return hatch ? p : { ...p, lo: NaN, hi: NaN };
              }),
              x,
              y,
            )}
            fill={hatchUrl(rid, "recon")}
          />
        )}
        {/* annual satellite context: one line per sensor (own dash), drift-flagged stretches
            dotted with hollow points — sensors are never joined into one zig-zag line */}
        {sensors.map((sensor, k) => {
          const pts = model.annualBySensor[sensor];
          return (
            <g key={sensor} data-sensor={sensor}>
              {annualRuns(pts).map((run, j) =>
                run.pts.length > 1 ? (
                  <path key={j} d={linePath(run.pts, x, y)} fill="none" stroke={CHART.inkFaint} strokeOpacity={run.drift ? 0.45 : 0.6} strokeWidth={1} strokeDasharray={run.drift ? "1.5 2.5" : SENSOR_DASH[k % SENSOR_DASH.length] ?? undefined} />
                ) : null,
              )}
              {pts.filter((p) => p.drift).map((p) => (
                <circle key={`d-${p.x}`} cx={x(p.x)} cy={y(p.y)} r={2} fill={CHART.surface} stroke={CHART.inkFaint} strokeWidth={1} />
              ))}
            </g>
          );
        })}
        {/* SSP fans and strands (selected drawn last, on top) */}
        {order.map((id) => {
          const rows = model.fans[id];
          if (!rows) return null;
          const st = sspStyle(id);
          const sel = id === selectedSsp;
          const pts = rows.map((r) => ({ x: r.x, y: r.p50 }));
          const last = rows[rows.length - 1];
          return (
            <g key={id} opacity={sel ? 1 : CHART.otherSspAlpha + 0.15}>
              {sel && <path d={bandPath(rows.map((r) => ({ x: r.x, lo: r.p05, hi: r.p95 })), x, y)} fill={st.color} fillOpacity={CHART.fanOuter} />}
              {sel && <path d={bandPath(rows.map((r) => ({ x: r.x, lo: r.p25, hi: r.p75 })), x, y)} fill={st.color} fillOpacity={CHART.fanInner} />}
              <path d={linePath(pts, x, y)} fill="none" stroke={st.color} strokeOpacity={sel ? 1 : CHART.otherSspAlpha / (CHART.otherSspAlpha + 0.15)} strokeWidth={sel ? st.width + 0.25 : st.width} strokeDasharray={st.dash ?? undefined} />
              {sel && model.baselines[id] && (
                <circle cx={x(model.baselines[id].x)} cy={y(model.baselines[id].y)} r={3.5} fill={CHART.surface} stroke={st.color} strokeWidth={1.5} data-testid="fan-baseline">
                  <title>{`Weather-normalised ${model.baselines[id].x} baseline ${fmt(model.baselines[id].y, 1)} °C: projected changes are measured from it`}</title>
                </circle>
              )}
              <line x1={x(last.x) + 4} x2={x(last.x) + 16} y1={y(last.p50)} y2={y(last.p50)} stroke={st.color} strokeWidth={st.width} strokeDasharray={st.dash ?? undefined} />
              <text x={x(last.x) + 19} y={y(last.p50)} dy="0.32em" fill={sel ? CHART.ink : CHART.inkMuted} fontSize={10.5} fontFamily={CHART.font}>
                {st.label}
              </text>
            </g>
          );
        })}
        {/* observed line, tier-styled segments + markers */}
        {segments.map(({ a, b, dash }) => (
          <line key={`${a.x}-${b.x}`} x1={x(a.x)} y1={y(a.y)} x2={x(b.x)} y2={y(b.y)} stroke={accent} strokeWidth={1.5} strokeDasharray={dash ?? undefined} strokeLinecap="round" />
        ))}
        {obsPts.map((p) => (
          <TierMarker key={p.x} cx={x(p.x)} cy={y(p.y)} tier={p.tier} color={accent} />
        ))}
        {model.gaps.map((g) => (
          <text key={`gap-${g}`} x={x(g)} y={M.top + innerH - 4} textAnchor="middle" fill={CHART.inkFaint} fontSize={10} fontFamily={CHART.font}>
            ∅
          </text>
        ))}
        {/* hover crosshair (synced) + playhead cursor (imperative) */}
        {activeYear !== null && <line x1={x(activeYear)} x2={x(activeYear)} y1={M.top} y2={M.top + innerH} stroke={CHART.hover} strokeWidth={1} pointerEvents="none" />}
        <g ref={cursor} pointerEvents="none" style={{ opacity: 0 }}>
          <line x1={0} x2={0} y1={M.top} y2={M.top + innerH} stroke={CHART.cursor} strokeWidth={1.5} />
        </g>
      </svg>
      {hoverData && hoverPx && (
        <ChartTip x={hoverPx.x} y={hoverPx.y} width={width}>
          {hoverData.between ? (
            <p className="text-ink-muted">
              between {hoverData.between[0] ?? "start"} and {hoverData.between[1] ?? "end"}: no data at this x
            </p>
          ) : (
            <div className="space-y-0.5">
              <p className="font-mono text-ink-strong">{hoverData.year}</p>
              {hoverData.obs && (
                <p className="flex flex-wrap items-center gap-1.5">
                  <TierGlyph tier={hoverData.obs.tier} variant="short" />
                  <span className="tnum font-mono">{fmtV(hoverData.obs.y)}</span>
                  {Number.isFinite(hoverData.obs.lo) && <span className="text-ink-muted">{fmtInterval([hoverData.obs.lo, hoverData.obs.hi])}</span>}
                </p>
              )}
              {hoverData.obs?.n ? <p className="text-ink-faint">n = {hoverData.obs.n.toLocaleString("en-US")} cells</p> : null}
              {hoverData.proj.map(({ id, row }) => (
                <p key={id} className="flex items-center gap-1.5">
                  <TierGlyph tier="projected" variant="glyph" />
                  <span className={cn(id === selectedSsp ? "text-ink" : "text-ink-muted")}>{sspStyle(id).label}</span>
                  <span className="tnum font-mono">{fmtV(row.p50)}</span>
                  <span className="text-ink-muted">[p5–p95 {fmtInterval([row.p05, row.p95])}]</span>
                </p>
              ))}
              {model.annual
                .filter((a) => a.x === hoverData.year)
                .map((a) => (
                  <p key={`${a.sensor}-${a.x}`} className="text-ink-faint">
                    annual {a.sensor ?? "satellite"}: {fmtV(a.y)}
                    {a.drift ? " · drift" : ""}
                  </p>
                ))}
            </div>
          )}
        </ChartTip>
      )}
      {(sensors.length > 0 || Object.keys(model.baselines).length > 0) && (
        <ul className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-ink-faint" aria-label="Annual sensors and baseline">
          {sensors.map((sensor, k) => (
            <li key={sensor} className="inline-flex items-center gap-1.5">
              <svg width="20" height="8" aria-hidden="true">
                <line x1="1" x2="19" y1="4" y2="4" stroke={CHART.inkFaint} strokeWidth="1" strokeDasharray={SENSOR_DASH[k % SENSOR_DASH.length] ?? undefined} />
              </svg>
              annual {sensor}
              {model.annualBySensor[sensor].some((p) => p.drift) ? " (◦ drift years)" : ""}
            </li>
          ))}
          {Object.keys(model.baselines).length > 0 && (
            <li className="inline-flex items-center gap-1.5">
              <svg width="10" height="10" aria-hidden="true">
                <circle cx="5" cy="5" r="3.5" fill={CHART.surface} stroke={CHART.inkMuted} strokeWidth="1.5" />
              </svg>
              weather-normalised {now ?? ""} baseline (projections start here)
            </li>
          )}
        </ul>
      )}
      {model.fanReason && ssps.length > 0 && <p className="mt-1 text-[11px] text-ink-faint">{model.fanReason}</p>}
    </div>
  );
}

export default FanChart;
