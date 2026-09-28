/**
 * Application shell of the Delhi NCR Thermal Intelligence Twin.
 *
 * Layout (>= 1024 px): glass header (title, epoch selector, data-mode badge, validation
 * status) over a left navigation rail and the active view. Below 1024 px the rail becomes a
 * bottom tab bar. The Digital Twin view is full-bleed (map fills the content area); the other
 * views scroll inside a centred column.
 *
 * Keyboard: arrow keys move within the nav rail and the epoch selector (roving tabindex);
 * global shortcuts 1-4 switch views and [ / ] step through epochs (ignored while typing).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  BarChart3,
  Boxes,
  CircleAlert,
  Gauge,
  LoaderCircle,
  Orbit,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Thermometer,
  X,
} from "lucide-react";
import MapContainer from "./components/MapContainer.jsx";
import ShapDependenceViewer from "./components/ShapDependenceViewer.jsx";
import GovernanceZoning from "./components/GovernanceZoning.jsx";
import ModelPerformance from "./components/ModelPerformance.jsx";
import { useData } from "./state/DataContext.jsx";
import { cn } from "./lib/cn.js";
import { fmtC, fmtInt } from "./lib/format.js";
import { Badge } from "./components/ui/Badge.jsx";
import { TooltipProvider } from "./components/ui/InfoTip.jsx";
import { EmptyState, MissingBundleState } from "./components/common/EmptyState.jsx";
import { ErrorState } from "./components/common/ErrorState.jsx";
import { LoadingScreen } from "./components/common/LoadingScreen.jsx";
import { DataModeBanner } from "./components/common/DataModeBanner.jsx";
import { DataCaveatsButton } from "./components/common/DataCaveats.jsx";
import { dataModeBadge } from "./components/common/dataNotes.js";
import { ErrorBoundary } from "./components/common/ErrorBoundary.jsx";

const NAV_ITEMS = [
  {
    id: "twin",
    label: "Digital Twin",
    short: "Twin",
    icon: Orbit,
    description: "3-D thermal grid, SHAP layers and scenario deltas",
    Component: MapContainer,
  },
  {
    id: "thresholds",
    label: "Threshold Explorer",
    short: "Thresholds",
    icon: Gauge,
    description: "Dependence curves, tipping points and what-if simulator",
    Component: ShapDependenceViewer,
  },
  {
    id: "zones",
    label: "Governance Zones",
    short: "Zones",
    icon: Boxes,
    description: "SHAP-signature zones, transitions and recommendations",
    Component: GovernanceZoning,
  },
  {
    id: "performance",
    label: "Model Performance",
    short: "Models",
    icon: BarChart3,
    description: "Triple cross-validation, benchmarks and spatial autocorrelation",
    Component: ModelPerformance,
  },
];

const isTypingTarget = (el) =>
  !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.getAttribute?.("role") === "slider");

// ---------------------------------------------------------------------------------------
// Background
// ---------------------------------------------------------------------------------------

/** Drifting neon grid + radial glows; purely decorative (aria-hidden, motion-safe). */
function AnimatedBackground() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-bg">
      <div className="absolute -left-40 -top-40 size-[38rem] rounded-full bg-cyan/10 blur-[120px]" />
      <div className="absolute -right-48 top-1/4 size-[34rem] rounded-full bg-violet/10 blur-[120px]" />
      <div className="absolute -bottom-56 left-1/3 size-[36rem] rounded-full bg-rose/[0.07] blur-[140px]" />
      <div className="grid-glow absolute inset-0 motion-safe:animate-grid-drift" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(5,8,15,0.85)_100%)]" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Header widgets
// ---------------------------------------------------------------------------------------

/** Segmented radio group over manifest.epochs with roving focus and a loading indicator. */
function EpochSelector() {
  const { manifest, year, pendingYear, setYear, epochError } = useData();
  const years = (manifest?.epochs ?? []).map(Number);
  const refs = useRef([]);
  const active = pendingYear ?? year;

  const onKeyDown = (event, index) => {
    const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    let next = null;
    if (delta) next = (index + delta + years.length) % years.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = years.length - 1;
    if (next === null) return;
    event.preventDefault();
    refs.current[next]?.focus();
    setYear(years[next]);
  };

  if (!years.length) return null;
  return (
    <div className="flex items-center gap-2">
      <div
        role="radiogroup"
        aria-label="Epoch (pre-monsoon season)"
        className="scrollbar-thin flex max-w-full items-center gap-0.5 overflow-x-auto rounded-xl border border-panel-border bg-bg-raised/70 p-1"
      >
        {years.map((y, i) => {
          const selected = y === active;
          const loading = y === pendingYear;
          const mean = manifest?.epoch_means?.[String(y)];
          return (
            <button
              key={y}
              ref={(el) => (refs.current[i] = el)}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              title={Number.isFinite(mean) ? `${y} · seasonal mean ${fmtC(mean)}` : String(y)}
              onClick={() => setYear(y)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                "focus-ring relative inline-flex h-7 items-center gap-1 rounded-lg px-2.5 font-mono text-xs font-medium transition-colors sm:px-3",
                selected ? "text-bg" : "text-ink-muted hover:text-ink",
              )}
            >
              {selected && (
                <motion.span
                  layoutId="epoch-pill"
                  className="absolute inset-0 rounded-lg bg-cyan shadow-glow-cyan"
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                />
              )}
              <span className="relative">{y}</span>
              {loading && <LoaderCircle aria-label="loading" className="relative size-3 animate-spin" />}
            </button>
          );
        })}
      </div>
      {epochError && (
        <span role="alert" title={epochError.message} className="text-rose">
          <CircleAlert aria-label="Epoch failed to load" className="size-4" />
        </span>
      )}
    </div>
  );
}

function DataModeBadge({ manifest }) {
  const badge = dataModeBadge(manifest);
  if (!badge) return null;
  return (
    <Badge variant={badge.variant} dot pulse={badge.variant === "amber"} title={badge.title}>
      {badge.text}
    </Badge>
  );
}

/** What the in-browser validation actually covered, for the "all good" message. */
function validationCoverageText(validation, manifest) {
  const checked = validation?.epochsChecked ?? [];
  const all = (manifest?.epochs ?? []).map(Number);
  const pending = all.filter((y) => !checked.includes(y));
  const epochs = checked.length ? `epoch${checked.length === 1 ? "" : "s"} ${checked.join(", ")}` : "no epoch yet";
  const sample = validation?.waterfallSample ? ` (SHAP waterfall invariant sampled on ${validation.waterfallSample} cells per epoch)` : "";
  const later = pending.length ? ` Epochs ${pending.join(", ")} are checked when first loaded.` : "";
  return `Checks passed for the manifest, model parity with Python, dependence, zones, metrics, SHAP importance, interactions, coupling and district files, and for ${epochs}${sample}.${later}`;
}

/** Contract-validation status with a popover listing errors and warnings. */
function ValidationIndicator() {
  const { validation, manifest } = useData();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e) => rootRef.current && !rootRef.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const errors = validation?.errors ?? [];
  const warnings = validation?.warnings ?? [];
  const state = !validation ? "pending" : errors.length ? "error" : warnings.length ? "warning" : "ok";
  const config = {
    pending: { icon: LoaderCircle, text: "Validating", tone: "text-ink-muted", spin: true },
    ok: { icon: ShieldCheck, text: "Contract OK", tone: "text-emerald" },
    warning: { icon: ShieldAlert, text: `${warnings.length} warning${warnings.length === 1 ? "" : "s"}`, tone: "text-amber" },
    error: { icon: ShieldX, text: `${errors.length} error${errors.length === 1 ? "" : "s"}`, tone: "text-rose" },
  }[state];
  const Icon = config.icon;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => validation && setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={!validation}
        className={cn(
          "focus-ring inline-flex h-7 items-center gap-1.5 rounded-lg border border-panel-border bg-bg-raised/70 px-2.5 font-mono text-[11px] uppercase tracking-wider",
          config.tone,
        )}
      >
        <Icon aria-hidden="true" className={cn("size-3.5", config.spin && "animate-spin")} />
        <span className="hidden sm:inline">{config.text}</span>
        <span className="sr-only sm:hidden">Bundle validation: {config.text}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Bundle validation report"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="glass-strong absolute right-0 top-9 z-50 w-[min(26rem,calc(100vw-1.5rem))] rounded-xl border p-3 shadow-glass"
          >
            <div className="mb-2 flex items-center justify-between">
              <p className="font-display text-sm font-semibold text-ink-strong">Web-bundle contract (SPEC §4)</p>
              <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="focus-ring rounded p-0.5 text-ink-muted hover:text-ink">
                <X aria-hidden="true" className="size-4" />
              </button>
            </div>
            {state === "ok" && <p className="text-xs text-ink-muted">{validationCoverageText(validation, manifest)}</p>}
            {state !== "ok" && (
              <p className="text-[11px] text-ink-faint">
                Epochs checked: {(validation?.epochsChecked ?? []).join(", ") || "none"}; others are checked when first
                loaded.
              </p>
            )}
            <ValidationList title="Errors" items={errors} tone="text-rose" />
            <ValidationList title="Warnings" items={warnings} tone="text-amber" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ValidationList({ title, items, tone }) {
  if (!items.length) return null;
  return (
    <div className="mt-2">
      <p className={cn("mb-1 font-mono text-[11px] uppercase tracking-wider", tone)}>
        {title} ({items.length})
      </p>
      <ul className="scrollbar-thin max-h-48 space-y-1 overflow-y-auto pr-1 text-xs leading-snug text-ink">
        {items.map((msg, i) => (
          <li key={i} className="rounded-md bg-bg-deep/60 px-2 py-1">
            {msg}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AppHeader() {
  const { manifest, epoch, status } = useData();
  const area = manifest?.study_area;
  const subtitleParts = [
    area?.grid_res_m ? `${area.grid_res_m / 1000} km grid` : null,
    epoch ? `${fmtInt(epoch.n)} cells` : null,
    manifest?.season ? `pre-monsoon ${manifest.season.join(" → ")}` : null,
    manifest?.target_mode ? `${manifest.target_mode} target` : null,
  ].filter(Boolean);

  return (
    <header className="glass-strong relative z-30 border-b border-x-0 border-t-0">
      <div className="mx-auto flex max-w-[1800px] flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-cyan/40 bg-cyan/10 text-cyan shadow-glow-cyan">
            <Thermometer aria-hidden="true" className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate font-display text-base font-semibold tracking-tight text-ink-strong sm:text-lg">
              <span className="neon-text">Delhi NCR</span> Thermal Intelligence Twin
            </h1>
            <p className="truncate font-mono text-[11px] text-ink-muted">
              {subtitleParts.length ? subtitleParts.join(" · ") : "Land surface temperature × explainable AI"}
            </p>
          </div>
        </div>
        {status === "ready" && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
            <EpochSelector />
            <div className="ml-auto flex items-center gap-2 sm:ml-0">
              <DataModeBadge manifest={manifest} />
              <DataCaveatsButton manifest={manifest} />
              <ValidationIndicator />
            </div>
          </div>
        )}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------

/** Vertical rail (lg+) / bottom tab bar (mobile) with arrow-key roving focus. */
function NavRail({ orientation }) {
  const { view, setView } = useData();
  const refs = useRef([]);
  const vertical = orientation === "vertical";

  const onKeyDown = (event, index) => {
    const keys = vertical ? { ArrowDown: 1, ArrowUp: -1 } : { ArrowRight: 1, ArrowLeft: -1 };
    let next = keys[event.key] !== undefined ? (index + keys[event.key] + NAV_ITEMS.length) % NAV_ITEMS.length : null;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = NAV_ITEMS.length - 1;
    if (next === null) return;
    event.preventDefault();
    refs.current[next]?.focus();
    setView(NAV_ITEMS[next].id);
  };

  return (
    <nav
      aria-label="Dashboard views"
      className={cn(
        vertical
          ? "glass hidden w-[5.5rem] shrink-0 flex-col items-stretch gap-1 border-y-0 border-l-0 px-2 py-3 lg:flex"
          : "glass-strong fixed inset-x-0 bottom-0 z-40 flex border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)] lg:hidden",
      )}
    >
      {NAV_ITEMS.map((item, i) => {
        const Icon = item.icon;
        const active = view === item.id;
        return (
          <button
            key={item.id}
            ref={(el) => (refs.current[i] = el)}
            type="button"
            aria-current={active ? "page" : undefined}
            tabIndex={active ? 0 : -1}
            title={`${item.label} - ${item.description} (key ${i + 1})`}
            onClick={() => setView(item.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "focus-ring group relative flex flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium transition-colors",
              vertical ? "px-1 py-2.5" : "flex-1 py-2",
              active ? "text-cyan-soft" : "text-ink-muted hover:text-ink",
            )}
          >
            {active && (
              <motion.span
                layoutId={`nav-active-${orientation}`}
                className={cn(
                  "absolute rounded-xl border border-cyan/40 bg-cyan/10 shadow-glow-cyan",
                  vertical ? "inset-0" : "inset-x-2 inset-y-1",
                )}
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            )}
            <Icon aria-hidden="true" className="relative size-5 transition-transform group-hover:scale-110" />
            <span className="relative leading-tight">{vertical ? item.label : item.short}</span>
          </button>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------

function ActiveView() {
  const { view, year } = useData();
  const reduceMotion = useReducedMotion();
  const item = NAV_ITEMS.find((n) => n.id === view) ?? NAV_ITEMS[0];
  const { Component } = item;
  const fullBleed = item.id === "twin";

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.section
        key={item.id}
        id="main-content"
        tabIndex={-1}
        aria-label={item.label}
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, filter: "blur(4px)" }}
        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, filter: "blur(0px)" }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, filter: "blur(2px)" }}
        transition={{ duration: reduceMotion ? 0.1 : 0.22, ease: "easeOut" }}
        className={cn(
          "min-h-0 flex-1 outline-none",
          fullBleed
            ? "flex flex-col p-2 pb-[4.75rem] sm:p-3 sm:pb-[4.75rem] lg:pb-3"
            : "scrollbar-thin overflow-y-auto px-3 pb-24 pt-4 sm:px-5 lg:pb-8",
        )}
      >
        <div className={cn(fullBleed ? "flex min-h-0 flex-1 flex-col" : "mx-auto w-full max-w-[1600px]")}>
          <ErrorBoundary resetKey={`${item.id}:${year}`} title={`${item.label} failed to render`}>
            <Component />
          </ErrorBoundary>
        </div>
      </motion.section>
    </AnimatePresence>
  );
}

/** Global keyboard shortcuts: 1-4 switch views, [ and ] step epochs. */
function useShortcuts() {
  const { status, setView, manifest, year, pendingYear, setYear } = useData();
  const handler = useCallback(
    (event) => {
      if (status !== "ready" || event.altKey || event.ctrlKey || event.metaKey || isTypingTarget(event.target)) return;
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < NAV_ITEMS.length) {
        setView(NAV_ITEMS[index].id);
        return;
      }
      if (event.key === "[" || event.key === "]") {
        const years = (manifest?.epochs ?? []).map(Number);
        const current = years.indexOf(pendingYear ?? year);
        const next = current + (event.key === "]" ? 1 : -1);
        if (current >= 0 && next >= 0 && next < years.length) setYear(years[next]);
      }
    },
    [status, setView, manifest, year, pendingYear, setYear],
  );
  useEffect(() => {
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handler]);
}

/** Keep the active view in the URL hash (#thresholds …) so views are linkable and survive reloads. */
function useHashView() {
  const { view, setView } = useData();
  useEffect(() => {
    const apply = () => {
      const id = window.location.hash.replace(/^#\/?/, "");
      if (NAV_ITEMS.some((n) => n.id === id)) setView(id);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [setView]);
  useEffect(() => {
    const target = `#${view}`;
    if (window.location.hash !== target) window.history.replaceState(null, "", target);
  }, [view]);
}

function ShellBody() {
  const { status, error, reload, manifest, epoch } = useData();
  useShortcuts();
  useHashView();

  if (status === "loading") return <LoadingScreen />;
  if (status === "empty") {
    return (
      <div className="scrollbar-thin flex-1 overflow-y-auto">
        <MissingBundleState onRetry={reload} />
      </div>
    );
  }
  if (status === "error") {
    return <ErrorState title="The data bundle could not be loaded" error={error} onRetry={reload} retryLabel="Reload data" />;
  }
  if (!manifest || !epoch) {
    return <EmptyState title="No epoch available" description="The manifest lists no loadable epoch." />;
  }
  return (
    <div className="flex min-h-0 flex-1">
      <NavRail orientation="vertical" />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ActiveView />
      </main>
      <NavRail orientation="horizontal" />
    </div>
  );
}

export default function App() {
  const { manifest } = useData();
  return (
    <TooltipProvider delayDuration={200} skipDelayDuration={300}>
      <div className="relative flex h-dvh flex-col overflow-hidden text-ink">
        <a
          href="#main-content"
          className="focus-ring sr-only z-50 rounded-md bg-cyan px-3 py-1.5 text-sm font-medium text-bg focus:not-sr-only focus:absolute focus:left-3 focus:top-3"
        >
          Skip to content
        </a>
        <AnimatedBackground />
        <AppHeader />
        <DataModeBanner manifest={manifest} />
        <ShellBody />
      </div>
    </TooltipProvider>
  );
}
