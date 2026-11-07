/**
 * Performance chip (UI_SPEC §6.6). When the perf tier rises above 0 (the engine's governor
 * stepped quality down, or the user chose a tier), a small chip in the command bar says so
 * and offers Undo (back to the previous tier). Undo dispatches `ncr:perf-undo`: the governor (E3)
 * steps back and holds off re-escalating for 30 s, without changing the user's floor.
 *
 * `?perf=1` adds a dev HUD (bottom-left): fps and frame ms measured by a rAF probe, the tier,
 * and which shell stores are fallbacks. The engine may render its own richer HUD (GPU memory).
 */
import { useEffect, useState } from "react";
import { Gauge, Undo2 } from "lucide-react";
import { setStoreField, storeFallbacks, useViewStore } from "./deps.js";

export const PERF_UNDO_EVENT = "ncr:perf-undo";

const TIER_TEXT = {
  1: "Solid panels",
  2: "Flat lighting · no lens",
  3: "2-D · CPU path",
};

function usePerfQuery() {
  const [on] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get("perf") === "1";
    } catch {
      return false;
    }
  });
  return on;
}

function DevHud({ tier }) {
  const [stats, setStats] = useState({ fps: 0, ms: 0 });
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let acc = 0;
    let windowStart = last;
    const loop = (now) => {
      const dt = now - last;
      last = now;
      frames += 1;
      acc += dt;
      if (now - windowStart >= 500) {
        setStats({ fps: Math.round((frames * 1000) / (now - windowStart)), ms: acc / frames });
        frames = 0;
        acc = 0;
        windowStart = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const fallbacks = Object.entries(storeFallbacks)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return (
    <div aria-hidden="true" className="glass-strong pointer-events-none fixed bottom-20 left-20 z-toast rounded-md px-2.5 py-1.5 font-mono text-[11px] leading-5 text-ink">
      <div>
        {stats.fps} fps · {stats.ms.toFixed(1)} ms
      </div>
      <div>tier T{tier}</div>
      {fallbacks.length > 0 && <div className="text-warn">fallback stores: {fallbacks.join(", ")}</div>}
    </div>
  );
}

export function PerfChip() {
  const tier = useViewStore((s) => (Number.isInteger(s.perfTier) ? s.perfTier : 0));
  const [prevTier, setPrevTier] = useState(0);
  const dev = usePerfQuery();

  useEffect(
    () =>
      useViewStore.subscribe((s, prev) => {
        if (prev && s.perfTier !== prev.perfTier) {
          setPrevTier(Number.isInteger(prev.perfTier) ? prev.perfTier : 0);
        }
      }),
    [],
  );

  // Undo only starts the governor's 30 s hold and steps back; it never sets the user's floor
  // (only an explicit Settings choice does). The map engine handles the event and updates the
  // store itself; without a mounted engine the chip writes the tier directly.
  const undo = () => {
    const target = prevTier < tier ? prevTier : Math.max(0, tier - 1);
    const detail = { from: tier, to: target, handled: false };
    window.dispatchEvent(new CustomEvent(PERF_UNDO_EVENT, { detail }));
    if (!detail.handled) setStoreField(useViewStore, "perfTier", target);
  };

  return (
    <>
      {tier > 0 && (
        <div title={`Performance tier ${tier}: ${TIER_TEXT[tier]}`} className="hidden items-center gap-1 rounded-md border border-warn/40 bg-warn/10 py-0.5 pl-2 pr-0.5 md:inline-flex">
          <Gauge aria-hidden="true" className="size-3.5 text-warn" strokeWidth={1.5} />
          <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink">
            Perf T{tier}
            <span className="sr-only"> — reduced quality: </span>
            <span className="sr-only text-ink-muted 2xl:not-sr-only 2xl:inline"> · {TIER_TEXT[tier]}</span>
          </span>
          <button
            type="button"
            onClick={undo}
            aria-label={`Undo performance step (back to ${prevTier < tier ? `tier ${prevTier}` : `tier ${Math.max(0, tier - 1)}`})`}
            className="focus-ring grid size-6 place-items-center rounded text-ink-muted hover:text-ink"
          >
            <Undo2 aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      )}
      {dev && <DevHud tier={tier} />}
    </>
  );
}

export default PerfChip;
