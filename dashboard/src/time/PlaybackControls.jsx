/**
 * Playback controls (UI_SPEC_v2 §3.3 left column, §5.2 B, §12):
 *   ►/❚❚ play (aria-pressed)  |◄ ►| previous / next frame  speed 0.5× · 1× · 2×  ⟲ loop
 *
 * Playback never autostarts (WCAG 2.2.2). The buffering state ("next frame not loaded") is
 * shown on the play button with a text alternative. In Off motion playback still works but
 * steps without tweens (3 s per frame, time/playback.js). `size="touch"` gives 44 px targets
 * (mobile tape variant).
 */
import { Pause, Play, Repeat, SkipBack, SkipForward } from "lucide-react";
import { cn } from "../lib/cn.js";
import { useTimeStore } from "../state/stores/timeStore.js";
import { IconTip } from "../components/ui/InfoTip.jsx";
import { usePlaybackStatus } from "./playback.js";

const SPEEDS = [0.5, 1, 2];

function IconButton({ label, shortcut, onClick, pressed, disabled, children, touch, className }) {
  return (
    <IconTip label={shortcut ? `${label} (${shortcut})` : label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        aria-keyshortcuts={shortcut || undefined}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "focus-ring grid shrink-0 place-items-center rounded-md text-ink-muted transition-colors duration-instant hover:bg-surface-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40",
          touch ? "size-11" : "size-8",
          pressed && "text-ink-strong",
          className,
        )}
      >
        {children}
      </button>
    </IconTip>
  );
}

/**
 * @param {{size?: "md"|"touch", showSpeed?: boolean, showLoop?: boolean, showSteps?: boolean,
 *          className?: string}} props
 */
export function PlaybackControls({ size = "md", showSpeed = true, showLoop = true, showSteps = true, className }) {
  const playing = useTimeStore((s) => Boolean(s.playing));
  const speed = useTimeStore((s) => s.speed ?? 1);
  const loop = useTimeStore((s) => Boolean(s.loop));
  const hasFrames = useTimeStore((s) => (s.years?.length ?? 0) > 1);
  const buffering = usePlaybackStatus((s) => s.buffering);
  const bufferingYear = usePlaybackStatus((s) => s.bufferingYear);
  const touch = size === "touch";
  const icon = touch ? "size-5" : "size-4";

  return (
    <div className={cn("flex items-center gap-0.5", className)} role="group" aria-label="Playback">
      <IconButton
        label={playing ? "Pause" : "Play"}
        shortcut="Space"
        pressed={playing}
        disabled={!hasFrames}
        touch={touch}
        onClick={() => useTimeStore.getState().togglePlay?.()}
        className={cn(playing && "bg-surface-3", buffering && "animate-live-pulse")}
      >
        {playing ? <Pause aria-hidden="true" className={icon} strokeWidth={1.75} /> : <Play aria-hidden="true" className={icon} strokeWidth={1.75} />}
      </IconButton>
      {buffering && (
        <span className="sr-only" role="status">
          {`Loading ${bufferingYear ?? "the next frame"}`}
        </span>
      )}
      {showSteps && (
        <>
          <IconButton label="Previous frame" shortcut="ArrowLeft" disabled={!hasFrames} touch={touch} onClick={() => useTimeStore.getState().step?.(-1)}>
            <SkipBack aria-hidden="true" className={icon} strokeWidth={1.5} />
          </IconButton>
          <IconButton label="Next frame" shortcut="ArrowRight" disabled={!hasFrames} touch={touch} onClick={() => useTimeStore.getState().step?.(1)}>
            <SkipForward aria-hidden="true" className={icon} strokeWidth={1.5} />
          </IconButton>
        </>
      )}
      {showSpeed && (
        <IconTip label="Playback speed">
          <button
            type="button"
            aria-label={`Playback speed ${speed}×, activate to change`}
            onClick={() => {
              const i = SPEEDS.indexOf(speed);
              useTimeStore.getState().setSpeed?.(SPEEDS[(i + 1) % SPEEDS.length]);
            }}
            className={cn(
              "focus-ring tnum shrink-0 rounded-md px-1.5 font-mono text-[11px] text-ink-muted hover:bg-surface-3 hover:text-ink",
              touch ? "h-11 min-w-11" : "h-8 min-w-9",
            )}
          >
            {speed}×
          </button>
        </IconTip>
      )}
      {showLoop && (
        <IconButton label="Loop playback" pressed={loop} touch={touch} onClick={() => useTimeStore.getState().setLoop?.(!loop)}>
          <Repeat aria-hidden="true" className={cn(icon, loop ? "text-signal" : undefined)} strokeWidth={1.5} />
        </IconButton>
      )}
    </div>
  );
}

export default PlaybackControls;
