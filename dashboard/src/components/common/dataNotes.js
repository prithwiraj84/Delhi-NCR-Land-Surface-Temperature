/**
 * Pure helpers for the data-provenance UI: the synthetic banner's reason sentence, the
 * header badge text and the "Data caveats" popover content (manifest.notes, generated_at,
 * data_sources). Kept free of React so they can be unit tested.
 */

/**
 * Sentence explaining why a bundle is synthetic, from `manifest.data_mode_reason`
 * (written by 05_export from section 1's mode decision).
 */
export function syntheticReasonText(reason) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) return "This bundle was generated in synthetic mode.";
  if (/LST_RUN_MODE\s*=\s*synthetic/i.test(text)) {
    return "The notebook was run in synthetic mode on purpose (LST_RUN_MODE=synthetic); Earth Engine was not contacted.";
  }
  if (/unavailable|fail|error|denied|credential/i.test(text)) {
    return `The notebook fell back to synthetic data: ${text.replace(/\.$/, "")}.`;
  }
  return `This bundle was generated in synthetic mode (${text.replace(/\.$/, "")}).`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "27 Sep 2026" (UTC, locale-independent) from an ISO timestamp, or null. */
export function formatGeneratedDate(iso) {
  if (typeof iso !== "string" || !iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Header badge for the data mode: a GEE bundle is a dated static snapshot, never "live". */
export function dataModeBadge(manifest) {
  if (!manifest) return null;
  if (manifest.data_mode === "synthetic") {
    return {
      variant: "amber",
      text: "SYNTHETIC demo data",
      title: "Values come from the synthetic generator, not satellite observations",
    };
  }
  const date = formatGeneratedDate(manifest.generated_at);
  return {
    variant: "emerald",
    text: date ? `GEE snapshot · ${date}` : "GEE snapshot",
    title: `Static export of Google Earth Engine data${date ? ` generated on ${date}` : ""}; it does not update live.`,
  };
}

/** manifest.notes as a clean string list. */
export function manifestNotes(manifest) {
  return (Array.isArray(manifest?.notes) ? manifest.notes : [])
    .map((n) => (typeof n === "string" ? n.trim() : ""))
    .filter(Boolean);
}

/**
 * Caveats relevant to cross-epoch comparisons (zone transitions, area / LST trends): notes on
 * changing land-cover products, sensor changes (DMSP -> VIIRS), orbit drift and projections.
 */
export function crossEpochCaveats(manifest) {
  return manifestNotes(manifest).filter((n) =>
    /product|land.?cover|dmsp|viirs|orbit|drift|projection|ghs|worldcover|dynamic world|glc/i.test(n),
  );
}

/**
 * manifest.data_sources as rows [{variable, entries: [{key, value}]}] (sorted by variable;
 * years ascending). Long provenance strings are kept whole; the UI wraps them.
 */
export function dataSourceRows(manifest) {
  const sources = manifest?.data_sources;
  if (!sources || typeof sources !== "object") return [];
  return Object.entries(sources)
    .filter(([, v]) => v && typeof v === "object")
    .map(([variable, entries]) => ({
      variable,
      entries: Object.entries(entries)
        .map(([key, value]) => ({ key, value: String(value) }))
        .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true })),
    }))
    .sort((a, b) => a.variable.localeCompare(b.variable));
}
