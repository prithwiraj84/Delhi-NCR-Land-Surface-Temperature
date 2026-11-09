/**
 * Findings: the results of the pipeline run in plain language, with server-rendered charts.
 * Every number is read from the web bundle at build time (lib/site/facts.js).
 */
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Reveal } from "../../_components/Reveal.jsx";
import { BarList, BudgetBars, TrendChart } from "../../_components/charts.jsx";
import { Eyebrow, PageIntro, Section } from "../../_components/ui.jsx";
import { JsonLd } from "../../../lib/site/JsonLd.jsx";
import { absoluteUrl, siteConfig, withBase } from "../../../lib/site/config.js";
import { SSP_LABEL, getFacts, signed } from "../../../lib/site/facts.js";
import { ssp as SSP_STYLE } from "../../../src/design/tokens.js";
import { pageMetadata } from "../../../lib/site/meta.js";

export const metadata = pageMetadata({
  title: "Findings: how Delhi NCR's surface heat changed, 1990–2050",
  description:
    "Results of the Delhi NCR Heat Atlas: daytime surface warming since 1990, a night-time urban heat island that keeps growing, the drivers identified by SHAP, model accuracy, and CMIP6 projections to 2050.",
  path: "/findings",
  type: "article",
});

function Takeaway({ value, label, body, accent, delay }) {
  return (
    <Reveal delay={delay} className="card p-6 sm:p-7">
      <p className="font-display text-[38px] font-semibold leading-none tracking-[-0.035em] tnum" style={{ color: accent ?? "var(--ink-strong)" }}>
        {value}
      </p>
      <p className="mt-3 text-[15px] font-semibold text-ink-strong">{label}</p>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">{body}</p>
    </Reveal>
  );
}

export default function FindingsPage() {
  const f = getFacts();
  const { day, night } = f;
  const accDay = f.accuracy.day;
  const accNight = f.accuracy.night;
  const nightFrames = night?.frames ?? [];
  const uhiFirst = nightFrames.find((r) => r.tier !== "modelled" && Number.isFinite(r.uhi));
  const topDistricts = f.districts.slice(0, 10);
  const coolest = f.districts.at(-1);

  const articleLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: "How Delhi NCR's land surface temperature changed, 1990–2050",
    description: metadata.description,
    author: { "@type": "Person", name: siteConfig.author.name, url: siteConfig.author.url },
    datePublished: f.generatedAt ?? undefined,
    dateModified: f.generatedAt ?? undefined,
    mainEntityOfPage: absoluteUrl("/findings"),
    image: absoluteUrl("/opengraph-image"),
    about: ["Urban heat island", "Land surface temperature", "Delhi NCR", "Explainable AI"],
  };

  return (
    <>
      <JsonLd data={articleLd} />
      <PageIntro
        eyebrow="Findings"
        title="What 35 years of satellite data say about Delhi NCR's heat"
        lead={`Surfaces across the region are about ${signed(day?.change, 1)} warmer by day than in ${day?.first?.year}, cities have become heat traps at night, and the model shows which land-cover choices drive both.`}
      />

      {/* -------------------------------------------------------------- takeaways */}
      <section aria-label="Key takeaways" className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Takeaway
            delay={0}
            value={signed(day?.change, 1)}
            accent="var(--solar)"
            label={`Daytime warming, ${day?.first?.year}–${day?.last?.year}`}
            body={`The NCR mean rose from ${day?.first?.mean.toFixed(1)} to ${day?.last?.mean.toFixed(1)} °C: a trend of ${signed(day?.trend?.perDecade, 2)} per decade (95 % range ${day?.trend?.ci?.[0]} to ${day?.trend?.ci?.[1]}).`}
          />
          <Takeaway
            delay={60}
            value={signed(night?.change, 1)}
            accent="var(--lunar)"
            label={`Night-time warming, ${night?.first?.year}–${night?.last?.year}`}
            body={`Night surfaces warmed ${signed(night?.trend?.perDecade, 2)} per decade. Before ${night?.first?.year} no night-time satellite record exists, so earlier nights are model hindcasts.`}
          />
          <Takeaway
            delay={120}
            value={signed(night?.uhi, 1)}
            label="Night-time urban heat island"
            body={`At night, built-up land is ${night?.uhi?.toFixed(1)} °C warmer than the countryside${uhiFirst ? `, up from ${uhiFirst.uhi.toFixed(1)} °C in ${uhiFirst.year}` : ""}. By day the sign flips: cities are ${Math.abs(day?.uhi ?? 0).toFixed(1)} °C cooler than sun-baked bare farmland.`}
          />
          <Takeaway
            delay={180}
            value={accDay?.spatial ? accDay.spatial.r2.toFixed(2) : "n/a"}
            label="Model accuracy (R²), daytime"
            body={`Tested on 20 km blocks the model never saw: RMSE ${accDay?.spatial?.rmse} °C by day and R² ${accNight?.spatial?.r2.toFixed(2)} (RMSE ${accNight?.spatial?.rmse} °C) at night.`}
          />
        </div>
      </section>

      {/* -------------------------------------------------------------- trends */}
      <Section
        id="trends"
        eyebrow="Trends"
        title="Thirty-five years observed, twenty-five projected"
        intro="NCR mean surface temperature for every frame. Filled points are well-observed frames, hollow points rest on fewer observations; the shaded band is the 95 % interval of each level. After 2025 the coloured fans show the three climate scenarios."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <Reveal className="card p-5 sm:p-6">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h3 className="text-[16px] font-semibold text-ink-strong">Day · ~10:45 IST</h3>
              <span className="text-[12.5px] text-ink-faint">°C, Landsat</span>
            </div>
            <TrendChart id="trend-day" mode="day" summary={day} scenarios={f.scenarios} title="Daytime NCR mean land surface temperature, 1990–2050" />
          </Reveal>
          <Reveal delay={80} className="card p-5 sm:p-6">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h3 className="text-[16px] font-semibold text-ink-strong">Night · ~01:30 IST</h3>
              <span className="text-[12.5px] text-ink-faint">°C, MODIS / VIIRS</span>
            </div>
            <TrendChart id="trend-night" mode="night" summary={night} scenarios={f.scenarios} title="Night-time NCR mean land surface temperature, 1990–2050" />
          </Reveal>
        </div>
      </Section>

      {/* -------------------------------------------------------------- districts */}
      {topDistricts.length > 0 && (
        <Section
          id="districts"
          eyebrow="Where"
          title="The hottest districts are not the biggest cities"
          intro={`By day the semi-arid south-west (Rajasthan and southern Haryana) runs hottest; ${coolest ? `${coolest.name} in the irrigated north is the coolest at ${coolest.day2025.toFixed(1)} °C` : "the irrigated north is coolest"}. Delhi's surfaces are milder by day but stay warm through the night.`}
        >
          <Reveal className="card overflow-x-auto p-0">
            <table className="w-full min-w-[640px] text-left text-[14px]">
              <caption className="sr-only">Ten hottest districts by 2025 daytime mean land surface temperature</caption>
              <thead>
                <tr className="border-b border-hairline text-[12.5px] text-ink-faint">
                  <th scope="col" className="px-5 py-3.5 font-medium">#</th>
                  <th scope="col" className="px-3 py-3.5 font-medium">District</th>
                  <th scope="col" className="px-3 py-3.5 text-right font-medium">Day 2025</th>
                  <th scope="col" className="px-3 py-3.5 text-right font-medium">Change since {day?.first?.year}</th>
                  <th scope="col" className="px-3 py-3.5 text-right font-medium">Night 2025</th>
                  <th scope="col" className="px-5 py-3.5 text-right font-medium">Day 2050 · SSP2-4.5</th>
                </tr>
              </thead>
              <tbody>
                {topDistricts.map((d, i) => (
                  <tr key={d.id} className="border-b border-hairline/60 last:border-0">
                    <td className="px-5 py-3 font-mono text-[13px] text-ink-faint tnum">{i + 1}</td>
                    <th scope="row" className="px-3 py-3 font-medium text-ink-strong">
                      {d.name} <span className="ml-1 text-[12.5px] font-normal text-ink-faint">{d.state}</span>
                    </th>
                    <td className="px-3 py-3 text-right font-mono text-ink tnum">{d.day2025.toFixed(1)} °C</td>
                    <td className="px-3 py-3 text-right font-mono tnum" style={{ color: (d.dayChange ?? 0) > 0 ? "var(--solar)" : "var(--ssp126)" }}>
                      {signed(d.dayChange, 1)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-ink-muted tnum">{d.night2025 !== null ? `${d.night2025.toFixed(1)} °C` : "n/a"}</td>
                    <td className="px-5 py-3 text-right font-mono text-ink-muted tnum">{d.day2050 !== null ? `${d.day2050.toFixed(1)} °C` : "n/a"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Reveal>
          <p className="mt-4 text-[13.5px] text-ink-faint">
            District means over 1 km cells. Changes compare the first and last observed frames, not a fitted trend. The full ledger for all {f.area.districts} districts is in the{" "}
            <a href={withBase("/explore#/timeline")} className="text-ink-muted underline decoration-hairline-strong underline-offset-4 hover:text-ink-strong">
              explorer timeline
            </a>
            .
          </p>
        </Section>
      )}

      {/* -------------------------------------------------------------- drivers */}
      <Section
        id="drivers"
        eyebrow="Why"
        title="What the AI model says drives the heat"
        intro="Average size of each driver group's SHAP contribution to a cell's temperature, with 95 % bootstrap intervals. Larger means the model leans on it more to explain why one place is hotter than another."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <Reveal className="card p-6 sm:p-7">
            <h3 className="mb-5 text-[16px] font-semibold text-ink-strong">By day</h3>
            <BarList items={f.drivers.day.slice(0, 10)} label="Daytime driver importance, top 10" accent="linear-gradient(90deg, #A78BFA, #6D8DFF)" />
          </Reveal>
          <Reveal delay={80} className="card p-6 sm:p-7">
            <h3 className="mb-5 text-[16px] font-semibold text-ink-strong">By night</h3>
            <BarList items={f.drivers.night.slice(0, 10)} label="Night-time driver importance, top 10" accent="linear-gradient(90deg, #6D8DFF, #45E0FF)" />
          </Reveal>
        </div>
        <Reveal className="mt-4 grid gap-4 md:grid-cols-3">
          {[
            { t: "Bare and built surfaces heat by day", b: "High NDBI (built-up and bare, dry soil) is by far the strongest daytime driver. Harvested fields in April–June are some of the hottest surfaces in the region." },
            { t: "Vegetation and water cool", b: "Greener cells (high NDVI) and wetter soils run cooler: evaporation spends energy that would otherwise heat the surface." },
            { t: "Cities hold heat at night", b: "At night the built-up fraction, terrain and distance to the urban core lead: buildings store daytime heat and release it after dark." },
          ].map((x) => (
            <div key={x.t} className="card p-6">
              <h3 className="text-[15px] font-semibold text-ink-strong">{x.t}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">{x.b}</p>
            </div>
          ))}
        </Reveal>
      </Section>

      {/* -------------------------------------------------------------- projections */}
      {f.scenarios.length > 0 && (
        <Section
          id="projections"
          eyebrow="2050"
          title="Projected change by 2050"
          intro="Median change of the NCR mean versus a weather-normalised 2025 baseline, with the 5–95 % range of 500 Monte Carlo draws. Climate warming is partly offset by day because new built-up land replaces hotter bare farmland."
        >
          <Reveal className="card overflow-x-auto p-0">
            <table className="w-full min-w-[620px] text-left text-[14px]">
              <caption className="sr-only">Projected change of NCR mean land surface temperature by 2050 per scenario</caption>
              <thead>
                <tr className="border-b border-hairline text-[12.5px] text-ink-faint">
                  <th scope="col" className="px-5 py-3.5 font-medium">Scenario</th>
                  <th scope="col" className="px-3 py-3.5 text-right font-medium">Day, median</th>
                  <th scope="col" className="px-3 py-3.5 text-right font-medium">Day, 5–95 %</th>
                  <th scope="col" className="px-3 py-3.5 text-right font-medium">Climate part</th>
                  <th scope="col" className="px-3 py-3.5 text-right font-medium">Land-use part</th>
                  <th scope="col" className="px-5 py-3.5 text-right font-medium">Night, median</th>
                </tr>
              </thead>
              <tbody>
                {f.scenarios.map((s) => {
                  const pd = day?.projections?.[s];
                  const pn = night?.projections?.[s];
                  return (
                    <tr key={s} className="border-b border-hairline/60 last:border-0">
                      <th scope="row" className="px-5 py-3 font-semibold" style={{ color: SSP_STYLE[s]?.color }}>
                        {SSP_LABEL[s]}
                      </th>
                      <td className="px-3 py-3 text-right font-mono text-ink-strong tnum">{signed(pd?.delta, 1)}</td>
                      <td className="px-3 py-3 text-right font-mono text-ink-muted tnum">
                        {signed(pd?.lo, 1, "")} to {signed(pd?.hi, 1)}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-ink-muted tnum">{signed(pd?.climate, 2)}</td>
                      <td className="px-3 py-3 text-right font-mono text-ink-muted tnum">{signed(pd?.land, 2)}</td>
                      <td className="px-5 py-3 text-right font-mono text-ink-strong tnum">{signed(pn?.delta, 1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Reveal>
          {day?.budget && (
            <Reveal className="card mt-4 p-6 sm:p-7">
              <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-[16px] font-semibold text-ink-strong">Where the 2050 uncertainty comes from (day)</h3>
                <span className="text-[12.5px] text-ink-faint">share of projection variance</span>
              </div>
              <BudgetBars budget={day.budget} scenarios={f.scenarios} />
              <p className="mt-5 text-[14px] leading-relaxed text-ink-muted">
                The largest single source is the surface sensitivity β, how much land surface temperature rises per degree of air warming: {f.sensitivity.day?.beta} by day (95 % range {f.sensitivity.day?.ci?.[0]} to{" "}
                {f.sensitivity.day?.ci?.[1]}) and {f.sensitivity.night?.beta} at night, estimated from {f.sensitivity.day?.years} and {f.sensitivity.night?.years} years of satellite record.
              </p>
            </Reveal>
          )}
        </Section>
      )}

      {/* -------------------------------------------------------------- skill */}
      {accDay?.benchmarks?.length > 0 && (
        <Section
          id="skill"
          eyebrow="Trust"
          title="How good is the model?"
          intro="Five models were trained on the same features and scored on spatial blocks of 20 km that each model never saw during training. Random cross-validation would look better and mean less, so it is not the headline."
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <Reveal className="card p-6 sm:p-7">
              <h3 className="mb-5 text-[16px] font-semibold text-ink-strong">R², day</h3>
              <BarList items={accDay.benchmarks.map((b) => ({ id: b.id, label: b.label, value: b.r2 }))} max={1} digits={3} label="Daytime R² by model" accent="var(--solar)" />
              {accDay.temporal && <p className="mt-5 text-[13.5px] text-ink-faint">Leave-one-epoch-out (unseen years): R² {accDay.temporal.r2.toFixed(2)}, RMSE {accDay.temporal.rmse} °C.</p>}
            </Reveal>
            <Reveal delay={80} className="card p-6 sm:p-7">
              <h3 className="mb-5 text-[16px] font-semibold text-ink-strong">R², night</h3>
              <BarList items={accNight.benchmarks.map((b) => ({ id: b.id, label: b.label, value: b.r2 }))} max={1} digits={3} label="Night-time R² by model" accent="var(--lunar)" />
              {accNight.temporal && <p className="mt-5 text-[13.5px] text-ink-faint">Leave-one-epoch-out (unseen years): R² {accNight.temporal.r2.toFixed(2)}, RMSE {accNight.temporal.rmse} °C.</p>}
            </Reveal>
          </div>
        </Section>
      )}

      {/* -------------------------------------------------------------- caveats */}
      <Section id="caveats" eyebrow="Read with care" title="Limits of these results">
        <Reveal as="ul" className="grid gap-4 md:grid-cols-2">
          {[
            ["Scenarios, not forecasts", "The 2030–2050 frames combine climate-model warming with simulated land change. They leave out irrigation change, aerosol trends, heat-wave frequency and monsoon-onset timing."],
            ["Explanations, not causes", "SHAP describes how the model uses each driver. It points to strong associations, which still need physical reasoning or experiments to call causes."],
            ["Uneven evidence through time", "1990 and 1995 rest on fewer clear Landsat 5 scenes; night 1990 and 1995 are model hindcasts and night 2000 is a calibrated Terra record."],
            ["Inputs have their own errors", "Built-up and population layers after 2020 are GHSL extrapolations, and ERA5-Land has known biases over irrigated cropland."],
          ].map(([t, b]) => (
            <li key={t} className="card p-6">
              <Eyebrow>{t}</Eyebrow>
              <p className="mt-3 text-[14.5px] leading-relaxed text-ink-muted">{b}</p>
            </li>
          ))}
        </Reveal>
        <div className="mt-10 flex flex-wrap gap-3">
          <Link href="/methodology" className="btn btn-secondary">
            How it was done
          </Link>
          <Link href="/explore" className="btn btn-primary">
            Explore the data
            <ArrowUpRight aria-hidden="true" className="size-4" strokeWidth={2} />
          </Link>
        </div>
      </Section>
    </>
  );
}
