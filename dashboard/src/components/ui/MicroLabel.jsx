import { cn } from "../../lib/cn.js";

/**
 * Micro label (UI_SPEC §4.3): JetBrains Mono 500, 11 px, 0.14em tracking, UPPERCASE,
 * ink-faint (5.11:1 on surface-3). Never smaller than 11 px.
 * @param {{as?: string, className?: string, children: React.ReactNode}} props
 */
export function MicroLabel({ as: Component = "span", className, children, ...props }) {
  return (
    <Component className={cn("micro-label", className)} {...props}>
      {children}
    </Component>
  );
}
