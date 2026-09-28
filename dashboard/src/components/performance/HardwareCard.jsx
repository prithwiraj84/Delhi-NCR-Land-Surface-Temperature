/**
 * Hardware & timings card: what the pipeline actually ran on (GPU names, XGBoost / LightGBM
 * devices, RAPIDS availability, the devices recorded per CV fold) and how long each
 * recorded stage took, as a horizontal bar list (longest first, long tails folded).
 *
 * Built as HTML rows rather than SVG: every bar sits next to its readable label and value,
 * so the list is its own table view and wraps gracefully at phone width.
 */
import { motion, useReducedMotion } from "framer-motion";
import { Cpu, Gauge, MemoryStick, Timer } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { MISSING } from "../../lib/format.js";
import { Badge } from "../ui/Badge.jsx";
import { formatDuration, stageLabel, timingRows } from "./perfModel.js";

function Fact({ label, children }) {
  return (
    <div className="min-w-0 rounded-lg border border-panel-border bg-bg-raised/50 px-3 py-2">
      <dt className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</dt>
      <dd className="mt-0.5 truncate font-mono text-xs text-ink">{children}</dd>
    </div>
  );
}

const isGpuDevice = (d) => /cuda|gpu/i.test(String(d ?? ""));

/**
 * @param {{hardware: ReturnType<import("./perfModel.js").hardwareInfo>, timings: object}} props
 */
export function HardwareCard({ hardware, timings }) {
  const reduceMotion = useReducedMotion();
  const { rows, total } = timingRows(timings, 10);
  const max = rows.reduce((m, r) => Math.max(m, r.seconds), 0) || 1;
  const gpuCount = hardware.nGpus || hardware.gpus.length;
  const accelerated = isGpuDevice(hardware.xgbDevice) || hardware.foldDevices.some(isGpuDevice);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={accelerated ? "cyan" : "default"} dot pulse={accelerated}>
            {accelerated ? "GPU accelerated" : "CPU run"}
          </Badge>
          <Badge
            variant={hardware.rapids ? "violet" : "outline"}
            title={
              hardware.rapidsUsed.length
                ? `RAPIDS components that ran: ${hardware.rapidsUsed.join(", ")}`
                : hardware.rapids
                  ? "RAPIDS was used by at least one stage"
                  : "No RAPIDS (cuDF / cuML) stage ran; CPU / XGBoost paths were used"
            }
          >
            {hardware.rapids ? `RAPIDS on${hardware.rapidsUsed.length ? ` · ${hardware.rapidsUsed.join(", ")}` : ""}` : "RAPIDS off"}
          </Badge>
          {hardware.bootstrap?.n != null && (
            <Badge variant="outline">
              bootstrap n={String(hardware.bootstrap.n)}
              {hardware.bootstrap.mode ? ` · ${hardware.bootstrap.mode}` : ""}
            </Badge>
          )}
        </div>

        <div>
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-faint">
            <MemoryStick aria-hidden="true" className="size-3.5 text-cyan" />
            GPUs ({gpuCount})
          </p>
          {hardware.gpus.length ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="GPUs">
              {hardware.gpus.map((name, i) => (
                <li
                  key={`${name}-${i}`}
                  className="inline-flex items-center gap-1.5 rounded-md border border-cyan/30 bg-cyan/10 px-2 py-1 font-mono text-[11px] text-cyan-soft"
                >
                  <span className="text-ink-faint">cuda:{i}</span>
                  {name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-ink-muted">No GPU was detected; all models trained on the CPU.</p>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Fact label="XGBoost device">{hardware.xgbDevice ?? MISSING}</Fact>
          <Fact label="LightGBM device">{hardware.lgbmDevice ?? MISSING}</Fact>
          <Fact label="XGBoost version">{hardware.xgbVersion ?? MISSING}</Fact>
          <Fact label="Python">{hardware.python ? String(hardware.python).split(" ")[0] : MISSING}</Fact>
          <Fact label="Fold devices">{hardware.foldDevices.length ? hardware.foldDevices.join(", ") : MISSING}</Fact>
          <Fact label="Platform">
            <span title={hardware.platform ?? undefined}>{hardware.platform ?? MISSING}</span>
          </Fact>
        </dl>
      </div>

      <div className="min-w-0">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-faint">
            <Timer aria-hidden="true" className="size-3.5 text-violet" />
            Stage timings
          </p>
          <p className="font-mono text-[11px] text-ink-muted">
            Σ {formatDuration(total)} <span className="text-ink-faint">(stages may nest)</span>
          </p>
        </div>
        {rows.length ? (
          <ul className="space-y-1.5" aria-label="Stage timings, longest first">
            {rows.map((r, i) => (
              <li key={r.stage} className="grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)_4.5rem] items-center gap-2 text-xs">
                <span className={cn("truncate", r.folded ? "italic text-ink-faint" : "text-ink")} title={r.stage}>
                  {stageLabel(r.stage)}
                </span>
                <span className="relative h-2.5 overflow-hidden rounded-r-[4px]" aria-hidden="true">
                  <motion.span
                    className="absolute inset-y-0 left-0 rounded-r-[4px] bg-violet"
                    style={{ opacity: r.folded ? 0.45 : 0.85 }}
                    initial={reduceMotion ? false : { width: 0 }}
                    animate={{ width: `${Math.max(1.5, (r.seconds / max) * 100)}%` }}
                    transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: reduceMotion ? 0 : i * 0.03 }}
                  />
                </span>
                <span className="kpi-number text-right font-mono text-ink-muted">{formatDuration(r.seconds)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-xs text-ink-muted">
            <Gauge aria-hidden="true" className="size-4" /> No stage timings were exported.
          </p>
        )}
        <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-faint">
          <Cpu aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Timings come from the notebook&apos;s <code className="font-mono text-ink-muted">timer()</code> blocks on this
            run&apos;s hardware; GPU stages (XGBoost hist, TreeSHAP) scale with the number of T4s via one worker per device.
          </span>
        </p>
      </div>
    </div>
  );
}
