import Link from "next/link";
import { BrandGlyph } from "../../src/design/glyphs.jsx";
import { EXPLORER_SECTIONS, NAV, siteConfig } from "../../lib/site/config.js";

/** Site footer: brand + summary, page links, explorer sections, credits. */
export function SiteFooter({ generatedAt }) {
  const year = new Date().getFullYear();
  const date = generatedAt ? new Date(generatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : null;
  return (
    <footer className="relative mt-24 border-t border-hairline">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:px-8 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <Link href="/" className="focus-ring -m-1 inline-flex items-center gap-2.5 rounded-lg p-1">
            <BrandGlyph size={26} />
            <span className="font-display text-[15px] font-semibold text-ink-strong">{siteConfig.name}</span>
          </Link>
          <p className="mt-4 max-w-sm text-[14px] leading-relaxed text-ink-muted">{siteConfig.tagline}. Built from Landsat, MODIS, VIIRS, ERA5-Land and CMIP6 data with Google Earth Engine, XGBoost and SHAP.</p>
          {date && <p className="mt-3 text-[13px] text-ink-faint">Data export: {date}</p>}
        </div>
        <nav aria-label="Footer: site">
          <h2 className="text-[13px] font-semibold text-ink-strong">Project</h2>
          <ul className="mt-3 space-y-2 text-[14px]">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="focus-ring rounded text-ink-muted transition-colors duration-200 hover:text-ink-strong">
                  {item.label}
                </Link>
              </li>
            ))}
            <li>
              <a href={siteConfig.repo} className="focus-ring rounded text-ink-muted transition-colors duration-200 hover:text-ink-strong" rel="noopener noreferrer" target="_blank">
                Source code on GitHub
              </a>
            </li>
          </ul>
        </nav>
        <nav aria-label="Footer: explorer">
          <h2 className="text-[13px] font-semibold text-ink-strong">Explorer</h2>
          <ul className="mt-3 space-y-2 text-[14px]">
            {EXPLORER_SECTIONS.map((s) => (
              <li key={s.hash}>
                <a href={`${siteConfig.basePath}/explore#/${s.hash}`} className="focus-ring rounded text-ink-muted transition-colors duration-200 hover:text-ink-strong">
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="border-t border-hairline">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-[13px] text-ink-faint sm:px-8">
          <p>
            © {year} {siteConfig.author.name}. Research and educational use.
          </p>
          <p>Projections are scenarios, not forecasts.</p>
        </div>
      </div>
    </footer>
  );
}
