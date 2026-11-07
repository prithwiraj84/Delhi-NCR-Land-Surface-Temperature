/**
 * Toast stack (top-right, under the command bar). Toasts come from `showToast()` in
 * toasts.js. Each toast: status icon + title + body (never colour alone), optional action,
 * dismiss button. Auto-dismiss after `duration` ms; the timer pauses while the pointer or
 * focus is inside the toast and while the tab is hidden (WCAG 2.2.1 timing adjustable).
 * Entry: quick rise; exit <= 75 % of entry (motion law 2); none under Off.
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { transition } from "../design/motion.js";
import { useMotionLevel } from "../design/useMotionLevel.js";
import { cn } from "../lib/cn.js";
import { useToastStore } from "./toasts.js";

const TONES = {
  info: { icon: Info, bar: "bg-signal", iconClass: "text-signal", label: "Information" },
  ok: { icon: CircleCheck, bar: "bg-ok", iconClass: "text-ok", label: "Success" },
  warn: { icon: TriangleAlert, bar: "bg-warn", iconClass: "text-warn", label: "Warning" },
  crit: { icon: CircleAlert, bar: "bg-crit", iconClass: "text-crit", label: "Error" },
};

function ToastItem({ toast, onDismiss, level }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(toast.duration);
  const startedAt = useRef(0);
  const tone = TONES[toast.tone] ?? TONES.info;
  const Icon = tone.icon;

  useEffect(() => {
    if (!toast.duration || toast.duration === Infinity || paused) return undefined;
    startedAt.current = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(500, remaining.current - (Date.now() - startedAt.current));
    };
  }, [paused, toast.duration, toast.id, onDismiss]);

  useEffect(() => {
    const onVisibility = () => setPaused(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const variants =
    level === "off"
      ? { initial: false, animate: { opacity: 1 }, exit: { opacity: 0, transition: { duration: 0 } } }
      : level === "reduced"
        ? { initial: { opacity: 0 }, animate: { opacity: 1, transition: { duration: 0.12 } }, exit: { opacity: 0, transition: { duration: 0.09 } } }
        : {
            initial: { opacity: 0, y: -6 },
            animate: { opacity: 1, y: 0, transition: transition("quick") },
            exit: { opacity: 0, y: -4, transition: transition("exit", { scale: 0.6 }) },
          };

  return (
    <motion.li
      layout={level === "full" ? "position" : false}
      {...variants}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="glass-strong pointer-events-auto relative flex w-[min(22rem,calc(100vw-2rem))] gap-2.5 overflow-hidden rounded-panel py-2.5 pl-3.5 pr-2"
    >
      <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-0.5", tone.bar)} />
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", tone.iconClass)} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-ink-strong">
          <span className="sr-only">{tone.label}: </span>
          {toast.title}
        </p>
        {toast.body && <p className="mt-0.5 text-xs leading-snug text-ink-muted">{toast.body}</p>}
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action.onClick?.();
              onDismiss(toast.id);
            }}
            className="focus-ring mt-1.5 inline-flex h-6 items-center rounded px-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-signal hover:bg-signal/10"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
        className="focus-ring grid size-6 shrink-0 place-items-center rounded text-ink-faint hover:text-ink"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </motion.li>
  );
}

export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const level = useMotionLevel();
  return (
    <div role="status" aria-live="polite" aria-label="Notifications" className="pointer-events-none fixed right-4 top-[60px] z-toast">
      <ol className="flex flex-col items-end gap-2">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={dismiss} level={level} />
          ))}
        </AnimatePresence>
      </ol>
    </div>
  );
}

export default ToastHost;
