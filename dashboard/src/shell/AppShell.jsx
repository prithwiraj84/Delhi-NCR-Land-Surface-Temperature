/**
 * NCR THERMAL/OPS v2 application shell (UI_SPEC_v2 §1-§3, §5.2 I, §12).
 *
 *   ┌ CommandBar 52 ─────────────────────────────────────────────┐
 *   ├ DataModeBanner (synthetic bundles only; persistent, SPEC §5) ┤
 *   ├──┬──────────────────────────────────────────────────────────┤
 *   │NR│  <main>: persistent STAGE slot (ThermalStage, never        │
 *   │64│  unmounted except on mobile) + lazy ROUTE OUTLET           │
 *   ├──┴──────────────────────────────────────────────────────────┤
 *   └ mobile tab bar (< 640 px)                                   ┘
 *   overlays: CommandPalette · ShortcutSheet · ToastHost · LiveAnnouncer · BootSequence
 *
 * The stage behaves per route (routes.js `stage`): live (Control), dimmed 40 % + paused
 * (Timeline), docked right 40 % (Drivers), docked left 45 % (Zones), hidden (Lab, Sources),
 * unmounted behind non-Control routes on mobile. ThermalStage receives `layout`, `active`
 * (interactive + rendering) and `dimmed`; the engine pauses itself when not active.
 *
 * Contract for route views (E4/E5):
 *   - Control: MissionControl renders OVER the live stage inside a `pointer-events: none`
 *     layer; its panels must opt back in with `pointer-events-auto` so the map stays usable.
 *   - Other routes render in a scrollable region; they own their H1.
 * Missing modules (sibling streams not built yet) render a clearly marked placeholder, and
 * v1 views are mounted under the new nav when their v2 replacement is missing (M1).
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Boxes, Construction } from "lucide-react";
import { panelVariants } from "../design/motion.js";
import { useMotionLevel } from "../design/useMotionLevel.js";
import { cn } from "../lib/cn.js";
import { useData } from "../state/DataContext.jsx";
import { DataModeBanner } from "../components/common/DataModeBanner.jsx";
import { EmptyState, MissingBundleState } from "../components/common/EmptyState.jsx";
import { ErrorBoundary } from "../components/common/ErrorBoundary.jsx";
import { ErrorState } from "../components/common/ErrorState.jsx";
import { UNSUPPORTED_BROWSER_MESSAGE } from "../data/bundleStore.js";
import { ScanSkeleton } from "../components/ui/ScanSkeleton.jsx";
import { announce } from "./announcer.js";
import { BootSequence } from "./BootSequence.jsx";
import { useBundleMeta } from "./bundleMeta.js";
import { CommandBar } from "./CommandBar.jsx";
import { CommandPalette } from "./CommandPalette.jsx";
import { useViewStore } from "./deps.js";
import { resolveRouteModule, ThermalStage } from "./moduleResolution.js";
import { LiveAnnouncer } from "./LiveAnnouncer.jsx";
import { NavRail } from "./NavRail.jsx";
import { DEFAULT_ROUTE, ROUTE_BY_ID, stageBehaviour } from "./routes.js";
import { ShortcutSheet } from "./ShortcutSheet.jsx";
import { ToastHost } from "./ToastHost.jsx";
import { useGlobalShortcuts, useMotionPersistence, usePauseWhenHidden, useRootAttributes, useUrlSyncEffect } from "./useShellEffects.js";

// ---------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------

function useIsMobile() {
  const query = "(max-width: 639.98px)";
  const get = () => {
    try {
      return window.matchMedia?.(query).matches ?? false;
    } catch {
      return false;
    }
  };
  const [mobile, setMobile] = useState(get);
  useEffect(() => {
    let mql = null;
    try {
      mql = window.matchMedia?.(query) ?? null;
    } catch {
      mql = null;
    }
    if (!mql) return undefined;
    const onChange = () => setMobile(mql.matches);
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, []);
  return mobile;
}

/** Placeholder for a module another stream has not delivered yet (clearly marked). */
function ModulePending({ title, path, owner, children }) {
  return (
    <div className="pointer-events-auto mx-auto max-w-xl p-6">
      <EmptyState
        compact
        icon={Construction}
        title={title}
        description={
          <>
            Module <code>{path}</code> ({owner}) is not part of this build yet. The shell, URL state and keyboard map are live; this
            panel appears once the module lands.
          </>
        }
      >
        {children}
      </EmptyState>
    </div>
  );
}

const STAGE_LAYOUT = {
  live: "inset-0",
  dimmed: "inset-0 opacity-40",
  "dock-right": "inset-y-0 right-0 w-[40%]",
  "dock-left": "inset-y-0 left-0 w-[45%]",
  hidden: "inset-0 invisible",
};

const OUTLET_LAYOUT = {
  live: "inset-0",
  dimmed: "inset-0",
  "dock-right": "inset-y-0 left-0 w-[60%]",
  "dock-left": "inset-y-0 right-0 w-[55%]",
  hidden: "inset-0",
  unmounted: "inset-0",
};

function StageSlot({ behaviour }) {
  const ref = useRef(null);
  const interactive = behaviour === "live" || behaviour === "dock-right" || behaviour === "dock-left";
  useEffect(() => {
    // `inert` keeps keyboard focus and AT out of a dimmed/hidden map (React 18 has no prop).
    if (ref.current) ref.current.inert = !interactive;
  }, [interactive]);
  return (
    <div
      ref={ref}
      data-stage={behaviour}
      aria-hidden={interactive ? undefined : "true"}
      className={cn("absolute z-stage overflow-hidden bg-void transition-[opacity,width] duration-base ease-expo-out", STAGE_LAYOUT[behaviour] ?? STAGE_LAYOUT.live, !interactive && "pointer-events-none")}
    >
      {ThermalStage ? (
        <ErrorBoundary title="The map stage failed" compact resetKey={behaviour === "live" ? "live" : "other"}>
          <Suspense fallback={<StagePlaceholder loading />}>
            <ThermalStage layout={behaviour} active={interactive} dimmed={behaviour === "dimmed"} />
          </Suspense>
        </ErrorBoundary>
      ) : (
        <StagePlaceholder />
      )}
      <div aria-hidden="true" className="stage-vignette pointer-events-none absolute inset-0" />
    </div>
  );
}

function StagePlaceholder({ loading = false }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-void">
      {loading ? (
        <ScanSkeleton label="Starting the map engine" height={2} className="w-48" />
      ) : (
        <p className="micro-label max-w-xs text-center" data-testid="stage-pending">
          Map engine pending · src/shell/ThermalStage.jsx (E3)
        </p>
      )}
    </div>
  );
}

function RouteFallback() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-3 p-4 sm:p-6">
      <ScanSkeleton label="Loading view" lines={1} height={28} blockClassName="w-1/3" />
      <div className="grid gap-3 md:grid-cols-2">
        <ScanSkeleton label="Loading panel" height={180} />
        <ScanSkeleton label="Loading panel" height={180} />
      </div>
    </div>
  );
}

/**
 * Route outlet: the view of the current route, keyed by route so it re-mounts (and plays the
 * §5.2 I panel entrance) on navigation.
 *
 * Deliberately NOT wrapped in <AnimatePresence mode="wait">: with "wait", the next route only
 * mounts after every presence-registered descendant of the old one has finished its exit, and
 * every motion element with `layout`/`layoutId` registers (the Segmented pills, the ribbon's
 * Day/Night switch, the inspector tabs). After a shared-layout pill animation (N, H, layer
 * changes) one of those registrations never resolved in framer-motion 11.18, so the old route
 * stayed mounted at opacity 0 and the new one never appeared (reproduced headless: press N or
 * H on Control, then 2). The old route now unmounts immediately; the new one fades in.
 */
function RouteOutlet({ routeId, behaviour, level }) {
  const { route, Component, kind } = useMemo(() => resolveRouteModule(routeId), [routeId]);
  const overlay = route.id === "control" && kind === "v2";
  const { initial, animate } = panelVariants(level);
  return (
    <motion.section
      key={route.id}
      aria-label={`${route.label} view`}
      data-route={route.id}
      data-view-kind={kind}
      initial={initial}
      animate={animate}
      className={cn(
        "absolute z-hud",
        OUTLET_LAYOUT[behaviour] ?? OUTLET_LAYOUT.live,
        overlay ? "pointer-events-none" : "scrollbar-thin overflow-y-auto",
        behaviour === "dimmed" && "bg-bg/40",
        (behaviour === "hidden" || behaviour === "unmounted") && "bg-bg",
        (behaviour === "dock-right" || behaviour === "dock-left") && "bg-bg/95",
      )}
    >
      <ErrorBoundary resetKey={route.id} title={`${route.label} failed to render`}>
        {Component ? (
          <Suspense fallback={<RouteFallback />}>
            {kind === "legacy" ? (
              // v1 views expect v1's content frame: full-bleed column for the map, padded column otherwise.
              <div className={route.id === "control" ? "flex h-full min-h-0 flex-col p-2 sm:p-3" : "mx-auto w-full max-w-[1600px] px-3 pb-8 pt-4 sm:px-5"}>
                <Component />
              </div>
            ) : (
              <Component />
            )}
          </Suspense>
        ) : (
          <ModulePending title={`${route.label} view is not built yet`} path={route.view.replace("../", "src/")} owner={route.id === "control" ? "E4" : "E5"} />
        )}
      </ErrorBoundary>
    </motion.section>
  );
}

function BundleProblem({ status, error, reload }) {
  if (status === "empty") {
    return (
      <div className="scrollbar-thin absolute inset-0 overflow-y-auto">
        <MissingBundleState onRetry={reload} />
      </div>
    );
  }
  if (error?.status === "unsupported") {
    // D22 f: an explicit unsupported-browser state (retrying cannot help).
    return (
      <div className="absolute inset-0 grid place-items-center" data-testid="unsupported-browser">
        <ErrorState title="This browser is not supported" error={error?.message ?? UNSUPPORTED_BROWSER_MESSAGE} />
      </div>
    );
  }
  return (
    <div className="absolute inset-0 grid place-items-center">
      <ErrorState title="The data bundle could not be loaded" error={error} onRetry={reload} retryLabel="Reload data" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------------------

export function AppShell() {
  const data = useData() ?? {};
  const { status = "loading", error, reload, manifest } = data;
  const meta = useBundleMeta();
  const level = useMotionLevel();
  const mobile = useIsMobile();
  const routeId = useViewStore((s) => (ROUTE_BY_ID[s.route] ? s.route : DEFAULT_ROUTE));
  const [booted, setBooted] = useState(false);
  const ready = status === "ready";

  useRootAttributes();
  useMotionPersistence();
  usePauseWhenHidden();
  useUrlSyncEffect(meta.scenarios.map((s) => s.id));
  useGlobalShortcuts({ meta, ready });

  // Announce route changes (polite; navigation buttons keep focus).
  const firstRoute = useRef(true);
  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    announce(`${ROUTE_BY_ID[routeId].label} view`);
  }, [routeId]);

  const onBootDone = useCallback(() => setBooted(true), []);
  const behaviour = stageBehaviour(routeId, mobile ? 320 : Infinity);
  const stageMounted = ready && behaviour !== "unmounted";

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-bg text-ink">
      <a
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
        className="focus-ring sr-only-focusable absolute left-3 top-3 z-boot rounded-md bg-signal px-3 py-1.5 text-sm font-medium text-void"
      >
        Skip to content
      </a>
      <CommandBar />
      <DataModeBanner manifest={manifest} />
      <div className="flex min-h-0 flex-1">
        <NavRail orientation="vertical" />
        <main id="main-content" tabIndex={-1} className="relative min-w-0 flex-1 overflow-hidden outline-none">
          {stageMounted && <StageSlot behaviour={behaviour} />}
          {ready && <RouteOutlet routeId={routeId} behaviour={behaviour} level={level} />}
          {(status === "empty" || status === "error") && <BundleProblem status={status} error={error} reload={reload} />}
          {ready && !manifest && <EmptyState icon={Boxes} title="The manifest is empty" description="The bundle loaded but carries no manifest content." />}
        </main>
      </div>
      <NavRail orientation="mobile" />
      <CommandPalette />
      <ShortcutSheet />
      <ToastHost />
      <LiveAnnouncer />
      {(!booted || status === "loading") && <BootSequence status={status} progress={data.progress ?? data.bundle?.progress ?? null} meta={meta} onDone={onBootDone} />}
    </div>
  );
}

export default AppShell;
