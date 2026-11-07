/**
 * ZONES route (UI_SPEC §3.7): governance zones = K-means on grouped-SHAP vectors, i.e. cells
 * grouped by WHY they are hot (per mode: day zones and night zones are different clusters).
 *
 *   header       silhouette, K, mapped area, frame; zone share band (animates on year change)
 *   zone cards   v1 ZoneCard (signature, numbers, actions) + area trajectory 1990–2050 with the
 *                scenario strands; caveats as pips
 *   transitions  ZoneAlluvial across all frames (projected fogged) | v1 TransitionMatrix toggle
 *   policy       v1 PolicyTable · K diagnostics
 * The map stage is docked left (45 %) showing the zones layer; this view fills the right.
 * v2 zones.json (series-keyed) is normalised to the v1 component shapes by zoneModel.
 */
import { useEffect, useMemo, useState } from "react";
import { Boxes, Map as MapIcon, Network, ScrollText, ShieldCheck, Waypoints } from "lucide-react";
import { useData } from "../../state/DataContext.jsx";
import { useTimeStore } from "../../state/stores/timeStore.js";
import { useViewStore } from "../../state/stores/viewStore.js";
import { useTimeline } from "../../data/hooks.js";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { Button } from "../../components/ui/Button.jsx";
import { Segmented } from "../../components/ui/Segmented.jsx";
import { ScanSkeleton } from "../../components/ui/ScanSkeleton.jsx";
import { KDiagnostics } from "../../components/zones/KDiagnostics.jsx";
import { PolicyTable } from "../../components/zones/PolicyTable.jsx";
import { TransitionMatrix } from "../../components/zones/TransitionMatrix.jsx";
import { ZoneCard } from "../../components/zones/ZoneCard.jsx";
import { ZoneHeader } from "../../components/zones/ZoneHeader.jsx";
import {
  alluvialColumns,
  alluvialRows,
  cellAreaKm2,
  mergeRecommendations,
  normalizeZones,
  num,
  orderedZones,
  previousEpoch,
  resolveEpoch,
  shapSignature,
  signatureMaxAbs,
  totalArea,
  zoneDisplayName,
  zoneEpochs,
  zoneShareTrajectories,
  zoneSummaries,
} from "../../components/zones/zoneModel.js";
import { fmtInt } from "../../lib/format.js";
import { ChartTable } from "../../viz/ChartTable.jsx";
import { sspStyle } from "../../viz/chartTheme.js";
import { Unavailable } from "../../viz/Unavailable.jsx";
import { buildCaveats, caveatsFor } from "../sources/caveats.js";
import { CaveatPip } from "./CaveatPip.jsx";
import { ZoneAlluvial } from "./ZoneAlluvial.jsx";
import { ZoneTrajectory } from "./ZoneTrajectory.jsx";

function Title({ icon: Icon, children }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon aria-hidden="true" className="size-3.5 text-signal" />
      {children}
    </span>
  );
}

export function ZonesView() {
  const { status, manifest, v1Manifest, schema, zones: zonesRaw, zonesMeta, year, uncertainty } = useData();
  const ciLabel = uncertainty?.label ?? "95% CI";
  const tl = useTimeline();
  const timeline = tl.status === "ready" ? tl.data : null;
  const timeMode = useTimeStore((s) => s.mode);
  const ssp = useTimeStore((s) => s.ssp);
  const mode = timeMode === "night" ? "night" : "day";
  const [transView, setTransView] = useState("alluvial");

  // The docked map shows the zones layer while this route is open (previous layer restored).
  useEffect(() => {
    const view = useViewStore.getState();
    const previous = view.layer;
    view.setLayer?.("zones");
    return () => {
      if (useViewStore.getState().layer === "zones" && previous !== "zones") useViewStore.getState().setLayer?.(previous);
    };
  }, []);

  const zones = useMemo(() => normalizeZones(zonesRaw), [zonesRaw]);
  const manifestForZones = v1Manifest ?? manifest;
  const zoneList = useMemo(() => orderedZones(zones, zonesMeta), [zones, zonesMeta]);
  const years = useMemo(() => zoneEpochs(zones, manifestForZones), [zones, manifestForZones]);
  const timeYear = useTimeStore((s) => s.year);
  const shownYear = resolveEpoch(years, year ?? timeYear);
  const prevYear = shownYear === null ? null : previousEpoch(years, shownYear);
  const summaries = useMemo(() => zoneSummaries(zoneList, years, shownYear, manifestForZones?.epoch_means), [zoneList, years, shownYear, manifestForZones]);
  const signatures = useMemo(() => zoneList.map((z) => shapSignature(z, 8)), [zoneList]);
  const sigMax = useMemo(() => signatureMaxAbs(signatures), [signatures]);
  const recommendations = useMemo(() => mergeRecommendations(zoneList), [zoneList]);
  const caveats = useMemo(() => buildCaveats(manifest, { schema }), [manifest, schema]);
  const cellArea = cellAreaKm2(manifest);
  const scenarioIds = timeline?.scenarioIds ?? [];
  const activeSsp = scenarioIds.includes(ssp) ? ssp : scenarioIds[0] ?? null;
  const transitionsBySeries = zones?.transitionsBySeries ?? zones?.transitions ?? null;
  const alluvial = useMemo(() => alluvialColumns(transitionsBySeries, { ssp: activeSsp }), [transitionsBySeries, activeSsp]);
  const zoneName = (z) => {
    const found = zoneList.find((x) => x.id === z);
    return found ? zoneDisplayName(found) : `Zone ${z}`;
  };

  if (status === "loading") return <ScanSkeleton label="Loading governance zones" height={320} className="m-4" />;
  if (status !== "ready" || !manifest) return <Unavailable status={status} reason="The web bundle has not been loaded." className="m-4" />;

  const header = (
    <header className="space-y-2">
      <p className="micro-label flex items-center gap-1.5">
        <ShieldCheck aria-hidden="true" className="size-3.5 text-signal" /> Zones · K-means on grouped TreeSHAP · {mode}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-ink-strong">Governance zones</h1>
        <div className="flex flex-wrap items-center gap-2">
          <CaveatPip caveats={caveatsFor(caveats, ["model", "landcover"])} label="Zone caveats" />
          <Button variant="outline" size="sm" onClick={() => useViewStore.getState().setRoute?.("control")}>
            <MapIcon aria-hidden="true" />
            Open the map
          </Button>
        </div>
      </div>
      <p className="max-w-3xl text-sm text-ink-muted">Cells grouped by why they are hot, not how hot: each zone shares a driver signature. Day and night zones are clustered separately. Recommendations are model counterfactuals, not causal effects.</p>
    </header>
  );

  if (!zones || !zoneList.length) {
    return (
      <div className="space-y-3 px-3 pb-10 pt-4 sm:px-4">
        {header}
        <Unavailable reason={`No ${mode} zones in this bundle${mode === "night" ? " (night zones need a v2 bundle)" : ""}.`} />
      </div>
    );
  }

  const total = shownYear === null ? null : totalArea(zoneList, shownYear);
  const prevTotal = prevYear === null ? null : totalArea(zoneList, prevYear);
  const xDomain = [timeline?.first ?? years[0] ?? 1990, timeline?.last ?? years[years.length - 1] ?? 2050];

  return (
    <div className="space-y-3 px-3 pb-10 pt-4 sm:px-4">
      {header}

      <HudFrame solid title={<Title icon={Boxes}>Zoning overview</Title>}>
        <ZoneHeader summaries={summaries} k={num(zones.k) ?? zoneList.length} silhouette={num(zones.silhouette)} total={total} prevTotal={prevTotal} year={shownYear} prevYear={prevYear} requestedYear={year ?? timeYear} />
        <div className="mt-2 flex flex-wrap gap-2">
          <CaveatPip caveats={caveatsFor(caveats, ["landcover", "sensor"])} label="Cross-frame comparisons" />
        </div>
      </HudFrame>

      <section aria-label="Zone cards" className="grid items-stretch gap-3 xl:grid-cols-2">
        {zoneList.map((zone, i) => (
          <div key={zone.id} className="flex min-w-0 flex-col gap-1.5">
            <ZoneCard zone={zone} summary={summaries[i]} signature={signatures[i]} signatureMax={sigMax} manifest={manifestForZones} year={shownYear} index={i} ciLabel={ciLabel} />
            {schema === "v2" && (
              <div className="rounded-md border border-hairline bg-surface-2 px-2.5 py-2">
                <ZoneTrajectory trajectories={zoneShareTrajectories(zones, zone.id)} color={zone.color} selectedSsp={activeSsp} now={timeline?.now} xDomain={xDomain} name={zoneDisplayName(zone)} />
              </div>
            )}
          </div>
        ))}
      </section>

      <ChartTable
        title={<Title icon={Waypoints}>Zone transitions{activeSsp && transView === "alluvial" ? ` · projected under ${sspStyle(activeSsp).label}` : ""}</Title>}
        actions={
          <Segmented
            ariaLabel="Transition view"
            size="sm"
            value={transView}
            onChange={setTransView}
            options={[
              { value: "alluvial", label: "Alluvial" },
              { value: "matrix", label: "Matrix" },
            ]}
            layoutId="zones-trans"
          />
        }
        columns={[
          { key: "pair", label: "Frames" },
          { key: "kind", label: "Kind" },
          { key: "from", label: "From zone" },
          { key: "to", label: "To zone" },
          { key: "cells", label: "Cells", align: "right", format: (v) => fmtInt(v) },
        ]}
        rows={alluvialRows(alluvial, zoneName)}
        caption="Cells moving between zones from one frame to the next (same grid cells). Projected flows follow the selected scenario's median land realisation."
      >
        {transView === "alluvial" ? (
          <ZoneAlluvial transitionsBySeries={transitionsBySeries} ssp={activeSsp} zonesMeta={zoneList} />
        ) : (
          <TransitionMatrix transitions={zones.transitions} zoneList={zoneList} year={shownYear} cellArea={cellArea} />
        )}
      </ChartTable>

      <HudFrame solid title={<Title icon={ScrollText}>Policy engine</Title>} actions={<CaveatPip caveats={caveatsFor(caveats, ["model"])} label="Model caveats" />}>
        <PolicyTable rows={recommendations} zoneList={zoneList} manifest={manifestForZones} ciLabel={ciLabel} />
      </HudFrame>

      <HudFrame solid title={<Title icon={Network}>K diagnostics</Title>}>
        <KDiagnostics diagnostics={zones.diagnostics} chosenK={num(zones.k)} />
      </HudFrame>
    </div>
  );
}

export default ZonesView;
