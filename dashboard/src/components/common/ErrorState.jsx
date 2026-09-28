import { useState } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Button } from "../ui/Button.jsx";

/**
 * Error panel with a readable message, optional technical details and a retry action.
 * @param {{title?: React.ReactNode, error?: unknown, onRetry?: Function, retryLabel?: string,
 *          compact?: boolean, className?: string}} props
 */
export function ErrorState({
  title = "Something went wrong",
  error,
  onRetry,
  retryLabel = "Try again",
  compact = false,
  className,
}) {
  const [showDetails, setShowDetails] = useState(false);
  const message = error instanceof Error ? error.message : error ? String(error) : null;
  const details = error instanceof Error ? [error.url && `URL: ${error.url}`, error.stack].filter(Boolean).join("\n") : null;

  return (
    <div
      role="alert"
      className={cn(
        "flex w-full flex-col items-center justify-center text-center",
        compact ? "gap-2 p-6" : "gap-4 px-6 py-14",
        className,
      )}
    >
      <div className="grid size-12 place-items-center rounded-2xl border border-rose/35 bg-rose/10 text-rose shadow-glow-rose">
        <TriangleAlert aria-hidden="true" className="size-6" />
      </div>
      <div className="max-w-xl">
        <h2 className={cn("font-display font-semibold text-ink-strong", compact ? "text-base" : "text-xl")}>{title}</h2>
        {message && <p className="mt-2 break-words text-sm leading-relaxed text-ink-muted">{message}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {onRetry && (
          <Button variant="danger" onClick={onRetry}>
            <RotateCcw aria-hidden="true" />
            {retryLabel}
          </Button>
        )}
        {details && (
          <Button variant="ghost" size="sm" aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)}>
            {showDetails ? "Hide details" : "Technical details"}
          </Button>
        )}
      </div>
      {showDetails && details && (
        <pre className="scrollbar-thin max-h-56 w-full max-w-2xl overflow-auto rounded-lg border border-panel-border bg-bg-deep/80 p-3 text-left font-mono text-[11px] leading-relaxed text-ink-muted">
          {details}
        </pre>
      )}
    </div>
  );
}
