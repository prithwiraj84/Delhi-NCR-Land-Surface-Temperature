/**
 * SOURCES route (UI_SPEC §3.9): where every number comes from.
 *   provenance swimlanes 1985–2050 (+ source cards) · frame provenance table · caveats grouped
 *   with anchors · contract validation (the bundle validator's report) · downloads + citation.
 * The map stage is hidden behind this route.
 */
import { useMemo } from "react";
import { BookOpenText, CheckCircle2, ShieldAlert } from "lucide-react";
import { useData } from "../../state/DataContext.jsx";
import { useAsset, useBundleStatus, useTimeline } from "../../data/hooks.js";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { ScanSkeleton } from "../../components/ui/ScanSkeleton.jsx";
import { Unavailable } from "../../viz/Unavailable.jsx";
import { buildCaveats } from "./caveats.js";
import { CaveatsList } from "./CaveatsList.jsx";
import { Downloads } from "./Downloads.jsx";
import { FrameProvenanceTable } from "./FrameProvenanceTable.jsx";
import { ProvenanceSwimlanes } from "./ProvenanceSwimlanes.jsx";
import { frameRows, swimlanes } from "./sourcesModel.js";

function ValidationReport({ validation }) {
  if (!validation) return <p className="text-xs text-ink-muted">The contract validation runs when the browser is idle after boot…</p>;
  const errors = validation.errors ?? [];
  const warnings = validation.warnings ?? [];
  const Icon = errors.length ? ShieldAlert : CheckCircle2;
  return (
    <div className="space-y-2 text-xs">
      <p className="flex items-center gap-1.5 text-ink">
        <Icon aria-hidden="true" className={errors.length ? "size-4 text-crit" : "size-4 text-ok"} />
        {errors.length ? `${errors.length} contract error${errors.length === 1 ? "" : "s"}` : "Bundle matches the data contract"}
        <span className="text-ink-muted">
          · {warnings.length} warning{warnings.length === 1 ? "" : "s"}
          {validation.schema ? ` · schema ${validation.schema}` : ""}
        </span>
      </p>
      {errors.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-ink">
          {errors.map((e, i) => (
            <li key={i}>{String(e)}</li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <details>
          <summary className="focus-ring cursor-pointer rounded text-ink-muted">Warnings ({warnings.length})</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-muted">
            {warnings.map((w, i) => (
              <li key={i}>{String(w)}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function SourcesView() {
  const { status, manifest, schema } = useData();
  const tl = useTimeline();
  const bundle = useBundleStatus();
  const prov = useAsset("provenance");
  const timeline = tl.status === "ready" ? tl.data : null;
  const provenance = prov.status === "ready" ? prov.data : null;
  const lanes = useMemo(() => swimlanes(provenance, manifest), [provenance, manifest]);
  const frames = useMemo(() => frameRows(timeline, provenance), [timeline, provenance]);
  const caveats = useMemo(() => buildCaveats(manifest, { schema }), [manifest, schema]);

  if (status === "loading") return <ScanSkeleton label="Loading sources" height={300} className="m-4" />;
  if (status !== "ready" || !manifest) return <Unavailable status={status} reason="The web bundle has not been loaded." className="m-4" />;

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-3 px-3 pb-10 pt-4 sm:px-5">
      <header>
        <p className="micro-label flex items-center gap-1.5">
          <BookOpenText aria-hidden="true" className="size-3.5 text-signal" /> Sources
        </p>
        <h1 className="font-display text-2xl font-semibold text-ink-strong">Where every number comes from</h1>
        <p className="max-w-3xl text-sm text-ink-muted">
          Bundle schema {manifest.schema_version ?? "?"} · data mode <span className={manifest.data_mode === "synthetic" ? "text-warn" : "text-ink"}>{manifest.data_mode ?? "?"}</span>
          {manifest.generated_at ? ` · generated ${String(manifest.generated_at).slice(0, 10)}` : ""}. Evidence tiers come from the manifest, frame by frame.
        </p>
      </header>
      {prov.status === "loading" ? <ScanSkeleton label="Loading provenance" height={160} /> : <ProvenanceSwimlanes lanes={lanes} now={timeline?.now ?? 2025} domain={[Math.min(1985, timeline?.first ?? 1985), Math.max(2050, timeline?.last ?? 2050)]} />}
      <FrameProvenanceTable rows={frames} />
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <CaveatsList caveats={caveats} />
        <div className="min-w-0 space-y-3">
          <HudFrame solid title="Contract validation">
            <ValidationReport validation={bundle.validation} />
          </HudFrame>
          <Downloads manifest={manifest} source={bundle.source} />
        </div>
      </div>
    </div>
  );
}

export default SourcesView;
