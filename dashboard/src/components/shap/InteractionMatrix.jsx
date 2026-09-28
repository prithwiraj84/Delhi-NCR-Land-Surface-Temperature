/**
 * K×K heatmap of mean |SHAP interaction| (°C), global or within one governance zone.
 *
 * Reading guide
 * - Row = feature plotted in the dependence chart, column = colour (partner) feature: clicking
 *   cell (row, col) plots `row` coloured by `col`. The diagonal holds the main effects.
 * - Main effects are an order of magnitude larger than pairwise interactions, so by default
 *   the colour scale is fitted to the off-diagonal cells only (diagonal drawn neutral); a
 *   toggle puts them back on the scale.
 * - Colour is a single-hue (violet) sequential ramp on a sqrt scale: interaction strengths
 *   are heavily right-skewed, and sqrt keeps the weak-but-real pairs visible.
 *
 * Accessibility: the grid is one tab stop (roving tabindex); arrow keys move, Enter/Space
 * selects, and focus shows the same readout as hover.
 */
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { scaleSequentialSqrt } from "d3-scale";
import { interpolateLab, piecewise } from "d3-interpolate";
import { cn } from "../../lib/cn.js";
import { THEME, zoneColor } from "../../lib/colors.js";
import { fmt, isNum } from "../../lib/format.js";
import { GlassTooltipCard, TooltipRow } from "./GlassTooltip.jsx";
import SegmentedToggle from "./SegmentedToggle.jsx";

const RAMP_LOW = "#1c1f3b";
const RAMP_MID = "#7c3aed";
const RAMP_HIGH = "#e9d5ff";
/** Single-hue violet ramp (dark -> light on the dark surface), interpolated in CIELAB. */
const RAMP = piecewise(interpolateLab, [RAMP_LOW, RAMP_MID, RAMP_HIGH]);
/** CSS gradient sampled from the same ramp so the legend matches the cells exactly. */
const RAMP_CSS = `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map((t) => RAMP(t)).join(", ")})`;
const DIAGONAL_FILL = "rgba(100, 116, 139, 0.28)";
const TOP_PAIRS = 6;

/** Short axis label (≤ 11 chars) so 17 columns fit a panel. */
function shortLabel(meta, name) {
  const text = meta?.label ?? name;
  return text.length > 11 ? `${text.slice(0, 10)}…` : text;
}

/** Validated K×K numeric matrix (or null when the shape does not match `k`). */
function asMatrix(raw, k) {
  if (!Array.isArray(raw) || raw.length !== k) return null;
  if (!raw.every((row) => Array.isArray(row) && row.length === k)) return null;
  return raw;
}

/** Colour-scale domain: max over (off-)diagonal finite cells. */
function matrixMax(matrix, includeDiagonal) {
  let max = 0;
  for (let i = 0; i < matrix.length; i += 1) {
    for (let j = 0; j < matrix.length; j += 1) {
      if (i === j && !includeDiagonal) continue;
      const v = matrix[i][j];
      if (isNum(v) && v > max) max = v;
    }
  }
  return max > 0 ? max : 1e-6;
}

/**
 * @param {object} props
 * @param {object|null} props.interactions  interactions.json (§4.8)
 * @param {Map<string, object>} props.metaByName  manifest feature metadata by name
 * @param {Array} props.zonesMeta            manifest.zones
 * @param {string} props.selectedFeature
 * @param {string|null} props.colorFeature
 * @param {(row: string, col: string) => void} props.onSelectCell
 */
function InteractionMatrix({ interactions, metaByName, zonesMeta, selectedFeature, colorFeature, onSelectCell }) {
  const [scope, setScope] = useState("global");
  const [includeDiagonal, setIncludeDiagonal] = useState(false);
  const [focus, setFocus] = useState(null); // {i, j, pos} of the hovered / focused cell
  const [cursor, setCursor] = useState({ i: 0, j: 1 }); // roving tab stop
  const cellRefs = useRef(new Map());
  const containerRef = useRef(null);

  const names = useMemo(() => interactions?.features ?? [], [interactions]);
  const k = names.length;
  const zoneKeys = useMemo(() => Object.keys(interactions?.by_zone ?? {}).sort((a, b) => a - b), [interactions]);

  const matrix = useMemo(() => {
    const raw = scope === "global" ? interactions?.global : interactions?.by_zone?.[scope];
    return asMatrix(raw, k);
  }, [interactions, scope, k]);

  const scale = useMemo(() => {
    if (!matrix) return null;
    return scaleSequentialSqrt(RAMP).domain([0, matrixMax(matrix, includeDiagonal)]);
  }, [matrix, includeDiagonal]);

  // Rank of each off-diagonal pair (upper triangle) for the readout.
  const pairRank = useMemo(() => {
    const ranks = new Map();
    if (!matrix) return { ranks, total: 0, top: [] };
    const pairs = [];
    for (let i = 0; i < k; i += 1)
      for (let j = i + 1; j < k; j += 1) if (isNum(matrix[i][j])) pairs.push([i, j, matrix[i][j]]);
    pairs.sort((a, b) => b[2] - a[2]);
    pairs.forEach(([i, j], r) => {
      ranks.set(`${i}-${j}`, r + 1);
      ranks.set(`${j}-${i}`, r + 1);
    });
    return { ranks, total: pairs.length, top: pairs.slice(0, TOP_PAIRS) };
  }, [matrix, k]);

  /** Show the readout for a cell element (position measured from the DOM in the event). */
  const showReadout = useCallback((i, j, element) => {
    setFocus({ i, j, pos: tooltipPosition(containerRef.current, element) });
  }, []);

  /** Move the roving tab stop; the cell's onFocus handler then shows its readout. */
  const focusCell = useCallback(
    (i, j) => {
      const ci = Math.min(Math.max(i, 0), k - 1);
      const cj = Math.min(Math.max(j, 0), k - 1);
      setCursor({ i: ci, j: cj });
      cellRefs.current.get(`${ci}-${cj}`)?.focus();
    },
    [k],
  );

  const onKeyDown = (event, i, j) => {
    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (moves[event.key]) {
      event.preventDefault();
      focusCell(i + moves[event.key][0], j + moves[event.key][1]);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusCell(i, 0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusCell(i, k - 1);
    }
  };

  if (!interactions || k === 0) {
    return (
      <p className="rounded-lg border border-dashed border-panel-border p-4 text-xs text-ink-muted">
        Interaction matrix unavailable — <span className="font-mono">interactions.json</span> was not exported with this
        bundle.
      </p>
    );
  }

  const scopeOptions = [
    { value: "global", label: "Global" },
    ...zoneKeys.map((z) => {
      const meta = zonesMeta?.find?.((m) => String(m.id) === z);
      return {
        value: z,
        label: meta?.name?.split(" ")[0] ?? `Zone ${z}`,
        title: meta?.name,
        dot: zoneColor(Number(z), zonesMeta),
      };
    }),
  ];
  const selectedIdx = names.indexOf(selectedFeature);
  const colorIdx = colorFeature ? names.indexOf(colorFeature) : -1;
  /** Cell fill: ramp colour, neutral for off-scale main effects, transparent when missing. */
  const cellFill = (i, j) => {
    const v = matrix[i][j];
    if (!isNum(v)) return "transparent";
    return i !== j || includeDiagonal ? scale(Math.max(v, 0)) : DIAGONAL_FILL;
  };
  const readout =
    focus && matrix ? readoutFor(focus, matrix, names, metaByName, pairRank, cellFill(focus.i, focus.j)) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedToggle
          label="Interaction scope"
          options={scopeOptions}
          value={scope}
          onChange={setScope}
          layoutId="interaction-scope"
        />
        <label className="inline-flex cursor-pointer items-center gap-2 text-[11px] text-ink-muted">
          <input
            type="checkbox"
            checked={includeDiagonal}
            onChange={(e) => setIncludeDiagonal(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-panel-border bg-slate-900 accent-violet focus-visible:ring-2 focus-visible:ring-cyan/70"
          />
          Main effects on colour scale
        </label>
      </div>

      {!matrix ? (
        <p className="text-xs text-ink-muted">No interaction matrix for this scope.</p>
      ) : (
        <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-start">
          <div ref={containerRef} className="relative min-w-0 overflow-x-auto pb-1" onMouseLeave={() => setFocus(null)}>
            <div
              role="grid"
              aria-label="Mean absolute SHAP interaction. Rows: plotted feature; columns: colour feature."
              aria-rowcount={k}
              aria-colcount={k}
              className="grid w-max gap-px"
              // Phones: the label column (≤ 24vw) and 12 px cells let all 17 columns fit a 390 px screen
              // without hidden sideways scrolling; from ~667 px up the sizes are unchanged.
              style={{ gridTemplateColumns: `minmax(4.5rem, min(7rem, 24vw)) repeat(${k}, clamp(12px, 2.4vw, 26px))` }}
            >
              {/* column headers (vertical text) */}
              <div role="row" className="contents">
                <span role="columnheader" aria-hidden="true" />
                {names.map((name, j) => (
                  <span
                    key={`col-${name}`}
                    role="columnheader"
                    title={metaByName.get(name)?.label ?? name}
                    className={cn(
                      "flex h-[5.5rem] items-end justify-center pb-1 text-[10px] leading-none [writing-mode:vertical-rl] rotate-180",
                      j === colorIdx ? "font-semibold text-ink-strong" : "text-ink-muted",
                    )}
                  >
                    {shortLabel(metaByName.get(name), name)}
                  </span>
                ))}
              </div>
              {names.map((rowName, i) => (
                <div role="row" key={`row-${rowName}`} className="contents">
                  <span
                    role="rowheader"
                    title={metaByName.get(rowName)?.label ?? rowName}
                    className={cn(
                      "truncate pr-2 text-right text-[11px] leading-[18px]",
                      i === selectedIdx ? "font-semibold text-ink-strong" : "text-ink-muted",
                    )}
                  >
                    {shortLabel(metaByName.get(rowName), rowName)}
                  </span>
                  {names.map((colName, j) => {
                    const v = matrix[i][j];
                    const diagonal = i === j;
                    const isActivePair = i === selectedIdx && j === colorIdx;
                    const inCross = i === selectedIdx || j === colorIdx;
                    return (
                      <button
                        key={`${rowName}-${colName}`}
                        ref={(el) => {
                          if (el) cellRefs.current.set(`${i}-${j}`, el);
                          else cellRefs.current.delete(`${i}-${j}`);
                        }}
                        type="button"
                        role="gridcell"
                        tabIndex={cursor.i === i && cursor.j === j ? 0 : -1}
                        aria-selected={isActivePair}
                        aria-label={`${metaByName.get(rowName)?.label ?? rowName} by ${metaByName.get(colName)?.label ?? colName}: ${isNum(v) ? fmt(v, 3) : "no value"} °C`}
                        onMouseEnter={(e) => showReadout(i, j, e.currentTarget)}
                        onFocus={(e) => {
                          setCursor({ i, j });
                          showReadout(i, j, e.currentTarget);
                        }}
                        onBlur={() => setFocus(null)}
                        onKeyDown={(e) => onKeyDown(e, i, j)}
                        onClick={() => onSelectCell(rowName, colName)}
                        className={cn(
                          "relative aspect-square min-h-[12px] rounded-[3px] outline-none transition-[transform,box-shadow] duration-150",
                          "hover:z-10 hover:scale-[1.18] focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-cyan",
                          isActivePair && "z-10 ring-2 ring-cyan shadow-glow-cyan",
                          !isActivePair && inCross && "ring-1 ring-slate-400/25",
                        )}
                        style={{ backgroundColor: cellFill(i, j) }}
                      >
                        {diagonal && !includeDiagonal ? (
                          <span
                            aria-hidden="true"
                            className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full"
                            style={{ backgroundColor: THEME.inkMuted }}
                          />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            {readout && focus.pos ? (
              <GlassTooltipCard
                title={readout.title}
                className="absolute z-20"
                style={{ left: focus.pos.left, top: focus.pos.top, transform: focus.pos.transform }}
              >
                <TooltipRow keyShape="dot" color={readout.color} value={readout.value} label={readout.label} />
                {readout.rank ? <TooltipRow value={readout.rank} label="rank among pairs" /> : null}
                <p className="pt-0.5 text-[10px] text-ink-faint">{readout.hint}</p>
              </GlassTooltipCard>
            ) : null}
          </div>
          <TopPairs
            pairs={pairRank.top}
            names={names}
            metaByName={metaByName}
            max={pairRank.top[0]?.[2] ?? 0}
            selectedFeature={selectedFeature}
            colorFeature={colorFeature}
            onSelectCell={onSelectCell}
          />
        </div>
      )}

      {matrix && scale ? <RampLegend max={scale.domain()[1]} includeDiagonal={includeDiagonal} /> : null}
    </div>
  );
}

/** Tooltip text for the focused cell. */
function readoutFor({ i, j }, matrix, names, metaByName, pairRank, color) {
  const v = matrix[i]?.[j];
  const a = metaByName.get(names[i])?.label ?? names[i];
  const b = metaByName.get(names[j])?.label ?? names[j];
  const diagonal = i === j;
  const rank = !diagonal ? pairRank.ranks?.get(`${i}-${j}`) : null;
  return {
    title: diagonal ? `${a} (main effect)` : `${a} × ${b}`,
    value: isNum(v) ? `${fmt(v, 3)} °C` : "—",
    label: diagonal ? "mean |main effect|" : "mean |interaction|",
    color,
    rank: rank ? `#${rank} of ${pairRank.total}` : null,
    hint: diagonal ? "Click to plot this feature" : `Click to plot ${a} coloured by ${b}`,
  };
}

/** Tooltip anchor below/above the cell, clamped inside the scroll container. */
function tooltipPosition(container, cell) {
  if (!container || !cell) return null;
  const box = container.getBoundingClientRect();
  const rect = cell.getBoundingClientRect();
  const centerX = rect.left - box.left + container.scrollLeft + rect.width / 2;
  const below = rect.top - box.top + rect.height + 6;
  const flipUp = rect.top - box.top > box.height * 0.6;
  const left = Math.min(Math.max(centerX, 96), container.scrollWidth - 96);
  return {
    left,
    top: flipUp ? rect.top - box.top - 6 : below,
    transform: flipUp ? "translate(-50%, -100%)" : "translateX(-50%)",
  };
}

/**
 * The strongest off-diagonal pairs as a ranked list (the heatmap's readable companion).
 * Clicking plots the more important feature of the pair (its row) coloured by the other.
 */
function TopPairs({ pairs, names, metaByName, max, selectedFeature, colorFeature, onSelectCell }) {
  if (!pairs.length) return null;
  const label = (name) => metaByName.get(name)?.label ?? name;
  return (
    <div className="min-w-0 flex-1 space-y-1.5 2xl:max-w-xs">
      <div className="flex justify-between text-[10px] uppercase tracking-[0.12em] text-ink-faint">
        <span>Strongest pairs</span>
        <span>°C</span>
      </div>
      <ol className="space-y-1">
        {pairs.map(([i, j, v], r) => {
          const a = names[i];
          const b = names[j];
          const active = (a === selectedFeature && b === colorFeature) || (b === selectedFeature && a === colorFeature);
          return (
            <li key={`${a}-${b}`}>
              <button
                type="button"
                onClick={() => onSelectCell(a, b)}
                aria-pressed={active}
                className={cn(
                  "focus-ring grid w-full grid-cols-[1rem_minmax(0,1fr)_3rem] items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors",
                  active ? "bg-violet/10 shadow-glow-violet" : "hover:bg-slate-800/60",
                )}
              >
                <span className="font-mono text-[10px] text-ink-faint">{r + 1}</span>
                <span className="min-w-0">
                  <span className="block truncate text-ink">
                    {label(a)} <span className="text-ink-faint">×</span> {label(b)}
                  </span>
                  <span className="mt-0.5 block h-1 rounded-full bg-slate-800/70">
                    <span
                      className="block h-full rounded-full"
                      style={{ width: `${max > 0 ? (v / max) * 100 : 0}%`, backgroundColor: RAMP_MID }}
                    />
                  </span>
                </span>
                <span className="text-right font-mono text-[11px] tabular-nums text-ink">{fmt(v, 3)}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Continuous legend for the sqrt ramp (0 … max °C). */
function RampLegend({ max, includeDiagonal }) {
  return (
    <div className="flex items-center gap-3 text-[10px] text-ink-muted">
      <span className="font-mono">0</span>
      <span aria-hidden="true" className="h-2 w-40 rounded-full" style={{ background: RAMP_CSS }} />
      <span className="font-mono">{fmt(max, 3)} °C</span>
      <span className="text-ink-faint">sqrt scale · {includeDiagonal ? "incl." : "excl."} diagonal</span>
    </div>
  );
}

export default memo(InteractionMatrix);
