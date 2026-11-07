import { cn } from "../../lib/cn.js";

const ACCENT_TEXT = {
  signal: "text-signal",
  solar: "text-solar",
  lunar: "text-lunar",
  ok: "text-ok",
  warn: "text-warn",
  crit: "text-crit",
  // v1 names
  cyan: "text-signal",
  violet: "text-lunar",
  emerald: "text-ok",
  rose: "text-crit",
  amber: "text-warn",
};

/**
 * Section title block: optional micro-label eyebrow + icon, Space Grotesk title, muted
 * description and right-aligned actions (wraps under the title on narrow screens).
 * @param {{title: React.ReactNode, eyebrow?: React.ReactNode, description?: React.ReactNode,
 *          icon?: React.ComponentType, actions?: React.ReactNode, as?: string, accent?: string,
 *          className?: string, id?: string}} props
 */
export function SectionHeader({ title, eyebrow, description, icon: Icon, actions, as: Heading = "h2", accent = "signal", className, id }) {
  const accentText = ACCENT_TEXT[accent] ?? ACCENT_TEXT.signal;
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        {eyebrow && (
          <p className="micro-label mb-1 flex items-center gap-1.5">
            {Icon && <Icon aria-hidden="true" className={cn("size-3.5", accentText)} />}
            {eyebrow}
          </p>
        )}
        <Heading id={id} className="flex items-center gap-2 font-display text-lg font-semibold text-ink-strong sm:text-xl">
          {!eyebrow && Icon && <Icon aria-hidden="true" className={cn("size-5", accentText)} />}
          {title}
        </Heading>
        {description && <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
