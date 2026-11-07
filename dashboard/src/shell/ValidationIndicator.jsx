/**
 * Bundle-contract validation status (command bar ✓). The data layer validates the bundle in
 * the browser (lib/validate.js, data/validateV2.js) and exposes `validation`
 * ({errors[], warnings[], epochsChecked?[], framesChecked?[]}) through useData(). The popover
 * lists every message; the status is icon + text, never colour alone.
 */
import { useEffect, useRef, useState } from "react";
import { LoaderCircle, ShieldAlert, ShieldCheck, ShieldX, X } from "lucide-react";
import { useData } from "../state/DataContext.jsx";
import { cn } from "../lib/cn.js";

function coverageText(validation) {
  const checked = validation?.framesChecked ?? validation?.epochsChecked ?? [];
  const frames = checked.length ? `frames ${checked.join(", ")}` : "the manifest and small assets";
  const sample = validation?.waterfallSample ? ` SHAP additivity sampled on ${validation.waterfallSample} cells per frame.` : "";
  return `All contract checks passed for ${frames}.${sample} Frames loaded later are checked when they arrive.`;
}

function MessageList({ title, items, tone }) {
  if (!items.length) return null;
  return (
    <div className="mt-2">
      <p className={cn("micro-label mb-1", tone)}>
        {title} ({items.length})
      </p>
      <ul className="scrollbar-thin max-h-48 space-y-1 overflow-y-auto pr-1 text-xs leading-snug text-ink">
        {items.map((msg, i) => (
          <li key={i} className="rounded-md bg-void/60 px-2 py-1">
            {String(msg)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ValidationIndicator() {
  const { validation } = useData() ?? {};
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e) => rootRef.current && !rootRef.current.contains(e.target) && setOpen(false);
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const errors = validation?.errors ?? [];
  const warnings = validation?.warnings ?? [];
  const state = !validation ? "pending" : errors.length ? "error" : warnings.length ? "warning" : "ok";
  const config = {
    pending: { icon: LoaderCircle, text: "Validating", tone: "text-ink-muted", spin: true },
    ok: { icon: ShieldCheck, text: "Contract OK", tone: "text-ok" },
    warning: { icon: ShieldAlert, text: `${warnings.length} warning${warnings.length === 1 ? "" : "s"}`, tone: "text-warn" },
    error: { icon: ShieldX, text: `${errors.length} error${errors.length === 1 ? "" : "s"}`, tone: "text-crit" },
  }[state];
  const Icon = config.icon;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => validation && setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-disabled={!validation || undefined}
        aria-label={`Bundle validation: ${config.text}`}
        className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md px-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted hover:text-ink"
      >
        <Icon aria-hidden="true" className={cn("size-4", config.tone, config.spin && "animate-spin")} strokeWidth={1.5} />
        <span aria-hidden="true" className="hidden xl:inline">
          {config.text}
        </span>
      </button>
      {open && (
        <div role="dialog" aria-label="Bundle validation report" className="glass-strong hud absolute right-0 top-10 z-overlay w-[min(26rem,calc(100vw-1.5rem))] rounded-panel p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="font-display text-sm font-semibold text-ink-strong">Web-bundle contract (SPEC §5)</p>
            <button type="button" aria-label="Close validation report" onClick={() => setOpen(false)} className="focus-ring grid size-6 place-items-center rounded text-ink-muted hover:text-ink">
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
          {state === "ok" && <p className="text-xs text-ink-muted">{coverageText(validation)}</p>}
          <MessageList title="Errors" items={errors} tone="text-crit" />
          <MessageList title="Warnings" items={warnings} tone="text-warn" />
        </div>
      )}
    </div>
  );
}

export default ValidationIndicator;
