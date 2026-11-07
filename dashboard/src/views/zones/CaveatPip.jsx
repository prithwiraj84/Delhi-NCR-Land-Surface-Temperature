/**
 * CaveatPip (UI_SPEC §3.7 "caveat prose becomes pips that open the drawer"): a small
 * labelled button next to the value it qualifies. It opens a popover with the exported
 * caveat sentences of the given topic(s) and a link to their anchors on the Sources route
 * (`#/sources#caveat-<id>`). Keyboard: Enter/Space opens, Esc closes and returns focus.
 */
import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, ArrowRight } from "lucide-react";
import { useViewStore } from "../../state/stores/viewStore.js";
import { scrollToAnchor } from "../../shell/actions.js";
import { cn } from "../../lib/cn.js";
import { caveatAnchor } from "../sources/caveats.js";

/**
 * @param {{caveats: Array<{id: string, text: string}>, label?: string, className?: string}} props
 */
export function CaveatPip({ caveats = [], label = "Caveats", className }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const box = useRef(null);
  const id = useId().replace(/:/g, "");

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        btn.current?.focus();
      }
    };
    const onDown = (e) => {
      if (!box.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  if (!caveats.length) return null;
  const go = (cid) => {
    setOpen(false);
    useViewStore.getState().setRoute?.("sources");
    scrollToAnchor(typeof window !== "undefined" ? window : null, caveatAnchor(cid));
  };

  return (
    <span className={cn("relative inline-flex", className)}>
      <button
        ref={btn}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="focus-ring inline-flex h-6 items-center gap-1 rounded-full border border-warn/45 bg-warn/10 px-1.5 text-[11px] text-ink"
      >
        <AlertCircle aria-hidden="true" className="size-3.5 text-warn" />
        {label}
        <span className="font-mono text-ink-muted">{caveats.length}</span>
      </button>
      {open && (
        <div ref={box} id={id} role="dialog" aria-label={label} className="absolute left-0 top-7 z-overlay w-[min(22rem,80vw)] space-y-2 rounded-md border border-hairline-strong bg-surface-2 p-3 text-xs text-ink shadow-panel">
          <ul className="space-y-1.5">
            {caveats.map((c) => (
              <li key={c.id} className="leading-snug text-ink-muted">
                {c.text}
                <button type="button" onClick={() => go(c.id)} className="focus-ring ml-1 inline-flex items-center gap-0.5 rounded text-signal hover:underline">
                  Sources <ArrowRight aria-hidden="true" className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}

export default CaveatPip;
