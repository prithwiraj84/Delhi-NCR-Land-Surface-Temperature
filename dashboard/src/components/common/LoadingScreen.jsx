import { motion, useReducedMotion } from "framer-motion";
import { cn } from "../../lib/cn.js";

/**
 * Boot screen: a thermal "scan" of a small cell grid while the bundle streams in.
 * @param {{message?: string, detail?: string, className?: string}} props
 */
export function LoadingScreen({ message = "Booting the thermal digital twin", detail, className }) {
  const reduceMotion = useReducedMotion();
  const cells = Array.from({ length: 36 }, (_, i) => i);
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex min-h-[60vh] w-full flex-col items-center justify-center gap-6 px-6", className)}
    >
      <div className="relative grid grid-cols-6 gap-1 rounded-xl border border-panel-border bg-bg-raised/60 p-2 shadow-glow-cyan">
        {cells.map((i) => (
          <motion.span
            key={i}
            className="size-3.5 rounded-[3px] sm:size-4"
            style={{ backgroundColor: "#22d3ee" }}
            initial={{ opacity: 0.12 }}
            animate={reduceMotion ? { opacity: 0.35 } : { opacity: [0.12, 0.9, 0.12], backgroundColor: ["#2b2a7c", "#df2f7d", "#fbb13c", "#2b2a7c"] }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : { duration: 2.4, repeat: Infinity, delay: ((i % 6) + Math.floor(i / 6)) * 0.08, ease: "easeInOut" }
            }
          />
        ))}
      </div>
      <div className="text-center">
        <p className="font-display text-base font-semibold text-ink-strong">{message}</p>
        <p className="mt-1 font-mono text-xs text-ink-muted">
          {detail ?? "Streaming LST grids, TreeSHAP attributions and the surrogate model…"}
        </p>
      </div>
    </div>
  );
}
