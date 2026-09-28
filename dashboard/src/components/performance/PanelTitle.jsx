/**
 * Heading row used inside the glass panels of the performance and zoning views (same
 * anatomy as the threshold explorer's panel titles): icon · title · optional info tip on
 * the left, controls on the right, wrapping under the title on narrow screens.
 */
import { cn } from "../../lib/cn.js";
import { InfoTip } from "../ui/InfoTip.jsx";

const ICON_TONE = {
  cyan: "text-cyan",
  violet: "text-violet",
  emerald: "text-emerald",
  rose: "text-rose",
  amber: "text-amber",
};

/**
 * @param {{icon?: React.ComponentType, title: React.ReactNode, info?: React.ReactNode,
 *          subtitle?: React.ReactNode, right?: React.ReactNode, tone?: string, id?: string,
 *          className?: string}} props
 */
export function PanelTitle({ icon: Icon, title, info, subtitle, right, tone = "cyan", id, className }) {
  return (
    <div className={cn("mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-2", className)}>
      <div className="min-w-0">
        <h3 id={id} className="flex items-center gap-2 font-display text-sm font-semibold tracking-wide text-ink-strong">
          {Icon ? <Icon aria-hidden="true" className={cn("size-4 shrink-0", ICON_TONE[tone] ?? ICON_TONE.cyan)} /> : null}
          {title}
          {info ? <InfoTip content={info} label={`About: ${typeof title === "string" ? title : "this panel"}`} /> : null}
        </h3>
        {subtitle ? <p className="mt-0.5 text-[11px] leading-snug text-ink-faint">{subtitle}</p> : null}
      </div>
      {right ? <div className="flex flex-wrap items-center gap-2">{right}</div> : null}
    </div>
  );
}
