import { cn } from "../../lib/cn.js";
import { ScanSkeleton } from "../ui/ScanSkeleton.jsx";

/**
 * Compact loading panel (v1 API, kept for views that load their own assets). The app boot
 * itself is the shell's BootSequence; this is the in-view equivalent: a scanline skeleton
 * plus a short status line.
 * @param {{message?: string, detail?: string, className?: string}} props
 */
export function LoadingScreen({ message = "Loading thermal data", detail, className }) {
  return (
    <div className={cn("flex min-h-[40vh] w-full flex-col items-center justify-center gap-4 px-6", className)}>
      <div className="w-full max-w-md">
        <ScanSkeleton label={message} height={120} />
      </div>
      <div className="text-center">
        <p className="font-display text-base font-semibold text-ink-strong">{message}</p>
        <p className="micro-label mt-1">{detail ?? "Streaming the bundle"}</p>
      </div>
    </div>
  );
}
