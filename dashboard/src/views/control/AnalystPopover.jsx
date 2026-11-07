/**
 * Analyst popover (UI_SPEC_v2 §3.2 "⋯ Analyst (opacity, H3, labels)", D16): the expert
 * options that do not belong in the main chrome —
 *   layer opacity · H3 hex aggregation (h3-js loaded on demand by the engine) · labels ·
 *   district boundaries · hillshade · colour scale (fixed / shared day+night / contrast-
 *   stretched per frame, which shows a warning) · projection quantile (p05 / p50 / p95 /
 *   spread) for projected frames.
 * A dialog that traps focus while open; Esc or the close button returns focus to the trigger.
 */
import { useEffect, useId, useRef, useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { Segmented } from "../../components/ui/Segmented.jsx";
import { Slider } from "../../components/ui/Slider.jsx";
import { Switch } from "../../components/ui/Switch.jsx";
import { IconTip } from "../../components/ui/InfoTip.jsx";
import { cn } from "../../lib/cn.js";
import { useFocusTrap } from "../../shell/useFocusTrap.js";
import { useViewStore } from "../../state/stores/viewStore.js";
import { useLiveFrame } from "./useControlData.js";

const SWITCHES = [
  { key: "h3", label: "H3 hexagons", description: "Aggregate cells into H3 hexagons, same colour scale (loads h3-js)" },
  { key: "labels", label: "District labels" },
  { key: "boundaries", label: "District boundaries" },
  // The optional SRTM hillshade (UI_SPEC §4.5) is not part of the v2 bundle contract (SPEC §5), so the
  // switch stays visible but disabled with its reason instead of silently doing nothing.
  { key: "hillshade", label: "Hillshade", description: "Static SRTM relief for Aravalli context", unavailable: "Unavailable: the bundle exports no hillshade relief" },
];

/** @param {{className?: string, align?: "left"|"right"}} props */
export function AnalystPopover({ className, align = "right" }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);
  const triggerRef = useRef(null);
  const titleId = useId().replace(/:/g, "");
  const analyst = useViewStore((s) => s.analyst);
  const domainMode = useViewStore((s) => s.domainMode);
  const quantile = useViewStore((s) => s.quantile);
  const { info } = useLiveFrame({ withStats: false });
  const projected = info?.kind === "projected" && info?.exact;
  useFocusTrap(panelRef, open);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onDown = (e) => {
      if (!panelRef.current?.contains(e.target) && !triggerRef.current?.contains(e.target)) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  return (
    <div className={cn("relative", className)}>
      <IconTip label="Analyst options">
        <button
          ref={triggerRef}
          type="button"
          aria-label="Analyst options"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn("focus-ring grid size-8 place-items-center rounded-md text-ink-muted hover:bg-surface-3 hover:text-ink", open && "bg-surface-3 text-ink")}
        >
          <SlidersHorizontal aria-hidden="true" className="size-4" strokeWidth={1.5} />
        </button>
      </IconTip>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          className={cn("glass-strong hud absolute bottom-full z-overlay mb-2 w-72 rounded-panel p-3", align === "right" ? "right-0" : "left-0")}
        >
          <header className="mb-2 flex items-center justify-between">
            <h2 id={titleId} className="micro-label">
              Analyst
            </h2>
            <button type="button" aria-label="Close analyst options" onClick={() => setOpen(false)} className="focus-ring grid size-6 place-items-center rounded text-ink-muted hover:text-ink">
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </header>
          <div className="space-y-3">
            <div>
              <p className="mb-1 flex justify-between text-[12px] text-ink">
                <span>Layer opacity</span>
                <span className="tnum font-mono text-ink-muted">{Math.round(analyst.opacity * 100)} %</span>
              </p>
              <Slider value={analyst.opacity} min={0.1} max={1} step={0.05} aria-label="Layer opacity" onValueChange={(v) => useViewStore.getState().setAnalyst({ opacity: v })} />
            </div>
            {SWITCHES.map((s) => (
              <Switch
                key={s.key}
                label={s.label}
                description={s.unavailable ? `${s.description}. ${s.unavailable}` : s.description}
                disabled={Boolean(s.unavailable)}
                checked={!s.unavailable && Boolean(analyst[s.key])}
                onCheckedChange={(v) => useViewStore.getState().setAnalyst({ [s.key]: v })}
              />
            ))}
            <div>
              <p className="mb-1 text-[12px] text-ink">Colour scale</p>
              <Segmented
                ariaLabel="Colour scale"
                layoutId="analyst-domain"
                size="sm"
                value={domainMode}
                onChange={(v) => useViewStore.getState().setDomainMode(v)}
                options={[
                  { value: "fixed", label: "Fixed", title: "One scale per mode for every frame (default)" },
                  { value: "shared", label: "Day+Night", title: "One scale over the day and night domains: honest day-vs-night magnitude" },
                  { value: "frame", label: "Stretch", title: "Contrast-stretched to this frame only (colours not comparable across years)" },
                ]}
              />
              {domainMode === "frame" && <p className="mt-1 text-[11px] text-warn">Contrast-stretched: colours are not comparable across frames.</p>}
            </div>
            <div className={cn(!projected && "opacity-50")}>
              <p className="mb-1 text-[12px] text-ink">Projection quantile</p>
              <Segmented
                ariaLabel="Projection quantile"
                layoutId="analyst-quantile"
                size="sm"
                value={quantile}
                onChange={(v) => useViewStore.getState().setQuantile(v)}
                options={["p05", "p50", "p95", "spread"].map((q) => ({ value: q, label: q === "spread" ? "Spread" : q.toUpperCase(), disabled: !projected, reason: "Quantiles apply to projected frames" }))}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AnalystPopover;
