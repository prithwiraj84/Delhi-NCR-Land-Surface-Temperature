/**
 * PROVENANCE SWIMLANES (UI_SPEC §3.9): a Gantt of every input dataset from 1985 to 2050 —
 * one lane per source, grouped by role (day LST, night LST, land cover, drivers, climate,
 * projections), with the NOW rule and the projection span fogged. Each lane label is a
 * button; selecting a lane (or clicking its bar) opens its source card: collection id,
 * resolution, role, use and the notebook's notes. v1 bundles (no provenance.json) show the
 * lanes recorded in manifest.data_sources, flagged as derived. The panel is a ChartTable, so
 * the Gantt has a real <table> twin (source · group · span · resolution · collection).
 */
import { useId, useRef, useState } from "react";
import { MicroLabel } from "../../components/ui/MicroLabel.jsx";
import { cn } from "../../lib/cn.js";
import { ChartTable } from "../../viz/ChartTable.jsx";
import { CHART, hatchUrl, linearScale, svgId, yearTicks } from "../../viz/chartTheme.js";
import { HatchDefs } from "../../viz/Hatch.jsx";
import { useSize } from "../../viz/useSize.js";

const LANE = 18;
const LABEL_W = 190;
const LABEL_W_NARROW = 112;

/** Compact list of a lane’s bars ("2003–2025" or "1990, 1995, 2000" for per-year marks). */
function spanText(lane) {
  if (!lane.bars.length) return null;
  if (lane.derived) return lane.bars.map((b) => Math.round((b.start + b.end) / 2)).join(", ");
  return lane.bars.map((b) => `${Math.round(b.start)}–${Math.round(b.end)}`).join(", ");
}

const TABLE_COLUMNS = [
  { key: "label", label: "Source" },
  { key: "group", label: "Group" },
  { key: "span", label: "Years" },
  { key: "resolution", label: "Resolution", align: "right" },
  { key: "asset", label: "Collection", format: (v) => (v ? <span className="break-all font-mono">{v}</span> : null) },
];

export function ProvenanceSwimlanes({ lanes, now = 2025, domain = [1985, 2050] }) {
  const boxRef = useRef(null);
  const pid = svgId(useId(), "lanes");
  const { width } = useSize(boxRef, { width: 760, height: 300 });
  const [sel, setSel] = useState(null);
  const title = `Provenance swimlanes · ${domain[0]}–${domain[1]}`;
  if (!lanes.length) return <ChartTable title={title} status={{ status: "unavailable", reason: "No provenance records in this bundle." }} />;
  // Narrow screens: shorter label column so lanes + plot fit a 320 px viewport.
  const labelW = width < 520 ? LABEL_W_NARROW : LABEL_W;
  const plotW = Math.max(160, width - labelW);
  const height = lanes.length * LANE + 22;
  // Inset the range by half a tick label so the centred first/last year labels (1990…2050) are not clipped.
  const x = linearScale(domain, [14, plotW - 18]);
  const active = lanes.find((l) => l.id === sel) ?? null;
  const derived = lanes.some((l) => l.derived);
  const rows = lanes.map((l) => ({ id: l.id, label: l.label, group: l.group, span: spanText(l), resolution: l.resolution_m ? `${l.resolution_m} m` : null, asset: l.asset }));
  return (
    <ChartTable
      title={title}
      columns={TABLE_COLUMNS}
      rows={rows}
      caption={`Time coverage of ${lanes.length} data sources${derived ? " (derived from manifest.data_sources; v1 bundle)" : ""}.`}
    >
      {derived && <p className="mb-2 text-[11px] text-ink-faint">This bundle has no provenance.json (v1): lanes are the variables documented in manifest.data_sources, one mark per documented year.</p>}
      <div ref={boxRef} className="flex">
        <ul className="shrink-0" style={{ width: labelW }} aria-label="Data sources">
          {lanes.map((l) => (
            <li key={l.id} style={{ height: LANE }}>
              <button type="button" onClick={() => setSel(l.id === sel ? null : l.id)} aria-pressed={l.id === sel} aria-controls={`${pid}-card`} className={cn("focus-ring block h-full w-full truncate rounded-sm pr-2 text-right text-[11px]", l.id === sel ? "text-ink-strong" : "text-ink-muted hover:text-ink")} title={l.label}>
                {l.label}
              </button>
            </li>
          ))}
        </ul>
        <svg width={plotW} height={height} role="img" aria-label={`Time coverage of ${lanes.length} data sources. Select a source on the left for its details.`}>
          <HatchDefs prefix={pid} />
          <rect x={x(now)} y={0} width={Math.max(0, x(domain[1]) - x(now))} height={lanes.length * LANE} fill={hatchUrl(pid, "fog")} />
          {yearTicks(domain[0], domain[1], plotW < 420 ? 20 : 10).map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={0} y2={lanes.length * LANE} stroke={CHART.grid} />
              <text x={x(t)} y={height - 6} textAnchor="middle" fill={CHART.axis} fontSize={CHART.fontSize} fontFamily={CHART.font}>
                {t}
              </text>
            </g>
          ))}
          <line x1={x(now)} x2={x(now)} y1={0} y2={lanes.length * LANE} stroke={CHART.now} />
          {lanes.map((l, k) =>
            l.bars.map((b, j) => (
              <rect
                key={`${l.id}-${j}`}
                x={x(Math.max(domain[0], b.start))}
                y={k * LANE + 4}
                width={Math.max(3, x(Math.min(domain[1], b.end)) - x(Math.max(domain[0], b.start)))}
                height={LANE - 8}
                rx={3}
                fill={l.id === sel ? CHART.ink : l.group === "projections" ? CHART.inkFaint : CHART.inkMuted}
                fillOpacity={l.group === "projections" ? 0.6 : 0.85}
                className="cursor-pointer"
                onClick={() => setSel(l.id)}
              >
                <title>{`${l.label}: ${Math.round(b.start)}–${Math.round(b.end)}`}</title>
              </rect>
            )),
          )}
        </svg>
      </div>
      <div id={`${pid}-card`} aria-live="polite">
        {active && (
          <div className="mt-2 grid gap-1 rounded-md border border-hairline bg-surface-3/40 p-3 text-xs sm:grid-cols-2">
            <p className="font-display text-sm font-semibold text-ink-strong sm:col-span-2">{active.label}</p>
            <p>
              <MicroLabel>Collection</MicroLabel> <span className="break-all font-mono text-ink">{active.asset ?? "—"}</span>
            </p>
            <p>
              <MicroLabel>Span</MicroLabel> <span className="font-mono text-ink">{Number.isFinite(active.start) ? `${active.start}–${active.end}` : "—"}</span>
            </p>
            <p>
              <MicroLabel>Resolution</MicroLabel> <span className="font-mono text-ink">{active.resolution_m ? `${active.resolution_m} m` : "—"}</span>
            </p>
            <p>
              <MicroLabel>Role</MicroLabel> <span className="text-ink">{active.role ?? "—"}</span>
              {active.used_for?.length ? <span className="text-ink-muted"> · used for {active.used_for.join(", ")}</span> : null}
            </p>
            {active.notes && <p className="whitespace-pre-line text-ink-muted sm:col-span-2">{active.notes}</p>}
          </div>
        )}
      </div>
    </ChartTable>
  );
}

export default ProvenanceSwimlanes;
