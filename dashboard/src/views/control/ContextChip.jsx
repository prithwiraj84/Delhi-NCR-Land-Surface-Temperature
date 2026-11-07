/**
 * Weather-context chip (UI_SPEC_v2 §3.2 CONTEXT): "ERA5-Land skin T anomaly +0.8 °C (weather
 * context)" for the current frame window — Concept C's weather caveat in compact form: a warm
 * spring makes a frame warmer without any land change. Rendered only when the bundle exports
 * the ERA5-Land annual anomaly (timeline_series `annual.era5_skin[].anomaly`) for the window,
 * on exact observed frames; otherwise nothing is shown (no invented context).
 */
import { CloudSun } from "lucide-react";
import { fmtSigned } from "../../lib/format.js";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { contextAnomaly } from "./controlModel.js";
import { useLiveFrame } from "./useControlData.js";

export function ContextChip({ className }) {
  const { info, ncr, exact } = useLiveFrame({ withStats: false });
  const frame = info?.frame;
  if (!exact || !frame || frame.kind !== "observed") return null;
  const ctx = contextAnomaly(ncr, frame);
  if (!ctx) return null;
  const sign = ctx.anomaly > 0 ? "warmer" : ctx.anomaly < 0 ? "cooler" : "average";
  return (
    <HudFrame as="aside" aria-label="Weather context" padding="sm" className={className} data-testid="context-chip">
      <p className="micro-label flex items-center gap-1.5">
        <CloudSun aria-hidden="true" className="size-3.5" strokeWidth={1.5} /> Context
      </p>
      <p className="mt-1 text-[12px] leading-snug text-ink">
        ERA5-Land skin T anomaly <span className="tnum font-mono font-semibold text-ink-strong">{fmtSigned(ctx.anomaly, 1)}<span className="unit">°C</span></span>
      </p>
      <p className="text-[11px] leading-snug text-ink-muted">
        {ctx.window[0]}–{ctx.window[1]} Apr–Jun was {sign} than usual (weather context, not land change)
      </p>
    </HudFrame>
  );
}

export default ContextChip;
