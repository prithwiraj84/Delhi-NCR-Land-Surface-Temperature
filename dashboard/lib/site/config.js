/**
 * Site identity and URLs (used by metadata, sitemap, robots, JSON-LD and the OG image).
 *
 * The public address is NEXT_PUBLIC_SITE_URL when set, else Vercel's production domain
 * (VERCEL_PROJECT_PRODUCTION_URL, available at build time on Vercel), else localhost.
 */
const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "";
const rawUrl = process.env.NEXT_PUBLIC_SITE_URL || (vercelHost ? `https://${vercelHost}` : "http://localhost:3000");
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/+$/, "");

export const siteConfig = Object.freeze({
  name: "Delhi NCR Heat Atlas",
  shortName: "NCR Heat Atlas",
  tagline: "Explainable AI for land surface temperature, 1990–2050",
  description:
    "An interactive atlas of land surface temperature across Delhi NCR from 1990 to 2050: day and night satellite observations, a machine-learning model explained with SHAP, heat zones, and CMIP6 climate projections.",
  url: `${rawUrl.replace(/\/+$/, "")}${basePath}`,
  basePath,
  locale: "en_IN",
  author: Object.freeze({
    name: "Prithwiraj Das",
    url: "https://github.com/prithwiraj84",
  }),
  repo: "https://github.com/prithwiraj84/Delhi-NCR-Land-Surface-Temperature",
  keywords: Object.freeze([
    "Delhi NCR",
    "land surface temperature",
    "LST",
    "urban heat island",
    "explainable AI",
    "SHAP",
    "XGBoost",
    "Landsat",
    "MODIS",
    "Google Earth Engine",
    "CMIP6",
    "SSP scenarios",
    "climate projections",
    "remote sensing",
    "heat mapping",
    "India",
  ]),
});

/** Absolute URL for a site path ("/findings" -> "https://…/findings"). */
export function absoluteUrl(pathname = "/") {
  const p = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${siteConfig.url}${p === "/" ? "" : p}` || "/";
}

/** Path with the base path prefixed (for plain <img>/<a> to public files). */
export function withBase(pathname) {
  return `${basePath}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

/** Primary navigation of the content pages. */
export const NAV = Object.freeze([
  Object.freeze({ href: "/findings", label: "Findings" }),
  Object.freeze({ href: "/methodology", label: "Methodology" }),
  Object.freeze({ href: "/learn", label: "Learn" }),
  Object.freeze({ href: "/data", label: "Data" }),
  Object.freeze({ href: "/about", label: "About" }),
]);

/** Explorer sections (hash routes of /explore). */
export const EXPLORER_SECTIONS = Object.freeze([
  Object.freeze({ hash: "control", label: "Heat map", blurb: "Every 1 km cell from 1990 to 2050, day and night, in 3D." }),
  Object.freeze({ hash: "timeline", label: "Timeline", blurb: "Observed trends, scenario fans and district ledgers." }),
  Object.freeze({ hash: "drivers", label: "AI drivers", blurb: "What heats each place: SHAP importance and dependence curves." }),
  Object.freeze({ hash: "zones", label: "Heat zones", blurb: "Clusters of cells that heat up for the same reasons." }),
  Object.freeze({ hash: "lab", label: "Model lab", blurb: "Honest accuracy: spatial and temporal cross-validation." }),
  Object.freeze({ hash: "sources", label: "Data sources", blurb: "Satellites, reanalysis and climate models behind each frame." }),
]);
