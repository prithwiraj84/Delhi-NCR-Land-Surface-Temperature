import { cn } from "../../lib/cn.js";

/**
 * Placeholder block (v1 API). In v2 it renders the scanline skeleton: surface-3 with a 1 px
 * signal line sweeping every 1.6 s (stopped under Reduced/Off motion). Prefer <ScanSkeleton>
 * for new code - it also announces loading to assistive technology.
 */
export function Skeleton({ className, ...props }) {
  return <div aria-hidden="true" className={cn("skeleton rounded-md", className)} {...props} />;
}
