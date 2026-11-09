/**
 * Command bar (52 px, UI_SPEC §3.2):
 *   ◈ NCR Heat Atlas │ ⌕ search… Ctrl K │ [Day | Night | DTR] │ SSP2-4.5 ▾ │ ● REAL·GEE │ caveats │ ✓ │ perf │ ⛭
 *
 * Mode and SSP are bound to timeStore (setMode / setSsp-or-setState). Unavailable modes stay
 * visible with their reason (v1 bundles: "rerun notebook v2"); the SSP picker notes that
 * scenarios apply to projected years only. On mobile the bar compacts to brand, mode and SSP;
 * the palette is an icon button.
 */
import { Search } from "lucide-react";
import { BrandGlyph, SunMoonGlyph } from "../design/glyphs.jsx";
import { color } from "../design/tokens.js";
import { cn } from "../lib/cn.js";
import { fmtSsp } from "../lib/format.js";
import { appEnv } from "../lib/env.js";
import { useData } from "../state/DataContext.jsx";
import { Badge } from "../components/ui/Badge.jsx";
import { IconTip } from "../components/ui/InfoTip.jsx";
import { Segmented } from "../components/ui/Segmented.jsx";
import { DataCaveatsButton } from "../components/common/DataCaveats.jsx";
import { formatGeneratedDate } from "../components/common/dataNotes.js";
import { runAction } from "./actions.js";
import { announce } from "./announcer.js";
import { useBundleMeta } from "./bundleMeta.js";
import { callAction, useTimeStore } from "./deps.js";
import { PerfChip } from "./PerfChip.jsx";
import { SettingsMenu } from "./SettingsMenu.jsx";
import { showToast } from "./toasts.js";
import { STORES } from "./useShellEffects.js";
import { useShellUi } from "./uiStore.js";
import { ValidationIndicator } from "./ValidationIndicator.jsx";

const MODE_ACCENT = { day: color.solar, night: color.lunar, dtr: color.lunar };

function DataModeChip({ dataMode, generatedAt, schema }) {
  if (!dataMode) return null;
  const date = formatGeneratedDate(generatedAt);
  if (dataMode === "synthetic") {
    return (
      <Badge variant="warn" dot size="sm" title="Values come from the synthetic generator, not satellite observations">
        Synthetic · demo
      </Badge>
    );
  }
  return (
    <Badge
      variant="ok"
      dot
      pulse
      size="sm"
      title={`Static Google Earth Engine export${date ? ` generated ${date}` : ""}; schema ${schema ?? "?"}. It does not update live.`}
    >
      Real data · {String(dataMode) === "gee" ? "Earth Engine" : String(dataMode).toUpperCase()}
    </Badge>
  );
}

function ModeSwitch({ meta, compact }) {
  const mode = useTimeStore((s) => s.mode ?? "day");
  const options = ["day", "night", "dtr"].map((m) => ({
    value: m,
    label: m === "dtr" ? "DTR" : m === "day" ? "Day" : "Night",
    // Compact (phones): text only, so the bar fits 320 px; the accent underline still marks the mode.
    icon: m === "dtr" || compact ? null : <SunMoonGlyph night={m === "night"} size={14} />,
    disabled: !meta.availableModes[m],
    reason: meta.modeReasons[m] ?? undefined,
    title: m === "dtr" ? "Diurnal temperature range (day − night)" : m === "day" ? "Day · ~10:30 IST" : "Night · ~01:30 IST",
  }));
  return (
    <Segmented
      ariaLabel="Day, night or diurnal range"
      layoutId={compact ? "cmd-mode-compact" : "cmd-mode"}
      value={mode}
      options={options}
      size={compact ? "sm" : "md"}
      accent={(v) => MODE_ACCENT[v]}
      onChange={(m) => {
        runAction({ type: "mode", mode: m }, { stores: STORES, availableModes: meta.availableModes, announce, toast: showToast });
        announce(m === "dtr" ? "Diurnal range" : m === "night" ? "Night" : "Day");
      }}
    />
  );
}

function SspPicker({ meta, compact }) {
  const ssp = useTimeStore((s) => s.ssp ?? null);
  const year = useTimeStore((s) => s.year);
  const scenarios = meta.scenarios;
  const none = scenarios.length === 0;
  const historical = Number.isFinite(year) && Number.isFinite(meta.now) && year <= meta.now;
  const id = compact ? "cmd-ssp-compact" : "cmd-ssp";
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={id} className="sr-only">
        Climate scenario (applies to projected years)
      </label>
      <select
        id={id}
        value={none ? "" : ssp ?? scenarios[0]?.id ?? ""}
        disabled={none}
        title={none ? "No projections in this bundle (rerun notebook v2)" : historical ? `Applies to projected years (after ${meta.now})` : "Climate scenario"}
        onChange={(e) => {
          const next = e.target.value;
          if (!callAction(useTimeStore, "setSsp", next)) useTimeStore.setState({ ssp: next });
          announce(`Scenario ${fmtSsp(next)}`);
        }}
        className={cn(
          "focus-ring h-8 cursor-pointer appearance-none rounded-full border border-hairline-strong bg-surface-3 pl-3 pr-7 text-[12.5px] font-medium text-ink transition-colors duration-quick hover:border-control",
          "disabled:cursor-not-allowed disabled:opacity-50",
          historical && !none && "text-ink-muted",
        )}
        style={{ backgroundImage: "linear-gradient(45deg, transparent 50%, var(--ink-muted) 50%), linear-gradient(135deg, var(--ink-muted) 50%, transparent 50%)", backgroundPosition: "calc(100% - 13px) 14px, calc(100% - 9px) 14px", backgroundSize: "4px 4px", backgroundRepeat: "no-repeat" }}
      >
        {none && <option value="">No SSP</option>}
        {scenarios.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label ?? fmtSsp(s.id)}
          </option>
        ))}
      </select>
    </div>
  );
}

export function CommandBar() {
  const meta = useBundleMeta();
  const { status, manifest } = useData() ?? {};
  const openPalette = () => useShellUi.getState().toggle("palette");
  const ready = status === "ready";

  return (
    <header className="relative z-chrome flex h-[52px] shrink-0 items-center gap-2 border-b border-hairline bg-bg/90 px-3 backdrop-blur-xl sm:gap-3 sm:px-4">
      {/* The brand returns to the site home page (the explorer state stays in the URL hash). */}
      <a href={appEnv.BASE_URL} className="focus-ring flex shrink-0 items-center gap-2.5 rounded-lg pr-1" aria-label="Delhi NCR Heat Atlas home page">
        <BrandGlyph size={24} />
        <span className="hidden flex-col leading-none md:flex">
          <span className="font-display text-[14px] font-semibold tracking-[-0.01em] text-ink-strong">NCR Heat Atlas</span>
          <span className="mt-0.5 text-[11px] font-medium text-ink-faint">Explorer</span>
        </span>
      </a>
      <span aria-hidden="true" className="hidden h-6 w-px bg-hairline sm:block" />

      <button
        type="button"
        onClick={openPalette}
        aria-keyshortcuts="Control+K Meta+K"
        aria-label="Open command palette: district, cell, year, command"
        className="focus-ring hidden h-9 min-w-0 max-w-sm flex-1 items-center gap-2 rounded-full border border-hairline-strong bg-white/[0.03] px-3.5 text-left text-[13px] text-ink-faint transition-colors duration-quick hover:border-control hover:text-ink-muted xl:flex xl:min-w-[13rem]"
      >
        <Search aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.5} />
        <span className="min-w-0 flex-1 truncate">Search districts, years, actions…</span>
        <kbd className="shrink-0 whitespace-nowrap rounded-md border border-hairline-strong bg-surface-3 px-1.5 font-mono text-[11px] text-ink-muted">Ctrl K</kbd>
      </button>
      <IconTip label="Command palette (Ctrl K)">
        <button
          type="button"
          onClick={openPalette}
          aria-label="Open command palette"
          className="focus-ring grid size-8 shrink-0 place-items-center rounded-md text-ink-muted hover:text-ink xl:hidden"
        >
          <Search aria-hidden="true" className="size-4" strokeWidth={1.5} />
        </button>
      </IconTip>

      <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3 xl:ml-0">
        {ready && (
          <>
            <div className="hidden sm:block">
              <ModeSwitch meta={meta} />
            </div>
            <div className="sm:hidden">
              <ModeSwitch meta={meta} compact />
            </div>
            <div className="hidden sm:block">
              <SspPicker meta={meta} />
            </div>
          </>
        )}
      </div>

      <div className="ml-auto hidden items-center gap-1.5 sm:flex">
        {ready && <DataModeChip dataMode={meta.dataMode} generatedAt={meta.generatedAt} schema={meta.schema} />}
        <PerfChip />
        {ready && manifest && <DataCaveatsButton manifest={manifest} />}
        {ready && <ValidationIndicator />}
      </div>
      <SettingsMenu />
    </header>
  );
}

export default CommandBar;
