import { absoluteUrl, siteConfig } from "../lib/site/config.js";

/** robots.txt: everything is public; the raw bundle and demo data are not pages. */
export default function robots() {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/demo/"] }],
    sitemap: absoluteUrl("/sitemap.xml"),
    host: siteConfig.url,
  };
}
