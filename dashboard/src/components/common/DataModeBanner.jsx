import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, FlaskConical } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { syntheticReasonText } from "./dataNotes.js";

/**
 * Explains that the bundle comes from the synthetic generator (SPEC §5): the numbers are a
 * planted response used to exercise the pipeline, NOT observations of Delhi NCR.
 * The reason comes from `manifest.data_mode_reason` (e.g. "LST_RUN_MODE=synthetic" for an
 * explicit synthetic run, or the Earth Engine error of an automatic fallback); without it the
 * wording stays neutral. Renders nothing for GEE bundles (their caveats live in the header's
 * "Data caveats" popover). It can be collapsed to a one-line strip but never fully hidden.
 * @param {{manifest: object|null, className?: string}} props
 */
export function DataModeBanner({ manifest, className }) {
  const [expanded, setExpanded] = useState(false);
  if (!manifest || manifest.data_mode !== "synthetic") return null;
  const truth = manifest.synthetic_truth;
  const truthEntries = truth && typeof truth === "object" ? Object.entries(truth).slice(0, 6) : [];
  const reason = syntheticReasonText(manifest.data_mode_reason);

  return (
    <div
      role="note"
      aria-label="Synthetic demo data notice"
      className={cn("border-b border-amber/30 bg-amber/10 text-amber-soft backdrop-blur-md", className)}
    >
      <div className="mx-auto flex max-w-[1800px] items-start gap-3 px-3 py-2 sm:px-5">
        <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber" />
        <div className="min-w-0 flex-1 text-xs leading-relaxed sm:text-[13px]">
          <p>
            <strong className="font-semibold text-amber">SYNTHETIC demo data.</strong>{" "}
            <span className="text-ink sm:hidden">Simulated values, not satellite observations.</span>
            <span className="hidden text-ink sm:inline">
              {reason} Every value here comes from a simulated Delhi NCR with a planted temperature response. Use it to
              explore the platform, not to draw conclusions about the region.
            </span>
          </p>
          <AnimatePresence initial={false}>
            {expanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <p className="mt-1.5 text-ink sm:hidden">
                  {reason} Every value comes from a simulated Delhi NCR with a planted temperature response.
                </p>
                <p className="mt-1.5 text-ink-muted">
                  To produce a real bundle, re-run the notebook with <code>LST_RUN_MODE=gee</code> and Earth Engine
                  credentials. On Kaggle add both secrets: <code>GEE_SERVICE_ACCOUNT_KEY</code> (the service-account JSON
                  key) and <code>GEE_PROJECT</code> (the Cloud project id). Locally set <code>LST_GEE_PROJECT</code> plus
                  either <code>LST_GEE_SERVICE_ACCOUNT_KEY</code> / <code>GOOGLE_APPLICATION_CREDENTIALS</code> or an
                  interactive <code>earthengine authenticate</code>.
                  {truthEntries.length > 0 && " The planted ground truth lets you check whether the SHAP analysis recovers it:"}
                </p>
                {truthEntries.length > 0 && (
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {truthEntries.map(([key, value]) => (
                      <li key={key} className="rounded-md border border-amber/30 bg-bg/40 px-2 py-0.5 font-mono text-[11px] text-ink">
                        {key} = {typeof value === "object" ? JSON.stringify(value) : String(value)}
                      </li>
                    ))}
                  </ul>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="focus-ring inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs text-amber hover:bg-amber/10"
        >
          {expanded ? "Less" : "Details"}
          <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
        </button>
      </div>
    </div>
  );
}
