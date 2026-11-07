/**
 * Keyboard shortcut sheet (`?`), UI_SPEC §2.3. Modal dialog with a focus trap; Esc, the
 * close button or a backdrop click closes it and focus returns to where it was.
 * Content comes from keyboard.js SHORTCUTS, so the sheet can never drift from the handler.
 */
import { useMemo, useRef } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "./useFocusTrap.js";
import { SHORTCUTS } from "./keyboard.js";
import { useShellUi } from "./uiStore.js";

export function ShortcutSheet() {
  const open = useShellUi((s) => s.overlay === "shortcuts");
  const close = useShellUi((s) => s.close);
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  useFocusTrap(panelRef, open, { initialFocus: closeRef });

  const groups = useMemo(() => {
    const map = new Map();
    for (const s of SHORTCUTS) {
      if (!map.has(s.group)) map.set(s.group, []);
      map.get(s.group).push(s);
    }
    return [...map.entries()];
  }, []);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-palette grid place-items-center bg-void/70 p-4" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-sheet-title"
        className="glass-strong hud scrollbar-thin max-h-[85dvh] w-full max-w-3xl overflow-y-auto rounded-panel p-5"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="shortcut-sheet-title" className="font-display text-base font-semibold text-ink-strong">
            Keyboard shortcuts
          </h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close keyboard shortcuts"
            onClick={close}
            className="focus-ring grid size-8 place-items-center rounded-md text-ink-muted hover:text-ink"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
        <p className="mb-4 text-xs text-ink-muted">
          Shortcuts are ignored while typing. When the time ribbon has focus, the arrow, Home/End and Page keys move the playhead.
        </p>
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {groups.map(([group, items]) => (
            <section key={group} aria-labelledby={`shortcut-group-${group}`}>
              <h3 id={`shortcut-group-${group}`} className="micro-label mb-2">
                {group}
              </h3>
              <dl className="space-y-1.5">
                {items.map((s) => (
                  <div key={s.label} className="flex items-start justify-between gap-3 text-[13px]">
                    <dt className="text-ink">{s.label}</dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {s.keys.map((k, i) =>
                        k === "–" ? (
                          <span key={i} aria-hidden="true" className="text-ink-faint">
                            –
                          </span>
                        ) : (
                          <kbd key={i} className="inline-flex min-w-6 items-center justify-center rounded border border-control bg-surface-3 px-1.5 font-mono text-[11px] text-ink">
                            {k}
                          </kbd>
                        ),
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export default ShortcutSheet;
