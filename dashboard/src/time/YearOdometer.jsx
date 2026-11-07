/**
 * Year odometer (UI_SPEC_v2 §4.3 hero, §5.2 J): Space Grotesk 700, tabular, −0.04em, with a
 * per-digit roll — 420 ms expoOut, 30 ms right-to-left stagger, only changed digits move
 * (each digit is a 0–9 column translated by its value, so an unchanged digit has nothing to
 * animate). While scrubbing or playing the year updates at ≤ 10 Hz WITHOUT animation, and an
 * interpolated position reads "≈2032" in italic (principle 4: interpolated frames are not data).
 * Reduced / Off motion: digits jump.
 *
 * The rolling digits are aria-hidden; the accessible text is the plain year (with "about" when
 * interpolated).
 */
import { memo } from "react";
import { cn } from "../lib/cn.js";
import { useMotionLevel } from "../design/useMotionLevel.js";

const DIGITS = "0123456789";

function DigitColumn({ digit, index, count, animate }) {
  const d = DIGITS.indexOf(digit);
  if (d < 0) return <span>{digit}</span>;
  const delay = (count - 1 - index) * 30; // right-to-left stagger
  return (
    <span className="relative inline-block overflow-hidden align-top" style={{ height: "1em", width: "0.62em" }}>
      <span
        className="absolute inset-x-0 top-0 flex flex-col"
        style={{
          transform: `translateY(${-d}em)`,
          transition: animate ? `transform 420ms var(--ease-expo-out) ${delay}ms` : "none",
        }}
      >
        {DIGITS.split("").map((c) => (
          <span key={c} className="block text-center" style={{ height: "1em", lineHeight: "1em" }}>
            {c}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * @param {{value: number|null, approx?: boolean, moving?: boolean, size?: number, className?: string}} props
 *   `moving` = scrubbing/playing (no roll animation, 10 Hz updates by the caller)
 */
export const YearOdometer = memo(function YearOdometer({ value, approx = false, moving = false, size = 80, className }) {
  const level = useMotionLevel();
  const year = Number.isFinite(value) ? Math.round(value) : null;
  const text = year === null ? "––––" : String(year);
  const animate = level === "full" && !moving;
  return (
    <span
      className={cn("tnum inline-flex items-baseline font-display font-bold leading-none text-ink-strong", approx && "italic text-ink", className)}
      style={{ fontSize: size, letterSpacing: "-0.04em" }}
    >
      <span className="sr-only">{year === null ? "Year not set" : approx ? `about ${year}, interpolated` : String(year)}</span>
      <span aria-hidden="true" className="inline-flex items-baseline">
        {approx && <span className="mr-[0.04em] text-ink-muted" style={{ fontSize: "0.7em" }}>≈</span>}
        {text.split("").map((c, i) => (
          <DigitColumn key={i} digit={c} index={i} count={text.length} animate={animate} />
        ))}
      </span>
    </span>
  );
});

export default YearOdometer;
