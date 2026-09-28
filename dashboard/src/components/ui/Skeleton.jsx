import { cn } from "../../lib/cn.js";

/** Shimmering placeholder block (animation disabled under prefers-reduced-motion). */
export function Skeleton({ className, ...props }) {
  return <div aria-hidden="true" className={cn("skeleton rounded-md", className)} {...props} />;
}
