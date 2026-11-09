"use client";
/**
 * Time-lapse of the real LST rasters: a year rail (radio group) and a Day / Night switch over
 * stacked images that crossfade (opacity 280 ms ease, interruptible CSS transitions, so rapid
 * clicks retarget instead of queueing). "Play" steps through the years once (one frame per
 * 900 ms) and stops on any user input. Images load lazily; only the active one is visible.
 */
import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";

const TIER_TEXT = {
  observed: "Observed",
  "observed-sparse": "Observed (few clear scenes)",
  reconstructed: "Reconstructed (Terra, calibrated)",
  modelled: "Modelled hindcast",
};

export function YearScrubber({ frames, basePath = "" }) {
  // frames: [{ mode, year, tier, file, width, height }]
  const modes = [...new Set(frames.map((f) => f.mode))];
  const [mode, setMode] = useState(modes.includes("day") ? "day" : modes[0]);
  const list = frames.filter((f) => f.mode === mode).sort((a, b) => a.year - b.year);
  const years = list.map((f) => f.year);
  const [year, setYear] = useState(years.at(-1));
  const [playing, setPlaying] = useState(false);
  const timer = useRef(null);
  const active = list.find((f) => f.year === year) ?? list.at(-1);

  useEffect(() => {
    if (!playing) return undefined;
    timer.current = setInterval(() => {
      setYear((y) => {
        const i = years.indexOf(y);
        if (i >= years.length - 1) {
          setPlaying(false);
          return y;
        }
        return years[i + 1];
      });
    }, 900);
    return () => clearInterval(timer.current);
  }, [playing, years]);

  const start = () => {
    if (year === years.at(-1)) setYear(years[0]);
    setPlaying(true);
  };

  return (
    <div className="card overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-3 sm:px-5">
        <div role="radiogroup" aria-label="Day or night" className="inline-flex rounded-full border border-hairline-strong bg-white/[0.03] p-0.5">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => {
                setPlaying(false);
                setMode(m);
              }}
              className={`focus-ring h-8 rounded-full px-4 text-[13px] font-medium transition-colors duration-200 ${mode === m ? "bg-white/[0.1] text-ink-strong" : "text-ink-muted hover:text-ink"}`}
            >
              {m === "day" ? "Day · 10:45" : "Night · 01:30"}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => (playing ? setPlaying(false) : start())} className="btn btn-secondary h-9 px-4 text-[13px]" aria-pressed={playing}>
          {playing ? <Pause aria-hidden="true" className="size-4" /> : <Play aria-hidden="true" className="size-4" />}
          {playing ? "Pause" : "Play 1990 → 2025"}
        </button>
      </div>

      <div className="relative bg-void" style={{ aspectRatio: `${active?.width ?? 960} / ${active?.height ?? 1043}` }}>
        {list.map((f) => (
          <img
            key={`${f.mode}-${f.year}`}
            src={`${basePath}/media/${f.file}`}
            alt={f.year === year ? `${f.mode === "day" ? "Daytime" : "Night-time"} land surface temperature of Delhi NCR, ${f.year} frame` : ""}
            aria-hidden={f.year === year ? undefined : true}
            width={f.width}
            height={f.height}
            loading="lazy"
            decoding="async"
            className="absolute inset-0 size-full object-contain"
            style={{ opacity: f.year === year ? 1 : 0, transition: "opacity 280ms ease" }}
          />
        ))}
        <div className="pointer-events-none absolute left-4 top-4 rounded-2xl bg-[#0A0B10]/75 px-4 py-3 backdrop-blur-md">
          <p className="font-display text-[34px] font-semibold leading-none tracking-[-0.03em] text-white tnum">{year}</p>
          <p className="mt-1.5 text-[12.5px] text-white/70">{TIER_TEXT[active?.tier] ?? active?.tier}</p>
        </div>
      </div>

      <div role="radiogroup" aria-label="Year" className="grid grid-cols-4 gap-1 p-3 sm:grid-cols-8">
        {list.map((f) => (
          <button
            key={f.year}
            type="button"
            role="radio"
            aria-checked={f.year === year}
            onClick={() => {
              setPlaying(false);
              setYear(f.year);
            }}
            className={`focus-ring relative rounded-xl px-2 py-2 text-[13px] font-medium tnum transition-colors duration-200 ${
              f.year === year ? "bg-white/[0.08] text-ink-strong" : "text-ink-muted hover:bg-white/[0.04] hover:text-ink"
            }`}
          >
            {f.year}
            {f.tier !== "observed" && <span aria-hidden="true" className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-warn/80" />}
          </button>
        ))}
      </div>
      <p className="px-5 pb-4 text-[12.5px] text-ink-faint">
        <span aria-hidden="true" className="mr-1.5 inline-block size-1.5 translate-y-[-1px] rounded-full bg-warn/80" />
        Marked years rest on fewer observations (sparse Landsat 5 scenes, calibrated Terra nights or a model hindcast).
      </p>
    </div>
  );
}
