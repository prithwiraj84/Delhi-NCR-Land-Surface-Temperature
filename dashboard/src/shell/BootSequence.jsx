/**
 * Acquisition sequence (UI_SPEC §3.1, §5.2 K): the boot overlay.
 *
 * Cinematic (Full motion, first load per session): graticule draws, a Landsat-like swath
 * band sweeps NE -> SW and the thermal grid "develops" behind it, while the log shows REAL
 * loader events (file, status, bytes, ms) from the data layer's progress. It finishes at
 * BOOT_MIN_MS..BOOT_MAX_MS once data is ready, loops while data is still loading, and any
 * key or click skips it.
 * Static (Reduced/Off motion, or a repeat visit): a still checklist shown only while loading.
 *
 * States: sweeping | waiting | done | skipped. The card is a labelled dialog with a
 * progressbar; the overlay never traps focus permanently (skip with any key).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { BrandGlyph } from "../design/glyphs.jsx";
import { ramps } from "../design/tokens.js";
import { useMotionLevel } from "../design/useMotionLevel.js";
import { LUTS } from "../design/ramps.js";
import { cn } from "../lib/cn.js";
import {
  BOOT_MAX_MS,
  BOOT_MIN_MS,
  bootFooter,
  fallbackLines,
  lineStatusText,
  normalizeProgress,
  overallFraction,
  rememberCinematic,
  shouldPlayCinematic,
} from "./bootModel.js";

// Study-area frame of the schematic (lon 75.4-78.6 E, lat 26.6-30.1 N) in a 400 x 260 viewBox.
const VB_W = 400;
const VB_H = 260;
const LON0 = 75.4;
const LON1 = 78.6;
const LAT0 = 26.6;
const LAT1 = 30.1;
const px = (lon) => ((lon - LON0) / (LON1 - LON0)) * VB_W;
const py = (lat) => VB_H - ((lat - LAT0) / (LAT1 - LAT0)) * VB_H;

/** Deterministic schematic heat field (hot semi-arid south-west, cooler north-east). */
function schematicCells() {
  const cols = 28;
  const rows = 18;
  const lut = LUTS.solar;
  const cells = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const u = c / (cols - 1);
      const v = r / (rows - 1);
      const t = 0.55 * (1 - u) + 0.35 * v + 0.12 * Math.sin(u * 9.1 + v * 5.3) + 0.06 * Math.cos(u * 23 - v * 17);
      const i = Math.round(Math.max(0, Math.min(1, t)) * 255) * 3;
      cells.push({ x: (c / cols) * VB_W, y: (r / rows) * VB_H, w: VB_W / cols - 1.2, h: VB_H / rows - 1.2, fill: `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})` });
    }
  }
  return cells;
}

function AcquisitionView({ looping }) {
  const cells = useMemo(schematicCells, []);
  const diag = Math.hypot(VB_W, VB_H);
  // Band position in the rotated frame: from beyond the NE edge to beyond the SW edge.
  const from = VB_H / 2 - 0.6 * diag;
  const to = VB_H / 2 + 0.6 * diag;
  const sweep = { duration: BOOT_MIN_MS / 1000, ease: "linear", repeat: looping ? Infinity : 0, repeatDelay: 0.2 };
  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="h-auto w-full" aria-hidden="true" focusable="false">
      <defs>
        <mask id="boot-develop">
          <g transform={`rotate(35 ${VB_W / 2} ${VB_H / 2})`}>
            <motion.g initial={{ y: from }} animate={{ y: [from, to] }} transition={sweep}>
              <rect x={VB_W / 2 - diag} y={-3 * diag} width={diag * 2} height={3 * diag} fill="#fff" />
            </motion.g>
          </g>
        </mask>
      </defs>
      <rect width={VB_W} height={VB_H} fill={ramps.solar[0]} opacity="0.08" />
      <g mask="url(#boot-develop)">
        {cells.map((c, i) => (
          <rect key={i} x={c.x} y={c.y} width={c.w} height={c.h} fill={c.fill} opacity="0.85" />
        ))}
      </g>
      {/* graticule draws once (stroke-dashoffset 600 ms) */}
      <g stroke="var(--hairline-strong)" strokeWidth="1" fill="none">
        {[76, 77, 78].map((lon) => (
          <line key={lon} x1={px(lon)} x2={px(lon)} y1="0" y2={VB_H} pathLength="1" strokeDasharray="1" style={{ animation: "graticule-draw 600ms linear both" }} />
        ))}
        {[27, 28, 29, 30].map((lat) => (
          <line key={lat} x1="0" x2={VB_W} y1={py(lat)} y2={py(lat)} pathLength="1" strokeDasharray="1" style={{ animation: "graticule-draw 600ms linear both" }} />
        ))}
      </g>
      <g fill="var(--ink-faint)" fontFamily="var(--font-mono)" fontSize="11">
        {[76, 77, 78].map((lon) => (
          <text key={lon} x={px(lon) + 3} y="12">
            {lon}°E
          </text>
        ))}
        {[27, 28, 29].map((lat) => (
          <text key={lat} x="3" y={py(lat) - 3}>
            {lat}°N
          </text>
        ))}
      </g>
      {/* swath band (~60 km) sweeping NE -> SW */}
      <g transform={`rotate(35 ${VB_W / 2} ${VB_H / 2})`}>
        <motion.g initial={{ y: from }} animate={{ y: [from, to] }} transition={sweep}>
          <rect x={VB_W / 2 - diag} y={-18} width={diag * 2} height="18" fill="var(--signal)" opacity="0.1" />
          <line x1={VB_W / 2 - diag} x2={VB_W / 2 + diag} y1="0" y2="0" stroke="var(--signal)" strokeOpacity="0.6" strokeWidth="1" />
        </motion.g>
      </g>
    </svg>
  );
}

const DOT = { ok: "bg-ok", error: "bg-crit", missing: "bg-warn", loading: "bg-brand-c animate-live-pulse", queued: "bg-ink-faint/50" };

function LogLines({ lines }) {
  return (
    <ul className="grid gap-x-6 gap-y-1.5 text-[12.5px] leading-5 sm:grid-cols-2">
      {lines.map((line) => (
        <li key={line.file} className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT[line.status] ?? DOT.queued)} />
          <span className="min-w-0 flex-1 truncate text-ink-muted">{line.label}</span>
          {line.status === "loading" && line.fraction !== null && (
            <span aria-hidden="true" className="relative hidden h-1 w-12 overflow-hidden rounded-full bg-surface-3 sm:block">
              <span className="absolute inset-y-0 left-0 bg-brand-c" style={{ width: `${Math.round(line.fraction * 100)}%` }} />
            </span>
          )}
          <span
            className={cn(
              "shrink-0 tabular-nums",
              line.status === "ok" && "text-ok",
              line.status === "error" && "text-crit",
              line.status === "missing" && "text-warn",
              (line.status === "queued" || line.status === "loading") && "text-ink-muted",
            )}
          >
            {lineStatusText(line)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * @param {{status: string, progress?: unknown, meta?: object, onDone: (skipped: boolean) => void}} props
 */
export function BootSequence({ status, progress, meta, onDone }) {
  const level = useMotionLevel();
  const [cinematic] = useState(() => shouldPlayCinematic(level));
  const [skipped, setSkipped] = useState(false);
  const startedAt = useRef(typeof performance !== "undefined" ? performance.now() : 0);
  const doneRef = useRef(false);
  const lines = useMemo(() => {
    const normalized = normalizeProgress(progress);
    return normalized.length ? normalized : fallbackLines(status);
  }, [progress, status]);
  const fraction = overallFraction(lines);
  const ready = status === "ready";
  const settled = status === "empty" || status === "error";
  const playing = cinematic && !skipped;

  // Finish: cinematic waits for data AND the minimum sweep (capped); static finishes on data.
  useEffect(() => {
    if (doneRef.current) return undefined;
    const finish = (wasSkipped) => {
      if (doneRef.current) return;
      doneRef.current = true;
      if (cinematic) rememberCinematic();
      onDone(wasSkipped);
    };
    if (settled) {
      finish(false);
      return undefined;
    }
    if (!ready) return undefined;
    if (!playing) {
      finish(skipped);
      return undefined;
    }
    const elapsed = performance.now() - startedAt.current;
    const wait = Math.max(0, Math.min(BOOT_MAX_MS, Math.max(BOOT_MIN_MS, elapsed)) - elapsed);
    const timer = setTimeout(() => finish(false), wait);
    return () => clearTimeout(timer);
  }, [ready, settled, playing, skipped, cinematic, onDone]);

  // Any key or click skips the cinematic (data may still be loading: the static list remains).
  useEffect(() => {
    if (!playing) return undefined;
    const skip = () => setSkipped(true);
    window.addEventListener("keydown", skip, { once: true, capture: true });
    window.addEventListener("pointerdown", skip, { once: true, capture: true });
    return () => {
      window.removeEventListener("keydown", skip, { capture: true });
      window.removeEventListener("pointerdown", skip, { capture: true });
    };
  }, [playing]);

  const pct = fraction === null ? null : Math.round(fraction * 100);
  const footer = bootFooter(meta);
  const stateLabel = playing ? (ready ? "sweeping" : "waiting") : "static";

  return (
    <div
      className="fixed inset-0 z-boot grid place-items-center bg-void px-4"
      style={{ backgroundImage: "radial-gradient(60% 50% at 50% 0%, rgba(109, 141, 255, 0.12), transparent 70%)" }}
      data-boot-state={stateLabel}
    >
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby="boot-title"
        aria-describedby="boot-status"
        className={cn("card w-full p-5 sm:p-6", playing ? "max-w-3xl" : "max-w-lg")}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h1 id="boot-title" className="flex items-center gap-2.5 font-display text-[15px] font-semibold text-ink-strong">
            <BrandGlyph size={24} />
            Delhi NCR Heat Atlas
          </h1>
          <span className="micro-label">{playing ? "Reading the satellite archive" : "Loading data"}</span>
        </div>
        {playing && (
          <div className="mb-4 overflow-hidden rounded-xl border border-hairline bg-void">
            <AcquisitionView looping={!ready} />
          </div>
        )}
        <div
          role="progressbar"
          aria-label="Bundle loading progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
          aria-valuetext={pct === null ? "Loading" : `${pct} percent`}
          className="mb-4 h-1 w-full overflow-hidden rounded-full bg-surface-3"
        >
          <div className="h-full rounded-full bg-[image:var(--brand-gradient)] transition-[width] duration-base ease-out" style={{ width: `${pct ?? 8}%` }} />
        </div>
        <LogLines lines={lines} />
        <p id="boot-status" className="sr-only" aria-live="polite">
          {ready ? "Bundle loaded." : `Loading bundle: ${lines.filter((l) => l.status === "ok").length} of ${lines.length} files ready.`}
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3">
          <span className="micro-label">{footer || "Delhi NCR · land surface temperature"}</span>
          {playing && (
            <button
              type="button"
              onClick={() => setSkipped(true)}
              className="btn btn-secondary h-8 px-3.5 text-[12.5px]"
            >
              Skip intro <kbd className="font-mono text-[11px] text-ink-faint">any key</kbd>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default BootSequence;
