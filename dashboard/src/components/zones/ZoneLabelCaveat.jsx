/**
 * Zone label caveat (D11): a small keyboard-reachable warning pip next to a zone's display name.
 * The notebook exports `label_caveat` when the SPEC zone rule names a cluster ("Riparian Buffer")
 * that shows no matching signature in the data; the pip makes that visible wherever the zone name
 * appears. Hover or focus shows the full caveat; the button's accessible name carries it too, so
 * screen readers and keyboard users reach the same text. Renders nothing without a caveat.
 */
import { AlertCircle } from "lucide-react";
import { InfoTip } from "../ui/InfoTip.jsx";
import { cn } from "../../lib/cn.js";

/**
 * @param {{caveat: string|null|undefined, name?: string, className?: string}} props
 */
export function ZoneLabelCaveat({ caveat, name = "zone", className }) {
  if (typeof caveat !== "string" || !caveat) return null;
  return (
    <InfoTip content={caveat}>
      <button
        type="button"
        aria-label={`Label caveat for ${name}: ${caveat}`}
        data-testid="zone-label-caveat"
        className={cn("focus-ring inline-flex size-5 shrink-0 items-center justify-center rounded-full text-warn hover:bg-warn/10", className)}
      >
        <AlertCircle aria-hidden="true" className="size-3.5" />
      </button>
    </InfoTip>
  );
}

export default ZoneLabelCaveat;
