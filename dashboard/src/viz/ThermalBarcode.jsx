/**
 * ThermalBarcode (UI_SPEC §3.5 "25 districts × 61 yrs (canvas); sort [name | Δ | 2050 | DTR];
 * row click = scope"): warming-stripe rows, one per district.
 *
 * Honesty: a frame is a multi-year window, so each frame paints the span halfway to its
 * neighbours (a step, NOT an interpolation between frames); years without any frame stay
 * empty. Colour is the value on a FIXED domain shared by all rows (Polar ramp for anomalies
 * against the row's own reference-period mean, or the mode ramp for absolute °C). Projected
 * columns carry the fog tint and a hatch so they never read as observations.
 *
 * Rows are labelled HTML buttons (keyboard + screen readers; Enter selects the scope); the
 * canvas is the visual twin (role="img", summary label) and every value is in the table view.
 *
 * @param {{rows: Array<{id: string, label: string, cells: Array<{year: number, value: number,
 *           tier?: string|null, projected?: boolean}>}>, years: number[], xDomain?: [number, number],
 *          domain: [number, number], ramp?: string, now?: number|null, selectedId?: string|null,
 *          onSelectRow?: (id: string) => void, valueLabel?: string, unit?: string, ariaLabel: string}} props
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { lutRgb } from "../design/ramps.js";
import { fmt, fmtSigned } from "../lib/format.js";
import { cn } from "../lib/cn.js";
import { CHART, frameSpans, linearScale, yearTicks } from "./chartTheme.js";
import { ChartTip } from "./ChartTip.jsx";
import { useLinkStore } from "./linking.js";
import { useSize } from "./useSize.js";

const ROW_H = 14;
const LABEL_W = 132;
const AXIS_H = 18;

export function ThermalBarcode({ rows = [], years = [], xDomain = [1990, 2050], domain, ramp = "polar", now = null, selectedId = null, onSelectRow, valueLabel = "Anomaly", unit = "°C", signed = true, ariaLabel }) {
  const boxRef = useRef(null);
  const canvasRef = useRef(null);
  const { width } = useSize(boxRef, { width: 720, height: 300 });
  const hoverScope = useLinkStore((s) => s.hoverScope);
  const setHoverScope = useLinkStore((s) => s.setHoverScope);
  const [tip, setTip] = useState(null);
  const plotW = Math.max(160, width - LABEL_W);
  const height = rows.length * ROW_H + AXIS_H;
  const x = useMemo(() => linearScale([xDomain[0] - 0.5, xDomain[1] + 0.5], [0, plotW]), [xDomain, plotW]);
  const spans = useMemo(() => frameSpans(years, xDomain), [years, xDomain]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.width = Math.round(plotW * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, plotW, height);
    const rgb = [0, 0, 0];
    rows.forEach((row, r) => {
      const y0 = r * ROW_H;
      const byYear = new Map(row.cells.map((c) => [c.year, c]));
      for (const s of spans) {
        const c = byYear.get(s.year);
        if (!c || !Number.isFinite(c.value)) continue;
        const px0 = Math.round(x(s.x0));
        const px1 = Math.round(x(s.x1));
        lutRgb(ramp, c.value, domain[0], domain[1], rgb);
        ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        // 1 px surface gap between rows (dataviz spacer), full width per frame span.
        ctx.fillRect(px0, y0, Math.max(1, px1 - px0), ROW_H - 1);
        if (c.projected) {
          ctx.fillStyle = "rgba(140,160,200,0.28)";
          ctx.fillRect(px0, y0, Math.max(1, px1 - px0), ROW_H - 1);
          ctx.strokeStyle = "rgba(223,231,242,0.30)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let hx = px0 - ROW_H; hx < px1; hx += 5) {
            ctx.moveTo(Math.max(px0, hx), y0 + Math.max(0, px0 - hx));
            ctx.lineTo(Math.min(px1, hx + ROW_H), y0 + Math.min(ROW_H - 1, px1 - hx));
          }
          ctx.stroke();
        }
      }
      if (row.id === selectedId || row.id === hoverScope) {
        ctx.strokeStyle = row.id === selectedId ? CHART.cursor : CHART.hover;
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, y0 + 0.5, plotW - 1, ROW_H - 2);
      }
    });
    // NOW rule + axis
    if (Number.isFinite(now)) {
      ctx.fillStyle = CHART.now;
      ctx.fillRect(Math.round(x(now + 2.5)), 0, 1, rows.length * ROW_H);
    }
    ctx.fillStyle = CHART.axis;
    ctx.font = `${CHART.fontSize}px ${CHART.font}`;
    ctx.textAlign = "center";
    for (const t of yearTicks(xDomain[0], xDomain[1], plotW < 400 ? 20 : 10)) ctx.fillText(String(t), x(t), rows.length * ROW_H + 13);
  }, [rows, spans, x, plotW, height, domain, ramp, now, selectedId, hoverScope, xDomain]);

  const locate = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const r = Math.floor(py / ROW_H);
    const row = rows[r];
    if (!row) return null;
    const t = x.invert(px);
    const span = spans.find((s) => t >= s.x0 && t < s.x1);
    const cell = span ? row.cells.find((c) => c.year === span.year) : null;
    return { row, cell, px: px + LABEL_W, py };
  };

  return (
    <div ref={boxRef} className="relative w-full">
      <div className="flex">
        <ul className="shrink-0" style={{ width: LABEL_W }} aria-label={`${ariaLabel}: rows`}>
          {rows.map((row) => (
            <li key={row.id} style={{ height: ROW_H }}>
              <button
                type="button"
                onClick={() => onSelectRow?.(row.id)}
                onMouseEnter={() => setHoverScope(row.id)}
                onMouseLeave={() => setHoverScope(null)}
                onFocus={() => setHoverScope(row.id)}
                onBlur={() => setHoverScope(null)}
                aria-pressed={row.id === selectedId}
                className={cn(
                  "focus-ring block h-full w-full truncate rounded-sm pr-2 text-right text-[11px] leading-[14px]",
                  row.id === selectedId ? "text-ink-strong" : row.id === hoverScope ? "text-ink" : "text-ink-muted hover:text-ink",
                )}
              >
                {row.label}
              </button>
            </li>
          ))}
        </ul>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`${ariaLabel}. ${rows.length} rows, frames ${years[0] ?? ""}–${years[years.length - 1] ?? ""}. Use the table view for values.`}
          style={{ width: plotW, height }}
          className="block cursor-pointer"
          onPointerMove={(e) => {
            const hit = locate(e);
            setTip(hit);
            setHoverScope(hit?.row.id ?? null);
          }}
          onPointerLeave={() => {
            setTip(null);
            setHoverScope(null);
          }}
          onClick={(e) => {
            const hit = locate(e);
            if (hit) onSelectRow?.(hit.row.id);
          }}
        />
      </div>
      {tip && (
        <ChartTip x={tip.px} y={tip.py} width={width}>
          <p className="text-ink-strong">{tip.row.label}</p>
          {tip.cell && Number.isFinite(tip.cell.value) ? (
            <p className="tnum font-mono">
              {tip.cell.year}
              {tip.cell.projected ? " (projected)" : tip.cell.tier ? ` (${tip.cell.tier})` : ""} · {valueLabel} {signed ? fmtSigned(tip.cell.value, 2) : fmt(tip.cell.value, 1)} {unit}
            </p>
          ) : (
            <p className="text-ink-muted">no frame at this x</p>
          )}
        </ChartTip>
      )}
    </div>
  );
}

export default ThermalBarcode;
