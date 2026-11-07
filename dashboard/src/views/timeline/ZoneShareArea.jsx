/**
 * ZONE SHARE 100 % (UI_SPEC §3.5): share of the mapped area in each governance zone at every
 * frame, observed frames then the selected SSP's projected zones, as a stacked area with a
 * 1 px surface gap between zones. Projected columns sit under the fog + hatch (scenario, not
 * observation). Zone identity = colour + name (legend and end labels); zones 0 and 3 are a
 * CVD-weak pair, so names are always shown.
 */
import { useId, useMemo, useRef } from "react";
import { ZONE_COLORS, ZONE_NAMES } from "../../lib/colors.js";
import { fmtPct } from "../../lib/format.js";
import { ChartTable } from "../../viz/ChartTable.jsx";
import { CHART, hatchUrl, linearScale, svgId, yearTicks } from "../../viz/chartTheme.js";
import { HatchDefs } from "../../viz/Hatch.jsx";
import { useSize } from "../../viz/useSize.js";
import { zoneDisplayName } from "../../components/zones/zoneModel.js";
import { zoneShareSeries } from "./timelineModel.js";

const M = { top: 8, right: 8, bottom: 20, left: 34 };

export function ZoneShareArea({ series, mode, ssp, zonesMeta = [], now, reason = null }) {
  const boxRef = useRef(null);
  const pid = svgId(useId(), "zs");
  const { width } = useSize(boxRef, { width: 420, height: 200 });
  const data = useMemo(() => zoneShareSeries(series, mode, ssp), [series, mode, ssp]);
  const height = 190;
  const zoneIds = [0, 1, 2, 3];
  const meta = (id) => {
    const z = zonesMeta.find((m) => Number(m.id) === id);
    // Visible labels use the zone's display name (D11).
    return z ? { ...z, name: zoneDisplayName(z) } : {};
  };
  const x = linearScale([data[0]?.year ?? 1990, data[data.length - 1]?.year ?? 2050], [M.left, Math.max(M.left + 80, width - M.right)]);
  const y = linearScale([0, 1], [height - M.bottom, M.top]);
  const layers = zoneIds.map((z) => {
    const top = [];
    const bottom = [];
    for (const r of data) {
      const total = r.shares.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) || 1;
      const below = r.shares.slice(0, z).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) / total;
      const own = (Number.isFinite(r.shares[z]) ? r.shares[z] : 0) / total;
      bottom.push([x(r.year), y(below)]);
      top.push([x(r.year), y(below + own)]);
    }
    const d = top.length ? `M${top.map((p) => p.join(",")).join("L")}L${[...bottom].reverse().map((p) => p.join(",")).join("L")}Z` : "";
    return { z, d };
  });
  const firstProj = data.find((r) => r.projected);
  const rows = data.map((r) => ({ id: r.year, year: r.year, kind: r.projected ? `projected (${ssp})` : "observed", ...Object.fromEntries(zoneIds.map((z) => [`z${z}`, r.shares[z]])) }));
  const status = reason ? { status: "unavailable", reason } : data.length ? { status: "ready" } : series ? { status: "unavailable", reason: "No zone shares exported for this mode." } : { status: "loading" };

  return (
    <ChartTable
      title={`Zone share · ${mode}`}
      status={status}
      columns={[{ key: "year", label: "Frame" }, { key: "kind", label: "Kind" }, ...zoneIds.map((z) => ({ key: `z${z}`, label: meta(z).name ?? ZONE_NAMES[z], align: "right", format: (v) => fmtPct(v, 1) }))]}
      rows={rows}
      caption="Share of mapped cells in each governance zone (rows sum to 100 %). Projected frames use the zones of the selected scenario's median land realisation."
    >
      <div ref={boxRef}>
        <ul className="mb-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-muted" aria-label="Zones">
          {zoneIds.map((z) => (
            <li key={z} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2.5 rounded-sm" style={{ backgroundColor: meta(z).color ?? ZONE_COLORS[z] }} />
              {z} · {meta(z).name ?? ZONE_NAMES[z]}
            </li>
          ))}
        </ul>
        <svg width={width} height={height} role="img" aria-label="Zone shares through time. Use the table view for values.">
          <HatchDefs prefix={pid} />
          {[0, 0.5, 1].map((t) => (
            <text key={t} x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fill={CHART.axis} fontSize={CHART.fontSize} fontFamily={CHART.font}>
              {t * 100}%
            </text>
          ))}
          {layers.map((l) => (
            <path key={l.z} d={l.d} fill={meta(l.z).color ?? ZONE_COLORS[l.z]} fillOpacity={0.82} stroke={CHART.surface} strokeWidth={1} />
          ))}
          {firstProj && <rect x={x(now ?? firstProj.year)} y={M.top} width={Math.max(0, x.range[1] - x(now ?? firstProj.year))} height={height - M.bottom - M.top} fill={hatchUrl(pid, "fog")} />}
          {Number.isFinite(now) && <line x1={x(now)} x2={x(now)} y1={M.top} y2={height - M.bottom} stroke={CHART.now} />}
          {yearTicks(x.domain[0], x.domain[1], width < 380 ? 20 : 10).map((t) => (
            <text key={t} x={x(t)} y={height - 5} textAnchor="middle" fill={CHART.axis} fontSize={CHART.fontSize} fontFamily={CHART.font}>
              {t}
            </text>
          ))}
        </svg>
      </div>
    </ChartTable>
  );
}

export default ZoneShareArea;
