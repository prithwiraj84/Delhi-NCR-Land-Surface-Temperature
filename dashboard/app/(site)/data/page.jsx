/**
 * Data: the public sources behind the atlas, the downloadable web bundle (file list read from
 * public/data at build time), how to reproduce it, and how to cite it.
 */
import { Download, ExternalLink } from "lucide-react";
import { Reveal } from "../../_components/Reveal.jsx";
import { PageIntro, Section } from "../../_components/ui.jsx";
import { siteConfig, withBase } from "../../../lib/site/config.js";
import { getFacts } from "../../../lib/site/facts.js";
import { pageMetadata } from "../../../lib/site/meta.js";

export const metadata = pageMetadata({
  title: "Data sources and downloads",
  description:
    "Every dataset behind the Delhi NCR Heat Atlas (Landsat, MODIS, VIIRS, ERA5-Land, GHSL, GLC_FCS30D, SRTM, NEX-GDDP-CMIP6) and the downloadable web bundle with land surface temperature grids, SHAP values and projections.",
  path: "/data",
  type: "website",
});

const SOURCES = [
  ["Landsat Collection 2, Level 2 (5, 7, 8, 9)", "USGS / NASA", "Daytime land surface temperature and spectral indices", "30 m"],
  ["MODIS MYD11A2 / MOD11A2", "NASA LP DAAC", "Night-time LST (Aqua, Terra), daytime context", "1 km"],
  ["VIIRS VNP21A1N", "NASA LP DAAC", "Night-time LST for 2025, calibrated to Aqua", "1 km"],
  ["ERA5-Land", "ECMWF / Copernicus", "Air temperature, humidity, soil moisture, radiation, wind, rainfall", "~9 km"],
  ["GHSL P2023A (built-up, volume, population)", "European Commission JRC", "Built-up surface, building volume, population density", "100 m"],
  ["GLC_FCS30D", "Liu et al., via awesome-gee-community-catalog", "Land-cover fractions and landscape pattern", "30 m"],
  ["SRTM GL1", "NASA / USGS", "Elevation, slope, aspect, topographic position", "30 m"],
  ["Global Surface Water", "European Commission JRC", "Water occurrence and distance to water", "30 m"],
  ["geoBoundaries ADM2", "William & Mary geoLab", "District boundaries of the study area", "vector"],
  ["NEX-GDDP-CMIP6", "NASA", "Climate-model air temperature for SSP1-2.6, SSP2-4.5, SSP5-8.5", "~25 km"],
  ["SSP urban land (Chen et al., 2020)", "Chen et al., Nature Communications", "District growth of urban land under each SSP", "1 km"],
  ["SSP population", "IIASA SSP database v3", "National urban-population trajectories", "national"],
];

function fmtBytes(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} B`;
}

const FILE_ROLE = [
  [/^manifest\.json$/, "Index: study area, frames, features, sources, notes"],
  [/^metrics\.json$/, "Model accuracy, cross-validation, calibration, timings"],
  [/^timeline_series/, "NCR, district and zone time series 1990–2050"],
  [/^cells\./, "Cell grid: id, row/column, longitude/latitude, district"],
  [/^cube_obs_/, "Observed LST per cell and frame"],
  [/^cube_ssp/, "Projected LST per cell, quantiles, AOA flags"],
  [/^cube_zones/, "Heat-zone membership per cell and frame"],
  [/^xai_\d+_features/, "Feature values per cell for one frame"],
  [/^xai_\d+_(day|night)/, "SHAP values and predictions per cell for one frame"],
  [/^shap_global/, "Global driver importance with bootstrap intervals"],
  [/^zones\.json$/, "Heat-zone definitions and diagnostics"],
  [/^dependence/, "SHAP dependence curves and thresholds"],
  [/^interactions/, "SHAP interaction strengths"],
  [/^model_web_/, "Compact model for in-browser what-if scenarios"],
  [/^districts\.geojson$/, "District boundaries"],
  [/^raster_index/, "Index of the 250 m raster images"],
  [/^scenario_coupling/, "Coupling of spectral indices to land-cover change"],
  [/^provenance/, "Per-frame provenance of every input"],
];

export default function DataPage() {
  const f = getFacts();
  const files = (f.files ?? []).filter((x) => !x.name.endsWith(".png"));
  const total = (f.files ?? []).reduce((a, x) => a + x.bytes, 0);
  const year = f.generatedAt ? new Date(f.generatedAt).getUTCFullYear() : new Date().getUTCFullYear();
  const citation = `${siteConfig.author.name} (${year}). ${siteConfig.name}: land surface temperature of Delhi NCR, 1990–2050, explained with machine learning. ${siteConfig.url}`;

  return (
    <>
      <PageIntro
        eyebrow="Data"
        title="Open sources, open results"
        lead="Everything in the atlas is built from public satellite, reanalysis and climate-model archives, and every result is published as a downloadable bundle."
      />

      <Section id="sources" eyebrow="Inputs" title="Data sources" intro="All inputs were accessed and processed through Google Earth Engine, then reduced to the common 1 km grid (250 m for the detail layer).">
        <Reveal className="card overflow-x-auto p-0">
          <table className="w-full min-w-[720px] text-left text-[14px]">
            <caption className="sr-only">Input datasets with provider, use and native resolution</caption>
            <thead>
              <tr className="border-b border-hairline text-[12.5px] text-ink-faint">
                <th scope="col" className="px-5 py-3.5 font-medium">Dataset</th>
                <th scope="col" className="px-3 py-3.5 font-medium">Provider</th>
                <th scope="col" className="px-3 py-3.5 font-medium">Used for</th>
                <th scope="col" className="px-5 py-3.5 text-right font-medium">Resolution</th>
              </tr>
            </thead>
            <tbody>
              {SOURCES.map(([name, by, use, res]) => (
                <tr key={name} className="border-b border-hairline/60 align-top last:border-0">
                  <th scope="row" className="px-5 py-3 font-medium text-ink-strong">
                    {name}
                  </th>
                  <td className="px-3 py-3 text-ink-muted">{by}</td>
                  <td className="px-3 py-3 text-ink-muted">{use}</td>
                  <td className="px-5 py-3 text-right font-mono text-[13px] text-ink-muted">{res}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Reveal>
        <p className="mt-4 text-[13.5px] text-ink-faint">The exact collection IDs, filters and processing of every layer and frame are recorded in the bundle’s manifest and provenance files.</p>
      </Section>

      <Section
        id="downloads"
        eyebrow="Outputs"
        title="Download the results"
        intro={`The web bundle is ${fmtBytes(total)} of JSON and compact binary grids (LSTB, gzip). Plus ${(f.files ?? []).length - files.length} raster images at 250 m.`}
      >
        <Reveal className="card overflow-hidden p-0">
          <ul className="divide-y divide-hairline/70">
            {files.map((x) => {
              const role = FILE_ROLE.find(([re]) => re.test(x.name))?.[1] ?? "";
              return (
                <li key={x.name}>
                  <a href={withBase(`/data/${x.name}`)} download className="group flex items-center gap-4 px-5 py-3 transition-colors duration-200 hover:bg-white/[0.03]">
                    <Download aria-hidden="true" className="size-4 shrink-0 text-ink-faint transition-colors duration-200 group-hover:text-ink-strong" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[13.5px] text-ink">{x.name}</span>
                      {role && <span className="block truncate text-[13px] text-ink-faint">{role}</span>}
                    </span>
                    <span className="shrink-0 font-mono text-[12.5px] text-ink-faint tnum">{fmtBytes(x.bytes)}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </Reveal>
        <p className="mt-4 text-[13.5px] text-ink-faint">The binary format and every field are documented in the data contract (docs/SPEC.md) in the repository.</p>
      </Section>

      <Section id="reproduce" eyebrow="Reproduce" title="Run it yourself">
        <div className="grid gap-4 md:grid-cols-2">
          <Reveal className="card p-6 sm:p-7">
            <h3 className="text-[16px] font-semibold text-ink-strong">Source code and notebook</h3>
            <p className="mt-2 text-[14.5px] leading-relaxed text-ink-muted">
              The pipeline is a single notebook of 13 sections that runs on Kaggle GPUs with a Google Earth Engine service account; a small launcher loads the code as a Kaggle dataset.
            </p>
            <a href={siteConfig.repo} rel="noopener noreferrer" target="_blank" className="btn btn-secondary mt-5 h-10 text-[14px]">
              View on GitHub
              <ExternalLink aria-hidden="true" className="size-4" />
            </a>
          </Reveal>
          <Reveal delay={70} className="card p-6 sm:p-7">
            <h3 className="text-[16px] font-semibold text-ink-strong">How to cite</h3>
            <p className="mt-3 rounded-xl border border-hairline bg-surface-3/60 p-4 font-mono text-[12.5px] leading-relaxed text-ink">{citation}</p>
            <p className="mt-3 text-[13.5px] text-ink-faint">Please also credit the original data providers listed above.</p>
          </Reveal>
        </div>
      </Section>
    </>
  );
}
