import { cn } from "../../lib/cn.js";

/**
 * Section title block: optional eyebrow + icon, display-font title, muted description and
 * right-aligned actions (wraps under the title on narrow screens).
 * @param {{title: React.ReactNode, eyebrow?: React.ReactNode, description?: React.ReactNode,
 *          icon?: React.ComponentType, actions?: React.ReactNode, as?: string, accent?: string,
 *          className?: string}} props
 */
export function SectionHeader({
  title,
  eyebrow,
  description,
  icon: Icon,
  actions,
  as: Heading = "h2",
  accent = "cyan",
  className,
  id,
}) {
  const accentText = {
    cyan: "text-cyan",
    violet: "text-violet",
    emerald: "text-emerald",
    rose: "text-rose",
    amber: "text-amber",
  }[accent] ?? "text-cyan";
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        {eyebrow && (
          <p className={cn("mb-1 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.18em]", accentText)}>
            {Icon && <Icon aria-hidden="true" className="size-3.5" />}
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
