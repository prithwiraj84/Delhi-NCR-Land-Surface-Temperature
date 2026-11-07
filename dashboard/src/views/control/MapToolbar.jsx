/**
 * Map toolbar (UI_SPEC_v2 §3.2 VIEW panel):
 *   GRID 1 km │ RASTER 250 m │ AUTO      flat │ excess │ abs      ◯ lens  ⫼ compare  ¶ describe  ⋯ analyst
 *
 * - Height (D3): `anom` ("excess", default) = °C above the frame's NCR mean, capped at +6;
 *   `flat`; `abs` (v1 behaviour, opt-in). Mobile and Reduced motion default to flat (engine).
 * - Lens (Z): 250 m inside a 110 px circle; disabled on touch and at perf tier ≥ 2 (reason).
 * - Compare (C): the same action as the keyboard (shell/actions.js `toggleCompare`).
 * - Describe: opens the DescribeMap panel (sentence + district table), a map alternative.
 */
import { useState } from "react";
import { FileText } from "lucide-react";
import { LensGlyph, SplitCompareGlyph } from "../../design/glyphs.jsx";
import { Segmented } from "../../components/ui/Segmented.jsx";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { IconTip } from "../../components/ui/InfoTip.jsx";
import { cn } from "../../lib/cn.js";
import { useTimeStore } from "../../state/stores/timeStore.js";
import { useViewStore } from "../../state/stores/viewStore.js";
import { runAction } from "../../shell/actions.js";
import { announce } from "../../shell/announcer.js";
import { STORES } from "../../shell/useShellEffects.js";
import { AnalystPopover } from "./AnalystPopover.jsx";
import { RenderSwitch } from "./RenderSwitch.jsx";

function useCoarsePointer() {
  const [coarse] = useState(() => {
    try {
      return window.matchMedia?.("(pointer: coarse)").matches ?? false;
    } catch {
      return false;
    }
  });
  return coarse;
}

function ToolButton({ label, shortcut, pressed, disabled, reason, onClick, children }) {
  return (
    <IconTip label={disabled ? reason : `${label}${shortcut ? ` (${shortcut})` : ""}`}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        aria-keyshortcuts={shortcut}
        aria-disabled={disabled || undefined}
        onClick={() => (disabled ? announce(`${label} unavailable: ${reason}`) : onClick())}
        className={cn(
          "focus-ring grid size-8 place-items-center rounded-md text-ink-muted transition-colors duration-instant hover:bg-surface-3 hover:text-ink",
          pressed && "bg-surface-3 text-signal",
          disabled && "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-ink-muted",
        )}
      >
        {children}
      </button>
    </IconTip>
  );
}

/** @param {{describeOpen?: boolean, onToggleDescribe?: () => void, compact?: boolean, className?: string}} props */
export function MapToolbar({ describeOpen = false, onToggleDescribe, compact = false, className }) {
  const heightMode = useViewStore((s) => s.heightMode);
  const lens = useViewStore((s) => s.lens);
  const perfTier = useViewStore((s) => s.perfTier ?? 0);
  const compareOn = useTimeStore((s) => Boolean(s.compare?.kind));
  const years = useTimeStore((s) => s.years);
  const coarse = useCoarsePointer();
  const lensReason = coarse ? "The lens needs a mouse — tap and hold for 250 m detail" : perfTier >= 2 ? "Lens is off at performance tier 2+" : null;

  return (
    <HudFrame as="section" aria-label="Map view options" padding="sm" className={cn("pointer-events-auto", className)} data-testid="map-toolbar">
      {/* Two explicit groups instead of flex-wrap: a wrapped flex row keeps the panel at its full
          max-width with an empty second line, so compact (< 1600 px) stacks the groups and the panel
          shrink-wraps to the wider one; wide screens keep a single row. */}
      <div className={cn("flex items-center gap-2", compact && "flex-col items-end gap-1.5")}>
        <div className="flex items-center gap-1.5">
        <RenderSwitch compact={compact} />
        <span aria-hidden="true" className="h-5 w-px bg-hairline" />
        <Segmented
          ariaLabel="Prism height"
          layoutId="height-mode"
          size="sm"
          value={heightMode}
          onChange={(v) => {
            useViewStore.getState().setHeightMode(v);
            announce(v === "anom" ? "Height: degrees above the NCR mean" : v === "abs" ? "Height: absolute" : "Flat map");
          }}
          options={[
            { value: "flat", label: "flat", title: "No extrusion" },
            { value: "anom", label: "excess", title: "Height = °C above the NCR mean of the frame (cap +6 °C)" },
            { value: "abs", label: "abs", title: "Height = absolute °C (v1; can build walls)" },
          ]}
        />
        </div>
        {!compact && <span aria-hidden="true" className="h-5 w-px bg-hairline" />}
        <div className="flex items-center gap-0.5">
          <ToolButton label="Downscale lens" shortcut="Z" pressed={lens && !lensReason} disabled={Boolean(lensReason)} reason={lensReason} onClick={() => useViewStore.getState().toggleLens()}>
            <LensGlyph size={16} />
          </ToolButton>
          <ToolButton label="Compare" shortcut="C" pressed={compareOn} onClick={() => runAction({ type: "toggleCompare" }, { stores: STORES, years: years ?? [], announce })}>
            <SplitCompareGlyph size={16} />
          </ToolButton>
          {onToggleDescribe && (
            <ToolButton label="Describe the map" pressed={describeOpen} onClick={onToggleDescribe}>
              <FileText aria-hidden="true" className="size-4" strokeWidth={1.5} />
            </ToolButton>
          )}
          <AnalystPopover />
        </div>
      </div>
    </HudFrame>
  );
}

export default MapToolbar;
