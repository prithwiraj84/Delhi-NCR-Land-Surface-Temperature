/**
 * SKILL SCOREBOARD (UI_SPEC §3.8 "model × scheme × mode, cell = value + fold strip"): a real
 * table — rows = models, columns = validation schemes — each cell the pooled R² (v1: mean of
 * folds) with RMSE and a strip of the per-fold R² values on a shared 0–1 scale. The headline
 * schemes are marked, random CV is greyed as the optimistic bound. The best R² per scheme is
 * marked with text (not colour alone).
 */
import { fmt } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { CHART } from "../../viz/chartTheme.js";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { modelLabel } from "../../components/performance/perfModel.js";
import { Unavailable } from "../../viz/Unavailable.jsx";
import { schemeInfo, scoreboard } from "./labModel.js";

function FoldStrip({ folds, r2 }) {
  if (!folds.length) return null;
  const w = 64;
  const x = (v) => 2 + Math.max(0, Math.min(1, v)) * (w - 4);
  return (
    <svg width={w} height={10} aria-hidden="true" className="block">
      <line x1={2} x2={w - 2} y1={5} y2={5} stroke={CHART.grid} />
      {folds.map((v, i) => (
        <circle key={i} cx={x(v)} cy={5} r={1.75} fill={CHART.inkMuted} />
      ))}
      {Number.isFinite(r2) && <line x1={x(r2)} x2={x(r2)} y1={1} y2={9} stroke={CHART.ink} strokeWidth={1.5} />}
    </svg>
  );
}

export function SkillScoreboard({ slice, mode }) {
  const sb = scoreboard(slice);
  if (!sb.schemes.length) return <Unavailable reason={`No cross-validation summary for ${mode}.`} />;
  const best = Object.fromEntries(sb.schemes.map((s) => [s, sb.models.reduce((b, m) => (sb.cells[`${s}|${m}`]?.r2 > (sb.cells[`${s}|${b}`]?.r2 ?? -Infinity) ? m : b), sb.models[0])]));
  return (
    <HudFrame solid title={`Skill scoreboard · ${mode}`} className="min-w-0">
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-xs">
          <caption className="sr-only">
            R² (pooled out-of-fold where available) and RMSE of each model under each validation scheme for {mode}; the strip shows the per-fold R² on a 0–1 scale with the tick at the pooled value.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="border-b border-hairline px-2 py-1.5 text-left font-mono text-[11px] font-medium uppercase text-ink-faint">
                Model
              </th>
              {sb.schemes.map((s) => (
                <th key={s} scope="col" title={schemeInfo(s).note} className={cn("border-b border-hairline px-2 py-1.5 text-left font-mono text-[11px] font-medium", schemeInfo(s).headline ? "text-ink" : "text-ink-faint")}>
                  {schemeInfo(s).short}
                  {schemeInfo(s).headline ? " ★" : ""}
                  {schemeInfo(s).kind === "optimistic" ? " (optimistic)" : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sb.models.map((m) => (
              <tr key={m} className="border-b border-hairline/50">
                <th scope="row" className="px-2 py-1 text-left font-normal text-ink">
                  {modelLabel(m)}
                </th>
                {sb.schemes.map((s) => {
                  const c = sb.cells[`${s}|${m}`];
                  const optimistic = schemeInfo(s).kind === "optimistic";
                  return (
                    <td key={s} className={cn("px-2 py-1 align-top", optimistic && "opacity-60")}>
                      {c ? (
                        <div className="space-y-0.5">
                          <span className="tnum font-mono text-ink">
                            {fmt(c.r2, 3)}
                            {best[s] === m && <span className="ml-1 text-[10px] text-ok">best</span>}
                          </span>
                          <span className="tnum block font-mono text-[10.5px] text-ink-faint">RMSE {fmt(c.rmse, 2)}</span>
                          <FoldStrip folds={c.folds} r2={c.r2} />
                        </div>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-ink-faint">★ headline schemes. Values are pooled out-of-fold R² in v2 bundles and the mean of per-fold R² in v1 bundles.</p>
    </HudFrame>
  );
}

export default SkillScoreboard;
