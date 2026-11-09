/**
 * About: the project, its author, its principles and the technology behind it.
 */
import Link from "next/link";
import { ArrowUpRight, ExternalLink } from "lucide-react";
import { Reveal } from "../../_components/Reveal.jsx";
import { Eyebrow, PageIntro, Section } from "../../_components/ui.jsx";
import { JsonLd } from "../../../lib/site/JsonLd.jsx";
import { absoluteUrl, siteConfig } from "../../../lib/site/config.js";
import { pageMetadata } from "../../../lib/site/meta.js";

export const metadata = pageMetadata({
  title: "About the project",
  description:
    "Why the Delhi NCR Heat Atlas was built, the principles behind it, the technology it uses, and who made it.",
  path: "/about",
  type: "profile",
});

const PRINCIPLES = [
  ["Honest validation", "Accuracy is measured on places and years the model never saw, and the less flattering number is the headline."],
  ["Evidence on every value", "Each frame carries its evidence tier, and the explorer marks cells where the model is outside its comfort zone."],
  ["Explanations, with limits", "SHAP shows what the model relies on; the site says clearly where that stops being a statement about causes."],
  ["Open by default", "Public data in, open results out: every number on this site comes from a downloadable, validated bundle."],
];

const STACK = [
  ["Data", "Google Earth Engine, Landsat, MODIS, VIIRS, ERA5-Land, GHSL, CMIP6"],
  ["Modelling", "Python, XGBoost, LightGBM, scikit-learn, PyTorch (graph neural network), SHAP"],
  ["Compute", "Kaggle notebooks on 2× NVIDIA T4 GPUs"],
  ["Website", "Next.js, React, Tailwind CSS, static generation for search engines"],
  ["Explorer", "deck.gl and luma.gl (WebGL), MapLibre, Web Workers, zustand"],
  ["Design", "Geist type, a colour-blind-safe data palette, motion guided by Emil Kowalski's design-engineering principles"],
];

export default function AboutPage() {
  const personLd = {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    mainEntityOfPage: absoluteUrl("/about"),
    mainEntity: { "@type": "Person", name: siteConfig.author.name, url: siteConfig.author.url, sameAs: [siteConfig.author.url] },
  };
  return (
    <>
      <JsonLd data={personLd} />
      <PageIntro
        eyebrow="About"
        title="Why map heat this way?"
        lead="Heat is one of the fastest-growing risks for the tens of millions of people who live in the National Capital Region. Planning for it needs more than a temperature map: it needs to know why each place is hot, how sure we are, and what could change it."
      />

      <Section id="principles" eyebrow="Principles" title="What the project stands for">
        <ul className="grid gap-4 sm:grid-cols-2">
          {PRINCIPLES.map(([t, b], i) => (
            <Reveal as="li" key={t} delay={(i % 2) * 60} className="card p-6 sm:p-7">
              <h3 className="text-[17px] font-semibold text-ink-strong">{t}</h3>
              <p className="mt-2 text-[14.5px] leading-relaxed text-ink-muted">{b}</p>
            </Reveal>
          ))}
        </ul>
      </Section>

      <Section id="stack" eyebrow="Technology" title="How it is built">
        <Reveal as="dl" className="grid gap-px overflow-hidden rounded-[20px] border border-hairline bg-hairline sm:grid-cols-2">
          {STACK.map(([k, v]) => (
            <div key={k} className="bg-surface-2 px-6 py-5">
              <dt className="text-[13px] text-ink-faint">{k}</dt>
              <dd className="mt-1 text-[15px] text-ink">{v}</dd>
            </div>
          ))}
        </Reveal>
      </Section>

      <Section id="author" eyebrow="Author" title={siteConfig.author.name}>
        <Reveal className="card grid gap-6 p-7 sm:p-9 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <p className="max-w-2xl text-[15.5px] leading-relaxed text-ink-muted">
              {siteConfig.author.name} designed and built the pipeline, the model and this atlas: from the Earth Engine extraction and GPU training to the explainable-AI analysis and the interactive explorer.
            </p>
            <Eyebrow className="mt-5">Data providers</Eyebrow>
            <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-faint">
              With thanks to NASA, USGS, ECMWF / Copernicus, the European Commission JRC, the GLC_FCS30D and geoBoundaries teams, and the Google Earth Engine and Kaggle platforms.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <a href={siteConfig.author.url} rel="noopener noreferrer" target="_blank" className="btn btn-secondary">
              GitHub
              <ExternalLink aria-hidden="true" className="size-4" />
            </a>
            <Link href="/explore" className="btn btn-primary">
              Open the explorer
              <ArrowUpRight aria-hidden="true" className="size-4" strokeWidth={2} />
            </Link>
          </div>
        </Reveal>
      </Section>
    </>
  );
}
