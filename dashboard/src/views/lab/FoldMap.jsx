/**
 * FOLD MAP (UI_SPEC §3.8 "blocks coloured by fold RMSE; NE strip visible"; SPEC §4.2
 * `fold_geometry`): the spatial-CV blocks in grid order (north up), each coloured by the RMSE
 * of its out-of-fold predictions on the Mist ramp (one hue family, light = worse), labelled
 * with its fold number; empty blocks (outside the ROI) are blank. The worst block is named in
 * the caption so the reader knows where not to trust the model — the real v1 run's weak fold
 * was the cool north-east strip (Karnal, Shamli, Muzaffarnagar).
 */
import { useRef, useState } from "react";
import { lutRgb, rampGradientCss } from "../../design/ramps.js";
import { fmt } from "../../lib/format.js";
import { ChartTable } from "../../viz/ChartTable.jsx";
import { CHART } from "../../viz/chartTheme.js";
import { ChartTip } from "../../viz/ChartTip.jsx";
import { useSize } from "../../viz/useSize.js";
import { Segmented } from "../../components/ui/Segmented.jsx";
import { foldMap } from "./labModel.js";

export function FoldMap({ slice, mode }) {
  const boxRef = useRef(null);
  const { width } = useSize(boxRef, { width: 320, height: 240 });
  const available = ["block20", "block5"].filter((s) => slice?.fold_geometry?.[s]);
  const [scheme, setScheme] = useState("block20");
  const active = available.includes(scheme) ? scheme : available[0] ?? "block20";
  const fm = foldMap(slice, active);
  const [tip, setTip] = useState(null);
  const status = fm ? { status: "ready" } : { status: "unavailable", reason: "Fold geometry is a v2 export (metrics.json fold_geometry) — rerun notebook v2." };
  const rmses = fm ? fm.cells.map((c) => c.rmse).filter(Number.isFinite) : [];
  const lo = rmses.length ? Math.min(...rmses) : 0;
  const hi = rmses.length ? Math.max(...rmses) : 1;
  const cell = fm ? Math.max(6, Math.min(36, Math.floor((width - 4) / fm.cols))) : 0;
  const rgb = [0, 0, 0];
  return (
    <ChartTable
      title={`Fold map · ${mode}`}
      status={status}
      actions={available.length > 1 ? <Segmented ariaLabel="Blocking" size="sm" value={active} onChange={setScheme} options={available.map((s) => ({ value: s, label: s }))} layoutId="foldmap-scheme" /> : null}
      columns={[
        { key: "pos", label: "Block (row, col)" },
        { key: "fold", label: "Fold", align: "right" },
        { key: "rmse", label: "RMSE °C", align: "right", format: (v) => fmt(v, 2) },
      ]}
      rows={(fm?.cells ?? []).filter((c) => c.fold !== null).map((c) => ({ id: `${c.r}-${c.c}`, pos: `${c.r + 1}, ${c.c + 1}`, fold: c.fold, rmse: c.rmse }))}
      caption={`Spatial cross-validation blocks (${fm?.blockKm ?? "?"} km) in grid order, north up, with the out-of-fold RMSE of each block.`}
    >
      {fm && (
        <div ref={boxRef} className="relative">
          <svg width={fm.cols * cell} height={fm.rows * cell} role="img" aria-label={`Fold map with ${fm.cells.filter((c) => c.fold !== null).length} blocks; worst block RMSE ${fmt(fm.worst?.rmse, 2)} °C at row ${(fm.worst?.r ?? 0) + 1}, column ${(fm.worst?.c ?? 0) + 1}. Use the table view for every block.`}>
            {fm.cells.map((c) => {
              if (c.fold === null) return null;
              const col = Number.isFinite(c.rmse) ? lutRgb("mist", c.rmse, lo, hi, rgb) : null;
              return (
                <g
                  key={`${c.r}-${c.c}`}
                  onPointerEnter={(e) => {
                    const rect = boxRef.current.getBoundingClientRect();
                    setTip({ c, x: e.clientX - rect.left, y: e.clientY - rect.top });
                  }}
                  onPointerLeave={() => setTip(null)}
                >
                  <rect x={c.c * cell + 1} y={c.r * cell + 1} width={cell - 2} height={cell - 2} rx={2} fill={col ? `rgb(${col[0]},${col[1]},${col[2]})` : CHART.surface} stroke={fm.worst === c ? CHART.ink : "none"} strokeWidth={1.5} />
                  {cell >= 16 && (
                    <text x={c.c * cell + cell / 2} y={c.r * cell + cell / 2} dy="0.32em" textAnchor="middle" fontSize={9.5} fontFamily={CHART.font} fill={col && col[0] > 150 ? "#05070D" : CHART.ink}>
                      {c.fold}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-ink-faint">
            <span className="font-mono">{fmt(lo, 2)}</span>
            <span aria-hidden="true" className="h-2 w-24 rounded-sm" style={{ backgroundImage: rampGradientCss("mist") }} />
            <span className="font-mono">{fmt(hi, 2)} °C RMSE</span>
            <span>· number = fold · outlined = worst block</span>
          </div>
          {tip && (
            <ChartTip x={tip.x} y={tip.y} width={width}>
              block row {tip.c.r + 1}, col {tip.c.c + 1} · fold {tip.c.fold} · RMSE {fmt(tip.c.rmse, 2)} °C
            </ChartTip>
          )}
        </div>
      )}
    </ChartTable>
  );
}

export default FoldMap;
