/**
 * SSP chips (UI_SPEC_v2 §3.3, §4.1): one radio chip per manifest scenario, each with its
 * strand swatch (colour + dash + weight) and label — colour is never the only cue. Roving
 * tabindex via components/ui/Segmented. Used where a visible scenario choice is wanted next
 * to a chart or map (Control mobile header, compare chips); the compact select is
 * ScenarioPicker.
 */
import { SspStrand } from "../design/glyphs.jsx";
import { ssp as SSP_STYLE } from "../design/tokens.js";
import { fmtSsp } from "../lib/format.js";
import { Segmented } from "../components/ui/Segmented.jsx";
import { useTimeStore } from "../state/stores/timeStore.js";
import { announce } from "../shell/announcer.js";

/**
 * @param {{options: Array<{id:string, label?:string}>, value?: string|null, onChange?: (id:string)=>void,
 *          size?: "sm"|"md"|"touch", ariaLabel?: string, layoutId?: string, className?: string}} props
 */
export function SspChips({ options = [], value, onChange, size = "sm", ariaLabel = "Climate scenario", layoutId = "ssp-chips", className }) {
  const storeSsp = useTimeStore((s) => s.ssp ?? null);
  const current = value === undefined ? storeSsp : value;
  if (!options.length) {
    return <p className="font-mono text-[11px] text-ink-faint">No projections in this bundle — rerun notebook v2</p>;
  }
  const items = options.map((o) => {
    const style = SSP_STYLE[o.id];
    return {
      value: o.id,
      label: o.label ?? fmtSsp(o.id),
      icon: style ? <SspStrand color={style.color} dash={style.dash} weight={style.width} width={16} height={8} /> : null,
      title: o.n_gcm ? `${o.label ?? fmtSsp(o.id)} · ${o.n_gcm} GCMs${o.method === "pattern-scaled" ? " · pattern-scaled from SSP2-4.5" : ""}` : undefined,
    };
  });
  const change = (id) => {
    if (onChange) onChange(id);
    else if (useTimeStore.getState().setSsp?.(id) !== false) announce(`Scenario ${fmtSsp(id)}`);
  };
  return <Segmented ariaLabel={ariaLabel} layoutId={layoutId} value={current} options={items} size={size} onChange={change} className={className} accent={(v) => SSP_STYLE[v]?.color} />;
}

export default SspChips;
