/**
 * Compact "unavailable" state for a panel (v1-compat bundles, missing exports, non-XAI
 * frames). It says WHY in user-facing words (the hook's `reason`), never just "no data".
 * @param {{status?: string, reason?: string, title?: string, action?: React.ReactNode, className?: string}} props
 */
import { AlertTriangle, CircleSlash } from "lucide-react";
import { cn } from "../lib/cn.js";

export function Unavailable({ status = "unavailable", reason, title, action, className }) {
  const error = status === "error";
  const Icon = error ? AlertTriangle : CircleSlash;
  return (
    <div role={error ? "alert" : "status"} className={cn("flex items-start gap-2 rounded-md border border-dashed border-hairline-strong bg-surface-3/40 p-3 text-xs text-ink-muted", className)}>
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", error ? "text-crit" : "text-ink-faint")} />
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-ink">{title ?? (error ? "Could not load this panel" : "Unavailable for this bundle")}</p>
        {reason && <p className="leading-snug">{reason}</p>}
        {action}
      </div>
    </div>
  );
}

export default Unavailable;
