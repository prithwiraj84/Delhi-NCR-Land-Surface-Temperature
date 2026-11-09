import { absoluteUrl } from "../lib/site/config.js";
import { getFacts } from "../lib/site/facts.js";

/** sitemap.xml: every public page, last modified at the data export. */
export default function sitemap() {
  const lastModified = getFacts().generatedAt ? new Date(getFacts().generatedAt) : new Date();
  const pages = [
    ["/", 1.0, "monthly"],
    ["/findings", 0.9, "monthly"],
    ["/explore", 0.9, "monthly"],
    ["/methodology", 0.8, "yearly"],
    ["/learn", 0.8, "yearly"],
    ["/data", 0.7, "monthly"],
    ["/about", 0.5, "yearly"],
  ];
  return pages.map(([path, priority, changeFrequency]) => ({ url: absoluteUrl(path), lastModified, changeFrequency, priority }));
}
