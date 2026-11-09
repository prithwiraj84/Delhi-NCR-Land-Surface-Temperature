import { siteConfig } from "../lib/site/config.js";

/** Web app manifest (installable, themed address bar). */
export default function manifest() {
  return {
    name: siteConfig.name,
    short_name: siteConfig.shortName,
    description: siteConfig.description,
    start_url: `${siteConfig.basePath}/`,
    display: "standalone",
    background_color: "#08090D",
    theme_color: "#08090D",
    icons: [{ src: `${siteConfig.basePath}/icon.svg`, sizes: "any", type: "image/svg+xml" }],
  };
}
