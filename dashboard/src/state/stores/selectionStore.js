/**
 * selectionStore (UI_SPEC §7): hover / pin / district / zone / brush selection.
 *
 * Shape (binding): { hoverIndex, pinnedIndex, districtId, zoneId, brushMask (Uint8Array|null) }
 *
 * Indices are positions in the canonical cell order (SPEC §1.1), identical for every cube, XAI
 * frame and the v1 facade's epochs, so a pinned cell survives year, mode and scenario changes.
 * `brushMask` (1 = selected) comes from the Drivers dependence brush and dims other cells.
 */

import { create } from "zustand";

const isIndex = (v) => v === null || (Number.isInteger(v) && v >= 0);

function initialSelectionState() {
  return { hoverIndex: null, pinnedIndex: null, districtId: null, zoneId: null, brushMask: null };
}

export function selectionStoreInitializer(set, get) {
  return {
    ...initialSelectionState(),
    setHover(index) {
      const i = index === undefined ? null : index;
      if (!isIndex(i)) return false;
      if (get().hoverIndex !== i) set({ hoverIndex: i });
      return true;
    },
    pin(index) {
      const i = index === undefined ? null : index;
      if (!isIndex(i)) return false;
      set({ pinnedIndex: i });
      return true;
    },
    unpin: () => set({ pinnedIndex: null }),
    togglePin(index) {
      if (!isIndex(index)) return false;
      set({ pinnedIndex: get().pinnedIndex === index ? null : index });
      return true;
    },
    setDistrict(id) {
      if (id !== null && !(Number.isInteger(id) && id >= 0)) return false;
      set({ districtId: id });
      return true;
    },
    setZone(id) {
      if (id !== null && !(Number.isInteger(id) && id >= 0 && id <= 3)) return false;
      set({ zoneId: id });
      return true;
    },
    setBrushMask(mask) {
      if (mask !== null && !(mask instanceof Uint8Array)) return false;
      set({ brushMask: mask });
      return true;
    },
    clearBrush: () => set({ brushMask: null }),
    /** Everything off (Esc). */
    clear: () => set(initialSelectionState()),
  };
}

export const useSelectionStore = create(selectionStoreInitializer);
