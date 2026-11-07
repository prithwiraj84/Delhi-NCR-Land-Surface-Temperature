/**
 * Focus management for modal surfaces (UI_SPEC §12 "drawers trap focus"):
 *   - on activation, remembers the previously focused element and focuses `initialFocus`
 *     (or the first focusable element inside the container);
 *   - Tab / Shift+Tab cycle inside the container;
 *   - on deactivation, focus returns to the element that had it before.
 */
import { useEffect } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Focusable, visible descendants of `root` in DOM order. */
export function focusableWithin(root) {
  if (!root) return [];
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.hasAttribute("inert") && el.getAttribute("aria-hidden") !== "true");
}

/**
 * @param {React.RefObject<HTMLElement>} containerRef
 * @param {boolean} active
 * @param {{initialFocus?: React.RefObject<HTMLElement>}} [options]
 */
export function useFocusTrap(containerRef, active, { initialFocus } = {}) {
  useEffect(() => {
    if (!active) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;
    const previous = document.activeElement;
    const first = initialFocus?.current ?? focusableWithin(container)[0] ?? container;
    // Defer one frame so enter animations / portals have attached the node.
    const raf = requestAnimationFrame(() => first?.focus?.({ preventScroll: true }));

    const onKeyDown = (event) => {
      if (event.key !== "Tab") return;
      const items = focusableWithin(container);
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const head = items[0];
      const tail = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === head || !container.contains(document.activeElement))) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && (document.activeElement === tail || !container.contains(document.activeElement))) {
        event.preventDefault();
        head.focus();
      }
    };
    container.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      container.removeEventListener("keydown", onKeyDown);
      if (previous && typeof previous.focus === "function" && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [active, containerRef, initialFocus]);
}
