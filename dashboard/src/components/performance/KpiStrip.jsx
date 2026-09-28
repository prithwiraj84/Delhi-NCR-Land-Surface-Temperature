/**
 * KPI strip for the Model Performance view: the honest (spatial-CV) skill of the best
 * model, its errors, temporal transfer, residual spatial autocorrelation and the optimism
 * gap of random CV. Each tile names the model/scheme it describes in its hint, and a
 * signed delta is only shown where a comparison exists (temporal vs spatial).
 */
import { motion, useReducedMotion } from "framer-motion";
import { CalendarClock, Crosshair, Ruler, Scale, Trophy } from "lucide-react";
import { StatTile } from "../ui/StatTile.jsx";
import { fmt, fmtSigned, isNum, MISSING } from "../../lib/format.js";
import { ALPHA, formatP, modelLabel, num } from "./perfModel.js";

const sdText = (sd, dp) => (isNum(sd) ? ` · ± ${fmt(sd, dp)} sd` : "");

function bestTile(kpis) {
  const best = kpis.best;
  const scheme = kpis.bestScheme === "spatial" ? "spatial-block CV" : `${kpis.bestScheme ?? MISSING} CV`;
  return {
    id: "best-r2",
    label: kpis.bestScheme === "spatial" ? "Best spatial-CV R²" : "Best CV R²",
    value: fmt(num(best?.r2_mean), 3),
    icon: Trophy,
    accent: "cyan",
    hint: `${best ? modelLabel(best.model) : MISSING} · ${scheme}${sdText(best?.r2_std, 3)}`,
  };
}

function errorTile(kpis) {
  const best = kpis.best;
  return {
    id: "rmse",
    label: "RMSE · MAE (best model)",
    value: fmt(num(best?.rmse_mean), 2),
    unit: "°C",
    icon: Ruler,
    accent: "violet",
    hint: `RMSE${sdText(best?.rmse_std, 2)} · MAE ${fmt(num(best?.mae_mean), 2)} °C${sdText(best?.mae_std, 2)}`,
  };
}

function temporalTile(kpis) {
  const temporalR2 = num(kpis.temporal?.r2_mean);
  const spatialR2 = num(kpis.best?.r2_mean);
  const hasDelta = temporalR2 !== null && spatialR2 !== null;
  const other =
    kpis.bestTemporal && kpis.bestTemporal.model !== kpis.best?.model
      ? ` · best: ${modelLabel(kpis.bestTemporal.model)} ${fmt(num(kpis.bestTemporal.r2_mean), 3)}`
      : "";
  return {
    id: "temporal",
    label: "Temporal R² (last epoch)",
    value: fmt(temporalR2, 3),
    icon: CalendarClock,
    accent: "emerald",
    delta: hasDelta ? temporalR2 - spatialR2 : undefined,
    deltaText: hasDelta ? fmtSigned(temporalR2 - spatialR2, 3) : undefined,
    deltaLabel: "vs spatial CV",
    goodDirection: "up",
    hint: `${kpis.best ? modelLabel(kpis.best.model) : MISSING}, trained on earlier epochs${other}`,
  };
}

function moranTile(kpis) {
  const moran = kpis.moran;
  const significant = Boolean(moran && isNum(moran.p) && moran.p < ALPHA && isNum(moran.I) && moran.I > 0);
  const target = kpis.moranTarget && isNum(kpis.moranTarget.I) ? ` · target I ${fmt(kpis.moranTarget.I, 3)}` : "";
  return {
    id: "moran",
    label: `Residual Moran's I${kpis.moranYear ? ` · ${kpis.moranYear}` : ""}`,
    value: fmt(num(moran?.I), 3),
    icon: Crosshair,
    accent: significant ? "rose" : "emerald",
    hint: moran
      ? `${modelLabel(kpis.moranModel)} · ${formatP(moran.p)} · ${significant ? "significant clustering" : "not significant"}${target}`
      : "No residual Moran's I exported",
  };
}

function gapTile(kpis) {
  return {
    id: "gap",
    label: "Optimism gap (R²)",
    value: isNum(kpis.gap) ? fmtSigned(kpis.gap, 3) : MISSING,
    icon: Scale,
    accent: "amber",
    hint: `Random − spatial CV for ${kpis.best ? modelLabel(kpis.best.model) : MISSING}${
      isNum(kpis.meanGap) ? ` · mean ${fmtSigned(kpis.meanGap, 3)} across models` : ""
    }`,
  };
}

/** @param {{kpis: ReturnType<import("./perfModel.js").deriveKpis>}} props */
export function KpiStrip({ kpis }) {
  const reduceMotion = useReducedMotion();
  const tiles = [bestTile(kpis), errorTile(kpis), temporalTile(kpis), moranTile(kpis), gapTile(kpis)];
  return (
    <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-label="Key performance indicators">
      {tiles.map((tile, i) => (
        <motion.li
          key={tile.id}
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, delay: reduceMotion ? 0 : i * 0.04 }}
          className={tile.id === "gap" ? "col-span-2 md:col-span-1" : undefined}
        >
          <StatTile
            className="h-full"
            label={tile.label}
            value={tile.value}
            unit={tile.unit}
            icon={tile.icon}
            accent={tile.accent}
            delta={tile.delta}
            deltaText={tile.deltaText}
            deltaLabel={tile.deltaLabel}
            goodDirection={tile.goodDirection ?? "none"}
            hint={tile.hint}
          />
        </motion.li>
      ))}
    </ul>
  );
}
