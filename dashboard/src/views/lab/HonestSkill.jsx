/**
 * HONEST SKILL (UI_SPEC §3.8 headline, §9 accuracy copy): pooled spatial-block CV (20 km
 * blocks) and leave-one-epoch-out (recentred) for Day and Night, with the per-fold spread;
 * random CV greyed as the "optimistic upper bound"; and the v1 → v2 change of METRIC stated
 * explicitly (v1 reported the mean of per-fold R² over 5×5 blocks; v2 reports pooled
 * out-of-fold R² over 20 km blocks), so the accuracy gain is not overstated. The v1 → v2 copy is
 * built from exported numbers only (same-metric comparison, pooled-scoring effect, focal-feature
 * ablation): it never attributes the gain to one cause the bundle cannot support.
 * v1 bundles show their own numbers under their own (v1) labels.
 */
import { MicroLabel } from "../../components/ui/MicroLabel.jsx";
import { fmt } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { MODE_STYLE } from "../../viz/chartTheme.js";
import { honestSkill, v1v2Story } from "./labModel.js";

function Score({ label, entry, muted = false, tag }) {
  if (!entry) {
    return (
      <div className="space-y-0.5">
        <MicroLabel>{label}</MicroLabel>
        <p className="text-xs text-ink-faint">Not in this bundle</p>
      </div>
    );
  }
  return (
    <div className={cn("space-y-0.5", muted && "opacity-60")}>
      <MicroLabel>{label}</MicroLabel>
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className={cn("font-display text-2xl font-semibold", muted ? "text-ink-muted" : "text-ink-strong")}>R² {fmt(entry.r2, 2)}</span>
        <span className="tnum font-mono text-sm text-ink-muted">RMSE {fmt(entry.rmse, 2)} °C</span>
      </p>
      <p className="text-[11px] text-ink-faint">
        {entry.pooled ? "pooled out-of-fold" : "mean of per-fold R²"}
        {Number.isFinite(entry.r2FoldSd) && (entry.nFolds ?? 2) > 1 ? ` · fold spread ±${fmt(entry.r2FoldSd, 2)}` : entry.nFolds === 1 ? " · single hold-out fold" : ""}
        {entry.model ? ` · ${entry.model}` : ""}
        {tag ? ` · ${tag}` : ""}
      </p>
    </div>
  );
}

function ModeColumn({ skill, mode }) {
  const style = MODE_STYLE[mode];
  return (
    <section aria-label={`${style.label} skill`} className="min-w-0 space-y-2 rounded-md border border-hairline bg-surface-3/30 p-3">
      <h3 className="font-display text-sm font-semibold" style={{ color: style.accent }}>
        {style.label}
      </h3>
      {skill ? (
        <>
          <Score label={skill.v1 ? "Spatial 5×5 blocks (v1 metric)" : "Spatial-block CV · 20 km · pooled"} entry={skill.spatial} />
          <Score label={skill.v1 ? "Temporal hold-out (v1)" : "Leave-one-epoch-out · recentred"} entry={skill.temporal} tag={skill.v1 ? "last epoch, anomaly pattern" : "timeline headline"} />
          <Score label="Random K-fold" entry={skill.random} muted tag="optimistic upper bound" />
        </>
      ) : (
        <p className="text-xs text-ink-muted">{mode === "night" ? "Night skill is unavailable in a v1 bundle — rerun notebook v2." : "No validation metrics for this mode."}</p>
      )}
    </section>
  );
}

/**
 * @param {{metrics: object|null, schema: string|null, dataMode?: string|null}} props
 */
export function HonestSkill({ metrics, schema, dataMode = null }) {
  const day = honestSkill(metrics, "day");
  const night = honestSkill(metrics, "night");
  const story = v1v2Story(metrics, "day", { dataMode });
  const label = day?.comparison?.label ?? null;
  const v1 = schema === "v1" || day?.v1;
  const headline = day?.spatial ? `Spatial-block CV R² ${fmt(day.spatial.r2, 2)} (${day.spatial.pooled ? "pooled, 20 km blocks" : "mean of folds, 5×5 blocks, v1"}): skill in unseen areas.` : null;
  return (
    <section aria-labelledby="honest-skill-title" className="hud glass-strong rounded-panel p-3.5 text-ink">
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="honest-skill-title" className="micro-label">
          Honest skill · how good is the model where it has not seen the data?
        </h2>
        {headline && <p className="text-xs text-ink">{headline}</p>}
      </header>
      <div className="grid gap-3 md:grid-cols-2">
        <ModeColumn skill={day} mode="day" />
        <ModeColumn skill={night} mode="night" />
      </div>
      <div className="mt-3 rounded-md border border-dashed border-hairline-strong p-2.5 text-xs leading-relaxed text-ink-muted">
        <p className="font-medium text-ink">v1 → v2: the metric changed, not only the model.</p>
        {v1 ? (
          <p>
            This is a v1 bundle: its spatial score is the mean of per-fold R² over 5×5 blocks, which one poorly predicted fold (the cool north-east: Karnal, Shamli, Muzaffarnagar) drags down. v2 reports pooled out-of-fold R² over 20 km blocks plus leave-one-epoch-out; rerun notebook v2 to see them. The two metrics are not directly comparable.
          </p>
        ) : story ? (
          <p data-testid="v1v2-story">
            {story.join(" ")}
            {label ? ` (v1: ${label}.)` : ""}
          </p>
        ) : (
          <p>No v1 comparison block in this bundle.</p>
        )}
      </div>
    </section>
  );
}

export default HonestSkill;
