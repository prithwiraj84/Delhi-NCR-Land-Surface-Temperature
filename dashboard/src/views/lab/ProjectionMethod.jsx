/**
 * PROJECTION METHOD (UI_SPEC §3.8 "SVG diagram"; SPEC §4.9–§4.10): how a projected frame is
 * made, drawn as the real mechanism — three additive terms on a weather-normalised baseline,
 * sampled jointly in a Monte-Carlo:
 *
 *   LST_k(i, y) = L_base + β_k · ΔT_{s,g}(y) · pattern(i)          climate term
 *               + [Â_{s,r}(y, i) − mean_FIXED Â(2025)]              land-use term (CA + model)
 *               + r̄(i)                                             persistent residual
 *               + e_i ~ OOF residuals of the cell's DI decile        model error
 *
 * Draw k picks a GCM g, a β from its bootstrap draws and a land realisation r; per-cell
 * P05…P95 and scope quantiles come from the draws. The diagram is mirrored by an ordered list
 * of the same steps (its text twin). Numbers shown come from the bundle when present.
 */
import { fmt } from "../../lib/format.js";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { CHART, COMPONENT_COLORS } from "../../viz/chartTheme.js";

const W = 780;
const H = 300;

function Box({ x, y, w, h, title, sub, color }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8} fill="rgba(24,35,58,0.9)" stroke={color ?? CHART.axisLine} strokeWidth={color ? 1.5 : 1} />
      <text x={x + 10} y={y + 18} fill={CHART.ink} fontSize={12} fontWeight={600}>
        {title}
      </text>
      {(Array.isArray(sub) ? sub : [sub]).filter(Boolean).map((s, i) => (
        <text key={i} x={x + 10} y={y + 34 + i * 14} fill={CHART.inkMuted} fontSize={10.5}>
          {s}
        </text>
      ))}
    </g>
  );
}

function Arrow({ x1, y1, x2, y2 }) {
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={CHART.inkFaint} strokeWidth={1.25} markerEnd="url(#pm-arrow)" />;
}

/**
 * @param {{metrics?: object|null, scenarios?: object[], nMc?: number|null, nLand?: number|null, available: boolean}} props
 */
export function ProjectionMethod({ metrics = null, scenarios = [], nMc = null, nLand = null, available = true }) {
  const bDay = metrics?.climate_sensitivity?.day?.beta;
  const bNight = metrics?.climate_sensitivity?.night?.beta;
  const fom = metrics?.land_model?.fom;
  const verdict = metrics?.land_model?.verdict ?? null;
  const rhoDay = metrics?.modes?.day?.aoa?.resid_rho_block20;
  const rhoNight = metrics?.modes?.night?.aoa?.resid_rho_block20;
  const rhoText = Number.isFinite(rhoDay) || Number.isFinite(rhoNight) ? ` (ρ${Number.isFinite(rhoDay) ? ` day ${fmt(rhoDay, 2)}` : ""}${Number.isFinite(rhoNight) ? ` night ${fmt(rhoNight, 2)}` : ""})` : "";
  const nGcm = scenarios.find((s) => Number.isFinite(Number(s.n_gcm)))?.n_gcm ?? null;
  const pattern = scenarios.some((s) => s.method === "pattern-scaled") ? "SSP1-2.6 pattern-scaled from SSP2-4.5 (AR6 GSAT ratio)" : null;
  const steps = [
    `Climate: CMIP6 (NEX-GDDP${nGcm ? `, ${nGcm} GCMs` : ""}) change in Apr–Jun tasmax (day) / tasmin (night), 20-year window vs 2016–2035, × β (dLST/dTair${Number.isFinite(bDay) ? `: day ${fmt(bDay, 2)}` : ""}${Number.isFinite(bNight) ? `, night ${fmt(bNight, 2)}` : ""}) × the ensemble-median spatial pattern.${pattern ? ` ${pattern}.` : ""}`,
    `Land use: district urban demand from Chen et al. (2020) SSP urban land; cellular-automaton allocation (suitability × neighbourhood × noise)${nLand ? `, ${nLand} realisations` : ""}${Number.isFinite(fom) ? `, hindcast figure of merit ${fmt(fom, 2)}` : ""}${verdict ? ` (vs the null model: ${String(verdict).replace(/_/g, " ")})` : ""}; spectral, built volume, population, focal and distance predictors derived from the projected land cover.`,
    "Model: the final per-mode XGBoost predicts the anomaly on the projected predictors, recentred relative to the 2025 prediction mean so the land-driven shift is kept.",
    rhoText
      ? `Residuals: the persistent per-cell residual r̄ is added, plus model error drawn from the projection-setting residuals (leave-one-epoch-out + r̄) of the cell's DI decile, correlated within 20 km blocks${rhoText}.`
      : "Residuals: the persistent per-cell residual r̄ is added, plus model error drawn from the block-20 out-of-fold residuals of the cell's DI decile.",
    `Monte Carlo${nMc ? ` (${nMc} draws)` : ""}: each draw samples a GCM, a β bootstrap draw and a land realisation; P05/P25/P50/P75/P95 per cell, scope quantiles from per-draw scope means, and the variance budget per factor.`,
  ];
  return (
    <HudFrame solid title="Projection method · how a 2030–2050 frame is made" className="min-w-0">
      {!available && <p className="mb-2 text-xs text-ink-muted">This bundle has no projections (rerun notebook v2); the method below is what v2 runs.</p>}
      <div className="scrollbar-thin overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 560, maxWidth: W }} role="img" aria-label="Diagram of the projection method; the same steps are listed below.">
          <defs>
            <marker id="pm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0L10,5L0,10Z" fill={CHART.inkFaint} />
            </marker>
          </defs>
          <Box x={10} y={14} w={210} h={60} title="CMIP6 ΔT_{s,g}(y)" sub={["tasmax / tasmin, 20-yr windows", nGcm ? `${nGcm} GCMs per SSP` : "per GCM g, per SSP s"]} color={COMPONENT_COLORS.gcm} />
          <Box x={250} y={14} w={150} h={60} title="× β (dLST/dTair)" sub={["bootstrap draws", Number.isFinite(bDay) ? `day ${fmt(bDay, 2)} · night ${fmt(bNight, 2)}` : "per mode"]} color={COMPONENT_COLORS.sensitivity} />
          <Box x={430} y={14} w={130} h={60} title="× pattern(i)" sub={["ensemble-median", "delta field / ROI mean"]} />
          <Box x={10} y={104} w={210} h={60} title="SSP urban demand" sub={["Chen et al. 2020, per district", "GHSL 2030 for comparison"]} />
          <Box x={250} y={104} w={150} h={60} title="CA allocation" sub={[nLand ? `${nLand} realisations r` : "N realisations r", Number.isFinite(fom) ? `FoM ${fmt(fom, 2)} (hindcast)` : "hindcast vs null"]} color={COMPONENT_COLORS.land} />
          <Box x={430} y={104} w={130} h={60} title="Derived predictors" sub={["spectral, pop, built_v", "focal + distances"]} />
          <Box x={430} y={194} w={130} h={60} title="XGBoost Â(y, i)" sub={["recentred vs 2025", "land-use term"]} color={COMPONENT_COLORS.land} />
          <Box x={250} y={194} w={150} h={60} title="+ r̄(i) + e_i" sub={["persistent residual", "OOF error by DI decile"]} color={COMPONENT_COLORS.model} />
          <Box x={600} y={60} w={170} h={150} title="Σ on L_base" sub={["weather-normalised 2025", "level of the mode", "", "Monte Carlo draws", nMc ? `k = 1…${nMc}` : "k = 1…N", "→ P05 · P50 · P95", "→ variance budget"]} color={CHART.ink} />
          <Arrow x1={220} y1={44} x2={248} y2={44} />
          <Arrow x1={400} y1={44} x2={428} y2={44} />
          <Arrow x1={560} y1={44} x2={598} y2={90} />
          <Arrow x1={220} y1={134} x2={248} y2={134} />
          <Arrow x1={400} y1={134} x2={428} y2={134} />
          <Arrow x1={495} y1={164} x2={495} y2={192} />
          <Arrow x1={560} y1={224} x2={598} y2={180} />
          <Arrow x1={400} y1={224} x2={428} y2={224} />
          <text x={10} y={H - 14} fill={CHART.inkFaint} fontSize={10.5}>
            A scenario projection, not a forecast: weather of individual years is not predicted.
          </text>
        </svg>
      </div>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-snug text-ink-muted">
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </HudFrame>
  );
}

export default ProjectionMethod;
