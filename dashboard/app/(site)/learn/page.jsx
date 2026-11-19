/**
 * Learn: an illustrated glossary of the concepts behind the atlas plus answers to common
 * questions (FAQPage structured data for search engines). Written for a first-year audience.
 */
import Link from "next/link";
import { ArrowUpRight, BrainCircuit, CloudSun, Gauge, Grid3x3, Layers, Leaf, Building2, Satellite, ScanSearch, Shuffle, Thermometer, Waves } from "lucide-react";
import { Reveal } from "../../_components/Reveal.jsx";
import { Eyebrow, PageIntro, Section } from "../../_components/ui.jsx";
import { JsonLd } from "../../../lib/site/JsonLd.jsx";
import { withBase } from "../../../lib/site/config.js";
import { annualContrast, getFacts, rangeText, signed } from "../../../lib/site/facts.js";
import { pageMetadata } from "../../../lib/site/meta.js";

export const metadata = pageMetadata({
  title: "Learn: land surface temperature, urban heat islands and SHAP explained",
  description:
    "Plain-language explanations of the ideas behind the Delhi NCR Heat Atlas: land surface temperature, the urban heat island, NDVI and NDBI, machine learning, spatial cross-validation, SHAP, heat zones and SSP climate scenarios.",
  path: "/learn",
  type: "article",
});

const TERMS = [
  {
    icon: Thermometer,
    term: "Land surface temperature (LST)",
    body: "How hot the surface itself is (soil, crops, roofs, roads), measured by satellites from the thermal infrared it emits. On a sunny afternoon it can be 10–20 °C hotter than the air you feel in the shade.",
  },
  {
    icon: Building2,
    term: "Urban heat island",
    body: "Cities are often warmer than the countryside around them. Here the surface version flips with the clock: by day bare farmland is hotter than the city, but at night concrete and asphalt release stored heat and cities are much warmer.",
  },
  {
    icon: Leaf,
    term: "NDVI and NDBI",
    body: "Two ratios of reflected light. NDVI (vegetation index) is high over green, growing plants. NDBI (built-up index) is high over buildings and bare, dry soil. They are the strongest clues to how hot a place gets.",
  },
  {
    icon: Satellite,
    term: "Landsat, MODIS and VIIRS",
    body: "Earth-observing satellites. Landsat passes every 16 days around 10:30 in the morning; its thermal sensors see 60–120 m detail (delivered on a 30 m grid). MODIS and VIIRS see about 1 km but pass every day and night, so they provide the night-time record.",
  },
  {
    icon: BrainCircuit,
    term: "Machine-learning model",
    body: "A program that learns patterns from examples. Here XGBoost, a collection of decision trees, learns how a cell's temperature relates to its vegetation, buildings, water, terrain and weather.",
  },
  {
    icon: Grid3x3,
    term: "Spatial cross-validation",
    body: "An honest exam for a model. The map is cut into 20 km blocks, and each block is predicted by a model that never saw it. Testing on random cells instead would let the model copy its neighbours and look better than it is.",
  },
  {
    icon: ScanSearch,
    term: "SHAP",
    body: "A method from game theory that splits a model's prediction into the contribution of each input, in °C. It answers “why does the model think this place is hot?”, but it explains the model, not nature itself.",
  },
  {
    icon: Layers,
    term: "Heat zones",
    body: "Groups of cells that are hot for the same reasons, found by clustering their SHAP explanations. Two equally hot places can need different fixes: shade trees for one, water or open space for another.",
  },
  {
    icon: Gauge,
    term: "Area of applicability",
    body: "Where the model's answers can be trusted: places whose features look like what the model learned from. Cells outside it are hatched in the explorer.",
  },
  {
    icon: CloudSun,
    term: "SSP scenarios and CMIP6",
    body: "Shared Socioeconomic Pathways are storylines for how the world develops, from strong climate action (SSP1-2.6) to fossil-fuelled growth (SSP5-8.5). CMIP6 climate models simulate the warming each storyline causes.",
  },
  {
    icon: Shuffle,
    term: "Monte Carlo uncertainty",
    body: "Instead of one answer, the projection is repeated hundreds of times with different plausible inputs. The spread of the results, shown as a 5–95 % range, is an honest picture of what we do not know.",
  },
  {
    icon: Waves,
    term: "Evidence tiers",
    body: "Every frame is labelled by how it was made: observed, observed with few scenes, reconstructed from another satellite, modelled where no data exist, or projected. Lower tiers deserve more caution.",
  },
];

/** "Is Delhi NCR getting hotter?", guarded by the exported trend CI and the annual series. */
function hotterAnswer(f) {
  const dt = f.day?.trend;
  if (!dt) return "The trend is reported on the findings page once the bundle exports it.";
  const nt = f.night?.trend;
  const range = rangeText(dt.ci);
  const clear = Array.isArray(dt.ci) && dt.ci[0] > 0;
  const lowYear = f.day?.low?.year;
  const sparse = f.day?.tiers?.sparse ?? [];
  const annual = [f.day?.annual?.air, f.day?.annual?.satellite].filter(Boolean);
  const annualAgrees = annual.length > 0 && annual.every((t) => Array.isArray(t.ci) && t.ci[0] > 0);
  const contrast = annualContrast(f.day, "day", f.seasonLabel);
  return [
    clear ? "In the satellite frames, yes, with caveats." : Array.isArray(dt.ci) && dt.ci[1] < 0 ? "Not in the satellite frames: they show cooling." : "Not clearly: the frame trend's range includes zero.",
    `Across the ${dt.n ?? f.years.observed.length} observed${f.seasonLabel ? ` ${f.seasonLabel}` : ""} frames${dt.period ? ` (${dt.period[0]}–${dt.period[1]})` : ""}, the region's mean daytime land surface temperature changed by about ${signed(dt.perDecade, 2)} per decade (Theil–Sen trend${range ? `, 95 % range ${range}` : ""})${
      nt ? `, and night-time surfaces by ${signed(nt.perDecade, 2)} per decade since ${nt.period?.[0] ?? f.night?.first?.year}` : ""
    }.`,
    lowYear || sparse.length
      ? `The change is not steady${lowYear ? `: the daytime series is lowest in ${lowYear}` : ""}${sparse.length ? `${lowYear ? "," : ""} and the ${sparse.join(" and ")} frames rest on few clear scenes` : ""}.`
      : "",
    contrast ?? "",
    clear && annual.length > 0 && !annualAgrees ? "So the frames point to warmer surfaces, but how much warmer is still uncertain." : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export default function LearnPage() {
  const f = getFacts();
  const faqs = [
    {
      q: "Is Delhi NCR getting hotter?",
      a: hotterAnswer(f),
    },
    {
      q: "Why are cities cooler than farmland during the day?",
      a:
        Number.isFinite(f.day?.uhi) && Number.isFinite(f.night?.uhi) && f.day.uhi < 0 && f.night.uhi > 0
          ? `In the pre-monsoon season much of the farmland is harvested and bare. Dry, bare soil heats up faster than the mix of buildings, trees and watered gardens in towns, so by day built-up areas are about ${Math.abs(f.day.uhi).toFixed(1)} °C cooler than rural land. At night the order reverses: cities are about ${f.night.uhi.toFixed(1)} °C warmer because they release the heat they stored.`
          : "In the pre-monsoon season much of the farmland is harvested and bare, and dry, bare soil heats up faster than the mix of buildings, trees and watered gardens in towns. The measured day and night differences are on the findings page.",
    },
    {
      q: "What does the AI model actually do?",
      a: `It predicts each ${f.area.gridM ? `${f.area.gridM / 1000} km ` : ""}cell's surface temperature from ${f.features.count ? `${f.features.count} ` : ""}features such as vegetation, built-up land, water, terrain and weather. SHAP then shows how much each feature pushed the prediction up or down, which is how the atlas explains why a place is hot.`,
    },
    {
      q: "How accurate is the model?",
      a: f.accuracy.day?.spatial
        ? `On 20 km blocks it never saw during training, the daytime model explains ${Math.round(f.accuracy.day.spatial.r2 * 100)} % of the variation (R² ${f.accuracy.day.spatial.r2.toFixed(2)}) with a typical error of ${f.accuracy.day.spatial.rmse} °C.${
            f.accuracy.night?.spatial ? ` The night model reaches R² ${f.accuracy.night.spatial.r2.toFixed(2)}.` : ""
          }`
        : "Accuracy is reported on the findings page.",
    },
    {
      q: `How reliable are the ${f.years.projected.length ? `${f.years.projected.at(-1)} ` : ""}projections?`,
      a: `They are scenarios, not forecasts. They combine climate-model warming with simulated urban growth, and they leave out factors such as irrigation change and heat-wave frequency. Each projection comes with a 5–95 % range from ${
        f.projection?.nMc ? `${f.projection.nMc} ` : "many "
      }simulations; read the range, not just the middle value.`,
    },
    {
      q: "Where does the data come from?",
      a: "From public archives processed in Google Earth Engine: Landsat, MODIS and VIIRS satellites (NASA / USGS), ERA5-Land weather (ECMWF), GHSL built-up and population (European Commission JRC), GLC_FCS30D land cover, SRTM terrain and NASA NEX-GDDP-CMIP6 climate projections.",
    },
  ];
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((x) => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: x.a } })),
  };

  return (
    <>
      <JsonLd data={faqLd} />
      <PageIntro
        eyebrow="Learn"
        title="The ideas behind the atlas, in plain language"
        lead="New to remote sensing or machine learning? These twelve concepts are all you need to read the maps, charts and explanations with confidence."
      />

      <Section id="glossary" eyebrow="Glossary" title="Twelve concepts">
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TERMS.map((t, i) => (
            <Reveal as="li" key={t.term} delay={(i % 3) * 60} className="card p-6">
              <span className="grid size-10 place-items-center rounded-xl border border-hairline-strong bg-white/[0.04] text-ink-strong">
                <t.icon aria-hidden="true" className="size-5" strokeWidth={1.6} />
              </span>
              <h3 className="mt-5 text-[16.5px] font-semibold text-ink-strong">{t.term}</h3>
              <p className="mt-2 text-[14.5px] leading-relaxed text-ink-muted">{t.body}</p>
            </Reveal>
          ))}
        </ul>
      </Section>

      <Section id="faq" eyebrow="Questions" title="Frequently asked">
        <div className="mx-auto max-w-3xl divide-y divide-hairline overflow-hidden rounded-[20px] border border-hairline bg-surface-2">
          {faqs.map((x) => (
            <details key={x.q} className="faq group">
              <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-5 text-[16px] font-semibold text-ink-strong [&::-webkit-details-marker]:hidden">
                {x.q}
                <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full border border-hairline-strong text-ink-muted transition-transform duration-200 ease-out group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="px-6 pb-6 text-[15px] leading-relaxed text-ink-muted">{x.a}</p>
            </details>
          ))}
        </div>
      </Section>

      <Section id="next" className="pt-0">
        <Reveal className="card grid gap-6 p-7 sm:p-9 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <Eyebrow>Try it</Eyebrow>
            <h2 className="mt-3 font-display text-[26px] font-semibold tracking-[-0.02em] text-ink-strong">See the concepts on the real map</h2>
            <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-ink-muted">
              The explorer has a guided briefing that walks through day and night heat, the drivers and the projections in a few steps.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <a href={withBase("/explore#/control")} className="btn btn-primary">
              Open the explorer
              <ArrowUpRight aria-hidden="true" className="size-4" strokeWidth={2} />
            </a>
            <Link href="/methodology" className="btn btn-secondary">
              Full methodology
            </Link>
          </div>
        </Reveal>
      </Section>
    </>
  );
}
