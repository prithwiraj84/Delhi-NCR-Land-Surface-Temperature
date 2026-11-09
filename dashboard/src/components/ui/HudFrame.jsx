import { forwardRef, useId, useState } from "react";
import { cn } from "../../lib/cn.js";
import { useMotionLevel } from "../../design/useMotionLevel.js";

const SCAN_KEY = "ncr-ops.scanned-panels";

/** True (once per panel id per session) when the mount scan should play; storage errors -> false. */
function claimScan(id) {
  if (!id) return false;
  try {
    const raw = globalThis.sessionStorage?.getItem(SCAN_KEY);
    const seen = new Set(raw ? JSON.parse(raw) : []);
    if (seen.has(id)) return false;
    seen.add(id);
    globalThis.sessionStorage?.setItem(SCAN_KEY, JSON.stringify([...seen]));
    return true;
  } catch {
    return false;
  }
}

/**
 * Glass panel with HUD corner brackets (UI_SPEC §4.5): 8 px L-ticks drawn by gradient layers
 * on a pseudo-element (no extra DOM). `active` turns the brackets signal @ 60 %. `scanId`
 * plays the one-time mount scan (1 px signal line, 600 ms) the first time that panel mounts
 * in a session, in Full motion only. `solid` uses the opaque surface-2 (off-map cards).
 * An optional `title` renders a micro-label header with `actions` on the right; the panel is
 * then a labelled region.
 * @param {{as?: string, title?: React.ReactNode, actions?: React.ReactNode, active?: boolean,
 *          solid?: boolean, scanId?: string, padding?: "none"|"sm"|"md", className?: string}} props
 */
export const HudFrame = forwardRef(function HudFrame(
  { as: Component = "section", title, actions, active = false, solid = false, scanId, padding = "md", className, children, ...props },
  ref,
) {
  const level = useMotionLevel();
  const [scan] = useState(() => level === "full" && claimScan(scanId));
  const pad = { none: "p-0", sm: "p-3", md: "p-4" }[padding] ?? "p-4";
  const autoId = useId();
  const headingId = `${props.id ?? autoId.replace(/:/g, "")}-title`;
  return (
    <Component
      ref={ref}
      aria-labelledby={title ? headingId : undefined}
      className={cn("hud rounded-panel text-ink", solid ? "glass-strong" : "glass", active && "hud-active", scan && "mount-scan", pad, className)}
      {...props}
    >
      {(title || actions) && (
        <header className="mb-2 flex min-h-6 items-center justify-between gap-2">
          {title && (
            <h2 id={headingId} className="micro-label truncate">
              {title}
            </h2>
          )}
          {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </header>
      )}
      {children}
    </Component>
  );
});
