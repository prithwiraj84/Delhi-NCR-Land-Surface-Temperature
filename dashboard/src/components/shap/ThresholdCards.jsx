/**
 * Threshold cards for the selected feature: zero crossing, breakpoint (with slopes before /
 * after), saturation, effect range and direction — each with its uncertainty and a
 * plain-language reading. All card content comes from buildThresholdCards() (pure, null-safe);
 * this component only lays it out and staggers the cards in when the feature changes.
 */
import { memo, useMemo } from "react";
import { motion } from "framer-motion";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { buildThresholdCards } from "./shapMath.js";

const TONE_ICON = { cooling: ArrowDownRight, warming: ArrowUpRight, neutral: Minus };

function ThresholdCard({ card, index }) {
  const Icon = card.key === "direction" ? TONE_ICON[card.tone] : null;
  const missing = card.value === null || card.value === undefined;
  return (
    <motion.article
      role="listitem"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: index * 0.04 }}
      className={cn(
        "group relative flex min-w-0 flex-col gap-1.5 overflow-hidden rounded-xl border border-panel-border",
        "bg-slate-900/40 p-3 transition-colors hover:border-slate-500/40 hover:bg-slate-900/60",
      )}
    >
      {/* thin accent rule keyed to the matching reference line in the plot */}
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px opacity-70"
        style={{ backgroundColor: card.accent }}
      />
      <header className="flex items-center gap-2">
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: card.accent }} />
        <h4 className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">{card.title}</h4>
      </header>
      <div className="flex items-baseline gap-1.5">
        {Icon ? <Icon aria-hidden="true" className="h-4 w-4 shrink-0 self-center text-ink-muted" /> : null}
        <span
          className={cn(
            "font-display text-xl font-semibold capitalize leading-tight",
            missing ? "text-ink-faint" : "text-ink-strong",
          )}
        >
          {missing ? card.missingText : card.value}
        </span>
      </div>
      {card.ci ? <p className="font-mono text-[11px] text-ink-muted">{card.ci}</p> : null}
      {card.support ? (
        <p className={cn("font-mono text-[11px]", card.lowSupport ? "text-amber-soft" : "text-ink-faint")}>
          {card.lowSupport ? "low support · " : ""}
          {card.support}
        </p>
      ) : null}
      {card.detail ? <p className="font-mono text-[11px] text-ink-faint">{card.detail}</p> : null}
      <p className="mt-auto pt-1 text-xs leading-snug text-ink">{card.interpretation}</p>
    </motion.article>
  );
}

/**
 * @param {object} props
 * @param {object} props.meta       manifest metadata of the selected feature
 * @param {object|null} props.threshold  dependence threshold object (may be null)
 * @param {Array} props.curve       rows from buildCurve()
 * @param {string} [props.ciLabel]  "95% CI" or "replicate range" (lib/uncertainty.js)
 */
function ThresholdCards({ meta, threshold, curve, ciLabel = "95% CI" }) {
  const cards = useMemo(
    () => buildThresholdCards({ meta, threshold, curve, ciLabel }),
    [meta, threshold, curve, ciLabel],
  );
  return (
    // Keyed by feature: switching features remounts the grid so the cards stagger in afresh.
    <div
      key={meta?.name ?? "none"}
      className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5"
      role="list"
      aria-label={`Thresholds for ${meta?.label ?? "the selected feature"}`}
    >
      {cards.map((card, i) => (
        <ThresholdCard key={card.key} card={card} index={i} />
      ))}
    </div>
  );
}

export default memo(ThresholdCards);
