/**
 * Shell-local UI state: which modal surface is open (palette, shortcut sheet, settings, the
 * mobile "More" menu) and the boot overlay state. Not part of the shareable URL state.
 * Only one modal surface is open at a time; opening one closes the others.
 */
import { create } from "zustand";

export const OVERLAYS = Object.freeze(["palette", "shortcuts", "settings", "more"]);

export const useShellUi = create((set, get) => ({
  overlay: null,
  bootDone: false,
  open: (overlay) => set({ overlay: OVERLAYS.includes(overlay) ? overlay : null }),
  toggle: (overlay) => set({ overlay: get().overlay === overlay ? null : overlay }),
  /** Close the open overlay; returns true when something was closed (Esc handling). */
  close: () => {
    if (!get().overlay) return false;
    set({ overlay: null });
    return true;
  },
  setBootDone: (bootDone) => set({ bootDone: Boolean(bootDone) }),
}));
