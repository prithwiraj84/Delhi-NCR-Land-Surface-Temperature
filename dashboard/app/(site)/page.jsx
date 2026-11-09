/**
 * Landing page. Statically generated from the real web bundle (lib/site/facts.js): every number
 * below is read from public/data at build time.
 *
 * Hero choreography (choreograph skill, first-visit marketing moment):
 *   | Element      | Role       | Starts | Duration | Motion                              |
 *   | pill         | decoration | 0      | 450 ms   | fade only                           |
 *   | H1           | lead       | 0      | 600 ms   | fade + 16 px rise                   |
 *   | lead text    | support    | 100    | 600 ms   | fade + 10 px rise                   |
 *   | CTAs + meta  | support    | 180    | 600 ms   | fade + 8 px rise                    |
 *   | heat map     | support    | 150    | 1200 ms  | clip-path develop, top -> bottom    |
 *   | scan line    | decoration | 150    | 1200 ms  | rides the develop edge, then fades  |
 *   | float chips  | decoration | 900    | 450 ms   | fade only, after the map lands      |
 * Static: header, background grid. Everything is clickable from the first frame.
 */
import Link from "next/link";
import { ArrowRight, ArrowUpRight, BrainCircuit, CloudSun, Database, FlaskConical, Hexagon, LineChart, Map as MapIcon, Orbit, Satellite, Sparkles } from "lucide-react";
import { CompareSlider } from "../_components/CompareSlider.jsx";
import { Reveal } from "../_components/Reveal.jsx";
import { StatNumber } from "../_components/StatNumber.jsx";
import { YearScrubber } from "../_components/YearScrubber.jsx";
import { BarList } from "../_components/charts.jsx";
import { Eyebrow, Section } from "../_components/ui.jsx";
import { JsonLd } from "../../lib/site/JsonLd.jsx";
import { pageMetadata } from "../../lib/site/meta.js";
import { EXPLORER_SECTIONS, siteConfig, withBase } from "../../lib/site/config.js";
import { SSP_LABEL, SSP_STORY, getFacts, signed } from "../../lib/site/facts.js";
import { ramps, ssp as SSP_STYLE } from "../../src/design/tokens.js";

export const metadata = pageMetadata({ description: siteConfig.description, path: "/" });

const SECTION_ICON = { control: MapIcon, timeline: LineChart, drivers: BrainCircuit, zones: Hexagon, lab: FlaskConical, sources: Database };

function datasetLd(f) {
  const [w, s, e, n] = f.area.bbox ?? [75.47, 26.7, 78.46, 29.99];
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Delhi NCR land surface temperature, 1990–2050 (day and night, 1 km)",
    description:
      "Gridded land surface temperature for the Delhi National Capital Region at 1 km (250 m detail): eight observed pre-monsoon frames 1990–2025 from Landsat, MODIS and VIIRS, a SHAP-explained XGBoost model of its drivers, heat zones, and CMIP6 SSP projections for 2030–2050.",
    url: siteConfig.url,
    keywords: [...siteConfig.keywords],
    creator: { "@type": "Person", name: siteConfig.author.name, url: siteConfig.author.url },
    isAccessibleForFree: true,
    temporalCoverage: `${f.years.all[0] ?? 1990}/${f.years.all.at(-1) ?? 2050}`,
    spatialCoverage: {
      "@type": "Place",
      name: "Delhi National Capital Region, India",
      geo: { "@type": "GeoShape", box: `${s} ${w} ${n} ${e}` },
    },
    variableMeasured: [
      { "@type": "PropertyValue", name: "Land surface temperature (day, ~10:45 IST)", unitText: "°C" },
      { "@type": "PropertyValue", name: "Land surface temperature (night, ~01:30 IST)", unitText: "°C" },
      { "@type": "PropertyValue", name: "SHAP driver attribution", unitText: "°C" },
    ],
    measurementTechnique: ["Satellite thermal remote sensing (Landsat, MODIS, VIIRS)", "Gradient-boosted trees (XGBoost)", "SHAP (TreeSHAP)", "CMIP6 pattern scaling"],
    dateModified: f.generatedAt ?? undefined,
    distribution: [{ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${siteConfig.url}/data/manifest.json` }],
  };
}

export default function HomePage() {
  const f = getFacts();
  const day = f.day;
  const night = f.night;
  const acc = f.accuracy.day?.spatial;
  const hero = f.media?.rasters?.find((r) => r.mode === "day" && r.year === 2025);
  const first = f.media?.rasters?.find((r) => r.mode === "day" && r.year === 1990);
  const hottest = f.districts[0];
  const dDay = f.drivers.day.slice(0, 6);
  const dNight = f.drivers.night.slice(0, 6);
  const ratio = dDay.length > 1 ? dDay[0].value / dDay[1].value : null;
  const solarGradient = `linear-gradient(90deg, ${ramps.solar.join(", ")})`;
  const scrubFrames = (f.media?.rasters ?? []).map((r) => ({ mode: r.mode, year: r.year, tier: r.tier, file: r.file, width: r.width, height: r.height }));

  return (
    <>
      <JsonLd data={datasetLd(f)} />

      {/* ---------------------------------------------------------------- hero */}
      <section className="relative overflow-hidden">
        <div aria-hidden="true" className="bg-grid pointer-events-none absolute inset-0 -top-16" />
        <div aria-hidden="true" className="pointer-events-none absolute -top-48 right-[-10%] h-[36rem] w-[36rem] rounded-full bg-[radial-gradient(closest-side,rgba(167,139,250,0.16),transparent)]" />
        <div aria-hidden="true" className="pointer-events-none absolute -left-40 top-40 h-[30rem] w-[30rem] rounded-full bg-[radial-gradient(closest-side,rgba(69,224,255,0.08),transparent)]" />

        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 pb-16 pt-14 sm:px-8 sm:pt-20 lg:grid-cols-[1.05fr_1fr] lg:gap-10 lg:pb-24">
          <div>
            <p className="pill hero-fade">
              <span aria-hidden="true" className="size-1.5 animate-live-pulse rounded-full bg-ok" />
              Real satellite data · {f.years.all[0]} → {f.years.all.at(-1)}
            </p>
            <h1 className="hero-rise mt-6 font-display text-[44px] font-semibold leading-[1.02] tracking-[-0.04em] text-ink-strong sm:text-[64px]" style={{ "--rise": "16px" }}>
              How hot is Delhi NCR getting, <span className="text-gradient">and why?</span>
            </h1>
            <p className="hero-rise mt-6 max-w-xl text-[17px] leading-relaxed text-ink-muted sm:text-[19px]" style={{ "--d": "100ms", "--rise": "10px" }}>
              An atlas of land surface temperature across {f.area.km2?.toLocaleString("en-US")} km², built from {(f.years.observed.at(-1) ?? 2025) - (f.years.observed[0] ?? 1990)} years of satellite
              observations, explained by an AI model you can question, and projected to 2050 under three climate scenarios.
            </p>
            <div className="hero-in mt-9 flex flex-wrap items-center gap-3" style={{ "--d": "180ms", "--rise": "8px" }}>
              <Link href="/explore" className="btn btn-primary">
                Open the explorer
                <ArrowUpRight aria-hidden="true" className="size-4" strokeWidth={2} />
              </Link>
              <Link href="/findings" className="btn btn-secondary">
                Read the findings
                <ArrowRight aria-hidden="true" className="size-4" strokeWidth={2} />
              </Link>
            </div>
            <ul className="hero-in mt-9 flex flex-wrap gap-x-6 gap-y-2 text-[13.5px] text-ink-faint" style={{ "--d": "180ms", "--rise": "8px" }}>
              <li>{f.area.gridM / 1000} km grid · {f.area.fineM} m detail</li>
              <li>Day and night</li>
              <li>{f.area.districts} districts</li>
              <li>{f.scenarios.length} SSP scenarios</li>
            </ul>
          </div>

          {/* hero visual: the REAL 2025 daytime map develops like a satellite swath */}
          <div className="relative">
            <div className="card relative overflow-hidden p-3 sm:p-4">
              <div className="relative overflow-hidden rounded-[14px] bg-void" style={{ aspectRatio: hero ? `${hero.width} / ${hero.height}` : "960 / 1043" }}>
                {hero && (
                  <img
                    src={withBase(`/media/${hero.file}`)}
                    alt={`Daytime land surface temperature of Delhi NCR in the ${hero.year} frame, from Landsat 8 and 9 at 250 m: hotter semi-arid south-west, cooler irrigated north-east.`}
                    width={hero.width}
                    height={hero.height}
                    fetchPriority="high"
                    decoding="async"
                    className="hero-develop absolute inset-0 size-full object-contain"
                  />
                )}
                {f.districtShapes && (
                  <img src={withBase("/media/districts.svg")} alt="" aria-hidden="true" width={hero?.width} height={hero?.height} decoding="async" className="hero-fade pointer-events-none absolute inset-0 size-full object-contain" style={{ "--d": "900ms" }} />
                )}
                <span aria-hidden="true" className="hero-scanline pointer-events-none absolute inset-0">
                  <span className="absolute inset-x-0 top-0 h-px bg-brand-c shadow-[0_0_14px_2px_rgba(69,224,255,0.7)]" />
                </span>
              </div>
              <div className="hero-fade mt-3 flex items-center gap-3 px-1" style={{ "--d": "900ms" }}>
                <span className="text-[12px] font-medium text-ink-muted tnum">{f.media?.domains?.day?.[0] ?? 30}°</span>
                <span aria-hidden="true" className="h-2 flex-1 rounded-full" style={{ background: solarGradient }} />
                <span className="text-[12px] font-medium text-ink-muted tnum">{f.media?.domains?.day?.[1] ?? 58}°C</span>
              </div>
            </div>
            {hottest && (
              <div className="hero-fade glass absolute -left-4 bottom-[4.5rem] hidden rounded-2xl px-4 py-3 sm:block" style={{ "--d": "1000ms" }}>
                <p className="text-[12px] text-ink-faint">Hottest district, 2025 (day)</p>
                <p className="mt-0.5 text-[15px] font-semibold text-ink-strong">
                  {hottest.name} <span className="font-mono text-solar tnum">{hottest.day2025.toFixed(1)} °C</span>
                </p>
              </div>
            )}
            {acc && (
              <div className="hero-fade glass absolute -right-3 top-8 hidden rounded-2xl px-4 py-3 sm:block" style={{ "--d": "1080ms" }}>
                <p className="text-[12px] text-ink-faint">Model accuracy (spatial CV)</p>
                <p className="mt-0.5 font-mono text-[15px] font-semibold text-ink-strong tnum">R² {acc.r2.toFixed(2)}</p>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- stats */}
      <section aria-label="Key numbers" className="mx-auto max-w-6xl px-5 sm:px-8">
        <Reveal className="grid grid-cols-2 gap-px overflow-hidden rounded-[20px] border border-hairline bg-hairline lg:grid-cols-4">
          {[
            { value: day?.change, format: { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero" }, suffix: " °C", label: `Daytime surface warming, NCR mean ${day?.first?.year}–${day?.last?.year}` },
            { value: acc?.r2, format: { minimumFractionDigits: 2, maximumFractionDigits: 2 }, label: "Model R² on districts it never saw (20 km spatial blocks)" },
            { value: f.area.km2, format: { maximumFractionDigits: 0 }, suffix: " km²", label: "Mapped cell by cell at 1 km, with 250 m detail" },
            { value: f.years.all.length, format: { maximumFractionDigits: 0 }, label: `Time frames, ${f.years.all[0]}–${f.years.all.at(-1)}: ${f.years.observed.length} observed, ${f.years.projected.length} projected` },
          ]
            .filter((s) => Number.isFinite(s.value))
            .map((s) => (
              <div key={s.label} className="bg-surface-2 p-6 sm:p-7">
                <p className="font-display text-[34px] font-semibold tracking-[-0.03em] text-ink-strong tnum sm:text-[40px]">
                  <StatNumber value={s.value} format={s.format} suffix={s.suffix ?? ""} />
                </p>
                <p className="mt-2 text-[14px] leading-snug text-ink-muted">{s.label}</p>
              </div>
            ))}
        </Reveal>
      </section>

      {/* ---------------------------------------------------------------- how it works */}
      <Section
        id="how"
        eyebrow="How it works"
        title="From satellite pixels to explanations"
        intro="Four steps turn raw thermal imagery into an answer you can interrogate. The full method, with every data source and validation check, is on the methodology page."
      >
        <ol className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: Satellite, step: "Observe", title: "Satellites measure surface heat", body: `Landsat by day (30 m) and MODIS / VIIRS by night (1 km), composited over the pre-monsoon season (April–June) for ${f.years.observed.length} frames from ${f.years.observed[0]} to ${f.years.observed.at(-1)}.` },
            { icon: Orbit, step: "Learn", title: "A model learns what makes places hot", body: `Gradient-boosted trees (XGBoost) relate temperature to ${f.features.count} features: vegetation, built-up land, water, terrain, soil moisture and weather, benchmarked against four other models.` },
            { icon: Sparkles, step: "Explain", title: "SHAP shows why, cell by cell", body: `TreeSHAP splits every prediction into the contribution of each driver, with confidence intervals from ${f.bootstrap?.n ?? 50} spatial bootstrap resamples. Clusters of similar explanations become heat zones.` },
            { icon: CloudSun, step: "Project", title: "Climate scenarios to 2050", body: `CMIP6 temperature changes for ${f.scenarios.map((s) => SSP_LABEL[s]).join(", ")}, scaled by the observed surface sensitivity and combined with simulated urban growth in ${f.projection?.nMc ?? 500} Monte Carlo draws.` },
          ].map((s, i) => (
            <Reveal as="li" key={s.step} delay={i * 70} className="card p-6">
              <div className="flex items-center justify-between">
                <span className="grid size-10 place-items-center rounded-xl border border-hairline-strong bg-white/[0.04] text-ink-strong">
                  <s.icon aria-hidden="true" className="size-5" strokeWidth={1.6} />
                </span>
                <span className="font-mono text-[12px] text-ink-faint">0{i + 1}</span>
              </div>
              <p className="mt-5 text-[13px] font-medium text-ink-faint">{s.step}</p>
              <h3 className="mt-1 text-[17px] font-semibold leading-snug text-ink-strong">{s.title}</h3>
              <p className="mt-3 text-[14px] leading-relaxed text-ink-muted">{s.body}</p>
            </Reveal>
          ))}
        </ol>
      </Section>

      {/* ---------------------------------------------------------------- compare */}
      {hero && first && (
        <Section
          id="compare"
          eyebrow="Then and now"
          title={`${f.years.observed[0]} vs ${f.years.observed.at(-1)}: drag to compare`}
          intro={`Daytime surface temperature on the same colour scale. The NCR mean rose from ${day.first.mean.toFixed(1)} °C to ${day.last.mean.toFixed(1)} °C, about ${signed(day.trend?.perDecade, 2, " °C")} per decade, while cities grew into farmland.`}
        >
          <Reveal className="mx-auto max-w-3xl">
            <CompareSlider
              before={withBase(`/media/${first.file}`)}
              after={withBase(`/media/${hero.file}`)}
              beforeLabel={String(first.year)}
              afterLabel={String(hero.year)}
              width={hero.width}
              height={hero.height}
              alt={`Comparison of daytime land surface temperature in ${first.year} and ${hero.year}.`}
              caption={`The ${first.year} frame comes from Landsat 5 alone and has fewer clear scenes (tier "observed, sparse"); both frames are corrected to a common 10:45 IST overpass.`}
            />
          </Reveal>
        </Section>
      )}

      {/* ---------------------------------------------------------------- time-lapse */}
      {scrubFrames.length > 0 && (
        <Section
          id="timelapse"
          eyebrow="Time-lapse"
          title="Watch three decades of heat"
          intro="Step through every observed frame, by day and by night. Night-time heat is where cities show up: built-up land releases the heat it stored during the day."
        >
          <Reveal className="mx-auto max-w-3xl">
            <YearScrubber frames={scrubFrames} basePath={siteConfig.basePath} />
          </Reveal>
        </Section>
      )}

      {/* ---------------------------------------------------------------- drivers */}
      {dDay.length > 0 && (
        <Section
          id="drivers"
          eyebrow="Explainable AI"
          title="What drives the heat"
          intro={`Mean absolute SHAP contribution of each driver group, in °C. By day, built-up and bare surfaces (high NDBI) dominate${ratio ? `, about ${ratio.toFixed(1)}× the effect of vegetation` : ""}; by night, built-up land, terrain and distance to the urban core matter most.`}
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <Reveal className="card p-6 sm:p-7">
              <div className="mb-5 flex items-center justify-between">
                <h3 className="text-[16px] font-semibold text-ink-strong">By day</h3>
                <span className="text-[12.5px] text-ink-faint">mean |SHAP|, °C · 95 % CI</span>
              </div>
              <BarList items={dDay} label="Daytime driver importance" accent="linear-gradient(90deg, #A78BFA, #6D8DFF)" />
            </Reveal>
            <Reveal delay={80} className="card p-6 sm:p-7">
              <div className="mb-5 flex items-center justify-between">
                <h3 className="text-[16px] font-semibold text-ink-strong">By night</h3>
                <span className="text-[12.5px] text-ink-faint">mean |SHAP|, °C · 95 % CI</span>
              </div>
              <BarList items={dNight} label="Night-time driver importance" accent="linear-gradient(90deg, #6D8DFF, #45E0FF)" />
            </Reveal>
          </div>
          <p className="mt-5 text-[13.5px] text-ink-faint">SHAP explains the model, not physical causation. See the methodology for what that means.</p>
        </Section>
      )}

      {/* ---------------------------------------------------------------- futures */}
      {f.scenarios.length > 0 && (
        <Section
          id="futures"
          eyebrow="Projections"
          title="Three futures for 2050"
          intro="Median change of the NCR mean surface temperature by 2050, relative to 2025 with that year's weather removed. These are scenarios, not forecasts."
        >
          <div className="grid gap-4 md:grid-cols-3">
            {f.scenarios.map((s, i) => {
              const pd = day?.projections?.[s];
              const pn = night?.projections?.[s];
              return (
                <Reveal key={s} delay={i * 70} className="card overflow-hidden p-6">
                  <span aria-hidden="true" className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${SSP_STYLE[s]?.color}, transparent)` }} />
                  <p className="text-[13px] font-semibold" style={{ color: SSP_STYLE[s]?.color }}>
                    {SSP_LABEL[s]}
                  </p>
                  <p className="mt-1 text-[14px] text-ink-muted">{SSP_STORY[s]}</p>
                  <dl className="mt-6 grid grid-cols-2 gap-4">
                    <div>
                      <dt className="text-[12.5px] text-ink-faint">Day</dt>
                      <dd className="mt-1 font-display text-[30px] font-semibold tracking-[-0.03em] text-ink-strong tnum">{signed(pd?.delta, 1, "")}°</dd>
                      {Number.isFinite(pd?.lo) && <dd className="text-[12.5px] text-ink-faint tnum">range {signed(pd.lo, 1, "")} to {signed(pd.hi, 1, "")}</dd>}
                    </div>
                    <div>
                      <dt className="text-[12.5px] text-ink-faint">Night</dt>
                      <dd className="mt-1 font-display text-[30px] font-semibold tracking-[-0.03em] text-ink-strong tnum">{signed(pn?.delta, 1, "")}°</dd>
                      {Number.isFinite(pn?.lo) && <dd className="text-[12.5px] text-ink-faint tnum">range {signed(pn.lo, 1, "")} to {signed(pn.hi, 1, "")}</dd>}
                    </div>
                  </dl>
                </Reveal>
              );
            })}
          </div>
          <Reveal className="card mt-4 grid gap-6 p-6 sm:p-7 md:grid-cols-[auto_1fr] md:items-center">
            <Eyebrow>Why so modest?</Eyebrow>
            <p className="text-[15px] leading-relaxed text-ink-muted">
              Climate alone adds {signed(day?.projections?.ssp245?.climate, 1)} by day under SSP2-4.5, but new built-up land replaces hot, bare farmland and takes off about{" "}
              {Number.isFinite(day?.projections?.ssp245?.land) ? Math.abs(day.projections.ssp245.land).toFixed(1) : "0.4"} °C. And in this record the surface warms only {f.sensitivity.day?.beta ?? "~0.7"} °C per °C of air temperature by day ({f.sensitivity.night?.beta ?? "~0.3"} °C at night), an
              uncertain estimate that dominates the projection ranges.
            </p>
          </Reveal>
        </Section>
      )}

      {/* ---------------------------------------------------------------- explorer */}
      <Section id="explore" eyebrow="Interactive explorer" title="Six ways into the data" intro="The explorer renders all cells in 3D on your GPU. Every view links to the same moment in time, so you can move from a hot spot to its explanation in one click.">
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {EXPLORER_SECTIONS.map((s, i) => {
            const Icon = SECTION_ICON[s.hash] ?? MapIcon;
            return (
              <Reveal as="li" key={s.hash} delay={Math.min(i, 5) * 50}>
                <a href={withBase(`/explore#/${s.hash}`)} className="card group flex h-full flex-col p-6 transition-[border-color,transform] duration-200 hover:border-hairline-strong active:scale-[0.99]">
                  <span className="grid size-10 place-items-center rounded-xl border border-hairline-strong bg-white/[0.04] text-ink-strong">
                    <Icon aria-hidden="true" className="size-5" strokeWidth={1.6} />
                  </span>
                  <h3 className="mt-5 flex items-center gap-1.5 text-[17px] font-semibold text-ink-strong">
                    {s.label}
                    <ArrowUpRight aria-hidden="true" className="size-4 text-ink-faint transition-transform duration-200 ease-out group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                  </h3>
                  <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">{s.blurb}</p>
                </a>
              </Reveal>
            );
          })}
        </ul>
      </Section>

      {/* ---------------------------------------------------------------- CTA */}
      <section className="mx-auto max-w-6xl px-5 sm:px-8">
        <Reveal className="card relative overflow-hidden px-6 py-14 text-center sm:px-12">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_50%_0%,rgba(109,141,255,0.18),transparent)]" />
          <h2 className="relative mx-auto max-w-2xl font-display text-[30px] font-semibold leading-tight tracking-[-0.025em] text-ink-strong sm:text-[40px]">
            Ask the map your own questions
          </h2>
          <p className="relative mx-auto mt-4 max-w-xl text-[16px] leading-relaxed text-ink-muted">
            Pick any 1 km cell, see why it is hot, and simulate what more trees or water would change.
          </p>
          <div className="relative mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/explore" className="btn btn-primary">
              Open the explorer
              <ArrowUpRight aria-hidden="true" className="size-4" strokeWidth={2} />
            </Link>
            <Link href="/learn" className="btn btn-secondary">
              Learn the concepts
            </Link>
          </div>
        </Reveal>
      </section>
    </>
  );
}
