/**
 * "Data caveats" header popover (both data modes): every caveat the notebook wrote into
 * `manifest.notes` (land-cover product changes between epochs, the DMSP -> VIIRS mapping,
 * Terra orbit drift, projected population, SHAP is not causal, scenarios use a surrogate…),
 * the bundle's `generated_at` timestamp and the per-variable `data_sources`.
 * Also exports `CrossEpochCaveat`, a one-line inline reminder for views that compare epochs.
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Info, TriangleAlert, X } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { crossEpochCaveats, dataSourceRows, formatGeneratedDate, manifestNotes } from "./dataNotes.js";

export function DataCaveatsButton({ manifest }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e) => rootRef.current && !rootRef.current.contains(e.target) && setOpen(false);
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!manifest) return null;
  const notes = manifestNotes(manifest);
  const sources = dataSourceRows(manifest);
  const generated = formatGeneratedDate(manifest.generated_at);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="focus-ring inline-flex h-7 items-center gap-1.5 rounded-lg border border-panel-border bg-bg-raised/70 px-2.5 font-mono text-[11px] uppercase tracking-wider text-ink-muted hover:text-ink"
      >
        <Info aria-hidden="true" className="size-3.5" />
        <span className="hidden sm:inline">Caveats{notes.length ? ` (${notes.length})` : ""}</span>
        <span className="sr-only sm:hidden">Data caveats</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Data caveats and sources"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="glass-strong absolute right-0 top-9 z-50 w-[min(30rem,calc(100vw-1.5rem))] rounded-xl border p-3 shadow-glass"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="font-display text-sm font-semibold text-ink-strong">Data caveats</p>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="focus-ring rounded p-0.5 text-ink-muted hover:text-ink"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </div>
            <p className="text-[11px] text-ink-muted">
              {manifest.data_mode === "synthetic" ? "SYNTHETIC bundle" : "Google Earth Engine snapshot"}
              {generated ? ` · generated ${generated} (UTC)` : ""}. A static export: it does not update live.
            </p>
            <div className="scrollbar-thin mt-2 max-h-[60vh] space-y-3 overflow-y-auto pr-1">
              {notes.length ? (
                <ul className="space-y-1.5 text-xs leading-snug text-ink">
                  {notes.map((note, i) => (
                    <li key={i} className="flex gap-2 rounded-md bg-bg-deep/60 px-2 py-1.5">
                      <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-amber" />
                      <span>{note}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-ink-muted">This bundle carries no caveat notes.</p>
              )}
              {sources.length ? (
                <details className="rounded-md border border-panel-border text-xs">
                  <summary className="focus-ring cursor-pointer select-none rounded-md px-2 py-1.5 text-ink-muted hover:text-ink">
                    Data sources ({sources.length} variables)
                  </summary>
                  <dl className="space-y-2 px-2 pb-2">
                    {sources.map((row) => (
                      <div key={row.variable}>
                        <dt className="font-mono text-[11px] text-cyan-soft">{row.variable}</dt>
                        {row.entries.map((e) => (
                          <dd key={e.key} className="break-words pl-2 text-[11px] leading-snug text-ink-muted">
                            <span className="font-mono text-ink">{e.key}</span>: {e.value}
                          </dd>
                        ))}
                      </div>
                    ))}
                  </dl>
                </details>
              ) : null}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Inline reminder for cross-epoch comparisons; renders nothing when the bundle has no such note. */
export function CrossEpochCaveat({ manifest, className }) {
  const caveats = crossEpochCaveats(manifest);
  if (!caveats.length) return null;
  return (
    <div
      role="note"
      className={cn("flex gap-2 rounded-lg border border-amber/25 bg-amber/5 px-2.5 py-2 text-[11px] leading-snug", className)}
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-amber" />
      <div className="min-w-0 space-y-1 text-ink-muted">
        <p className="text-ink">
          Part of any change between epochs can come from the data sources themselves, not from the ground:
        </p>
        <ul className="list-disc space-y-0.5 pl-4">
          {caveats.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
