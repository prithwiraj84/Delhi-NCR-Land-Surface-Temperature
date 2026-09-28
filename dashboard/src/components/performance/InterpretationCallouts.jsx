/**
 * Plain-language reading of the validation results (built by `buildInterpretations`).
 * Tone is carried by an icon + the title text, with the status hue only on the icon and a
 * hairline accent, so the message never depends on colour alone.
 */
import { motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { cn } from "../../lib/cn.js";

const TONES = {
  warning: { icon: AlertTriangle, iconClass: "text-amber", edge: "before:bg-amber/70", srLabel: "Caution" },
  good: { icon: CheckCircle2, iconClass: "text-emerald", edge: "before:bg-emerald/70", srLabel: "Good" },
  info: { icon: Info, iconClass: "text-cyan", edge: "before:bg-cyan/70", srLabel: "Note" },
};

/** @param {{items: {id: string, tone: string, title: string, body: string}[]}} props */
export function InterpretationCallouts({ items }) {
  const reduceMotion = useReducedMotion();
  if (!items.length) return null;
  return (
    <ul className="grid gap-3 md:grid-cols-2" aria-label="Interpretation of the validation results">
      {items.map((item, i) => {
        const tone = TONES[item.tone] ?? TONES.info;
        const Icon = tone.icon;
        return (
          <motion.li
            key={item.id}
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: reduceMotion ? 0 : 0.05 * i }}
            className={cn(
              "glass relative overflow-hidden rounded-xl border p-3.5 pl-4",
              "before:absolute before:inset-y-3 before:left-0 before:w-0.5 before:rounded-full",
              tone.edge,
            )}
          >
            <p className="flex items-center gap-2 font-display text-sm font-semibold text-ink-strong">
              <Icon aria-hidden="true" className={cn("size-4 shrink-0", tone.iconClass)} />
              <span className="sr-only">{tone.srLabel}: </span>
              {item.title}
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{item.body}</p>
          </motion.li>
        );
      })}
    </ul>
  );
}
