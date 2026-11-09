"use client";
/**
 * Scroll reveal: children fade in and rise 14 px the first time they enter the viewport
 * (IntersectionObserver, 80 px early, once). The motion itself is CSS (transform + opacity,
 * ease-out, 600 ms) so it runs off the main thread; `delay` (ms) staggers siblings. Content is
 * only hidden after hydration (`data-reveal="armed"`), so it is always visible to crawlers and
 * no-JS readers, and reduced motion keeps a plain fade (index.css + the rules below).
 */
import { useEffect, useRef, useState } from "react";

export function Reveal({ as: Component = "div", delay = 0, className, children, ...props }) {
  const ref = useRef(null);
  const [state, setState] = useState("static");

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return undefined;
    // Already on screen at hydration (above the fold): leave it alone, no flash.
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.92) return undefined;
    setState("armed");
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setState("shown");
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -80px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Component ref={ref} data-reveal={state} style={delay ? { "--reveal-delay": `${delay}ms` } : undefined} className={className} {...props}>
      {children}
    </Component>
  );
}
