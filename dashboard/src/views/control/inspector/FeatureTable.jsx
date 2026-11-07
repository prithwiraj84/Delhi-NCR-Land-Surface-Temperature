/**
 * Feature values of the pinned cell with their percentile ranks across the NCR (UI_SPEC_v2
 * §3.4 "Feature values (n) with p-ranks"). v2 frames carry the 33 base features
 * (`xai_<year>_features.lstb.gz`); v1 epochs their v1 feature columns. Units and display come
 * from `manifest.features`. A real <table> (sortable by rank via the column header button).
 */
import { useMemo, useState } from "react";
import { ArrowDownUp } from "lucide-react";
import { featureMeta, fmtFeatureValue, MISSING } from "../../../lib/format.js";
import { percentRank } from "../controlModel.js";

/** @param {{xai: object, index: number, manifest: object|null}} props */
export function FeatureTable({ xai, index, manifest }) {
  const [byRank, setByRank] = useState(false);
  const rows = useMemo(() => {
    const names = xai?.featureNames?.length ? xai.featureNames : Object.keys(xai?.features ?? {});
    return names.map((name) => {
      const col = xai.features[name];
      const v = col ? col[index] : NaN;
      const meta = featureMeta(manifest, name);
      return { name, label: meta?.label ?? name, value: fmtFeatureValue(meta, v), rank: percentRank(col, v), family: meta?.family ?? meta?.group ?? null };
    });
  }, [xai, index, manifest]);
  const sorted = byRank ? [...rows].sort((a, b) => (b.rank ?? -1) - (a.rank ?? -1)) : rows;
  if (!rows.length) return <p className="text-[12px] text-ink-muted">No feature values in this frame.</p>;
  return (
    <div className="scrollbar-thin max-h-64 overflow-auto">
      <table className="w-full border-collapse text-left text-[12px]">
        <caption className="sr-only">{`Feature values of the cell (${rows.length}) with percentile rank across all cells`}</caption>
        <thead className="micro-label sticky top-0 bg-surface-2">
          <tr>
            <th scope="col" className="py-1 pr-1 font-medium">
              Feature
            </th>
            <th scope="col" className="py-1 pr-1 text-right font-medium">
              Value
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              <button type="button" onClick={() => setByRank((v) => !v)} aria-pressed={byRank} className="focus-ring inline-flex items-center gap-0.5 rounded px-0.5 uppercase">
                p-rank <ArrowDownUp aria-hidden="true" className="size-3" />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.name} className="border-t border-hairline">
              <th scope="row" className="max-w-[9rem] truncate py-1 pr-1 font-normal text-ink" title={r.label}>
                {r.label}
              </th>
              <td className="tnum py-1 pr-1 text-right font-mono text-ink">{r.value}</td>
              <td className="py-1 text-right">
                <span className="inline-flex items-center justify-end gap-1">
                  <span aria-hidden="true" className="h-1 w-10 overflow-hidden rounded-full bg-surface-3">
                    <span className="block h-full bg-ink-muted" style={{ width: `${Number.isFinite(r.rank) ? r.rank : 0}%` }} />
                  </span>
                  <span className="tnum w-7 text-right font-mono text-[11px] text-ink-muted">{Number.isFinite(r.rank) ? Math.round(r.rank) : MISSING}</span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default FeatureTable;
