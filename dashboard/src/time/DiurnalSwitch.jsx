/**
 * Day | Night | DTR switch (UI_SPEC_v2 §3.3, §8 `DiurnalSwitch`): a radio group with roving
 * focus (components/ui/Segmented). Unavailable modes stay visible with their reason (e.g.
 * "Night unavailable in v1 bundle — rerun notebook v2"). When the night tier of the current
 * year is `modelled` (no satellite night LST before 2003) the Night option carries the ◇
 * "modelled" mark — from the manifest tier, never from the year.
 *
 * Controlled when `value`/`onChange` are passed; otherwise bound to timeStore.mode.
 */
import { SunMoonGlyph, TierShape } from "../design/glyphs.jsx";
import { color } from "../design/tokens.js";
import { Segmented } from "../components/ui/Segmented.jsx";
import { useTimeStore } from "../state/stores/timeStore.js";
import { announce } from "../shell/announcer.js";

const ACCENT = { day: color.solar, night: color.lunar, dtr: color.lunar };
const LABEL = { day: "Day", night: "Night", dtr: "DTR" };
const TITLE = { day: "Day · ~10:30 IST", night: "Night · ~01:30 IST", dtr: "Diurnal temperature range (day − night)" };

/**
 * @param {{value?: string, onChange?: (mode:string)=>void, available?: {day?:boolean, night?:boolean, dtr?:boolean},
 *          reasons?: {day?:string, night?:string, dtr?:string}, nightTier?: string|null,
 *          size?: "sm"|"md"|"touch", compact?: boolean, layoutId?: string, className?: string}} props
 */
export function DiurnalSwitch({ value, onChange, available = { day: true, night: true, dtr: true }, reasons = {}, nightTier = null, size = "sm", compact = false, layoutId = "ribbon-mode", className }) {
  const storeMode = useTimeStore((s) => s.mode ?? "day");
  const mode = value ?? storeMode;
  const modelledNight = nightTier === "modelled";
  const options = ["day", "night", "dtr"].map((m) => ({
    value: m,
    label: (
      <>
        {LABEL[m]}
        {m === "night" && modelledNight && (
          <span className="inline-flex items-center gap-0.5 text-ink-muted">
            <TierShape tier="modelled" size={9} />
            {!compact && <span className="text-[11px]">modelled</span>}
          </span>
        )}
      </>
    ),
    icon: m === "dtr" || compact ? null : <SunMoonGlyph night={m === "night"} size={13} />,
    disabled: available[m] === false,
    reason: available[m] === false ? reasons[m] ?? `${LABEL[m]} is unavailable in this bundle` : undefined,
    title: m === "night" && modelledNight ? `${TITLE.night} — modelled (no satellite night LST for this frame)` : TITLE[m],
  }));
  const change = (m) => {
    if (onChange) {
      onChange(m);
      return;
    }
    if (useTimeStore.getState().setMode?.(m) !== false) announce(m === "dtr" ? "Diurnal range" : LABEL[m]);
  };
  return <Segmented ariaLabel="Day, night or diurnal range" layoutId={layoutId} value={mode} options={options} size={size} accent={(v) => ACCENT[v]} onChange={change} className={className} />;
}

export default DiurnalSwitch;
