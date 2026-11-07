/**
 * Small multiples of map frames (UI_SPEC §3.5 ATLAS: "13 × Day row, 13 × Night row; fixed
 * scale; current ringed; click = set year"). Each thumbnail is a button (keyboard + screen
 * reader reachable) drawing a worker-rasterised ImageBitmap with nearest-neighbour scaling.
 * Colours use the FIXED cross-time domain, so thumbnails of different years compare honestly.
 * Projected thumbnails carry a dashed frame and the ○ tier glyph; unavailable frames render
 * an empty, labelled slot (never an interpolated picture).
 *
 * @param {{items: Array<{key: string, year: number, label?: string, tier?: string|null,
 *            values?: Float32Array|null, ramp: string, domain: [number, number], current?: boolean,
 *            projected?: boolean, reason?: string|null, mask?: Uint8Array|null}>,
 *          grid: {width: number, height: number, pixel: Int32Array}|null, gridKey: string,
 *          onSelect?: (item) => void, thumbWidth?: number, ariaLabel: string, mode?: string}} props
 */
import { memo, useEffect, useRef, useState } from "react";
import { TierShape } from "../design/glyphs.jsx";
import { LUTS } from "../design/ramps.js";
import { cn } from "../lib/cn.js";
import { sharedThumbRenderer } from "./thumbClient.js";

function Thumb({ item, grid, gridKey, width, onSelect }) {
  const canvasRef = useRef(null);
  const [state, setState] = useState(item.values ? "loading" : "empty");
  const height = grid ? Math.round((width * grid.height) / grid.width) : width;

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas || !grid || !item.values) {
      setState("empty");
      return undefined;
    }
    setState("loading");
    const lut = LUTS[item.ramp] ?? LUTS.solar;
    const key = `${gridKey}|${item.key}|${item.ramp}|${item.domain[0]}|${item.domain[1]}|${item.mask ? "m" : ""}`;
    sharedThumbRenderer()
      .render(key, { gridKey, grid, values: item.values, lut, lo: item.domain[0], hi: item.domain[1], mask: item.mask ?? null })
      .then((bitmap) => {
        if (cancelled || !bitmap) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        setState("ready");
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("[atlas] thumbnail failed", error);
          setState("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [item.key, item.values, item.ramp, item.domain, item.mask, grid, gridKey]);

  const label = `${item.label ?? item.year}${item.tier ? `, ${item.tier}` : ""}${item.reason ? `, ${item.reason}` : ""}${item.current ? ", shown on the map" : ""}`;
  return (
    <li className="shrink-0">
      <button
        type="button"
        onClick={() => onSelect?.(item)}
        disabled={!onSelect}
        aria-label={`${label}. Show this frame`}
        aria-current={item.current ? "true" : undefined}
        title={item.reason ?? label}
        className={cn(
          "focus-ring group relative block rounded-md border bg-void p-0.5 transition-colors",
          item.current ? "border-signal" : "border-hairline hover:border-hairline-strong",
          item.projected && !item.current && "border-dashed",
        )}
      >
        <canvas ref={canvasRef} width={width * 2} height={height * 2} style={{ width, height }} className={cn("block rounded-[4px]", state !== "ready" && "opacity-0")} aria-hidden="true" />
        {state !== "ready" && (
          <span className="absolute inset-0.5 grid place-items-center rounded-[4px] bg-surface-3/40 px-1 text-center text-[10px] text-ink-faint">
            {state === "loading" ? "…" : state === "error" ? "failed" : item.reason ? "n/a" : "—"}
          </span>
        )}
        <span className="mt-0.5 flex items-center justify-center gap-1 font-mono text-[10.5px] text-ink-muted">
          {item.tier && <TierShape tier={item.tier} size={9} />}
          {item.year}
        </span>
      </button>
    </li>
  );
}

const MemoThumb = memo(Thumb);

export function SmallMultiples({ items = [], grid, gridKey = "grid", onSelect, thumbWidth = 72, ariaLabel, className }) {
  return (
    <ul aria-label={ariaLabel} className={cn("scrollbar-thin flex gap-1.5 overflow-x-auto pb-1", className)}>
      {items.map((item) => (
        <MemoThumb key={item.key} item={item} grid={grid} gridKey={gridKey} width={thumbWidth} onSelect={onSelect} />
      ))}
    </ul>
  );
}

export default SmallMultiples;
