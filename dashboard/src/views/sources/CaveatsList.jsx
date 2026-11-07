/**
 * CAVEATS (UI_SPEC §3.9 "caveats, grouped with anchors #/sources#caveat-<id>"): every caveat
 * the notebook exported (and the ones that follow from the bundle itself, e.g. v1 mode),
 * grouped by topic. Each item is an anchor target that CaveatPips elsewhere link to; when the
 * page is opened on an anchor the item is highlighted and focused (shell scrollToAnchor).
 */
import { useEffect, useState } from "react";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { cn } from "../../lib/cn.js";
import { scrollToAnchor } from "../../shell/actions.js";
import { CAVEAT_GROUPS, caveatAnchor } from "./caveats.js";

export function CaveatsList({ caveats }) {
  const [target, setTarget] = useState(() => (typeof location !== "undefined" ? (location.hash.split("#")[2] ?? null) : null));
  useEffect(() => {
    const onAnchor = (e) => setTarget(e.detail?.id ?? null);
    window.addEventListener("ncr:anchor", onAnchor);
    return () => window.removeEventListener("ncr:anchor", onAnchor);
  }, []);
  const groups = CAVEAT_GROUPS.map((g) => ({ ...g, items: caveats.filter((c) => c.group === g.id) })).filter((g) => g.items.length);
  return (
    <HudFrame solid title={`Caveats · ${caveats.length}`} id="caveats" className="min-w-0" tabIndex={-1}>
      {!groups.length ? (
        <p className="text-xs text-ink-muted">This bundle carries no caveat notes.</p>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <section key={g.id} aria-labelledby={`caveat-group-${g.id}`}>
              <h3 id={`caveat-group-${g.id}`} className="font-display text-sm font-semibold text-ink-strong">
                {g.label}
              </h3>
              <ul className="mt-1 space-y-1">
                {g.items.map((c) => (
                  <li key={c.id} id={caveatAnchor(c.id)} tabIndex={-1} className={cn("rounded-md border px-2.5 py-1.5 text-xs leading-relaxed text-ink-muted outline-none", target === caveatAnchor(c.id) ? "border-signal/60 bg-signal/10 text-ink" : "border-transparent")}>
                    {c.text}
                    {c.source === "dashboard" && <span className="ml-1 text-[10.5px] text-ink-faint">(dashboard note)</span>}
                    <a
                      href={`#/sources#${caveatAnchor(c.id)}`}
                      onClick={(e) => {
                        // Scroll in place: a bare hash link would drop the view params from the URL.
                        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                        e.preventDefault();
                        scrollToAnchor(window, caveatAnchor(c.id), { attempts: 1, intervalMs: 0 });
                      }}
                      className="focus-ring ml-1.5 rounded text-[10.5px] text-ink-faint hover:text-signal"
                      aria-label="Link to this caveat"
                    >
                      #
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </HudFrame>
  );
}

export default CaveatsList;
