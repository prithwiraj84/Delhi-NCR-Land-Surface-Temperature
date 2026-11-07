/**
 * Toast queue (rendered by ToastHost.jsx). Any stream can raise a toast:
 *
 *   import { showToast } from "../shell/toasts.js";
 *   showToast({ id: "now-crossing", title: "Entering projections",
 *               body: "Model + CMIP6 scenario, not observations", tone: "info",
 *               duration: 4000, oncePerSession: true });
 *
 * - `id` de-duplicates (re-raising an id replaces it); `oncePerSession` remembers the id in
 *   sessionStorage (inside try/catch: private windows may throw) and drops repeats.
 * - `tone`: "info" | "ok" | "warn" | "crit" (status colours + an icon, never colour alone).
 * - `action`: optional {label, onClick} button (e.g. PerfChip-style "Undo").
 * - At most MAX_TOASTS are visible; the oldest is dropped first.
 */
import { create } from "zustand";

export const MAX_TOASTS = 3;
export const DEFAULT_TOAST_MS = 4000;
const SESSION_KEY = "ncr-ops.toasts-shown";

let counter = 0;

function readShown() {
  try {
    const raw = globalThis.sessionStorage?.getItem(SESSION_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

function rememberShown(id) {
  try {
    const shown = readShown();
    shown.add(id);
    globalThis.sessionStorage?.setItem(SESSION_KEY, JSON.stringify([...shown]));
  } catch {
    // storage unavailable: the toast may repeat in this session, which is harmless
  }
}

export const useToastStore = create((set) => ({
  toasts: [],
  push: (toast) =>
    set((state) => {
      const rest = state.toasts.filter((t) => t.id !== toast.id);
      return { toasts: [...rest, toast].slice(-MAX_TOASTS) };
    }),
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/**
 * Raise a toast. Returns its id, or null when suppressed (oncePerSession repeat / no text).
 * @param {{id?: string, title: string, body?: string, tone?: "info"|"ok"|"warn"|"crit",
 *          duration?: number, oncePerSession?: boolean, action?: {label: string, onClick: Function}}} toast
 */
export function showToast({ id, title, body = "", tone = "info", duration = DEFAULT_TOAST_MS, oncePerSession = false, action = null } = {}) {
  if (!title && !body) return null;
  const toastId = id ?? `toast-${(counter += 1)}`;
  if (oncePerSession) {
    if (readShown().has(toastId)) return null;
    rememberShown(toastId);
  }
  useToastStore.getState().push({ id: toastId, title: title ?? "", body, tone, duration, action, createdAt: Date.now() });
  return toastId;
}

/** Remove a toast by id. */
export function dismissToast(id) {
  useToastStore.getState().dismiss(id);
}
