/**
 * Evidence-tier vocabulary (UI_SPEC_v2 §1.3, SPEC §5.3 `timeline.tiers`).
 *
 * The tier of a value ALWAYS comes from the manifest (`timeline.frames[].{day,night}.tier`);
 * this module only names and normalises the vocabulary - it never maps years to tiers.
 * Encoding is glyph + pattern + text, never hue alone (TierShape in glyphs.jsx, TierGlyph in
 * components/ui).
 */

/** Evidence tiers (UI_SPEC §1.3): canonical ids, glyph character, label and short text. */
export const TIER_META = Object.freeze({
  observed: Object.freeze({ id: "observed", char: "●", label: "Observed", short: "OBS" }),
  "observed-sparse": Object.freeze({ id: "observed-sparse", char: "◒", label: "Observed (sparse)", short: "OBS·SPARSE" }),
  reconstructed: Object.freeze({ id: "reconstructed", char: "◐", label: "Reconstructed", short: "RECON" }),
  modelled: Object.freeze({ id: "modelled", char: "◇", label: "Modelled", short: "MODEL" }),
  projected: Object.freeze({ id: "projected", char: "○", label: "Projected", short: "PROJ" }),
  "simulated-demo": Object.freeze({ id: "simulated-demo", char: "▨", label: "Simulated (demo)", short: "SIM" }),
});

/** Normalise tier spellings from bundles ("modeled", "OBSERVED_SPARSE" …) to TIER_META ids. */
export function normalizeTier(tier) {
  const t = String(tier ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  if (t === "modeled") return "modelled";
  if (t === "simulated" || t === "synthetic" || t === "demo") return "simulated-demo";
  return TIER_META[t] ? t : null;
}

/** Ordered tier ids (strongest evidence first). */
export const TIER_ORDER = Object.freeze(Object.keys(TIER_META));
