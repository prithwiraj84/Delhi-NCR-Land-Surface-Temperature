/**
 * Settings popover (⛭ in the command bar): motion level (§5.3), performance tier (§6.6),
 * bundle source (SPEC §6: data | demo | fixture) and the shortcut sheet. A non-modal dialog: focus
 * moves into it on open and returns to the trigger on close; Esc or an outside click closes.
 */
import { useEffect, useRef } from "react";
import { Keyboard, Settings2 } from "lucide-react";
import { MOTION_PREF_LABELS, MOTION_PREFS } from "../design/motion.js";
import { useMotionLevel } from "../design/useMotionLevel.js";
import { useData } from "../state/DataContext.jsx";
import { cn } from "../lib/cn.js";
import { IconTip } from "../components/ui/InfoTip.jsx";
import { Segmented } from "../components/ui/Segmented.jsx";
import { announce } from "./announcer.js";
import { setStoreField, useViewStore } from "./deps.js";
import { currentBundleSource, hasCustomBaseUrl, switchBundleSource } from "./bundleSource.js";
import { useFocusTrap } from "./useFocusTrap.js";
import { useShellUi } from "./uiStore.js";

const PERF_OPTIONS = [
  { value: "0", label: "Full", title: "Full quality (the governor may step down automatically)" },
  { value: "1", label: "T1", title: "Solid panels (no backdrop blur)" },
  { value: "2", label: "T2", title: "Flat lighting, lens off, DPR 1, isotherms off" },
  { value: "3", label: "T3", title: "2-D, CPU path, raster only on pause" },
];

const PERF_HELP = {
  0: "Full quality. Steps down automatically if frames take longer than 22 ms.",
  1: "Solid panels: no backdrop blur over the map.",
  2: "Flat lighting, no lens, device-pixel ratio 1, no isotherms.",
  3: "2-D map on the CPU path; the 250 m raster loads only when paused.",
};

export function SettingsMenu() {
  const overlay = useShellUi((s) => s.overlay);
  const toggle = useShellUi((s) => s.toggle);
  const close = useShellUi((s) => s.close);
  const open = overlay === "settings";
  const motionPref = useViewStore((s) => s.motionPref ?? "system");
  const perfTier = useViewStore((s) => (Number.isInteger(s.perfTier) ? s.perfTier : 0));
  const level = useMotionLevel();
  const data = useData();
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const source = currentBundleSource(data?.source);
  const customBase = hasCustomBaseUrl();

  useFocusTrap(panelRef, open);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e) => rootRef.current && !rootRef.current.contains(e.target) && close();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);

  return (
    <div ref={rootRef} className="relative">
      <IconTip label="Settings">
        <button
          type="button"
          aria-label="Settings"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls={open ? "settings-dialog" : undefined}
          onClick={() => toggle("settings")}
          className={cn(
            "focus-ring grid size-8 place-items-center rounded-md border border-transparent text-ink-muted hover:text-ink",
            open && "border-hairline bg-surface-3 text-ink-strong",
          )}
        >
          <Settings2 aria-hidden="true" className="size-4" strokeWidth={1.5} />
        </button>
      </IconTip>
      {open && (
        <div
          ref={panelRef}
          id="settings-dialog"
          role="dialog"
          aria-label="Settings"
          className="glass-strong hud absolute right-0 top-10 z-overlay w-[min(22rem,calc(100vw-1.5rem))] space-y-4 rounded-panel p-4"
        >
          <fieldset className="space-y-2">
            <legend className="micro-label">Motion</legend>
            <Segmented
              ariaLabel="Motion level"
              layoutId="settings-motion"
              value={motionPref}
              onChange={(v) => {
                setStoreField(useViewStore, "motionPref", v);
                announce(`Motion: ${MOTION_PREF_LABELS[v]}`);
              }}
              options={MOTION_PREFS.map((p) => ({ value: p, label: MOTION_PREF_LABELS[p] }))}
              size="sm"
            />
            <p className="text-xs text-ink-muted">
              Now: {MOTION_PREF_LABELS[level]}
              {motionPref === "system" ? " (from the system setting)" : ""}. Playback never starts by itself. Key <kbd className="font-mono text-ink">M</kbd> cycles.
            </p>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="micro-label">Performance</legend>
            <Segmented
              ariaLabel="Performance tier"
              layoutId="settings-perf"
              value={String(perfTier)}
              onChange={(v) => setStoreField(useViewStore, "perfTier", Number(v))}
              options={PERF_OPTIONS}
              size="sm"
            />
            <p className="text-xs text-ink-muted">{PERF_HELP[perfTier] ?? PERF_HELP[0]}</p>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="micro-label">Bundle source</legend>
            <Segmented
              ariaLabel="Bundle source"
              layoutId="settings-bundle"
              value={source}
              onChange={(v) => switchBundleSource(v, data)}
              options={[
                { value: "data", label: "Data", title: "public/data — your bundle" },
                { value: "demo", label: "Demo", title: "public/demo — synthetic v2 demo bundle" },
                { value: "fixture", label: "Fixture", title: "In-memory synthetic v2 fixture (no files needed)" },
              ]}
              size="sm"
            />
            <p className="text-xs text-ink-muted">
              {source === "data" && "Your bundle (public/data). "}
              {source === "demo" && "Synthetic v2 demo bundle (public/demo): simulated values. "}
              {source === "fixture" && "In-memory synthetic fixture: simulated values, for testing the UI. "}
              {source === "custom" && "Bundle from VITE_DATA_BASE_URL. "}
              {customBase && source !== "custom" ? "An explicit choice overrides VITE_DATA_BASE_URL. " : ""}
              Switching reloads the bundle.
            </p>
          </fieldset>

          <button
            type="button"
            onClick={() => useShellUi.getState().open("shortcuts")}
            className="focus-ring flex h-8 w-full items-center gap-2 rounded-md border border-control px-3 text-sm text-ink hover:border-ink-faint"
          >
            <Keyboard aria-hidden="true" className="size-4" strokeWidth={1.5} />
            Keyboard shortcuts
            <kbd className="ml-auto font-mono text-xs text-ink-muted">?</kbd>
          </button>
        </div>
      )}
    </div>
  );
}

export default SettingsMenu;
