/**
 * ZONE ALLUVIAL (UI_SPEC §3.7): how the same grid cells move between governance zones across
 * every frame — observed transitions, then the selected SSP's projected transitions chained
 * from NOW. Column stacks = cells per zone (ordered by zone id, 2 px surface gap); ribbons =
 * cells moving from zone i (left) to zone j (right), coloured by the SOURCE zone. Projected
 * columns and ribbons sit under the fog/hatch. Hover a ribbon for its count; the table view
 * lists every non-zero flow. The v1 transition matrix is a toggle in ZonesView.
 */
import { useId, useMemo, useRef, useState } from "react";
import { ZONE_COLORS, ZONE_NAMES } from "../../lib/colors.js";
import { fmtInt, fmtPct } from "../../lib/format.js";
import { alluvialColumns, zoneDisplayName } from "../../components/zones/zoneModel.js";
import { ChartTip } from "../../viz/ChartTip.jsx";
import { CHART, hatchUrl, linearScale, svgId } from "../../viz/chartTheme.js";
import { HatchDefs } from "../../viz/Hatch.jsx";
import { useSize } from "../../viz/useSize.js";

const M = { top: 18, right: 8, bottom: 8, left: 8 };
const NODE_W = 10;
const GAP = 2;

/**
 * @param {{transitionsBySeries: object|null, ssp?: string|null, zonesMeta?: object[], height?: number}} props
 */
export function ZoneAlluvial({ transitionsBySeries, ssp = null, zonesMeta = [], height = 260 }) {
  const boxRef = useRef(null);
  const pid = svgId(useId(), "alluvial");
  const { width } = useSize(boxRef, { width: 640, height });
  const [tip, setTip] = useState(null);
  const data = useMemo(() => alluvialColumns(transitionsBySeries, { ssp }), [transitionsBySeries, ssp]);
  const color = (z) => zonesMeta.find((m) => Number(m.id) === z)?.color ?? ZONE_COLORS[z];
  const name = (z) => {
    const m = zonesMeta.find((x) => Number(x.id) === z);
    return m ? zoneDisplayName(m) : ZONE_NAMES[z] ?? `Zone ${z}`;
  };

  const layout = useMemo(() => {
    const cols = data.columns;
    if (!cols.length) return null;
    const k = cols[0].totals.length;
    const maxTotal = Math.max(...cols.map((c) => c.totals.reduce((a, b) => a + b, 0)));
    const innerH = height - M.top - M.bottom - GAP * (k - 1);
    const scale = innerH / Math.max(1, maxTotal);
    const x = linearScale([0, Math.max(1, cols.length - 1)], [M.left, width - M.right - NODE_W]);
    const nodes = cols.map((c, ci) => {
      let y = M.top;
      return c.totals.map((t, z) => {
        const node = { z, x: x(ci), y, h: t * scale, total: t, projected: c.projected, year: c.year };
        y += t * scale + GAP;
        return node;
      });
    });
    const ribbons = [];
    data.flows.forEach((f, fi) => {
      const left = nodes[fi];
      const right = nodes[fi + 1];
      const outOff = left.map((n) => n.y);
      const inOff = right.map((n) => n.y);
      for (let i = 0; i < k; i += 1) {
        for (let j = 0; j < k; j += 1) {
          const v = f.matrix[i]?.[j] ?? 0;
          if (v <= 0) continue;
          const h = v * scale;
          const x0 = left[i].x + NODE_W;
          const x1 = right[j].x;
          const y0 = outOff[i];
          const y1 = inOff[j];
          outOff[i] += h;
          inOff[j] += h;
          const mx = (x0 + x1) / 2;
          ribbons.push({ key: `${fi}-${i}-${j}`, i, j, v, from: f.from, to: f.to, projected: f.projected, share: left[i].total ? v / left[i].total : 0, d: `M${x0},${y0}C${mx},${y0} ${mx},${y1} ${x1},${y1}L${x1},${y1 + h}C${mx},${y1 + h} ${mx},${y0 + h} ${x0},${y0 + h}Z` });
        }
      }
    });
    return { nodes, ribbons, x };
  }, [data, width, height]);

  if (!layout) {
    return <p className="rounded-md border border-dashed border-hairline p-4 text-center text-xs text-ink-muted">No zone transitions were exported for consecutive frames.</p>;
  }
  const projStart = layout.nodes.find((col) => col[0].projected)?.[0]?.x;

  return (
    <div ref={boxRef} className="relative">
      <ul className="mb-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-muted" aria-label="Zones">
        {[0, 1, 2, 3].map((z) => (
          <li key={z} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2.5 rounded-sm" style={{ backgroundColor: color(z) }} />
            {z} · {name(z)}
          </li>
        ))}
      </ul>
      <svg width={width} height={height} role="img" aria-label={`Zone transitions across ${layout.nodes.length} frames${ssp ? `, projected under ${ssp}` : ""}. Use the table view for counts.`}>
        <HatchDefs prefix={pid} />
        {projStart !== undefined && <rect x={projStart - 6} y={M.top - 14} width={width - projStart + 6 - M.right} height={height - M.top + 14 - M.bottom} fill={hatchUrl(pid, "fog")} />}
        {layout.ribbons.map((r) => (
          <path
            key={r.key}
            d={r.d}
            fill={color(r.i)}
            fillOpacity={r.i === r.j ? 0.2 : 0.42}
            stroke={tip?.key === r.key ? CHART.ink : "none"}
            onPointerEnter={(e) => {
              const rect = boxRef.current.getBoundingClientRect();
              setTip({ ...r, x: e.clientX - rect.left, y: e.clientY - rect.top });
            }}
            onPointerLeave={() => setTip(null)}
          />
        ))}
        {layout.nodes.map((col, ci) => (
          <g key={ci}>
            <text x={col[0].x + NODE_W / 2} y={M.top - 6} textAnchor="middle" fill={col[0].projected ? CHART.inkFaint : CHART.inkMuted} fontSize={10} fontFamily={CHART.font}>
              {col[0].year}
            </text>
            {col.map((n) => (
              <rect key={n.z} x={n.x} y={n.y} width={NODE_W} height={Math.max(0.5, n.h)} rx={2} fill={color(n.z)} stroke={n.projected ? CHART.inkFaint : "none"} strokeDasharray={n.projected ? "2 2" : undefined} />
            ))}
          </g>
        ))}
      </svg>
      {tip && (
        <ChartTip x={tip.x} y={tip.y} width={width}>
          <p className="text-ink-strong">
            {tip.from} → {tip.to}
            {tip.projected ? " (projected)" : ""}
          </p>
          <p>
            {name(tip.i)} → {name(tip.j)}: <span className="tnum font-mono">{fmtInt(tip.v)}</span> cells ({fmtPct(tip.share, 0)} of the source zone)
          </p>
        </ChartTip>
      )}
    </div>
  );
}

export default ZoneAlluvial;
