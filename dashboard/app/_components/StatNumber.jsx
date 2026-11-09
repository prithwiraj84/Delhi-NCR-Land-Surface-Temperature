"use client";
/**
 * A statistic that counts up (NumberFlow) the first time it scrolls into view. The server
 * renders the final, formatted value, so crawlers and no-JS readers always see the real
 * number; only a below-the-fold stat is reset to 0 after hydration and then animated in.
 * Reduced motion: no count, the final value stays.
 */
import NumberFlow from "@number-flow/react";
import { useEffect, useRef, useState } from "react";

export function StatNumber({ value, format = {}, prefix = "", suffix = "", locales = "en-US", className }) {
  const ref = useRef(null);
  const [mode, setMode] = useState("static");
  const [shown, setShown] = useState(value);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return undefined;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return undefined;
    // Count up only when the stat starts fully below the fold; a partly visible one keeps its value.
    if (el.getBoundingClientRect().top < window.innerHeight) return undefined;
    setMode("flow");
    setShown(0);
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(value);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -60px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [value]);

  const text = `${prefix}${new Intl.NumberFormat(locales, format).format(value)}${suffix}`;
  return (
    <span ref={ref} className={className}>
      {mode === "static" ? (
        text
      ) : (
        <>
          {/* Screen readers get the final value once; the rolling digits are decoration. */}
          <span className="sr-only">{text}</span>
          <NumberFlow value={shown} format={format} locales={locales} prefix={prefix} suffix={suffix} transformTiming={{ duration: 900, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }} aria-hidden="true" />
        </>
      )}
    </span>
  );
}
