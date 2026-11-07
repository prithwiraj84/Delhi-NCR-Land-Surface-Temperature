/**
 * Command palette (Ctrl/⌘ K), UI_SPEC §2.4. A hand-rolled ARIA 1.2 combobox + listbox
 * (no cmdk): the input keeps focus, ↑/↓ move the active option (aria-activedescendant),
 * Enter runs it, Esc closes, Home/End jump. Results are grouped (Years, Districts, Cells,
 * Layers, Views, Commands); the model lives in paletteModel.js.
 * Modal: focus is trapped while open and returns to the previously focused element.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import { cn } from "../lib/cn.js";
import { runAction } from "./actions.js";
import { announce } from "./announcer.js";
import { useBundleMeta } from "./bundleMeta.js";
import { useViewStore } from "./deps.js";
import { buildPaletteItems, GROUP_ORDER, searchPalette } from "./paletteModel.js";
import { showToast } from "./toasts.js";
import { useFocusTrap } from "./useFocusTrap.js";
import { STORES } from "./useShellEffects.js";
import { useShellUi } from "./uiStore.js";

export function CommandPalette() {
  const open = useShellUi((s) => s.overlay === "palette");
  const close = useShellUi((s) => s.close);
  if (!open) return null;
  return <PaletteDialog onClose={close} />;
}

function PaletteDialog({ onClose }) {
  const meta = useBundleMeta();
  const motionPref = useViewStore((s) => s.motionPref ?? "system");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const panelRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  useFocusTrap(panelRef, true, { initialFocus: inputRef });

  const items = useMemo(
    () =>
      buildPaletteItems({
        districts: meta.districts,
        features: meta.features,
        groups: meta.groups,
        scenarios: meta.scenarios,
        years: meta.years,
        motionPref,
      }),
    [meta.districts, meta.features, meta.groups, meta.scenarios, meta.years, motionPref],
  );
  const results = useMemo(() => searchPalette(items, query, { years: meta.years }), [items, query, meta.years]);
  const activeIndex = results.length ? Math.min(active, results.length - 1) : -1;
  const activeId = activeIndex >= 0 ? `palette-opt-${activeIndex}` : undefined;

  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current?.querySelector(`#palette-opt-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const run = (item) => {
    if (!item) return;
    onClose();
    runAction(item.action, {
      stores: STORES,
      availableModes: meta.availableModes,
      years: meta.years,
      announce,
      toast: showToast,
      ui: {
        openPalette: () => useShellUi.getState().open("palette"),
        openShortcuts: () => useShellUi.getState().open("shortcuts"),
        closeOverlay: () => useShellUi.getState().close(),
      },
    });
    announce(item.label.replace(/^Go to /, ""));
  };

  const onKeyDown = (event) => {
    const n = results.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (n) setActive((activeIndex + 1) % n);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (n) setActive((activeIndex - 1 + n) % n);
    } else if (event.key === "Home" && event.ctrlKey) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && event.ctrlKey) {
      event.preventDefault();
      setActive(Math.max(0, n - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(results[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  // Group results while keeping one flat index for aria-activedescendant.
  const grouped = useMemo(() => {
    const out = [];
    results.forEach((item, index) => {
      const last = out.at(-1);
      if (!last || last.group !== item.group) out.push({ group: item.group, entries: [{ item, index }] });
      else last.entries.push({ item, index });
    });
    return out.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  }, [results]);

  return (
    <div className="fixed inset-0 z-palette flex items-start justify-center bg-void/70 px-4 pt-[12vh]" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Command palette" className="glass-strong hud w-full max-w-xl overflow-hidden rounded-panel">
        <div className="flex items-center gap-2 border-b border-hairline px-3">
          <Search aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-listbox"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label="Search districts, cells, years, layers and commands"
            placeholder="District, cell #id, year (2045 night ssp585), layer, command…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
            className="h-12 min-w-0 flex-1 bg-transparent text-sm text-ink-strong placeholder:text-ink-faint focus:outline-none"
          />
          <kbd className="hidden rounded border border-control px-1.5 font-mono text-[11px] text-ink-muted sm:inline">Esc</kbd>
        </div>
        <div ref={listRef} id="palette-listbox" role="listbox" aria-label="Results" className="scrollbar-thin max-h-[min(60dvh,26rem)] overflow-y-auto p-1.5">
          {grouped.length === 0 && (
            <p role="presentation" className="px-3 py-6 text-center text-sm text-ink-muted">
              No match. Try a district name, a year such as “2040 night”, or “#48211”.
            </p>
          )}
          {grouped.map(({ group, entries }) => (
            <div key={group} role="group" aria-labelledby={`palette-group-${group}`} className="mb-1">
              <div id={`palette-group-${group}`} role="presentation" className="micro-label px-2.5 pb-1 pt-2">
                {group}
              </div>
              {entries.map(({ item, index }) => {
                const selected = index === activeIndex;
                return (
                  <div
                    key={item.id}
                    id={`palette-opt-${index}`}
                    role="option"
                    aria-selected={selected}
                    onPointerMove={() => activeIndex !== index && setActive(index)}
                    onClick={() => run(item)}
                    className={cn(
                      "relative flex min-h-9 cursor-pointer items-center gap-3 rounded-md px-2.5 py-1.5 text-sm",
                      selected ? "bg-surface-3 text-ink-strong" : "text-ink",
                    )}
                  >
                    <span aria-hidden="true" className={cn("absolute inset-y-1.5 left-0 w-0.5 rounded-full", selected ? "bg-signal" : "bg-transparent")} />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.hint && <span className="hidden max-w-[45%] truncate text-xs text-ink-muted sm:inline">{item.hint}</span>}
                    {selected && <CornerDownLeft aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default CommandPalette;
