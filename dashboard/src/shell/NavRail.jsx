/**
 * Route navigation (UI_SPEC §2.1).
 *
 *   <NavRail orientation="vertical" />  64 px rail (>= 640 px): icon + label, keys 1-6
 *   <NavRail orientation="mobile" />    bottom tab bar (< 640 px): Control, Timeline, Drivers,
 *                                       Zones, More (Model Lab, Sources) + safe-area inset
 *
 * One tab stop (roving tabindex); arrow keys move focus, Enter/Space (native button) selects,
 * Home/End jump. The current route has aria-current="page", a raised pill and a 2 px brand
 * gradient bar (no glow). A home link to the site sits at the foot of the rail.
 * Targets are >= 44 px on the mobile bar.
 */
import { useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { House, MoreHorizontal } from "lucide-react";
import { appEnv } from "../lib/env.js";
import { transition } from "../design/motion.js";
import { useMotionLevel } from "../design/useMotionLevel.js";
import { cn } from "../lib/cn.js";
import { setStoreField, useViewStore } from "./deps.js";
import { MOBILE_MORE, MOBILE_PRIMARY, ROUTE_BY_ID, ROUTES } from "./routes.js";
import { useShellUi } from "./uiStore.js";

function useRovingKeys(count, refs, vertical) {
  return (event, index) => {
    const keys = vertical ? { ArrowDown: 1, ArrowUp: -1 } : { ArrowRight: 1, ArrowLeft: -1 };
    let next = keys[event.key] !== undefined ? (index + keys[event.key] + count) % count : null;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = count - 1;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    refs.current[next]?.focus();
  };
}

function goTo(routeId) {
  setStoreField(useViewStore, "route", routeId);
}

function VerticalRail({ route }) {
  const refs = useRef([]);
  const onKeyDown = useRovingKeys(ROUTES.length, refs, true);
  const activeIndex = Math.max(
    0,
    ROUTES.findIndex((r) => r.id === route),
  );
  return (
    <nav aria-label="Views" className="hidden w-16 shrink-0 flex-col items-stretch gap-1 border-r border-hairline bg-bg/90 py-2.5 sm:flex">
      {ROUTES.map((item, i) => {
        const Icon = item.icon;
        const active = item.id === route;
        return (
          <button
            key={item.id}
            ref={(el) => (refs.current[i] = el)}
            type="button"
            aria-current={active ? "page" : undefined}
            aria-keyshortcuts={item.key}
            tabIndex={i === activeIndex ? 0 : -1}
            title={`${item.label} — ${item.description} (key ${item.key})`}
            onClick={() => goTo(item.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "focus-ring group relative mx-1.5 flex min-h-[54px] flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium leading-tight transition-[background-color,color] duration-quick",
              active ? "bg-white/[0.06] text-ink-strong shadow-[inset_0_0_0_1px_rgba(226,232,255,0.08)]" : "text-ink-faint hover:bg-white/[0.03] hover:text-ink",
            )}
          >
            <span aria-hidden="true" className={cn("absolute inset-y-3 -left-1.5 w-[3px] rounded-full", active ? "bg-[image:var(--brand-gradient)]" : "bg-transparent")} />
            <Icon aria-hidden="true" className="size-[19px]" strokeWidth={1.6} />
            <span>{item.short}</span>
          </button>
        );
      })}
      <a
        href={appEnv.BASE_URL}
        title="Back to the Heat Atlas home page"
        className="focus-ring mx-1.5 mt-auto flex min-h-[48px] flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium text-ink-faint transition-colors duration-quick hover:bg-white/[0.03] hover:text-ink"
      >
        <House aria-hidden="true" className="size-[18px]" strokeWidth={1.6} />
        <span>Home</span>
      </a>
    </nav>
  );
}

function MobileBar({ route }) {
  const refs = useRef([]);
  const overlay = useShellUi((s) => s.overlay);
  const toggle = useShellUi((s) => s.toggle);
  const close = useShellUi((s) => s.close);
  const level = useMotionLevel();
  const items = [...MOBILE_PRIMARY.map((id) => ROUTE_BY_ID[id]), { id: "more", label: "More", short: "More", icon: MoreHorizontal }];
  const onKeyDown = useRovingKeys(items.length, refs, false);
  const moreActive = MOBILE_MORE.includes(route);
  const activeIndex = moreActive ? items.length - 1 : Math.max(0, MOBILE_PRIMARY.indexOf(route));
  const moreOpen = overlay === "more";

  return (
    <nav aria-label="Views" className="relative z-chrome border-t border-hairline bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl sm:hidden">
      <AnimatePresence>
        {moreOpen && (
          <motion.ul
            id="nav-more-menu"
            initial={level === "off" ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0, transition: transition("quick") }}
            exit={{ opacity: 0, transition: transition("exit", { scale: 0.6 }) }}
            className="glass-strong absolute bottom-full right-2 mb-2 w-48 rounded-panel p-1"
          >
            {MOBILE_MORE.map((id) => {
              const r = ROUTE_BY_ID[id];
              const Icon = r.icon;
              return (
                <li key={id}>
                  <button
                    type="button"
                    aria-current={route === id ? "page" : undefined}
                    onClick={() => {
                      goTo(id);
                      close();
                    }}
                    className={cn(
                      "focus-ring flex h-11 w-full items-center gap-2.5 rounded-md px-3 text-sm",
                      route === id ? "bg-surface-3 text-ink-strong" : "text-ink-muted hover:text-ink",
                    )}
                  >
                    <Icon aria-hidden="true" className="size-4" strokeWidth={1.5} />
                    {r.label}
                  </button>
                </li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
      <div className="flex h-14">
        {items.map((item, i) => {
          const Icon = item.icon;
          const isMore = item.id === "more";
          const active = isMore ? moreActive : item.id === route;
          return (
            <button
              key={item.id}
              ref={(el) => (refs.current[i] = el)}
              type="button"
              aria-current={!isMore && active ? "page" : undefined}
              aria-expanded={isMore ? moreOpen : undefined}
              aria-controls={isMore && moreOpen ? "nav-more-menu" : undefined}
              aria-haspopup={isMore ? "true" : undefined}
              tabIndex={i === activeIndex ? 0 : -1}
              onClick={() => (isMore ? toggle("more") : goTo(item.id))}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                "focus-ring relative flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
                active ? "text-ink-strong" : "text-ink-muted",
              )}
            >
              <span aria-hidden="true" className={cn("absolute inset-x-5 top-0 h-[3px] rounded-full", active ? "bg-[image:var(--brand-gradient)]" : "bg-transparent")} />
              <Icon aria-hidden="true" className="size-5" strokeWidth={1.5} />
              <span>{isMore && moreActive ? ROUTE_BY_ID[route].short : item.short}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/** @param {{orientation: "vertical"|"mobile"}} props */
export function NavRail({ orientation = "vertical" }) {
  const route = useViewStore((s) => s.route ?? "control");
  return orientation === "mobile" ? <MobileBar route={ROUTE_BY_ID[route] ? route : "control"} /> : <VerticalRail route={route} />;
}

export default NavRail;
