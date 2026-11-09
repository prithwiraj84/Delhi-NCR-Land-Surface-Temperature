/**
 * Methodology: the pipeline in reading order, for an educated non-specialist audience. Facts
 * that depend on the run (counts, accuracies, sensitivities) come from the bundle at build time.
 */
import Link from "next/link";
import { Reveal } from "../../_components/Reveal.jsx";
import { PageIntro } from "../../_components/ui.jsx";
import { JsonLd } from "../../../lib/site/JsonLd.jsx";
import { absoluteUrl, siteConfig } from "../../../lib/site/config.js";
import { SSP_LABEL, getFacts } from "../../../lib/site/facts.js";
import { pageMetadata } from "../../../lib/site/meta.js";

export const metadata = pageMetadata({
  title: "Methodology: satellites, machine learning and SHAP",
  description:
    "How the Delhi NCR Heat Atlas was built: Landsat, MODIS and VIIRS land surface temperature, 47 explanatory features from Google Earth Engine, XGBoost with spatial cross-validation, TreeSHAP explanations, heat zones, 250 m downscaling and CMIP6 projections.",
  path: "/methodology",
  type: "article",
});

function Step({ id, n, title, children }) {
  return (
    <Reveal as="section" id={id} aria-labelledby={`${id}-h`} className="scroll-mt-24 border-t border-hairline py-12 first:border-t-0 first:pt-0">
      <p className="font-mono text-[12.5px] text-ink-faint">Step {n}</p>
      <h2 id={`${id}-h`} className="mt-2 font-display text-[26px] font-semibold tracking-[-0.02em] text-ink-strong sm:text-[30px]">
        {title}
      </h2>
      <div className="prose-atlas mt-5">{children}</div>
    </Reveal>
  );
}

function Facts({ rows }) {
  return (
    <dl className="not-prose mt-6 grid gap-px overflow-hidden rounded-2xl border border-hairline bg-hairline sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="bg-surface-2 px-5 py-4">
          <dt className="text-[12.5px] text-ink-faint">{k}</dt>
          <dd className="mt-1 text-[14.5px] text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const STEPS = [
  ["area", "Study area and grid"],
  ["lst", "Measuring surface heat from space"],
  ["features", "Explanatory features"],
  ["model", "Machine-learning model and validation"],
  ["explain", "Explaining the model with SHAP"],
  ["zones", "Heat zones"],
  ["downscale", "250 m detail"],
  ["projections", "Projections to 2050"],
  ["compute", "Computation and reproducibility"],
];

export default function MethodologyPage() {
  const f = getFacts();
  const acc = f.accuracy;
  const howTo = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: "Methodology of the Delhi NCR Heat Atlas",
    description: metadata.description,
    author: { "@type": "Person", name: siteConfig.author.name, url: siteConfig.author.url },
    mainEntityOfPage: absoluteUrl("/methodology"),
    dateModified: f.generatedAt ?? undefined,
    proficiencyLevel: "Beginner",
    articleSection: STEPS.map(([, t]) => t),
  };

  return (
    <>
      <JsonLd data={howTo} />
      <PageIntro
        eyebrow="Methodology"
        title="How the atlas was built"
        lead="Nine steps from raw satellite archives to explained, validated and projected temperature maps. Each step lists what was done and why, in plain language."
      />

      <div className="mx-auto grid max-w-6xl gap-12 px-5 sm:px-8 lg:grid-cols-[14rem_1fr]">
        <nav aria-label="On this page" className="hidden lg:block">
          <ol className="sticky top-24 space-y-1 border-l border-hairline text-[13.5px]">
            {STEPS.map(([id, t], i) => (
              <li key={id}>
                <a href={`#${id}`} className="focus-ring -ml-px block border-l border-transparent py-1.5 pl-4 text-ink-muted transition-colors duration-200 hover:border-ink-muted hover:text-ink-strong">
                  <span className="mr-2 font-mono text-[12px] text-ink-faint">{i + 1}</span>
                  {t}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="min-w-0">
          <Step id="area" n={1} title="Study area and grid">
            <p>
              The atlas covers the Delhi National Capital Region: {f.area.km2?.toLocaleString("en-US")} km² across {f.area.districts} districts of Delhi, Haryana, Uttar Pradesh and Rajasthan, with district
              boundaries from geoBoundaries (ADM2). The region is divided into a regular grid of {f.area.cells?.toLocaleString("en-US")} cells of 1 km × 1 km in UTM zone 43N, so every frame and every layer refers to exactly
              the same places.
            </p>
            <p>
              All observations come from the <strong>pre-monsoon season, April to June</strong>, the hottest and driest part of the year, when surface heat matters most for health and energy demand and when clouds
              rarely block the satellites.
            </p>
            <Facts
              rows={[
                ["Grid", `${f.area.gridM} m cells, EPSG:32643 (UTM 43N), detail layer at ${f.area.fineM} m`],
                ["Season", "1 April – 30 June of each frame window"],
                ["Frames", `${f.years.observed.join(", ")} observed; ${f.years.projected.join(", ")} projected`],
                ["Districts", `${f.area.districts}, from geoBoundaries ADM2`],
              ]}
            />
          </Step>

          <Step id="lst" n={2} title="Measuring surface heat from space">
            <p>
              <strong>Land surface temperature (LST)</strong> is how hot the ground, roofs and roads are, not the air. Satellites infer it from the thermal infrared radiation that surfaces emit.
            </p>
            <p>
              <strong>Daytime</strong> maps use Landsat Collection 2 surface temperature (Landsat 5, 7, 8 and 9, 30 m) around 10:30 local time. Clouds, cloud shadows and saturated pixels are removed, clear scenes are combined
              per frame window, and the two Landsat paths that cover the region are aligned. Because the overpass time drifted over the decades, every frame is corrected to a common 10:45 IST using the morning heating rate from
              ERA5-Land.
            </p>
            <p>
              <strong>Night-time</strong> maps use MODIS Aqua (about 01:30–02:15 local time, 1 km). The 2000 frame uses MODIS Terra and the 2025 frame VIIRS; both are calibrated to Aqua on the years where the sensors overlap.
              No night-time thermal satellite record exists for 1990 and 1995, so those nights are model hindcasts.
            </p>
            <p>
              Every frame carries an <strong>evidence tier</strong>, observed, observed with few scenes, reconstructed, modelled or projected, which the site and the explorer show wherever the value appears.
            </p>
          </Step>

          <Step id="features" n={3} title="Explanatory features">
            <p>
              For each cell and frame, {f.features.count} features in {f.features.groups} groups describe what is on the ground and around it. All are computed in Google Earth Engine from public data:
            </p>
            <ul className="mt-4 list-disc space-y-2 pl-5 marker:text-ink-faint">
              <li>
                <strong>Spectral indices</strong> from Landsat: vegetation (NDVI), built-up and bare soil (NDBI), surface wetness (MNDWI), albedo, and spring green-up.
              </li>
              <li>
                <strong>Land cover</strong>: shares of built-up land, trees, water, cropland and bare land (GLC_FCS30D, JRC GHSL), plus landscape pattern metrics.
              </li>
              <li>
                <strong>Urban form</strong>: building volume, population density and distance to urban cores (GHSL).
              </li>
              <li>
                <strong>Terrain</strong> from SRTM: elevation, slope, aspect and the position of a cell relative to its surroundings.
              </li>
              <li>
                <strong>Weather</strong> from ERA5-Land: air temperature, vapour-pressure deficit, soil moisture, evaporation, solar radiation, wind and winter rainfall.
              </li>
            </ul>
            <p>Neighbourhood averages over 3 km and 15 km let the model see the cooling or warming reach of surrounding land, not only the cell itself.</p>
          </Step>

          <Step id="model" n={4} title="Machine-learning model and validation">
            <p>
              The main model is <strong>XGBoost</strong>, an ensemble of gradient-boosted decision trees trained on GPUs. It learns how temperature anomalies (each cell compared with the regional mean of its frame) depend on the
              features. Four other models are trained on exactly the same data as benchmarks: LightGBM, a random forest, a graph neural network and a linear ridge regression.
            </p>
            <p>
              Neighbouring cells are similar, so randomly held-out cells would make any model look better than it is. The headline score therefore comes from <strong>spatial block cross-validation</strong>: the region is cut
              into 20 km blocks, and each block is predicted by a model that never saw it. A second test, <strong>leave-one-epoch-out</strong>, predicts a whole year the model never saw.
            </p>
            <Facts
              rows={[
                ["Daytime, spatial blocks", acc.day?.spatial ? `R² ${acc.day.spatial.r2.toFixed(2)}, RMSE ${acc.day.spatial.rmse} °C` : "n/a"],
                ["Night-time, spatial blocks", acc.night?.spatial ? `R² ${acc.night.spatial.r2.toFixed(2)}, RMSE ${acc.night.spatial.rmse} °C` : "n/a"],
                ["Daytime, unseen years", acc.day?.temporal ? `R² ${acc.day.temporal.r2.toFixed(2)}, RMSE ${acc.day.temporal.rmse} °C` : "n/a"],
                ["Training rows (day)", acc.day?.nTrain ? `${acc.day.nTrain.toLocaleString("en-US")} cell-frames` : "n/a"],
              ]}
            />
            <p>
              The model is only trusted where the features of a cell resemble what it was trained on. This <strong>area of applicability</strong> is computed for every cell and frame, and cells outside it are hatched in the
              explorer.
            </p>
          </Step>

          <Step id="explain" n={5} title="Explaining the model with SHAP">
            <p>
              <strong>SHAP</strong> (SHapley Additive exPlanations) splits every prediction into contributions from each feature, measured in °C: for one cell it might say vegetation cools by 1.2 °C while bare soil warms by 2.0 °C.
              TreeSHAP computes these values exactly for tree models.
            </p>
            <p>
              Contributions are summed into the {f.features.groups} driver groups so related features (for example NDVI and its neighbourhood averages) are read together. To show how certain each importance is, it is
              recomputed on {f.bootstrap?.n ?? 50} resamples of {f.bootstrap?.blockKm ?? 10} km spatial blocks, giving the 95 % intervals on the findings page. Dependence curves and thresholds show where a driver’s effect changes
              sign or levels off.
            </p>
            <p>
              <strong>Important:</strong> SHAP explains the model, not the physical world. A strong SHAP value is a strong association that the model relies on, not proof of cause and effect.
            </p>
          </Step>

          <Step id="zones" n={6} title="Heat zones">
            <p>
              Cells are grouped by the <em>reasons</em> they are hot rather than by temperature alone: K-means clustering on the SHAP values separates places that heat up for different reasons, such as bare semi-arid land
              versus dense urban fabric. The four day zones are:
            </p>
            <ul className="mt-4 space-y-2">
              {f.zones.day.map((z) => (
                <li key={z.id} className="flex items-start gap-3">
                  <span aria-hidden="true" className="mt-2 size-2.5 shrink-0 rounded-full" style={{ background: z.color }} />
                  <span>
                    <strong>{z.name}</strong>
                    {z.caveat ? <span className="text-ink-faint"> (label note: no cluster shows a river signature)</span> : null}
                  </span>
                </li>
              ))}
            </ul>
            <p>Zone-level what-if simulations then estimate how feasible land-cover changes, such as more tree cover or water, would shift each zone’s temperature, within the model’s area of applicability.</p>
          </Step>

          <Step id="downscale" n={7} title="250 m detail">
            <p>
              <strong>Daytime</strong> detail at 250 m is observed directly: Landsat measures at 30 m, and the pixels are averaged to 250 m. <strong>Night-time</strong> satellites only see 1 km, so the night layer is
              sharpened to 250 m with a model trained on fine-scale features, and every sharpened value is labelled as downscaled.
            </p>
            {f.downscale ? (
              <p>
                A scale-invariance test checks that idea honestly: sharpen 4 km data to 1 km and compare with the real 1 km observations. The sharpened map scores R² {f.downscale.r2.toFixed(2)}, while simple smooth
                interpolation scores {f.downscale.bilinearR2.toFixed(2)}, so treat night-time patterns finer than 1 km as illustrative rather than measured.
              </p>
            ) : null}
          </Step>

          <Step id="projections" n={8} title="Projections to 2050">
            <p>
              The projected frames combine two changes. <strong>Climate</strong>: April–June air-temperature changes from the NASA NEX-GDDP-CMIP6 climate-model ensemble under {f.scenarios.map((s) => SSP_LABEL[s]).join(", ")}, scaled by
              how strongly the surface responds to air warming in the observed record (β ≈ {f.sensitivity.day?.beta} by day, {f.sensitivity.night?.beta} at night).
              <strong> Land use</strong>: a land-change model grows built-up land district by district, following the SSP urban-land and population trajectories, and the trained model re-predicts every cell with the new land
              cover.
            </p>
            <p>
              {f.projection?.nMc ?? 500} Monte Carlo draws sample the climate model, the sensitivity β, {f.projection?.nLand ?? 20} land-use realisations and the model’s own error; the medians and 5–95 % ranges are what the site
              reports. Changes are measured from a <strong>weather-normalised 2025</strong>, so one unusually hot or cool season does not shift every projection.
            </p>
            {f.projection?.omitted?.length > 0 && <p>Not included: {f.projection.omitted.join(", ")}. These are why the frames are scenarios, not forecasts.</p>}
          </Step>

          <Step id="compute" n={9} title="Computation and reproducibility">
            <p>
              Data are extracted with Google Earth Engine and the models trained on Kaggle{f.hardware?.gpus?.length ? ` (${f.hardware.gpus.length}× ${f.hardware.gpus[0]} GPUs)` : ""} in a single notebook of 13 sections, with
              cached stages so a run can resume. The pipeline writes a web bundle of compressed binary grids and JSON that this site and the explorer read directly; a validator checks the bundle against a written data
              contract before it is published.
            </p>
            <p>
              The code, notebook and bundle are on{" "}
              <a href={siteConfig.repo} rel="noopener noreferrer" target="_blank">
                GitHub
              </a>
              . The <Link href="/data">data page</Link> lists every source and file.
            </p>
          </Step>
        </div>
      </div>
    </>
  );
}
