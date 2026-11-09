/**
 * Complete per-page metadata. Next.js replaces (does not merge) a parent's `openGraph` /
 * `twitter` objects when a page defines its own, so every page builds the full set here:
 * canonical, Open Graph (with the generated 1200 x 630 card), Twitter card.
 */
import { siteConfig } from "./config.js";

const OG_IMAGE = Object.freeze({ url: "/opengraph-image", width: 1200, height: 630, alt: `${siteConfig.name}: land surface temperature 1990–2050, explained with AI` });

export function pageMetadata({ title, description, path, type = "website", ogTitle }) {
  const fullTitle = ogTitle ?? (title ? `${title} · ${siteConfig.name}` : `${siteConfig.name}: ${siteConfig.tagline}`);
  return {
    ...(title ? { title } : {}),
    description,
    alternates: { canonical: path },
    openGraph: {
      type,
      siteName: siteConfig.name,
      locale: siteConfig.locale,
      url: path,
      title: fullTitle,
      description,
      images: [OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images: [OG_IMAGE.url],
    },
  };
}
