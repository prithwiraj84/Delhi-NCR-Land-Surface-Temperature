/**
 * Methodology: the pipeline in reading order, for an educated non-specialist audience. Facts
 * that depend on the run (counts, accuracies, sensitivities) come from the bundle at build time.
 */
import Link from "next/link";
import { Reveal } from "../../_components/Reveal.jsx";
import { PageIntro } from "../../_components/ui.jsx";
import { JsonLd } from "../../../lib/site/JsonLd.jsx";
import { absoluteUrl, siteConfig } from "../../../lib/site/config.js";
import { SSP_LABEL, getFacts, modelChoice, spell } from "../../../lib/site/facts.js";
import { pageMetadata } from "../../../lib/site/meta.js";

const META_FACTS = getFacts();

export const metadata = pageMetadata({
  title: "Methodology: satellites, machine learning and SHAP",
  description: `How the Delhi NCR Heat Atlas was built: Landsat, MODIS and VIIRS land surface temperature, ${
    META_FACTS.features.count ? `${META_FACTS.features.count} ` : ""
  }explanatory features from Google Earth Engine, XGBoost with spatial cross-validation, TreeSHAP explanations, heat zones, ${
    META_FACTS.area.fineM ? `${META_FACTS.area.fineM} m ` : "fine-scale "
  }downscaling and CMIP6 projections.`,
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

const BENCHMARK_PROSE = { lightgbm: "LightGBM", random_forest: "a random forest", gnn: "a graph neural network", ridge: "a linear ridge regression" };

const STEPS = [
  ["area", "Study area and grid"],
  ["lst", "Measuring surface heat from space"],
  ["features", "Explanatory features"],
  ["model", "Machine-learning model and validation"],
  ["explain", "Explaining the model with SHAP"],
  ["zones", "Heat zones"],
  ["downscale", META_FACTS.area.fineM ? `${META_FACTS.area.fineM} m detail` : "Fine-scale detail"],
  ["projections", META_FACTS.years.projected.length ? `Projections to ${META_FACTS.years.projected.at(-1)}` : "Projections"],
  ["compute", "Computation and reproducibility"],
];

export default function MethodologyPage() {
  const f = getFacts();
  const acc = f.accuracy;
  const title = Object.fromEntries(STEPS);
  const gridKm = f.area.gridM ? f.area.gridM / 1000 : null;
  const obsN = f.years.observed.at(-1);
  const dayOverpass = f.modes.find((m) => m.id === "day")?.overpass;
  const nightModelled = f.night?.tiers?.modelled ?? [];
  const yearsText = (ys) => (ys.length > 1 ? `${ys.slice(0, -1).join(", ")} and ${ys.at(-1)}` : String(ys[0] ?? ""));
  const nightBy = (prefix) => (f.frameSensors?.night ?? []).filter((r) => r.sensor.startsWith(prefix)).map((r) => r.year);
  const otherSensors = [
    nightBy("MODIS Terra").length ? `the ${yearsText(nightBy("MODIS Terra"))} frame comes from MODIS Terra` : null,
    nightBy("VIIRS").length ? `the ${yearsText(nightBy("VIIRS"))} frame from VIIRS` : null,
  ].filter(Boolean);
  const nightOther = otherSensors.length
    ? ` ${otherSensors.join(" and ").replace(/^t/, "T")}; ${otherSensors.length > 1 ? "both are" : "it is"} calibrated to Aqua on the years where the sensors overlap.`
    : "";
  const nOther = (acc.day?.benchmarks?.length ?? 0) - 1;
  const choice = modelChoice(f, "day");
  const scaled = f.projection?.patternScaled ?? [];
  const scaledIds = new Set(scaled.map((p) => p.id));
  const direct = f.scenarios.filter((s) => !scaledIds.has(s));
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
              boundaries from geoBoundaries (ADM2). The region is divided into a regular grid of {f.area.cells?.toLocaleString("en-US")} cells{gridKm ? ` of ${gridKm} km × ${gridKm} km` : ""} in UTM zone 43N, so every frame and
              every layer refers to exactly the same places.
            </p>
            <p>
              All observations come from the <strong>pre-monsoon season{f.seasonLabel ? `, ${f.seasonLabel}` : ""}</strong>, the hottest and driest part of the year, when surface heat matters most for health and energy demand
              and when clouds rarely block the satellites.
            </p>
            <Facts
              rows={[
                ["Grid", `${f.area.gridM} m cells, EPSG:32643 (UTM 43N), detail layer at ${f.area.fineM} m`],
                ["Season", f.seasonLabel ? `${f.seasonLabel} of each frame window` : "n/a"],
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
              <strong>Daytime</strong> maps use Landsat Collection 2 surface temperature from Landsat 5, 7, 8 and 9 around 10:30 local time. Their thermal bands measure at 120 m (Landsat 5), 60 m (Landsat 7) and 100 m
              (Landsat 8 and 9); the product delivers them resampled to a 30 m grid. Clouds, cloud shadows and saturated pixels are removed, clear scenes are combined per frame window, and the two Landsat paths that cover
              the region are aligned. Because the overpass time drifted over the decades, every frame is corrected to a common {dayOverpass ? `${dayOverpass} IST` : "reference time"} using the morning heating rate from
              ERA5-Land.
            </p>
            <p>
              <strong>Night-time</strong> maps use MODIS Aqua (about 1 km, a little after midnight).{nightOther}
              {nightModelled.length ? ` No night-time thermal satellite record exists for ${yearsText(nightModelled)}, so those nights are model hindcasts.` : ""}
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
            <p>
              Neighbourhood averages{gridKm && f.focalWindows.length ? ` over ${yearsText(f.focalWindows.map((w) => `${w * gridKm} km`))}` : ""} let the model see the cooling or warming reach of surrounding land, not only the
              cell itself.
            </p>
          </Step>

          <Step id="model" n={4} title="Machine-learning model and validation">
            <p>
              The main model is <strong>XGBoost</strong>, an ensemble of gradient-boosted decision trees trained on GPUs. It learns how temperature anomalies (each cell compared with the regional mean of its frame) depend on the
              features.
              {nOther > 0
                ? ` ${spell(nOther, true)} other models are trained on exactly the same data as benchmarks: ${yearsText(acc.day.benchmarks.filter((b) => b.id !== "xgboost").map((b) => BENCHMARK_PROSE[b.id] ?? b.label))}.`
                : ""}
              {choice ? ` ${choice}` : ""}
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
                ["Night-time, unseen years", acc.night?.temporal ? `R² ${acc.night.temporal.r2.toFixed(2)}, RMSE ${acc.night.temporal.rmse} °C` : "n/a"],
                ["Daytime, whole districts held out", acc.day?.district ? `R² ${acc.day.district.r2.toFixed(2)}, RMSE ${acc.day.district.rmse} °C` : "n/a"],
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
              <strong>SHAP</strong> (SHapley Additive exPlanations) splits every prediction into contributions from each feature, measured in °C: for one cell it might say how many degrees vegetation takes off and how many
              bare soil adds. TreeSHAP computes these values exactly for tree models.
            </p>
            <p>
              Contributions are summed into the {f.features.groups} driver groups so related features (for example NDVI and its neighbourhood averages) are read together. To show how certain each importance is, it is
              recomputed on {f.bootstrap?.n ? `${f.bootstrap.n} ` : ""}resamples of {f.bootstrap?.blockKm ? `${f.bootstrap.blockKm} km ` : ""}spatial blocks, giving the 95 % intervals on the findings page. Dependence curves and
              thresholds show where a driver’s effect changes sign or levels off.
            </p>
            <p>
              <strong>Important:</strong> SHAP explains the model, not the physical world. A strong SHAP value is a strong association that the model relies on, not proof of cause and effect.
            </p>
          </Step>

          <Step id="zones" n={6} title="Heat zones">
            <p>
              Cells are grouped by the <em>reasons</em> they are hot rather than by temperature alone: K-means clustering on the SHAP values separates places that heat up for different reasons, such as bare semi-arid land
              versus dense urban fabric.{f.zones.day.length ? ` The ${spell(f.zones.day.length)} day zones are:` : ""}
            </p>
            <ul className="mt-4 space-y-2">
              {f.zones.day.map((z) => (
                <li key={z.id} className="flex items-start gap-3">
                  <span aria-hidden="true" className="mt-2 size-2.5 shrink-0 rounded-full" style={{ background: z.color }} />
                  <span>
                    <strong>{z.name}</strong>
                  </span>
                </li>
              ))}
            </ul>
            <p>Zone-level what-if simulations then estimate how feasible land-cover changes, such as more tree cover or water, would shift each zone’s temperature, within the model’s area of applicability.</p>
          </Step>

          <Step id="downscale" n={7} title={title.downscale}>
            <p>
              <strong>Daytime</strong> detail{f.area.fineM ? ` at ${f.area.fineM} m` : ""} is observed directly: Landsat’s thermal bands measure at 60–120 m (delivered on a 30 m grid), and the pixels are averaged
              {f.area.fineM ? ` to ${f.area.fineM} m` : ""}. <strong>Night-time</strong> satellites only see about 1 km, so the night layer is sharpened with a model trained on fine-scale features, and every sharpened value is
              labelled as downscaled.
            </p>
            {f.downscale ? (
              <p>
                A scale-invariance test checks that idea honestly: sharpen{f.downscale.coarseM && f.downscale.fineM ? ` ${f.downscale.coarseM / 1000} km data to ${f.downscale.fineM / 1000} km` : " coarse data to the grid"} and compare
                with the real observations at that resolution. The sharpened map scores R² {f.downscale.r2.toFixed(2)}, while simple smooth interpolation scores {f.downscale.bilinearR2.toFixed(2)}
                {f.downscale.r2 < f.downscale.bilinearR2 ? ", so treat night-time patterns finer than the satellite pixel as illustrative rather than measured." : "."}
              </p>
            ) : null}
          </Step>

          <Step id="projections" n={8} title={title.projections}>
            <p>
              The projected frames combine two changes. <strong>Climate</strong>: {f.seasonLabel ? `${f.seasonLabel} ` : ""}air-temperature changes from the NASA NEX-GDDP-CMIP6 climate-model ensemble
              {direct.length ? ` under ${direct.map((s) => SSP_LABEL[s] ?? s).join(" and ")}` : ""}, scaled by how strongly the surface responds to air warming in the observed record
              {f.sensitivity.day ? ` (β ≈ ${f.sensitivity.day.beta} by day${f.sensitivity.night ? `, ${f.sensitivity.night.beta} at night` : ""})` : ""}.
              {scaled.map((p) => (
                <span key={p.id}>
                  {" "}
                  {SSP_LABEL[p.id] ?? p.id} is not in the NEX-GDDP-CMIP6 collection on Google Earth Engine, so its changes are pattern-scaled from {SSP_LABEL[p.from] ?? p.from} by the ratio of global-mean warming
                  {p.ratio ? ` (×${p.ratio.first} in ${p.ratio.firstYear} to ×${p.ratio.last} in ${p.ratio.lastYear})` : ""}.
                </span>
              ))}
              <strong> Land use</strong>: a land-change model grows built-up land district by district, following the SSP urban-land and population trajectories, and the trained model re-predicts every cell with the new land
              cover.
            </p>
            <p>
              {f.projection?.nMc ? `${f.projection.nMc} ` : ""}Monte Carlo draws sample the climate model, the sensitivity β, {f.projection?.nLand ? `${f.projection.nLand} ` : "several "}land-use realisations and the model’s
              own error; the medians and 5–95 % ranges are what the site reports. Changes are measured from a <strong>weather-normalised {obsN}</strong>, so one unusually hot or cool season does not shift every projection.
            </p>
            {f.projection?.omitted?.length > 0 && <p>Not included: {f.projection.omitted.join(", ")}. These are why the frames are scenarios, not forecasts.</p>}
          </Step>

          <Step id="compute" n={9} title="Computation and reproducibility">
            <p>
              Data are extracted with Google Earth Engine and the models trained on Kaggle{f.hardware?.gpus?.length ? ` (${f.hardware.gpus.length}× ${f.hardware.gpus[0]} GPUs)` : ""} in a single notebook of numbered sections,
              with cached stages so a run can resume. The pipeline writes a web bundle of compressed binary grids and JSON that this site and the explorer read directly; a validator checks the bundle against a written data
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
