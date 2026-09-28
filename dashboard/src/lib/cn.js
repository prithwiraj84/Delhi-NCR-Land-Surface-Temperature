/**
 * Class-name composer used by every component.
 *
 * `clsx` flattens conditional class lists; `tailwind-merge` then resolves Tailwind
 * conflicts so the LAST utility wins (e.g. `cn("px-2", "px-4")` yields "px-4"). This is
 * what lets callers pass `className` overrides to the UI primitives safely.
 */
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** @param {...(string|false|null|undefined|Record<string, boolean>|Array)} classes */
export function cn(...classes) {
  return twMerge(clsx(classes));
}
