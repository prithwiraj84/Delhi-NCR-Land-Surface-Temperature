/**
 * The patterned evidence track of the ribbon (UI_SPEC_v2 §3.3 "TRACK 24"):
 *
 *   Observed          solid --surface-3
 *   Observed-sparse   fine dither
 *   Reconstructed     45° hatch
 *   Modelled          cross-dots
 *   Projected         dashed 4/4 outline plus fog
 *   (no data)         empty, dotted outline
 *
 * Tiers come from `frameTicks` (manifest), never from years. Patterns are drawn in ink tones
 * (not hue), so the track reads in greyscale and under forced colours; each tier also has its
 * glyph on the tick and a text label in the tier legend. Also draws the NOW rule, the hover
 * window bracket ("└89–92┘"), the compare bracket and the frame ticks.
 */
import { memo } from "react";
import { EpochTick } from "./EpochTick.jsx";
import { tickLabelled } from "./ribbonScale.js";

const PATTERN_TIERS = Object.freeze(["observed-sparse", "reconstructed", "modelled"]);

function patternId(prefix, tier) {
  return `${prefix}-tier-${tier}`;
}

/** SVG <defs> of the tier patterns (ids are prefixed per ribbon instance). */
function TierPatternDefs({ prefix }) {
  return (
    <defs>
      <pattern id={patternId(prefix, "observed-sparse")} width="3" height="3" patternUnits="userSpaceOnUse">
        <rect width="3" height="3" fill="var(--surface-3)" />
        <rect width="1" height="1" fill="var(--ink-muted)" fillOpacity="0.55" />
      </pattern>
      <pattern id={patternId(prefix, "reconstructed")} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill="var(--surface-2)" />
        <line x1="0" y1="0" x2="0" y2="6" stroke="var(--ink-muted)" strokeOpacity="0.6" strokeWidth="1.5" />
      </pattern>
      <pattern id={patternId(prefix, "modelled")} width="6" height="6" patternUnits="userSpaceOnUse">
        <rect width="6" height="6" fill="var(--surface-2)" />
        <path d="M3 1.5v3M1.5 3h3" stroke="var(--ink-muted)" strokeOpacity="0.6" strokeWidth="1" />
      </pattern>
    </defs>
  );
}

function Segment({ seg, y, h, prefix }) {
  const x = seg.x0 + 0.5;
  const w = Math.max(0, seg.x1 - seg.x0 - 1);
  if (!seg.available || !seg.tier) {
    return <rect x={x} y={y + 0.5} width={w} height={h - 1} rx={3} fill="none" stroke="var(--hairline-strong)" strokeDasharray="1 3" />;
  }
  if (seg.tier === "projected") {
    return (
      <g>
        <rect x={x} y={y} width={w} height={h} rx={3} fill="var(--fog)" />
        <rect x={x} y={y + 0.5} width={w} height={h - 1} rx={3} fill="none" stroke="var(--ink-faint)" strokeDasharray="4 4" />
      </g>
    );
  }
  const fill = PATTERN_TIERS.includes(seg.tier) ? `url(#${patternId(prefix, seg.tier)})` : "var(--surface-3)";
  return <rect x={x} y={y} width={w} height={h} rx={3} fill={fill} stroke="var(--hairline-strong)" strokeWidth={0.75} />;
}

/**
 * @param {{prefix:string, ticks:Array, segments:Array, scale:object, trackY:number, trackH:number,
 *          labelY:number|null, now:number|null, nowTop:number, currentYear:number|null,
 *          hoverYear:number|null, loadingYear?:number|null, labelStride:number,
 *          compare?: {a:number, b:number, live?: boolean}|null, compact?: boolean}} props
 */
export const RibbonTrack = memo(function RibbonTrack({ prefix, ticks, segments, scale, trackY, trackH, labelY, now, nowTop, currentYear, hoverYear, loadingYear = null, labelStride, compare = null, compact = false }) {
  const hoverTick = hoverYear !== null ? ticks.find((t) => t.year === hoverYear) : null;
  const nowX = Number.isFinite(now) && now >= scale.first && now <= scale.last ? scale.x(now) : null;
  return (
    <g data-testid="ribbon-track">
      <TierPatternDefs prefix={prefix} />
      {segments.map((seg) => (
        <Segment key={`${seg.years[0]}-${seg.tier}`} seg={seg} y={trackY} h={trackH} prefix={prefix} />
      ))}

      {/* Window bracket under the hovered tick: each frame is a multi-year Apr–Jun window. */}
      {hoverTick && hoverTick.window[0] !== hoverTick.window[1] && (
        <g aria-hidden="true">
          <path
            d={`M${hoverTick.wx0} ${trackY + trackH + 1}v3H${hoverTick.wx1}v-3`}
            fill="none"
            stroke="var(--ink-muted)"
            strokeWidth={1}
          />
        </g>
      )}

      {compare && compare.a !== null && compare.b !== null && (
        <g aria-hidden="true" data-testid="compare-bracket">
          <rect x={scale.x(compare.a)} y={trackY - 3} width={Math.max(1, scale.x(compare.b) - scale.x(compare.a))} height={trackH + 6} rx={4} fill="rgba(69, 224, 255, 0.08)" stroke="var(--signal)" strokeOpacity={compare.live ? 0.9 : 0.6} strokeDasharray={compare.live ? "3 2" : undefined} />
          {!compact && (
            <>
              <text x={scale.x(compare.a) + 3} y={trackY - 5} style={{ font: "600 11px var(--font-mono)", fill: "var(--signal)" }}>
                A
              </text>
              <text x={scale.x(compare.b) - 3} y={trackY - 5} textAnchor="end" style={{ font: "600 11px var(--font-mono)", fill: "var(--signal)" }}>
                B
              </text>
            </>
          )}
        </g>
      )}

      {ticks.map((t, i) => (
        <EpochTick
          key={t.year}
          x={t.x}
          trackY={trackY}
          trackH={trackH}
          labelY={labelY}
          year={t.year}
          tier={t.tier}
          available={t.available}
          labelled={labelY !== null && tickLabelled(ticks, i, labelStride, now)}
          state={t.year === loadingYear ? "loading" : t.year === currentYear ? "current" : t.year === hoverYear ? "hover" : "default"}
          glyphSize={compact ? 9 : 10}
        />
      ))}

      {nowX !== null && (
        <line x1={nowX} x2={nowX} y1={nowTop} y2={trackY + trackH + 2} stroke="var(--signal)" strokeOpacity={0.8} strokeWidth={1} strokeDasharray="3 3" aria-hidden="true" data-testid="now-rule" />
      )}
    </g>
  );
});
