/**
 * DescribeMap (UI_SPEC_v2 §12 "Map alternatives", graft from Concept C): an auto-generated
 * sentence of what the map shows (frame, tier, NCR mean with interval, hottest district,
 * signed surface UHI, hot core, layer and scale) plus a district data table. The sentence is
 * always present for assistive technology (visually hidden, referenced by the stage region);
 * the toolbar's "Describe" button shows it with the table. Not a live region: announcements
 * are reserved for snap / mode / SSP / scenario (UI_SPEC §12).
 */
import { useMemo } from "react";
import { X } from "lucide-react";
import { TierShape } from "../../design/glyphs.jsx";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { useDomain, useResource } from "../../data/hooks.js";
import { frameAt } from "../../data/timeline.js";
import { scopeSeries, scopesOfKind, seriesValueAt } from "../../data/series.js";
import { cn } from "../../lib/cn.js";
import { fmt, fmtSigned, fmtSsp, MISSING } from "../../lib/format.js";
import { useViewStore } from "../../state/stores/viewStore.js";
import { describeMapSentence } from "./controlModel.js";
import { LAYER_ITEMS, legendSpec } from "./layerModel.js";
import { useLiveFrame } from "./useControlData.js";

export const DESCRIBE_MAP_ID = "describe-map-sentence";

/**
 * @param {{open?: boolean, onClose?: () => void, hiddenSentence?: boolean, className?: string}} props
 *   `hiddenSentence` renders the always-present visually hidden sentence (mount it once).
 */
export function DescribeMap({ open = false, onClose, hiddenSentence = true, className }) {
  const live = useLiveFrame();
  const { stats, info, mode, ssp, timeline } = live;
  const layer = useViewStore((s) => s.layer);
  const variable = useViewStore((s) => s.variable);
  const domain = useDomain(mode, variable);
  const series = useResource("series");
  const scenario = timeline?.scenarios?.find((s) => s.id === ssp);
  const legend = useMemo(() => (layer === "lst" || layer === "pred" ? legendSpec({ layer, variable, mode, domain: domain.status === "ready" ? domain.data : null, timeline }) : null), [layer, variable, mode, domain, timeline]);
  const sentence = describeMapSentence({ stats, info, mode, layerLabel: LAYER_ITEMS.find((l) => l.id === layer)?.label ?? layer, legend, sspLabel: scenario?.label ?? fmtSsp(ssp) });

  const exactYear = live.exact && info?.frame ? info.frame.year : null;
  const rows = useMemo(() => {
    if (!open || series.status !== "ready" || exactYear === null) return [];
    const s = series.data;
    return scopesOfKind(s, "district")
      .map((scope) => {
        const v = seriesValueAt(scopeSeries(s, scope.id, mode), exactYear, ssp);
        return { id: scope.id, label: scope.label, mean: v?.mean ?? NaN, uhi: v?.uhi ?? NaN, lo: v?.ci?.[0] ?? NaN, hi: v?.ci?.[1] ?? NaN, tier: v?.tier ?? null };
      })
      .sort((a, b) => (Number.isFinite(b.mean) ? b.mean : -Infinity) - (Number.isFinite(a.mean) ? a.mean : -Infinity));
  }, [open, series, exactYear, mode, ssp]);

  const frame = exactYear !== null ? frameAt(timeline, exactYear) : null;
  return (
    <>
      {hiddenSentence && (
        <p id={DESCRIBE_MAP_ID} className="sr-only">
          {sentence}
        </p>
      )}
      {open && (
        <HudFrame as="section" aria-label="Map description" padding="sm" className={cn("pointer-events-auto w-[min(32rem,calc(100vw-2rem))]", className)} data-testid="describe-map">
          <header className="flex items-start justify-between gap-2">
            <h2 className="micro-label">Describe the map</h2>
            {onClose && (
              <button type="button" aria-label="Close map description" onClick={onClose} className="focus-ring grid size-6 place-items-center rounded text-ink-muted hover:text-ink">
                <X aria-hidden="true" className="size-3.5" />
              </button>
            )}
          </header>
          <p className="mt-1 text-[13px] leading-relaxed text-ink">{sentence}</p>
          {exactYear === null ? (
            <p className="mt-2 text-[12px] text-ink-muted">The district table appears on exact frames (release the playhead on a frame).</p>
          ) : (
            <div className="scrollbar-thin mt-2 max-h-64 overflow-auto">
              <table className="w-full border-collapse text-left text-[12px]">
                <caption className="sr-only">{`Districts at ${exactYear}, ${mode}${frame?.kind === "projected" ? `, ${scenario?.label ?? fmtSsp(ssp)} p50` : ""}`}</caption>
                <thead className="micro-label">
                  <tr>
                    <th scope="col" className="px-1.5 py-1 font-medium">
                      District
                    </th>
                    <th scope="col" className="px-1.5 py-1 text-right font-medium">
                      Mean °C
                    </th>
                    <th scope="col" className="px-1.5 py-1 text-right font-medium">
                      Interval
                    </th>
                    <th scope="col" className="px-1.5 py-1 text-right font-medium">
                      UHI °C
                    </th>
                    <th scope="col" className="px-1.5 py-1 font-medium">
                      Tier
                    </th>
                  </tr>
                </thead>
                <tbody className="tnum font-mono">
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-hairline">
                      <th scope="row" className="px-1.5 py-1 font-sans font-normal text-ink">
                        {r.label}
                      </th>
                      <td className="px-1.5 py-1 text-right text-ink-strong">{fmt(r.mean, 1)}</td>
                      <td className="px-1.5 py-1 text-right text-ink-muted">{Number.isFinite(r.lo) && Number.isFinite(r.hi) ? `${fmt(r.lo, 1)}–${fmt(r.hi, 1)}` : MISSING}</td>
                      <td className="px-1.5 py-1 text-right text-ink">{Number.isFinite(r.uhi) ? fmtSigned(r.uhi, 1) : MISSING}</td>
                      <td className="px-1.5 py-1 text-ink-muted">
                        <span className="inline-flex items-center gap-1">
                          <TierShape tier={r.tier} size={9} />
                          {r.tier ?? MISSING}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </HudFrame>
      )}
    </>
  );
}

export default DescribeMap;
