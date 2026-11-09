/**
 * Server-rendered charts for the content pages (pure SVG / HTML, no client JS). Colours and
 * dash patterns come from the dashboard tokens so the site and the explorer read alike.
 * Every chart carries a title, a description and a data table for screen readers.
 *
 * Bars "grow" from the left when their section scrolls into view: the fill is scaled with
 * transform (composite-only) and only once the parent is armed by <Reveal>, so without JS or
 * above the fold the bars are simply drawn at full length.
 */
import { color, ssp as SSP_STYLE } from "../../src/design/tokens.js";
import { SSP_LABEL } from "../../lib/site/facts.js";

const MODE_COLOR = { day: color.solar, night: color.lunar };

function ticks(lo, hi, step) {
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

/**
 * NCR mean LST through time: observed frames (CI band + markers, hollow for sparse / modelled
 * tiers) and the SSP fans (p05-p95 band + p50 line) from the weather-normalised 2025 baseline.
 */
export function TrendChart({ mode, summary, scenarios, title, id }) {
  if (!summary?.frames?.length) return null;
  const W = 600;
  const H = 330;
  const M = { l: 40, r: 78, t: 20, b: 34 };
  const x0 = 1988;
  const x1 = 2052;
  const proj = scenarios.flatMap((s) => summary.projections[s]?.rows ?? []);
  const vals = [...summary.frames.flatMap((f) => [f.ci?.[0] ?? f.mean, f.ci?.[1] ?? f.mean]), ...proj.flatMap((r) => [r.p05, r.p95])].filter(Number.isFinite);
  const lo = Math.floor(Math.min(...vals) - 0.5);
  const hi = Math.ceil(Math.max(...vals) + 0.5);
  const x = (yr) => M.l + ((yr - x0) / (x1 - x0)) * (W - M.l - M.r);
  const y = (v) => H - M.b - ((v - lo) / (hi - lo)) * (H - M.t - M.b);
  const accent = MODE_COLOR[mode] ?? color.signal;
  const obs = summary.frames;
  const band = obs.filter((f) => f.ci);
  const bandPath = band.length > 1 ? `M${band.map((f) => `${x(f.year)},${y(f.ci[1])}`).join("L")}L${[...band].reverse().map((f) => `${x(f.year)},${y(f.ci[0])}`).join("L")}Z` : null;
  const line = `M${obs.map((f) => `${x(f.year)},${y(f.mean)}`).join("L")}`;
  const now = obs.at(-1)?.year ?? 2025;
  const yStep = hi - lo > 8 ? 2 : 1;
  // End labels of the SSP strands: sorted by height and pushed apart to >= 15 px (no overlap).
  const labelY = {};
  const ends = scenarios
    .map((s) => ({ s, v: summary.projections[s]?.rows?.filter((r) => Number.isFinite(r.p50)).at(-1)?.p50 }))
    .filter((e) => Number.isFinite(e.v))
    .map((e) => ({ ...e, y: y(e.v) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 0; i < ends.length; i += 1) if (i > 0 && ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
  const shift = ends.length ? Math.max(0, ends.at(-1).y - (H - M.b - 4)) : 0;
  for (const e of ends) labelY[e.s] = e.y - shift;
  const descId = `${id}-desc`;

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-labelledby={`${id}-title ${descId}`}>
        <title id={`${id}-title`}>{title}</title>
        <desc id={descId}>
          NCR mean land surface temperature by frame from {obs[0].year} to {now}, then SSP scenario projections to 2050 (median line, 5-95 % band).
        </desc>
        {/* grid */}
        {ticks(lo, hi, yStep).map((v) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} stroke="rgba(226,232,255,0.07)" />
            <text x={M.l - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize="12.5" fill={color.inkFaint} fontFamily="Geist Mono Variable, monospace">
              {v}°
            </text>
          </g>
        ))}
        {[1990, 2000, 2010, 2020, 2030, 2040, 2050].map((yr) => (
          <text key={yr} x={x(yr)} y={H - 10} textAnchor="middle" fontSize="12.5" fill={color.inkFaint} fontFamily="Geist Mono Variable, monospace">
            {yr}
          </text>
        ))}
        {/* projected region */}
        <rect x={x(now)} y={M.t} width={W - M.r - x(now)} height={H - M.t - M.b} fill="rgba(226,232,255,0.025)" />
        <line x1={x(now)} x2={x(now)} y1={M.t} y2={H - M.b} stroke="rgba(226,232,255,0.3)" strokeDasharray="3 4" />
        <text x={x(now) + 6} y={M.t + 12} fontSize="12.5" fill={color.inkMuted} fontFamily="Geist Variable, sans-serif">
          projections →
        </text>
        {/* observed */}
        {bandPath && <path d={bandPath} fill={accent} opacity="0.13" />}
        <path d={line} fill="none" stroke={accent} strokeWidth="2" strokeLinejoin="round" />
        {obs.map((f) => {
          const hollow = f.tier !== "observed";
          return <circle key={f.year} cx={x(f.year)} cy={y(f.mean)} r="4" fill={hollow ? "#08090D" : accent} stroke={accent} strokeWidth="1.6" />;
        })}
        {/* scenarios */}
        {scenarios.map((s) => {
          const p = summary.projections[s];
          if (!p?.rows?.length) return null;
          const st = SSP_STYLE[s] ?? { color: color.signal, dash: null, width: 1.5 };
          const base = p.baseline;
          const rows = p.rows.filter((r) => Number.isFinite(r.p50));
          const start = Number.isFinite(base) ? [{ year: now, p05: base, p50: base, p95: base }] : [];
          const pts = [...start, ...rows];
          const fan = `M${pts.map((r) => `${x(r.year)},${y(r.p95)}`).join("L")}L${[...pts].reverse().map((r) => `${x(r.year)},${y(r.p05)}`).join("L")}Z`;
          const last = rows.at(-1);
          return (
            <g key={s}>
              <path d={fan} fill={st.color} opacity="0.09" />
              <path d={`M${pts.map((r) => `${x(r.year)},${y(r.p50)}`).join("L")}`} fill="none" stroke={st.color} strokeWidth={st.width + 0.25} strokeDasharray={st.dash ?? undefined} />
              {last && (
                <text x={x(last.year) + 8} y={labelY[s] ?? y(last.p50)} dy="0.32em" fontSize="12.5" fill={st.color} fontFamily="Geist Variable, sans-serif" fontWeight="600">
                  {SSP_LABEL[s] ?? s}
                </text>
              )}
            </g>
          );
        })}
        {scenarios.length > 0 && Number.isFinite(summary.projections[scenarios[0]]?.baseline) && (
          <circle cx={x(now)} cy={y(summary.projections[scenarios[0]].baseline)} r="4" fill="#08090D" stroke={color.inkStrong} strokeWidth="1.5" />
        )}
      </svg>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Year</th>
            <th scope="col">Mean °C</th>
            <th scope="col">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {obs.map((f) => (
            <tr key={f.year}>
              <th scope="row">{f.year}</th>
              <td>{f.mean.toFixed(2)}</td>
              <td>{f.tier}</td>
            </tr>
          ))}
          {scenarios.flatMap((s) =>
            (summary.projections[s]?.rows ?? []).map((r) => (
              <tr key={`${s}-${r.year}`}>
                <th scope="row">
                  {r.year} {SSP_LABEL[s]}
                </th>
                <td>{Number.isFinite(r.p50) ? r.p50.toFixed(2) : "n/a"}</td>
                <td>projection (5-95 %: {r.p05?.toFixed(1)}-{r.p95?.toFixed(1)})</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </figure>
  );
}

/** Horizontal bars with optional CI whiskers (SHAP importance, model skill). */
export function BarList({ items, max, unit = "", digits = 2, accent = "var(--brand-b)", label }) {
  const top = max ?? Math.max(...items.map((d) => d.hi ?? d.value));
  return (
    <ul className="space-y-2.5" aria-label={label}>
      {items.map((d, i) => {
        const w = Math.max(0.5, (d.value / top) * 100);
        return (
          <li key={d.id ?? d.label} className="grid grid-cols-[minmax(0,11rem)_1fr_3.5rem] items-center gap-3 text-[14px]">
            <span className="truncate text-ink" title={d.label}>
              {d.label}
            </span>
            <span className="relative h-2.5 rounded-full bg-white/[0.05]">
              <span
                className="bar-fill absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${w}%`, background: d.color ?? accent, "--i": i }}
              />
              {Number.isFinite(d.lo) && Number.isFinite(d.hi) && (
                <span
                  aria-hidden="true"
                  className="absolute top-1/2 h-3 -translate-y-1/2 border-x border-white/50"
                  style={{ left: `${(d.lo / top) * 100}%`, width: `${Math.max(0.4, ((d.hi - d.lo) / top) * 100)}%` }}
                />
              )}
            </span>
            <span className="text-right font-mono text-[13px] text-ink-muted tnum">
              {d.value.toFixed(digits)}
              {unit}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** 2050 uncertainty budget: share of the projection variance per source, one bar per SSP. */
export function BudgetBars({ budget, scenarios }) {
  const SRC = [
    { key: "gcm", label: "Climate-model spread", color: "#6D8DFF" },
    { key: "sensitivity", label: "Surface sensitivity β", color: "#A78BFA" },
    { key: "model", label: "ML model error", color: "#45E0FF" },
    { key: "land", label: "Land-use path", color: color.ok },
  ];
  const rows = scenarios.map((s) => ({ s, b: budget?.[s]?.["2050"] })).filter((r) => r.b);
  if (!rows.length) return null;
  return (
    <div>
      <ul className="space-y-3">
        {rows.map(({ s, b }) => {
          const total = SRC.reduce((a, c) => a + (b[c.key] ?? 0), 0) || 1;
          return (
            <li key={s} className="grid grid-cols-[5.5rem_1fr] items-center gap-3 text-[13px]">
              <span className="font-medium text-ink">{SSP_LABEL[s]}</span>
              <span className="flex h-3 overflow-hidden rounded-full" role="img" aria-label={`${SSP_LABEL[s]}: ${SRC.map((c) => `${c.label} ${Math.round(((b[c.key] ?? 0) / total) * 100)}%`).join(", ")}`}>
                {SRC.map((c) => (
                  <span key={c.key} style={{ width: `${((b[c.key] ?? 0) / total) * 100}%`, background: c.color }} />
                ))}
              </span>
            </li>
          );
        })}
      </ul>
      <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[12.5px] text-ink-muted">
        {SRC.map((c) => (
          <li key={c.key} className="flex items-center gap-2">
            <span aria-hidden="true" className="size-2.5 rounded-full" style={{ background: c.color }} />
            {c.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
