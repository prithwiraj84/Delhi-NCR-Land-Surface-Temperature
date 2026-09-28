/**
 * Governance Zoning & Policy Engine (view "zones").
 *
 * Reads `zones.json` (SPEC §4.6), `manifest.zones` (colours / names) and the current epoch
 * (`year` from DataContext; if zones.json does not cover it, the latest covered epoch is
 * shown and the header says so).
 *
 *   1. Header strip: silhouette, K, mapped area, epoch and an animated stacked bar of zone
 *      area shares.
 *   2. Four comparison cards (4 → 2 → 1 columns), one per canonical zone, sharing scales.
 *   3. Policy engine: every recommendation in one sortable / filterable TanStack table.
 *   4. Transition matrix for a selectable epoch pair (net flow into the Heat Extreme Core).
 *   5. K diagnostics (inertia elbow + silhouette vs K, chosen K marked).
 *
 * Zones are K-means clusters of SHAP vectors, i.e. groups of cells whose heat has the same
 * *explanation*; recommendations are model counterfactuals (SPEC §4.6): the final model
 * re-evaluated on the zone's cells after a feasible, bounded change of one actionable
 * feature (target = bound, threshold or partial step). `zones` is optional: when
 * it is null every panel explains what is missing instead of failing.
 */
import { useMemo } from "react";
import { Boxes, Map as MapIcon, Network, ScrollText, ShieldCheck, Waypoints } from "lucide-react";
import { useData } from "../state/DataContext.jsx";
import { Badge } from "./ui/Badge.jsx";
import { Button } from "./ui/Button.jsx";
import { GlassPanel } from "./ui/GlassPanel.jsx";
import { SectionHeader } from "./ui/SectionHeader.jsx";
import { Skeleton } from "./ui/Skeleton.jsx";
import { EmptyState } from "./common/EmptyState.jsx";
import { CrossEpochCaveat } from "./common/DataCaveats.jsx";
import { PanelTitle } from "./performance/PanelTitle.jsx";
import { KDiagnostics } from "./zones/KDiagnostics.jsx";
import { PolicyTable } from "./zones/PolicyTable.jsx";
import { TransitionMatrix } from "./zones/TransitionMatrix.jsx";
import { ZoneCard } from "./zones/ZoneCard.jsx";
import { ZoneHeader } from "./zones/ZoneHeader.jsx";
import {
  cellAreaKm2,
  mergeRecommendations,
  num,
  orderedZones,
  previousEpoch,
  resolveEpoch,
  shapSignature,
  signatureMaxAbs,
  totalArea,
  zoneEpochs,
  zoneSummaries,
} from "./zones/zoneModel.js";

function LoadingLayout() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading governance zones">
      <Skeleton className="h-16 w-2/3 rounded-xl" />
      <Skeleton className="h-40 rounded-2xl" />
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[720px] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

export default function GovernanceZoning() {
  const { status, manifest, zones, zonesMeta, year, setMapLayer, setView, uncertainty } = useData();
  const ciLabel = uncertainty?.label ?? "95% CI";

  const zoneList = useMemo(() => orderedZones(zones, zonesMeta), [zones, zonesMeta]);
  const years = useMemo(() => zoneEpochs(zones, manifest), [zones, manifest]);
  const shownYear = resolveEpoch(years, year);
  const prevYear = shownYear === null ? null : previousEpoch(years, shownYear);
  const summaries = useMemo(
    () => zoneSummaries(zoneList, years, shownYear, manifest?.epoch_means),
    [zoneList, years, shownYear, manifest],
  );
  const signatures = useMemo(() => zoneList.map((z) => shapSignature(z, 8)), [zoneList]);
  const sigMax = useMemo(() => signatureMaxAbs(signatures), [signatures]);
  const recommendations = useMemo(() => mergeRecommendations(zoneList), [zoneList]);
  const cellArea = cellAreaKm2(manifest);

  if (status === "loading") return <LoadingLayout />;
  if (status !== "ready" || !manifest) {
    return (
      <EmptyState
        title="Governance zones unavailable"
        description="The web bundle has not been loaded. Run the notebook and copy outputs/web/* to dashboard/public/data/."
      />
    );
  }

  const showOnMap = () => {
    setMapLayer("zones");
    setView("twin");
  };

  const header = (
    <SectionHeader
      eyebrow="Policy engine · K-means on TreeSHAP"
      icon={ShieldCheck}
      title="Governance Zoning & Policy Engine"
      description="Cells grouped by why they are hot, not just how hot: K-means on per-cell SHAP vectors yields four mechanism zones, each with its driver signature, trajectory and threshold-based cooling actions."
      actions={
        <>
          {shownYear ? (
            <Badge variant="cyan" dot>
              epoch {shownYear}
            </Badge>
          ) : null}
          {zones ? <Badge variant="outline">K = {num(zones.k) ?? zoneList.length}</Badge> : null}
          <Button variant="outline" size="sm" onClick={showOnMap}>
            <MapIcon aria-hidden="true" />
            Show zones on map
          </Button>
        </>
      }
    />
  );

  if (!zones || !zoneList.length) {
    return (
      <div className="space-y-4">
        {header}
        <GlassPanel>
          <EmptyState
            compact
            icon={Boxes}
            title="No governance zones in this bundle"
            description="zones.json is missing, failed to load or has no zone profiles. It is produced by notebook section 04 (SHAP K-means zoning) and exported by section 05; re-export the web bundle to populate this view."
          />
        </GlassPanel>
      </div>
    );
  }

  const total = shownYear === null ? null : totalArea(zoneList, shownYear);
  const prevTotal = prevYear === null ? null : totalArea(zoneList, prevYear);

  return (
    <div className="space-y-4">
      {header}

      <GlassPanel as="section" aria-label="Zoning overview" padding="sm" className="sm:p-4">
        <ZoneHeader
          summaries={summaries}
          k={num(zones.k) ?? zoneList.length}
          silhouette={num(zones.silhouette)}
          total={total}
          prevTotal={prevTotal}
          year={shownYear}
          prevYear={prevYear}
          requestedYear={year}
        />
        <CrossEpochCaveat manifest={manifest} className="mt-3" />
      </GlassPanel>

      <section aria-label="Zone comparison cards" className="grid items-stretch gap-4 md:grid-cols-2 2xl:grid-cols-4">
        {zoneList.map((zone, i) => (
          <ZoneCard
            key={zone.id}
            zone={zone}
            summary={summaries[i]}
            signature={signatures[i]}
            signatureMax={sigMax}
            manifest={manifest}
            year={shownYear}
            index={i}
            ciLabel={ciLabel}
          />
        ))}
      </section>

      <GlassPanel as="section" aria-labelledby="zones-policy-title" padding="sm" className="sm:p-4" glow="cyan">
        <PanelTitle
          id="zones-policy-title"
          icon={ScrollText}
          title="Policy engine"
          subtitle="All zone recommendations, ranked by expected cooling. Filter by priority, feature or zone; expand a row for its rationale."
          info={`Candidate levers are the five land-cover fractions, NDVI and the landscape metrics (NDWI / NDBI are spectral diagnostics, not levers). The target is the smallest step (25 / 50 / 75 / 100% of the way to the zone's own p90 or p10, or a detected breakpoint / saturation) that reaches at least 90% of the best cooling, capped at 20 pp (fractions) or 0.15 (NDVI); actions cooling by less than 0.05 °C are dropped. ΔLST is a model-based ceteris-paribus estimate: the final model re-run on the zone's cells with that lever changed (land taken proportionally from the other covers, including other vegetation, with the coupled spectral indices following). It is an association, not a causal effect. Interval: ${uncertainty?.describe ?? "bootstrap"} Priority: high ≤ −1 °C, medium ≤ −0.3 °C, low otherwise.`}
        />
        <PolicyTable rows={recommendations} zoneList={zoneList} manifest={manifest} ciLabel={ciLabel} />
      </GlassPanel>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <GlassPanel as="section" aria-labelledby="zones-transition-title" padding="sm" className="min-w-0 sm:p-4">
          <PanelTitle
            id="zones-transition-title"
            icon={Waypoints}
            title="Zone transitions"
            tone="rose"
            info="How the same grid cells moved between zones from one epoch to the next (consecutive epoch pairs only). Rows sum to 100%. Net flow = cells entering a zone from other zones minus cells leaving it. Zone names come from the bundle's labelling of the SHAP clusters."
          />
          <TransitionMatrix transitions={zones.transitions} zoneList={zoneList} year={shownYear} cellArea={cellArea} />
          <CrossEpochCaveat manifest={manifest} className="mt-3" />
        </GlassPanel>
        <GlassPanel as="section" aria-labelledby="zones-k-title" padding="sm" className="min-w-0 sm:p-4">
          <PanelTitle
            id="zones-k-title"
            icon={Network}
            title="K diagnostics"
            tone="violet"
            info="Inertia is the within-cluster sum of squared distances in SHAP space (always falls with K; look for the elbow). The silhouette compares each cell's distance to its own zone with the nearest other zone (−1 to 1, higher is better), computed on a 20,000-cell sample."
          />
          <KDiagnostics diagnostics={zones.diagnostics} chosenK={num(zones.k)} />
        </GlassPanel>
      </div>
    </div>
  );
}
