import ExploreLoader from "./ExploreLoader.jsx";
import { siteConfig } from "../../lib/site/config.js";
import { pageMetadata } from "../../lib/site/meta.js";

export const metadata = pageMetadata({
  title: "Interactive explorer",
  description:
    "Explore Delhi NCR land surface temperature cell by cell: a 3D heat map from 1990 to 2050, day and night, SHAP drivers, heat zones, model diagnostics and CMIP6 scenarios.",
  path: "/explore",
  type: "website",
});

export default function ExplorePage() {
  return (
    <>
      {/* Crawlers and no-JS visitors get a description; the WebGL app replaces nothing here. */}
      <h1 className="sr-only">{siteConfig.name}: interactive land surface temperature explorer</h1>
      <noscript>
        <p style={{ padding: 24 }}>
          The interactive explorer needs JavaScript and WebGL. The findings, methodology and data pages work without them.
        </p>
      </noscript>
      <ExploreLoader />
    </>
  );
}
