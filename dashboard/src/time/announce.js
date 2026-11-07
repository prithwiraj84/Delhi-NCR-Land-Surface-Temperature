/**
 * Spoken description of the time state (UI_SPEC_v2 §12): the ribbon slider's aria-valuetext
 * and the polite live-region message on snap / mode / SSP change, e.g.
 *   "2040, projected under SSP2-4.5, night, NCR mean 31.2 °C (30.4 to 32.1)".
 * Reads the stores imperatively (no React render), so it can run inside store subscriptions.
 */

import { computeFrameStats } from "../data/frameStats.js";
import { fmtSsp } from "../lib/format.js";
import { useTimeStore } from "../state/stores/timeStore.js";
import { bracketTier, ribbonValueText } from "./ribbonScale.js";

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * @param {object} api BundleStore (vanilla zustand store: timeline, resources.series)
 * @param {object} [time] time store (defaults to the app store)
 * @returns {{now: number|null, text: string}}
 */
export function describeTimeState(api, time = useTimeStore) {
  const s = time.getState();
  const b = api?.getState?.() ?? {};
  const timeline = b.timeline;
  if (!timeline || !finite(s.scrubT)) return { now: s.scrubT ?? null, text: "Timeline loading" };
  const series = b.resources?.series?.status === "ready" ? b.resources.series.data : null;
  let stats = null;
  try {
    stats = series ? computeFrameStats({ timeline, series, year: s.scrubT, mode: s.mode, ssp: s.ssp }) : null;
  } catch {
    stats = null;
  }
  const label = (timeline.scenarios ?? []).find((x) => x.id === s.ssp)?.label ?? fmtSsp(s.ssp);
  const frame = timeline.frames[s.bracket?.iA ?? 0];
  return {
    now: s.scrubT,
    text: ribbonValueText({ t: s.scrubT, bracket: s.bracket, tier: bracketTier(timeline, s.bracket, s.mode), mode: s.mode, sspLabel: label, kind: frame?.kind, stats }),
  };
}
