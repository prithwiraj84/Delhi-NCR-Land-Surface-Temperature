# SUMMARY
I scored the three concepts on six criteria (1-10 each, 60 maximum). **Concept A, Mission Control, is the base: 52/60.** Concept C, Observatory, is second at 49 and contributes the most honesty mechanisms. Concept B, Holographic, scored 45 but contributes the most visual drama and two important data findings.

| Criterion | A Mission Control | B Holographic | C Observatory |
|---|---|---|---|
| Scientific legibility & trust | 9 | 7 | 10 |
| "Futuristic top-class" impact | 8 | 9 | 7 |
| Motion quality & purpose | 9 | 8 | 8 |
| Usability/IA for 1990-2050, day/night, projections | 9 | 7 | 7 |
| Feasibility & performance | 8 | 6 | 8 |
| Accessibility | 9 | 8 | 9 |
| **Total** | **52** | **45** | **49** |

**Concept A, Mission Control (52).**
- It is the most complete and the easiest to build from. It has:
  - a straight time ribbon with sparkline, warming stripes and SSP uncertainty fans;
  - a tier label on every value, drawn as a glyph and pattern, not colour;
  - an uncertainty palette that fades projected colours;
  - Day/Night accent colours checked for colour blindness against the SSP colours;
  - one GPU shader mechanism that drives the time tween, the day/night sweep, split compare and the scenario ripple;
  - shareable URL state, a performance governor that steps quality down, and correct lat/lon placement of the 250 m raster.
- It also found that the daytime urban heat island is negative and must always be shown signed.
- Weaknesses:
  - It keeps v1's absolute-height prisms, which build walls in the hot south-west and hide the rest of the map.
  - Its 16-bit RGBA rasters are heavy.
  - It hard-codes the data tiers: MODIS 2000-25 as observed, 1990-95 as reconstructed. The research shows Landsat is the day backbone from 1990.
  - Its briefing copy is not guarded against what the data actually says.

**Concept B, Holographic (45).**
- It has the strongest visual impact and two key findings:
  - Each epoch is coloured on its own scale, so animating across years would hide real change. Colour scales must be fixed across all years.
  - Absolute heights build walls, so heights should show heat above the mean, with a cap.
- Its best ideas, all grafted into the final spec:
  - a map stage that stays mounted across every view;
  - "data-pure" prism tops that show the exact palette colour, unlit;
  - a map of which spatial-CV folds fail;
  - a coarse 500 m preview raster during playback;
  - a second "ghost" year handle for change comparison;
  - shipping the CPU rendering path first.
- What lost it points:
  - The curved timeline is harder to read and to build.
  - The draggable, angled day/night line is a metaphor that misleads geographically.
  - It patches deck.gl's shader source with a string replace, which is brittle.
  - Particles and bloom add cost without information.
  - Its Day/Night accents collide with the SSP colours: Concept A measured the colour difference at about 7.7-7.9 units under colour-blindness simulation and rejected those choices.

**Concept C, Observatory (49).**
- It is the most honest design, and its ideas are grafted in:
  - a guarded, templated story, so the copy never claims something the data contradicts;
  - five provenance states, each with its own visual pattern;
  - extra timeline tracks: sensor, night availability, coverage, and notes such as the 2022 Terra drift;
  - Atlas small multiples plus a sortable 25-district table;
  - a compare split done by discarding pixels by screen position, which is tiny and works at any camera tilt;
  - isotherms drawn in the shader, brushing on a chart that highlights cells on the map, and an auto-generated text description of the map;
  - a single tokens file that feeds Tailwind, CSS and the colour code.
- What lost it points:
  - It is the least "futuristic": lime accent, serif headlines, flat panels.
  - Seven routes overlap each other (Futures and Story duplicate other views).
  - It produces about 106 small per-frame files.
  - It defaults the map to anomaly, which hides the absolute LST the user asked for.
  - Its sample wireframe shows a +3.1 °C daytime urban heat island, which contradicts the real data (about −1.5 to −2.3 °C).

**Final spec in the report.** The final design is "NCR Thermal/OPS v2": Concept A's shell, tokens, ribbon and motion, with B's and C's ideas grafted on. It specifies:
- six views: Control, Timeline, Drivers, Zones, Model Lab, Sources;
- a persistent map stage with heights showing heat above the mean;
- one blend function in JavaScript that the GPU shader mirrors (CPU path first, GPU second);
- a frame list driven by the manifest, so evidence tiers are never hard-coded;
- binary data cubes per mode and scenario, plus 8-bit lat/lon rasters;
- a guarded Briefing tour that replaces a separate Story route;
- a five-engineer split with frozen interfaces, file paths under `dashboard/src/`, and acceptance criteria.

Note: I left the `dashboard/` folder unchanged. While checking feasibility I found that deck.gl 9.4.0 ColumnLayer exposes a shader hook that can set prism elevation from the blended value, so no string patching of deck.gl's shader is needed.

# RECOMMENDATIONS
- Adopt Concept A (Mission Control) as the base. Graft from B: the persistent stage, prism tops that show the exact palette colour, fixed colour scales, heights that show heat above the mean, the fold-failure map, the 500 m preview during playback, and the ghost/compare handle. Graft from C: guarded templated copy, the sensor/night/coverage/notes tracks, Atlas small multiples, the district ledger, the screen-space compare split, isotherms, brushing to the map, the auto-generated map description, and a single tokens.js.
- Ship the CPU blend function (src/engine/mixFrame.js) first as the reference. Then add the GPU extension and inject elevation through the DECKGL_FILTER_SIZE shader hook, which I checked in the installed deck.gl 9.4.0 ColumnLayer. Do not patch deck.gl's shader source with string replacement, and pin @deck.gl to ~9.4.
- Never hard-code evidence tiers. Every year and day/night mode reads its tier, sensor, overpass time, window and scene count from manifest.timeline.frames. The expected v2 values are: day 1990-2025 observed (Landsat C2 ST), night 2003-2025 observed (Aqua and VIIRS), night 1990-2000 modelled, 2030-2050 projected.
- Use fixed colour scales across all years by default, with the absolute-LST map default only when the manifest says the series is harmonised. Show the daytime urban heat island signed. Route every trend or UHI headline through a guard function with alternate wording.
- Ship v2 data as cubes per mode and scenario: Int16 values, plus Uint8 quantiles and flags. Ship 250 m rasters as 8-bit RGB PNGs in lat/lon (EPSG:4326) with lo/hi per frame. Defer the SHAP/features files until after the first map paint, so boot data stays at or under 1.2 MB.
- Build a v1-compatibility path in the data hooks, so the redesigned UI runs on the current real bundle from day one. Build a synthetic v2 fixture generator (src/data/fixtures/synthV2.js) for local testing without Earth Engine.
- Freeze interfaces in week 0: token names, store shapes, hook signatures, the blend/shader uniform contract and the manifest v2 schema. Then run the five streams (E1 shell, E2 data/state, E3 engine, E4 time and Control chrome, E5 analysis views) in parallel behind ?v2=1.
- Make pooled spatial-block CV (20 km blocks) and leave-one-epoch-out the headline accuracy numbers in Model Lab. Label random CV as the optimistic upper bound. Show the v1-to-v2 change of metric explicitly, so the accuracy gain is not overstated.

# RISKS
- The GPU elevation hook relies on the internals of deck.gl 9.4's ColumnLayer shader. A deck upgrade could break it. Mitigations: pin to ~9.4, add a test that the hook string exists in the installed shader, and keep the CPU path permanently.
- Frosted-glass panels over a WebGL canvas that redraws every frame are expensive on integrated GPUs. The 6-panel limit, switching to solid panels during playback, and performance tier T1 have to be enforced, not left optional.
- The cyan interface accent sits close to the cool arms of the Nocturne and Polar palettes. The on-map reticle is white for this reason, and tokens.test.js must fail if the colour difference between the accent and any palette stop drops below 8.
- Scope is large (six routes, briefing, compare, lens, rasters, Model Lab additions). If the team is short of time, cut in this order: lens, isotherms, tracks drawer, alluvial, small multiples. Keep the ribbon, tiers, day/night, projections and the honest accuracy panel.
- The data contract depends on pipeline outputs that are not built yet: night modelled tier, annual series, projection quantiles, uncertainty budget, downscaling validation. The UI has to degrade gracefully through 'unavailable' states, and the synthetic fixture must be kept in step with the SPEC changes.
- The 250 m rasters must be reprojected to lat/lon in the pipeline. Placing UTM 43N images directly on the map would misplace pixels by about 4 km at the eastern edge. Acceptance test: alignment within 1 px of district boundaries at zoom 11.
- If the v2 feature set grows well beyond 17 features, the SHAP/feature files and the colour palette for the dominant-driver layer both grow. Use quantised binary XAI columns and group drivers into families to keep the files and the palette manageable.
- The guarded briefing copy and the context chips depend on stats computed at runtime. A bad guard could suppress or misstate findings. Every guard is unit-tested against the real and synthetic bundles.

# REPORT
# Delhi NCR LST v2 Dashboard: Final Design Spec

**"NCR THERMAL/OPS v2": Concept A base, with grafts from B and C**

**Status.** This is the binding UI design for v2. The pipeline-facing data contract in section 10 has to be added to `docs/SPEC.md` by the pipeline owner before engineers freeze their interfaces.

**Read-only phase.** No project files were changed. I checked feasibility against the installed `dashboard/node_modules/@deck.gl/layers` 9.4.0 and against the v1 source tree.

**Concept evidence (scratch only):** `C:/Users/PRITHW~1/AppData/Local/Temp/claude/e--LST-replication-study/94d615e4-b613-4110-9bfc-050e85f614c6/scratchpad/{designA,designB,designC}/`. This holds v1 screenshots, palette validators (`palette_check.cjs`, `alt2.cjs`, `pal.cjs`, `tokens.py`) and a baseline build.

---

## Part I: Judging

### I.1 Scores (1 to 10)

| Criterion | A: Mission Control | B: Holographic Lab | C: Observatory |
|---|---|---|---|
| Scientific legibility and trust | **9** | 7 | **10** |
| "Futuristic, top-class" visual impact | 8 | **9** | 7 |
| Motion quality and purpose | **9** | 8 | 8 |
| Usability and IA (1990–2050 timeline, day/night, projections) | **9** | 7 | 7 |
| Feasibility and performance (React, deck.gl, bundle) | **8** | 6 | **8** |
| Accessibility | **9** | 8 | **9** |
| **Total (of 60)** | **52** | 45 | 49 |

### I.2 Rationale

**A: Mission Control (base).**

Strengths:
- It is the most implementable and internally consistent concept.
  - Global time state, with a URL schema and a keyboard map.
  - A straight, legible ribbon combining sparkline, patterned tier track, warming stripes and SSP fans.
  - Tier encoding by glyph and pattern, never by hue alone.
  - VSUP for projections.
  - A perf governor with explicit tiers.
  - The correct EPSG:4326 raster requirement. Drawing UTM imagery on Mercator bounds would misplace pixels by about 4 km at the eastern edge.
- Its Day and Night accents were checked against the SSP colours under CVD simulation. They are the only accents in the three concepts with that check.
- It drew the right product insight from the real bundle. Daytime surface UHI (urban minus rural) is negative in every epoch (−1.5 to −2.3 °C), so the Day versus Night contrast is the core story and every UHI readout must be signed.
- One "two-slot" mix mechanism unifies tween, sweep, split and ripple.

Weaknesses (fixed in the synthesis):
- It keeps absolute-height prisms, which build walls in the south-west.
- It hard-codes tiers: MODIS 2000–25 as observed and Landsat 1990–95 as reconstructed. The research makes harmonised Landsat C2 ST the day backbone from 1990, and makes night before 2003 model-only.
- Its rasters are heavy RGBA 16-bit at 1.2 to 2 MB each.
- The briefing copy is unguarded.
- It has no sensor or annotation tracks.

**B: Holographic Lab (graft source for drama and two key findings).**

Strengths:
- The best "wow": a persistent stage that every instrument docks over.
- Data-pure prism top faces, unlit and carrying the exact LUT colour. Decoration never alters data pixels.
- An explicit Analysis / Present / Lite mode separation.
- Two key findings:
  1. v1 colours each epoch on its own p02–p98, which would erase temporal change in an animation.
  2. Absolute extrusion builds occluding walls, so heights should be anomaly-relative with a cap.
- A fold-failure map. This matches the research finding that v1's poor spatial R² is driven by one north-east fold (Karnal, Shamli, Muzaffarnagar).
- A 500 m "focus-pull" preview during playback.
- A ghost-year handle for change comparison.
- A "CPU path ships first" discipline.

Weaknesses:
- The ChronoArc Bézier with diverging strands needs an arc-length LUT. It is harder to read precisely and degrades on mobile.
- The angled draggable terminator implies a geography that does not exist (B admits it is "a metaphor, not astronomy").
- Vertex-source string patching is brittle across deck versions.
- Particles and bloom add cost without information.
- The solar accent `#FFC56B` and lunar accent `#9FB6FF` collide with the SSP colours (ΔE about 7.7 to 7.9 under CVD, per A's check).
- "No night before 2000" understates the gap: per the research, night before 2003 is model-only.

**C: Observatory (graft source for honesty mechanisms).**

Strengths, the most epistemically careful concept:
- Five provenance states, each with one visual code used everywhere.
- Templated, guarded story copy: a chapter falls back to alternate copy when the data contradicts it.
- Chronometer tracks: SENSOR, NIGHT availability, COVER, and NOTES (L7 SLC-off, Terra drift).
- Atlas small multiples plus a sortable district ledger.
- `ScreenSplitExtension`, a `gl_FragCoord` discard that works at any pitch with one camera.
- Shader isotherms.
- Linked brushing written as a mask attribute.
- `DescribeMap`.
- A single `tokens.js` feeding Tailwind and CSS, which removes v1's three-file sync.
- No new runtime dependencies.

Weaknesses:
- Visually the most conservative (lime phosphor, Newsreader serif, radius-6 flat plates). This under-delivers on "futuristic top-class".
- Seven routes. Story and Futures duplicate Timeline and Control.
- About 106 per-frame files.
- Defaulting the map to anomaly hides the absolute LST the user asked to see.
- Its wireframe example "SUHI +3.1 °C" by day contradicts the real negative daytime SUHI. This shows exactly why copy must be data-driven.

### I.3 Conflict resolutions (decision log)

| # | Conflict | Decision | Reason |
|---|---|---|---|
| D1 | Timeline shape: straight ribbon (A, C) or ChronoArc curve (B) | **Straight ribbon** (A), with C's optional track drawer and B's "SSP strands unfurl at NOW" animation inside the sparkline | Precise year reading, simple hit-testing, works on mobile |
| D2 | Default map variable: absolute (A, B) or anomaly (C) | **Data-driven.** `abs` with a fixed cross-time domain when `manifest.timeline.harmonised === true`, otherwise `anom`. A "weather and sensor context" chip is always visible. Trend claims appear only through guarded copy. | The user asked for LST. The v2 pipeline removes Terra drift (Landsat 10:00–10:50 IST day, Aqua/VIIRS night). C's honesty concern is kept as a guard rather than as a default. |
| D3 | Prism height | **`anomaly+` default**: height ∝ clamp(v − NCR mean of the frame, 0, cap 6 °C). `flat` on mobile and in reduced motion. `absolute` (v1) opt-in. | B and C both measured the occlusion. Colour = value; height = local excess heat. |
| D4 | Colour domain | **Fixed per mode × variable across all frames** (manifest `timeline.domains`). Per-frame stretch is opt-in and labelled "contrast-stretched". | B finding 1 |
| D5 | Interface accent | **Signal cyan `#45E0FF`** for chrome only. On-map selection uses a white reticle with a void halo. Signal is never used inside data ramps. | It keeps the futuristic voice. The night ramp is teal/blue, so on-map UI state uses white to avoid reading as data (C's concern). |
| D6 | Day/Night accents and SSP colours | **A's verified set**: `#FFE27A`, `#E0C9FF`, `#4F9DFF`, `#FF9B3D`, `#FF4F6D` | The only set checked for CVD separation |
| D7 | Ramps | A's Solar (day), Nocturne (night), Polar (diverging), Amplitude (DTR); C's Mist (spread) | All are OKLab-monotonic and verified |
| D8 | Fonts | Space Grotesk, Inter and JetBrains Mono, **self-hosted**. No fourth family. | Newsreader adds weight and a voice that clashes with "futuristic" |
| D9 | IA | **6 routes**: Control, Timeline, Drivers, Zones, Model Lab, Sources. Story becomes a **Briefing** overlay on Control. Futures content splits into Timeline (fans, decomposition), Control (SSP compare) and Model Lab (method). | Fewer places to look, and no duplicated charts |
| D10 | Day/night switch transition | A's **east→west sweep** (both directions; sunset and sunrise reach the east first). The angled draggable terminator is dropped. A Day|Night split is a **compare preset**. | One splitter mechanism, honest geography |
| D11 | Compare and split | C's `ScreenSplitExtension` (screen-space discard on two layer instances) | Works at any pitch and bearing, on both the column and raster layers |
| D12 | Shader architecture | A's two-slot mix. **Elevation injected in the `DECKGL_FILTER_SIZE` hook (no string patch).** CPU `mixFrame()` ships first and is the reference implementation. | Verified: in `@deck.gl/layers` 9.4.0 `column-layer-vertex.glsl.js`, `vec3 pos = vec3(offset, 0.); DECKGL_FILTER_SIZE(pos, geometry);` runs before projection. `pos.z` can therefore carry `project_size(elev * (positions.z + 1.0) / 2.0 * column.elevationScale)` with `getElevation` set to constant 0. |
| D13 | Raster encoding | **8-bit RGB PNG, EPSG:4326.** R = value code (0 = nodata; `value = lo + (R − 1)·(hi − lo)/254`). G = flags (bit 0 outside AOA; bits 1–2 uncertainty tier). B = 0. No alpha. Plus a 500 m preview variant. | About 0.4–0.8 MB per frame. Quantisation is ≤ 0.1 °C, far below the 1.5–2.5 K downscaling RMSE. Without alpha there are no premultiply hazards. |
| D14 | Grid data packaging | **Cubes per (mode, series)**, not per-frame files: `cube_obs_day.i16.gz`, `cube_ssp245_night.i16.gz`, and so on | One fetch per animation track, and about 12 files instead of about 106 |
| D15 | State library | **zustand** (about 1.2 kB). `useData()` facade is kept. | Selector subscriptions plus imperative `getState()` for the rAF engine. A and B agree; C accepts it as an option. |
| D16 | H3 aggregation | Kept (v1 users), moved to the Analyst popover, `h3-js` **dynamically imported** | It leaves the initial bundle |
| D17 | Cinematic extras | Bloom and particles **rejected**. Present mode = Briefing (larger type, caption cards, a slow 8° orbit only in Full motion). | Legibility and GPU budget |
| D18 | Story | C's 9 chapters with **template variables and guards**, delivered as A's stepped Briefing (JSON) | The editorial power of C at A's implementation cost |

---

## Part II: Final design spec

### 1. Principles

1. **Instrument first, theatre second.** There are three cinematic moments: first-load acquisition, crossing NOW, and the Day↔Night sweep. After 3 s idle, nothing moves except the live-data dot.
2. **The map is the stage and never unmounts.** One deck.gl/maplibre instance lives in `AppShell`. Views dock over it, dim it, or (on mobile only) unmount it.
3. **Every value carries its evidence tier.** The tiers are OBSERVED, OBSERVED-SPARSE, RECONSTRUCTED, MODELLED, PROJECTED, and SIMULATED-DEMO, with a DOWNSCALED resolution attribute. Each is encoded as glyph + pattern + text, never hue alone. **The tier always comes from the manifest and is never hard-coded.**
4. **Interpolated frames are not data.** While scrubbing between frames the map tweens, and readouts dim, show "≈", and name the bracket ("2035 ↔ 2040"). Values become exact only on snap.
5. **Uncertainty is visible.** Projections show fans on charts, VSUP fog on the map, and hatching outside the AOA. On Control, the headline skill is pooled spatial-block CV.
6. **Copy is computed and guarded.** Headlines are templates over bundle numbers. Each claim has a guard predicate and an alternate wording.
7. **Glow budget = 3** (playhead, current selection, one alert). Decoration never alters data pixels: prism top faces and raster pixels are the exact LUT colour.
8. **One mechanism, many choreographies.** `mixFrame` (CPU) or the `thermal` uniform module (GPU) drives the time tween, terminator sweep, scenario ripple and compare split.

### 2. Information architecture

#### 2.1 Routes (hash routing, nav rail keys 1–6)

| Key | Route id | Nav label | Contents | Stage behaviour |
|---|---|---|---|---|
| 1 | `control` | **Control** | Map, telemetry, inspector, ribbon, Layer Dock, compare, lens, Briefing | live |
| 2 | `timeline` | **Timeline** | 1990–2050: fan charts (Day/Night panels), thermal barcode, Atlas small multiples, district ledger, Day vs Night dumbbell, rank bump, zone share, threshold-crossing years, future decomposition | dimmed to 40 %, paused; mini-map docked |
| 3 | `drivers` | **Drivers** | SHAP importance (Day, Night and Day−Night diff, importance through time), dependence/threshold explorer with brushing to the map, interaction matrix, cell waterfall, **what-if simulator** | docked right 40 %, live |
| 4 | `zones` | **Zones** | Zone header, share band, 4 zone cards (trajectory + actions), alluvial across all frames, transition matrix, K diagnostics, policy table | docked left 45 % (zones layer) |
| 5 | `lab` | **Model Lab** | Skill scoreboard, error-vs-distance, fold map, fold strip, Moran, AOA, downscaling validation, hindcast and figure of merit, projection method and uncertainty budget, v1→v2 comparison, model card, hardware | hidden (mini maps only) |
| 6 | `sources` | **Sources** | Provenance swimlanes 1985–2050, frame provenance table, caveats (grouped and anchored), contract validation, downloads, citation | hidden |

The **Briefing** (key `B`) is a mode of Control, not a route.

Navigation by width:
- Mobile: tab bar with Control, Timeline, Drivers, Zones, More (Model Lab, Sources).
- Desktop: a 64 px rail with icon + label.

#### 2.2 Global state and URL

```
#/control?y=2040&m=night&s=245&v=abs&l=lst&r=auto&h=anom&q=p50&c=48211&d=7&cmp=y:1990&cam=77.21,28.61,8.2,40,-12
```

| Param | Values | Default |
|---|---|---|
| `y` | 1990–2050 (integer when snapped) | `timeline.now` (2025) |
| `m` | `day` \| `night` \| `dtr` | `day` |
| `s` | `126` \| `245` \| `370` \| `585` (only those in the manifest) | `245` |
| `v` | `abs` \| `anom` (frame-mean-relative) \| `suhi` (rural-reference) \| `delta` (vs cmp) | per D2 |
| `l` | `lst` \| `pred` \| `resid` \| `shap:<feature>` \| `driver` \| `zones` \| `whatif` \| `unc` \| `aoa` | `lst` |
| `r` | `grid` \| `raster` \| `auto` | `auto` (desktop), `grid` (mobile) |
| `h` | `flat` \| `anom` \| `abs` | `anom` |
| `q` | `p05` \| `p50` \| `p95` \| `spread` | `p50` |
| `c`, `d`, `z` | cell index, district id, zone id | — |
| `cmp` | `y:<year>` \| `s:<ssp>` \| `m:night` (Day|Night split) | off |
| `cam` | lon, lat, zoom, pitch, bearing | manifest centre |

**Variable, layer and legend semantics (binding):**
- The legend renders the channel the engine actually drew (`engineStore.legend`: ramp, lo, hi, kind, stretched, note,
  held); `legendSpec` only supplies titles, categorical / zone / driver entries and the AOA key. Categories are
  memoised, so the legend does not change every frame. When the engine draws nothing because the selected content
  is unavailable (e.g. surface UHI at a projected year), `engineStore.legend` is `{kind: "unavailable", note:
  <reason>}` and the legend shows the reason instead of a scale (no "fixed all frames" claim). Compare sides are
  cached per side on content, height mode, brush **and** colour channel: a side coloured with a provisional channel
  (the per-frame Δ scale while the cross-frame domain waits for an SSP cube) is rebuilt once the final channel
  exists, so both sides always match the legend.
- The `pred` layer always shows **absolute** predicted LST (legend title "Predicted LST (absolute)"), whatever the
  `v` selector says.
- Domain-less layers: `delta` uses the p98 of |Δ| over all frames of the mode (observed cube plus the selected SSP
  cube, the reference frame excluded) relative to the current reference year, computed once per (mode, ssp, ref,
  quantile) from a strided sample; nodata stays NaN at the reference year. SHAP / residual / what-if domains are
  never cached from a degenerate (all-zero or fallback) frame, and the legend never says "fixed across all frames"
  unless the domain is cross-frame.
- Evidence-tier labels always come from the manifest tier: "Obs" only for `observed` / `observed-sparse`,
  "Reconstructed", "Modelled", "<SSP> p50".
- Zone labels use `display_name` (fallback `name`) and show `label_caveat` when the bundle provides it (SPEC §1.5).

The URL is written with `history.replaceState`, debounced 250 ms. Nothing is written during playback.

#### 2.3 Keyboard map

The `?` key opens the shortcut sheet. Keys are ignored while typing (keep v1 `isTypingTarget`). The ribbon slider owns the arrow keys while it has focus.

| Key | Action |
|---|---|
| `1–6` | switch route |
| `Space` | play / pause |
| `← →` and `[ ]` (v1 compatible) | previous / next frame |
| `, .` | ±1 year (interpolated) |
| `Shift+← →` | jump to tier boundary (first observed, NOW, 2050) |
| `PgUp` / `PgDn` | +10 years / −10 years (WAI-ARIA slider convention) |
| `Home End` | 1990 / 2050 |
| `D` `N` | Day / Night |
| `T` | toggle Day/Night |
| `A` | DTR |
| `S` | cycle SSP |
| `L` | focus Layer Dock |
| `G` | grid / raster / auto |
| `Z` | downscale lens |
| `C` | compare |
| `H` | probe the hottest cell |
| `B` | Briefing |
| `M` | motion level |
| `Ctrl/⌘ K` | command palette |
| `Esc` | close / unpin |

#### 2.4 Command palette

The palette is a hand-rolled listbox (no cmdk). Groups:
- **Districts:** fly-to.
- **Years:** parses "2045 night ssp585".
- **Layers**, **Views**.
- **Cell id**.
- **Commands:** "Compare 1990 vs 2050", "Day | Night split", "Start briefing", "Export view PNG", "Show caveats", "Reduced motion", "Performance mode".

### 3. Wireframes

#### 3.1 Acquisition sequence

The sequence runs on first load once per session (sessionStorage, inside try/catch):
- Under 2.4 s when data is ready. While data is still loading, the sweep loops with real progress.
- Skippable with any key or click.
- Skipped under Reduced or Off motion.

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ◈ NCR THERMAL/OPS                                          ACQUISITION · PASS 01/01  │
│      76°E·········77°E·········78°E        graticule draws (stroke-dashoffset 600ms) │
│   30°N ·   ╲╲   Landsat descending swath band (60 km) sweeps NE→SW                   │
│        ·    ╲╲▓▒░  cells develop behind the swath (blue-noise rank reveal)           │
│   28°N ·  ▅▆▇█▇╲╲                                                                     │
│ > manifest.json ........................ ok   22 KB                                  │
│ > timeline_series.json ................. ok  140 KB                                  │
│ > cube_obs_day.i16.gz .................. ███████████░░░░ 71 %  0.43 / 0.61 MB        │
│ > xai_2025_day (deferred to idle) ...... queued                                      │
│ 55,150 cells · 1 km · 250 m · 1990 ─ 2050 · REAL · GEE                [ Skip  Enter ]│
└──────────────────────────────────────────────────────────────────────────────────────┘
```

The log lines are real loader events (status, bytes, ms), taken from `BundleStore.progress`.

#### 3.2 Control, desktop (≥ 1280 px; designed at 1440×900)

```
┌ COMMAND BAR 52 ─────────────────────────────────────────────────────────────────────────────────────┐
│ ◈ NCR THERMAL/OPS │ ⌕ district, cell, year, command…  Ctrl K │ [ Day | Night | DTR ] │ SSP2-4.5 ▾ │ ● REAL·GEE │ !9 │ ✓ │ ⛭ │
├──┬ TELEMETRY 44 (h-scroll on overflow; 1 px dividers) ──────────────────────────────────────────────────┤
│  │ NCR MEAN 41.2 °C ▁▂▃▅ │ SURFACE UHI (urban−rural) −1.6 °C · day │ HOT CORE 27 % │ HOTTEST Bharatpur 44.0 │
│  │ Δ vs 1990 +x.x │ SKILL sp-CV R² 0.xx │ ● OBSERVED · Landsat 8/9 C2 ST · 10:40 IST · 2024–26 Apr–Jun │
│N ├────────────────────────────────────────────────────────────────────────────────────┬────────────────┤
│A │ ┌ LAYER DOCK 208 ┐                                            ┌ FRAME / ODOMETER ┐│ INSPECTOR 360  │
│V │ │◉ LST           │                                            │   2 0 2 5        ││ ┌ DISTRICT ───┐│
│  │ │○ Predicted     │                                            │ ● OBSERVED       ││ │Gurugram     ││
│R │ │○ Residual (OOF)│            PERSISTENT THERMAL STAGE         │ Day · 10:40 IST  ││ │38.1 °C +0.4 ││
│A │ │○ SHAP ▸ NDBI   │            1 km prisms, height = °C above    │ window 2024–26   ││ │1990━━●┃┄┄50 ││
│I │ │○ Dominant driver│           NCR mean (cap +6), top = exact    └──────────────────┘│ │Day ── Night ││
│L │ │○ Zones         │            LUT colour; 250 m raster at       ┌ CONTEXT ────────┐│ └─────────────┘│
│  │ │○ What-if Δ     │            zoom ≥ 9.5 (Auto)                  │ ERA5-Land skin T ││ ┌ CELL 48211 ─┐│
│64│ │○ Uncertainty   │                ◯ downscale lens (Z)           │ anomaly +0.8 °C  ││ │waterfall    ││
│  │ │○ AOA           │                                      ⊕ N 25km │ (weather context)││ │features (n) ││
│  │ └────────────────┘ ┌ LEGEND ─────────────────────┐ ┌ VIEW ───────────────────────────┐ │ │timeline     ││
│  │                    │ Solar 28 ─ 40 ─ 52 °C fixed  │ │ GRID 1km │ RASTER 250m │ AUTO   │ │ │AOA inside   ││
│  │                    │ height: °C above NCR mean    │ │ flat│excess│abs · lens · compare│ │ └─────────────┘│
│  │                    │ VSUP wedge · ▨ outside AOA   │ │ ⋯ Analyst (opacity, H3, labels) │ │ [Drivers →]    │
├──┴────────────────────┴──────────────────────────────┴─┴─────────────────────────────────┴─┴────────────────┤
│ TIME RIBBON 128 (3.3)                                                               [ Tracks ▴ ] drawer    │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- Overlays float in 16 px gutters and are drawn as glass panels with HUD corner brackets.
- At most 6 blurred panels sit over the map. Panels switch to the solid style during playback (B).
- When the inspector opens, the deck `padding` is shifted so the camera centre stays visually centred.
- The CONTEXT chip appears only if the bundle exports the ERA5-Land anomaly per frame. It holds C's "weather caveat" in compact form.

#### 3.3 Time ribbon (signature component)

The standard ribbon is 128 px. The optional Tracks drawer adds 96 px.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ►  |◄ ►|  1×▾  ⟲ │ °C  thin annual line (ERA5/VIIRS where exported) · frame markers · SSP fans        │
│ Day|Night SSP▾   │   ○   ○  ●──●──●──●──●──●──●──●  ┃       ╱▔▔▔▔ SSP5-8.5 (solid-bold)            │
│                  │                                   ┃   ╱▔▔▔▔▔▔▔▔ SSP2-4.5 (selected, full α)         │
│                  │                                   ┃ ▔▔▔▔▔▔▔▔▔▔▔ SSP1-2.6 (long-dash, 25 % α)        │
│ ── TRACK 24 ──   │ ▒▒▒▒▒▒▒▒█████████████████████████████┃┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ │
│                  │ ◒1990 ◒1995 ●2000 ●2005 ●2010 ●2015 ●2020 ●2025 NOW ○2030 ○2035 ○2040 ○2045 ○2050 │
│                  │  └89–92┘ (window bracket on hover)                ◆ playhead (signal, glow, 2 px)  │
│ ── STRIPES 12 ── │ ▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌┃▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌ (selected SSP, fog)│
│ tier legend  ● OBSERVED  ◒ OBSERVED-SPARSE  ◐ RECONSTRUCTED  ◇ MODELLED  ○ PROJECTED   (mode-specific)  │
├─ TRACKS DRAWER (C) ─────────────────────────────────────────────────────────────────────────────────────┤
│ SENSOR  L5 TM ▓▓▓▓▓▓▓▓▓▓│L7 (SLC-off 2003+)▓▓│L8 ▓▓▓▓▓│L9 ▓▓ ┆ MODIS Aqua ■■■■ │ VIIRS ■■■ ┆ CMIP6 ░░░  │
│ NIGHT   ◇ modelled (ERA5-Land) ◇ ◇ │●───●───●───●───●───●  ┆ ○ ○ ○ ○ ○                              │
│ COVER   ▃ ▃ ▅ ▅ ▇ █ █ █  (valid-pixel fraction per frame)  ┆                                         │
│ NOTES   ◆2003 L7 SLC-off  ◆2002–07 no L5 Apr–Jun  ◆2020 lockdown  ◆2022 L7 dropped  ◆2020+ Terra drift │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Glyphs and tiers.**
- Glyphs are text-safe: ● observed, ◒ observed-sparse, ◐ reconstructed, ◇ modelled, ○ projected.
- **The tier per year × mode is read from `timeline.frames[].{day,night}.tier`.**
- Expected v2 values: day 1990–2025 observed (1990/1995 possibly observed-sparse, with only about 3 scenes per path/row); night 2003–2025 observed; night 1990–2000 modelled; 2030–2050 projected.

**Track patterns.**
| Tier | Pattern |
|---|---|
| Observed | solid `--surface-3` |
| Observed-sparse | fine dither |
| Reconstructed | 45° hatch |
| Modelled | cross-dots |
| Projected | dashed 4/4 plus fog |

**Window brackets.** Each frame is a multi-year Apr–Jun window, e.g. 1990 = 1989–92. Hovering a tick shows the bracket under it, and the tooltip shows `n scenes`.

**NOW marker.** A 1 px dashed signal line labelled `NOW · 2025 · OBSERVED | PROJECTED`.

**Warming stripes.** NCR mean minus the reference period (`timeline.reference_period`, e.g. 2000–2020), on the Polar ramp. Years without data stay empty. Projected years use the selected SSP at 60 % alpha.

**Interactions.**
- Click a tick to step to it.
- Dragging: the playhead follows the pointer 1:1 and tweens continuously. On release, a magnetic snap (spring-ui) moves it to the nearest frame within 2.5 years. `Shift` disables the snap.
- Hover shows a ghost playhead and a tooltip: "2040 · PROJECTED · SSP2-4.5 p50 38.9 °C [37.8–40.2] · n GCM = 34".
- **Compare bracket:** `Shift`-drag across the track creates an A↔B bracket, which turns on `cmp=y:<A>` and `v=delta`. This merges B's ghost handle and C's bracket.

**Mobile variant.** A 72 px "tape measure": the playhead is fixed at centre and the axis scrolls under it with momentum and snap. It shows the track and ticks only, with a 44 px play button.

#### 3.4 Inspector (right, 360 px; bottom sheet on mobile)

```
┌ INSPECTOR ─────────────────────────── ✕ ┐
│ DISTRICT · Gurugram (Haryana)  ⌖  pin   │
│ 38.1 °C Day 2025 ● obs   +0.4 vs NCR    │
│ ┌ 1990 ───────────────────┃┄┄┄┄ 2050 ┐  │ two stacked mini panels (Day | Night),
│ │ Day   ◒──●──●──●──●──●──┃╱▔▔        │  │ shared x, SSP fan only in the
│ │ Night ◇──◇──●──●──●──●──┃╱▔▔        │  │ selected SSP
│ └──────────────────────────────────────┘  │
│ DTR 13.2 °C · Surface UHI rank 4/25      │
├──────────────────────────────────────────┤
│ CELL #48211 · 28.46N 77.03E · Zone 3     │
│ Obs 41.2 · Pred 40.8 · OOF resid +0.4    │
│ ▸ SHAP waterfall (Day | Night tabs)      │
│ ▸ Feature values (n) with p-ranks        │
│ ▸ Cell timeline 1990–2050 (from cubes)   │
│ AOA ✓ inside (DI 0.21 < 0.47)            │
│ 250 m: 40.1–43.0 °C within this cell     │
│ [Open in Drivers →] [Simulate →] [⤓ CSV] │
└──────────────────────────────────────────┘
```

**States:**
- `empty`: hint "click a cell or press H".
- `district-only`.
- `cell-pinned`.
- `playing-frozen`: badge "► playing".
- `xai-unavailable`: "drivers exist for frames with XAI: 2010–2025".

#### 3.5 Timeline route

```
┌ TIMELINE · 1990–2050 ── scope [NCR ▾][District ▾][Zone ▾] · metric [Mean|P90|Hot-core km²|UHI|DTR] · SSPs ☑126 ☑245 ☑585 ┐
│ ┌ FAN · DAY (absolute °C) ─────────────────────────────────────────────────────┐ ┌ KEY FIGURES (guarded) ───┐ │
│ │ 46┤   ◒   ◒   ●╌●──●──●──●──●──●  ┃       ╱▔▔ 5-8.5 p5–p95                    │ │ Δ obs first→last ± CI    │ │
│ │ 40┤   thin annual line (weather noise)┃ ──── 2-4.5   ╲__ 1-2.6               │ │ Δ 2025→2050 p50 per SSP  │ │
│ ├ FAN · NIGHT (shared x, synced crosshair) ────────────────────────────────────┤ │ first year > 40 °C       │ │
│ │ 30┤   ◇   ◇   ◇  ●──●──●──●──●──●  ┃   fans…                                  │ │ DTR trend                │ │
│ └──────────────────────────────────────────────────────────────────────────────┘ └──────────────────────────┘ │
│ ┌ ATLAS · small multiples (13 × Day row, 13 × Night row; fixed scale; current ringed; click = set year) ───────┐ │
│ │ [▦][▦][▦][▦][▦][▦][▦][▦] ┆ [▦][▦][▦][▦][▦]      (worker-rasterised ImageBitmaps, hover = shared reticle)  │ │
│ └───────────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ THERMAL BARCODE · 25 districts × 61 yrs (canvas) ┐ ┌ DAY vs NIGHT dumbbell ┐ ┌ FUTURE DECOMPOSITION 2050 ──┐ │
│ │ sort [name | Δ | 2050 | DTR]; row click = scope  │ │ sorted by DTR         │ │ climate Δ / land-use Δ /    │ │
│ └──────────────────────────────────────────────────┘ └──────────────────────┘ │ pop Δ; uncertainty budget   │ │
│ ┌ DISTRICT LEDGER (TanStack, sortable; real <table>) ───────────────────────────┐ │ (GCM / sensitivity / land / │ │
│ │ # District State Day Δ Night Δ UHI(d) UHI(n) sparkfan 1990–2050 rank         │ │ model error)                │ │
│ └───────────────────────────────────────────────────────────────────────────────┘ └─────────────────────────────┘ │
│ ┌ RANK BUMP ┐ ┌ ZONE SHARE 100 % (projected fogged) ┐ ┌ THRESHOLD-CROSSING YEARS (district × SSP) ┐            │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Linking:**
- Every chart cursor is bound to the global `year` motion value without React re-renders.
- Clicking a chart's x position sets `year`.
- Hovering a district highlights it everywhere.

**Rules:**
- Day and Night are never drawn in one panel when fans are present.
- Every chart has a `Table ⊞` toggle.

#### 3.6 Drivers

```
┌ DRIVERS · frame [2025 ● Day]  (follows ribbon; non-XAI frames → reason + nearest XAI frame button) ┐
│ ┌ IMPORTANCE ───────────────┐ ┌ DEPENDENCE & THRESHOLDS (canvas scatter) ┐ ┌ WHAT-IF SIMULATOR ───┐ │
│ │ Global | Frame | Zone     │ │ binned mean + CI band, breakpoints,       │ │ presets · feature ·  │ │
│ │ Day | Night | Day−Night Δ │ │ zero crossing; colour-by partner;         │ │ Δ slider · region ·  │ │
│ │ bars + CI + trend sparks  │ │ BRUSH x-range → map mask (cells dim 25 %) │ │ coupled · base frame │ │
│ └───────────────────────────┘ └───────────────────────────────────────────┘ │ RESULT −0.51 °C      │ │
│ ┌ INTERACTION MATRIX ───────┐ ┌ THRESHOLD CARDS ┐ ┌ DOCKED MAP 40 % (SHAP layer) ┐ │ [Show on map →]   │ │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The "Day−Night Δ" view shows where driver signs flip, for example urban, water and NDVI.

#### 3.7 Zones

The layout follows v1, compressed:
- Header: silhouette, K, area, frame.
- A zone share band that animates its widths when the year changes.
- Four ZoneCards: SHAP signature, area trajectory 1990–2050 with an SSP fan, and action rows (`action · expected Δ °C [CI] · feasibility · caveat pip`).
- A **ZoneAlluvial** across all frames, with the projected columns fogged. The v1 TransitionMatrix is a toggle.
- KDiagnostics and PolicyTable.
- Caveat prose becomes pips that open the drawer.

#### 3.8 Model Lab

```
┌ MODEL LAB ── "How good is this model, and where should you not trust it?" ──────────────────────────────┐
│ ┌ HONEST SKILL (headline) ─────────────────────────────────────────────────────────────────────────────┐ │
│ │ Spatial-block CV (20 km blocks, 10 folds, POOLED R²)  Day 0.xx / 1.xx °C   Night 0.xx / 0.xx °C       │ │
│ │ Leave-one-epoch-out (timeline headline)  Day 0.xx  Night 0.xx  · random CV greyed "optimistic bound" │ │
│ │ v1 → v2: spatial R² 0.62±0.31 (XGB, mean-of-folds) → 0.xx pooled · GNN 0.82±0.05 → …                 │ │
│ └───────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ SCOREBOARD model × scheme × mode (cell = value + fold strip) ┐ ┌ ERROR vs DISTANCE TO TRAINING ┐       │
│ ┌ FOLD MAP (blocks coloured by fold RMSE; NE strip visible)    ┐ ┌ MORAN (v1) ┐ ┌ AOA mini map + DI hist ┐│
│ ┌ DOWNSCALING: 250 m vs Landsat (day) / ECOSTRESS (night) · leave-coarse-out 2–4 km→1 km · by LC class   ┐│
│ ┌ HINDCAST: train ≤2015 → 2020/2025 vs obs, vs persistence; land CA figure of merit                    ┐│
│ ┌ PROJECTION METHOD (SVG diagram) + UNCERTAINTY BUDGET (Monte Carlo components)  ┐ ┌ MODEL CARD ┐ HW  ┐│
└───────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### 3.9 Sources

- **Provenance swimlanes** (Gantt, 1985–2050): Landsat 5/7/8/9, MODIS Terra/Aqua, VIIRS S-NPP, DMSP, srunet NTL, GHSL, GLC_FCS30D, WorldCover, Dynamic World, WorldPop, ERA5-Land, CHIRPS, NEX-GDDP-CMIP6, Chen 2020 SSP urban, FuturePop. Clicking a bar opens a source card with collection id, resolution, QC, overpass time and caveats.
- A frame provenance table: every frame × mode, with sensor, scenes, window, coverage and tier.
- Caveats, grouped with anchors `#/sources#caveat-<id>`.
- Contract validation (the v1 report).
- Downloads and citation.

#### 3.10 Compare (`C`)

```
┌──────────────── map ─────────────────────────────────────────────┐
│ [◒ 1990 · Day · Landsat-5 ▾]          ┃          [○ 2050 · SSP2-4.5 p50 · Day ▾] │
│        left = layer instance A        ┃◀▶  right = instance B (same camera)        │
│                                       ┃   cursor readout: "+2.3 °C here (B − A)"  │
└──────────────────────────────────────────────────────────────────┘
presets: Year A|B (default first→2050) · SSP A|B (2050 126|585) · Day|Night (same year)
```

- The divider is a DOM element with `role="separator"`, arrow keys move it 2 %, and its drag uses spring-soft.
- On mobile, the split is replaced by the Δ layer with an A/B toggle.

#### 3.11 Briefing (`B`): guarded story

The Briefing is a stepped caption card, bottom-left, 440 px, with ◄ ► controls and a progress bar. Each step sets `{year, mode, ssp, var, layer, cmp, camera}` (flyTo 1.2 s).

Steps live in `src/views/control/briefing/steps.js`. Each step has `copy` (with `{{vars}}`), `guard(stats) → boolean` and `altCopy`.

| # | Step | State | Guard example |
|---|---|---|---|
| 0 | "{{area_gt40}} km² above 40 °C by day in {{now}}" | now, day, abs | area_gt40 > 0 |
| 1 | The baseline ({{first_year}}, Landsat era) | 1990 day | — |
| 2 | Day: the hottest land is the bare fringe ({{hot_day_district}}) | day, suhi | uhi_day < 0, else alt "the city is hottest" |
| 3 | Night: the island flips (terminator sweep) | night, suhi | uhi_night > 0 |
| 4 | {{first_year}}→{{now}} playback (trend only with CI) | play obs | trend CI excludes 0; an exported CI that includes 0 → "No clear trend: year-to-year weather dominates"; no trend with a CI exported → "no trend with a confidence interval is exported in this bundle — rerun notebook v2" |
| 5 | Crossing NOW into SSP2-4.5 | NOW cinematic | projections exist |
| 6 | 2050: SSP1-2.6 vs SSP5-8.5 | cmp s:126 / 585 | — |
| 7 | What-if: +20 % tree canopy in Gurugram (ripple) | whatif | engine ready |
| 8 | How sure are we (AOA, skill) | aoa layer | — |

A unit test runs every guard against the real and synthetic bundles.

#### 3.12 Tablet (640–1279 px)

- The inspector becomes an overlay drawer (380 px).
- Telemetry scrolls horizontally.
- The ribbon is 104 px, and the stripes hide below 900 px.
- The Layer Dock becomes an icon column.

#### 3.13 Mobile (< 640 px)

```
┌──────────────────────────────┐
│◈ NCR/OPS   [Day|Night] SSP▾ │ 48
│41.2 °C · UHI −1.6 · 27 % · ▸ │ 32 telemetry (h-scroll, snap)
│   map: 2-D, flat, grid 1 km  │
│   (3-D opt-in) ┌───────────┐ │
│                │2025 ● OBS │ │
│ [legend ▾]     └───────────┘ │
├──────────────────────────────┤
│ ► ━━━━━━━━●━━━━━┃┄┄┄┄ 2025   │ 72 tape ribbon
├──────────────────────────────┤
│ ▔▔ Gurugram 38.1 °C      ⌃   │ 96 bottom sheet: peek 96 / half 50vh / full
├──────────────────────────────┤
│ Control Timeline Drivers Zones ⋯│ 56 + safe-area
└──────────────────────────────┘
```

- Touch targets are ≥ 44 px.
- The lens is off; tap-and-hold shows the 250 m detail.
- The stage is unmounted behind non-Control routes and replaced by a static thumbnail.

### 4. Visual language

#### 4.1 Tokens

There is one source, `src/design/tokens.js`. It is consumed by `tailwind.config.js`, by `src/design/tokens.css` (generated CSS variables, or written by hand and kept in sync by a test) and by `src/lib/colors.js`. The UI is dark-only; a light "print" theme exists for PNG export only.

| Token | Value | Use |
|---|---|---|
| `--void` | `#05070D` | map surround, boot |
| `--bg` | `#070B14` | app background (`body`) |
| `--surface-1` | `#0C1220` @ 72 % + blur 12 px, saturate 140 % | glass over map |
| `--surface-2` | `#111A2B` | cards; solid fallback (96 %) |
| `--surface-3` | `#18233A` | hover, inputs, track |
| `--hairline` | `rgba(160,185,225,.14)` | borders |
| `--hairline-strong` | `rgba(160,185,225,.28)` | HUD brackets |
| `--control-border` | `#5E6B80` | input/toggle borders (≥ 3:1) |
| `--ink-strong` | `#F4F7FB` | hero numbers (14.6:1 on s3) |
| `--ink` | `#DFE7F2` | body (12.6:1) |
| `--ink-muted` | `#A3B0C4` | secondary (7.1:1) |
| `--ink-faint` | `#8794AA` | micro labels, axes (5.11:1 on s3) |
| `--signal` | `#45E0FF` | chrome accent: playhead, focus, selection UI (9.97:1) |
| `--reticle` | `#F4F7FB` + 2 px `--void` halo | on-map selection (never cyan, per D5) |
| `--solar` | `#FFE27A` | Day accent (12.2:1) |
| `--lunar` | `#E0C9FF` | Night accent (10.4:1) |
| `--mode-accent` | animated solar ↔ lunar (`@property <color>`) | sky glow, sweep front |
| `--ssp126` | `#4F9DFF` | long-dash |
| `--ssp245` | `#FF9B3D` | solid |
| `--ssp370` | `#C98BFF` | dash-dot. **Optional**: only if the pipeline adds ssp370 from AWS; must pass `palette_check.cjs` before use |
| `--ssp585` | `#FF4F6D` | solid-bold (4.92:1) |
| `--ok` / `--warn` / `--crit` | `#3DDC97` / `#FBBF24` / `#FF6B6B` | status only |
| `--fog` | `rgba(140,160,200,.10)` | projection fog |
| `--hatch` | `rgba(223,231,242,.22)` | reconstructed, AOA |

**Rules.**
- SSP series always carry an end-label plus their distinct dash. The ssp245/ssp585 deutan separation is only 11.7.
- `tokens.test.js` ports the validators. It asserts:
  - WCAG ≥ 4.5 for text tokens;
  - ≥ 3 for non-text;
  - CVD ΔE ≥ 11 between all series accents;
  - monotonic OKLab L for every ramp;
  - ramp stop 0 ≥ 1.5:1 against `--void`;
  - ΔE between `--signal` and every Nocturne/Polar stop reported (fail if < 8).

#### 4.2 Data ramps

All ramps are interpolated in OKLab and baked into 256-entry LUTs (v1 `colors.js` machinery). On the GPU they are a 256×6 RGBA texture with one row per ramp.

| Ramp | Stops | Use |
|---|---|---|
| Solar | `#2A1B6E #5B23A8 #9A2FA8 #D6457A #F5774C #FDB54E #FFF3C4` | Day LST (L 30→96) |
| Nocturne | `#14245C #1B4589 #16709F #1C9AA6 #4CC2A4 #A2E3B6 #ECFBE9` | Night LST (L 28→97) |
| Polar (diverging) | `#B8F0FF #3DD6F5 #0F7FA0 #1E2738 #B3263E #FF6B7D #FFD0D6` | anomaly, SUHI, Δ, SHAP, residual, what-if |
| Amplitude | `#1D2442 #33407C #5B5AA8 #9A6FBE #D68CC0 #F6B9CF #FFF0F4` | DTR |
| Mist | `#1A2230 → #8E9AAD → #EDF1F7` | p95−p05 spread |
| Driver (17+ categorical) | v1 palette, extended by CVD search if v2 adds features; features beyond 17 are grouped into 6 families (spectral, terrain, urban form, population/NTL, land cover, meteorology) for the "dominant driver" layer | driver |
| Zones | v1 `#34D399 #22D3EE #A78BFA #FB7185` | zones |

**Domains.**
- Fixed per mode × variable, from `timeline.domains` (p0.5–p99.5 over all frames).
- "Shared scale" toggle: Solar over the union of the Day and Night domains, for honest day-versus-night magnitude.
- "Contrast-stretched" per frame is opt-in and carries a warning chip.

**VSUP** for projected frames and the `unc` layer:

| Tier | Half-width | Bins | Chroma | Fog |
|---|---|---|---|---|
| U0 | < 0.5 °C | 16 | 100 % | 0 |
| U1 | 0.5–1 °C | 8 | 75 % | 15 % |
| U2 | 1–2 °C | 4 | 50 % | 35 % |
| U3 | > 2 °C | 2 | 30 % | 60 % + hatch |

Cells outside the AOA are always hatched.

#### 4.3 Typography

Fonts are self-hosted with `@fontsource-variable/*` (latin subset, swap), about 90 kB.

| Role | Family | Spec |
|---|---|---|
| Hero year odometer | Space Grotesk 700 | 72–88 px, −0.04em, tabular, per-digit roll |
| H1 view | Space Grotesk 600 | 24 px |
| H2 panel | Space Grotesk 600 | 16 px |
| Briefing headline | Space Grotesk 600 | 32/36 |
| Body | Inter 400 | 14/21 |
| UI labels | Inter 500 | 13 |
| Telemetry values | JetBrains Mono 600 | 15–20, `tnum zero` |
| Micro labels | JetBrains Mono 500 | 11 px, 0.14em, UPPERCASE, ink-faint, never < 11 px |
| Axis ticks | JetBrains Mono 400 | 11 |

- Units are set at 0.7 em in ink-muted.
- Minus is a true minus (U+2212); signs are always explicit.
- Intervals are written "±1.6 °C" or "[37.8–40.2]".

#### 4.4 Icons

- lucide-react (1.5 stroke, 16/20) for general icons.
- Custom inline SVG glyphs (`src/design/glyphs.jsx`, < 4 kB): Swath, Lens, SplitCompare, Terminator, tier glyphs (● ◒ ◐ ◇ ○), SSP strand, registration corner.
- Sun/Moon crescent-morph on toggle.
- No emoji. Icon-only buttons have `aria-label` plus a tooltip.

#### 4.5 Surfaces

- **Glass panel:** `--surface-1`, 1 px hairline, inset top highlight `rgba(255,255,255,.04)`, radius 12 px, and **HUD corner brackets** (8 px L-ticks, 4 background-gradient layers, no extra DOM). The active panel's brackets are `--signal` @ 60 %.
- **One-time mount scan (B):** a 1 px signal line sweeps the panel top→bottom over 600 ms at 30 %, on the first mount per session only.
- **Glow (budget 3):** playhead `0 0 12px rgba(69,224,255,.55)`; selection reticle; one alert. The nav active state is a 2 px signal bar, with no glow.
- **Grain:** a static 128 px `feTurbulence` data-URI at 3 %, overlay blend, on chrome only. It is hidden under forced-colors, `prefers-contrast: more` and print.
- **Vignette:** a CSS radial over the stage edge, transparent at 55 % to `--void` @ 70 %. Sky glow: one static radial in `--mode-accent` @ 6 %.
- **Removed from v1:** the drifting grid, blurred blobs, neon gradient title and `shadow-glow-*` tokens.
- **Map styling:**
  - Basemap: CARTO dark-matter-nolabels, dimmed to 70 % at night.
  - District hairlines.
  - Optional static SRTM hillshade (multiply 18 %, about 300 kB, lazy) for Aravalli context.

#### 4.6 Charts

- Horizontal gridlines only, at `rgba(160,185,225,.08)`. No dual axes.
- Direct end-labels when there are ≤ 4 series.

| Series state | Encoding |
|---|---|
| Observed | solid 1.5 px, filled markers |
| Observed-sparse | hollow markers |
| Reconstructed | 2-4 dash + hatched CI |
| Modelled | dotted + ◇ markers |
| Projected | selected SSP solid; others 25 % α in their dash; fans p5–p95 @ 18 %, p25–p75 @ 32 % |

- The NOW rule appears on every time axis.
- Tooltips use glass with mono values and always show the tier glyph, source and n. Between frames they read "between 2035 and 2040: no data at this x".
- Charts with > 2,000 marks use canvas, with SVG axes.
- Custom SVG with d3-scale/d3-shape for the ribbon, fan charts, sparkfans, alluvial and barcode. Recharts only in lazy view chunks (v1 components).

### 5. Motion system

#### 5.1 Tokens

The tokens live in `src/design/motion.js`, exported as JS for framer-motion and the engine, and mirrored as CSS variables.

| Token | ms | Easing | Use |
|---|---|---|---|
| `instant` | 80 | linear | hover, press, reticle snap |
| `quick` | 140 | `(.2,.8,.2,1)` | tooltip, chip, toggle |
| `base` | 220 | expoOut `(.16,1,.3,1)` | panel/drawer/view enter |
| `exit` | 160 | `(.4,0,1,1)` | exits (≤ 0.75 × enter) |
| `layer` | 400 | cubicInOut `(.65,0,.35,1)` | layer colour crossfade |
| `epoch` | 800 | cubicInOut | automated frame step (play, click) |
| `elev` | 550 | cubicInOut | elevation morph |
| `ticker` | 500 | expoOut | number tickers |
| `terminator` | 700 | sineInOut `(.37,0,.63,1)` | Day↔Night sweep |
| `unfurl` | 900 (+120 ms stagger) | cubicInOut | SSP strands at NOW |
| `flight` | 1200 | FlyToInterpolator, curve 1.4 | camera |
| `cinematic` | ≤ 2400 | scripted | boot only |
| `data` | — | **linear** | scrub interpolation (value-linear in t) |
| `spring-ui` | — | stiffness 420, damping 34 | pills, playhead snap, layoutId |
| `spring-soft` | — | stiffness 260, damping 30 | sheets, docking, divider |

**Laws.**
1. Data never overshoots. Springs are used for chrome only.
2. Exits are at most 75 % of the entrance duration.
3. Stagger is ≤ 40 ms per item, ≤ 8 items.
4. During playback only transform, opacity, CSS variables and GPU uniforms animate.
5. Everything pauses on `visibilitychange` hidden.
6. Each element animates at most 2 properties.

#### 5.2 Choreographies

**A. Scrub.**
1. The pointer maps to `timeStore.scrubT` 1:1, rAF-batched.
2. The engine sets `mix = (t − yA)/(yB − yA)` and rebinds slots only when the bracket changes.
3. The odometer shows `≈2032` in italic.
4. Telemetry dims to 50 % and shows `2030 ↔ 2035`.
5. Chart cursors follow through refs, with no React re-render.
6. On release: snap with spring-ui (about 250 ms), tickers settle over 500 ms, and the live region announces.

**B. Playback (`Space`).**
- At 1×: 800 ms tween plus 800 ms hold per frame, about 21 s for 13 frames. 0.5× and 2× scale both phases.
- Picking and autoHighlight are off during playback, and the inspector shows "► playing".
- Play starts at the current year. At 2050 it stops, or with loop on it fades back to 1990 over 1.2 s.
- If the next frame is not loaded, the playhead waits with a pulse ("buffering"). The map never blanks.
- At 250 m, playback uses the 500 m preview and pulls in 250 m on pause (240 ms crossfade, 2 px blur to 0).

**C. Crossing NOW (once per pass, 1.1 s).**
| Time | Event |
|---|---|
| 0 ms | the NOW rule pulses once |
| 0–600 ms | the fog uniform ramps in; the projected track brightens; the telemetry tier label cross-fades (`OBSERVED · Landsat` → `PROJECTED · SSP2-4.5 · p50 [p5–p95]`); the odometer tier chip flips (rotateX) |
| 0–900 ms | SSP strands unfurl in the sparkline (stroke-dashoffset, 120 ms stagger) |
| 400 ms | toast for 4 s, once per session: "Entering projections: model + CMIP6 scenario, not observations" |
| — | playback holds an extra 400 ms at 2030 |

**D. Day↔Night sweep (700 ms).**
- Slot A holds the current mode and slot B the other. Shape is `sweep` on normalised longitude, **east→west**, with feather 0.08 and a 1 px `--mode-accent` front line.
- In parallel:
  - the `--mode-accent` CSS variable;
  - the sky glow;
  - the deck lighting preset (Sun: warm, high; Moon: ambient 0.9, key 0.5, `[180,200,255]`);
  - the legend LUT crossfade;
  - the Sun/Moon morph;
  - tickers.
- Night frames with tier `modelled` keep the ◇ chip after the sweep.

**E. Layer change.** Continuous layers crossfade through slot A/B with shape `fade` over 400 ms. Elevation morphs over 550 ms. Categorical layers (driver, zones) use a 220 ms opacity fade. The legend cross-fades with its ticks sliding 4 px.

**F. Resolution change ("develop").**
- Going finer, 1 km → 250 m: prisms sink (300 ms exit), the raster appears through a blue-noise dissolve (400 ms) and pitch eases 40→30 (600 ms).
- Going coarser runs the reverse, with prisms rising over 550 ms.
- If the raster is not ready, a ring loader shows on the Render chip and the map stays at 1 km.

**G. Compare.** The divider enters from the right (base timing); dragging is 1:1.

**H. Scenario ripple ("Show on map").** Shape `radial` from the region centroid over 800 ms. The result ticker counts from −0.00 to the final value.

**I. Route change.** The stage stays mounted. Outgoing panels fade and slide 4 px up (160 ms). The stage dims (240 ms) and is then paused. Incoming panels rise 8 px with blur 4→0 (220 ms), staggered 40 ms in reading order. The camera eases to the route framing only if the user has not moved it in the last 10 s.

**J. Tickers.**
- `AnimatedNumber` (v1) for values.
- `YearOdometer`: per-digit roll, 420 ms expoOut, 30 ms right-to-left stagger, only changed digits roll.
- Tickers update at 10 Hz without animation while scrubbing.
- Δ arrows are coloured from the Polar arms, with "warmer/cooler" in the `aria-label`.

**K. Loading.**
- Scanline skeleton: `--surface-2` with a 1 px signal @ 30 % sweeping over 1.6 s.
- Real byte progress from the fetch `ReadableStream`.
- Stale-while-loading, with a "⟳ 2040 night streaming" chip.

**L. Ambient.** Allowed idle motion: the live-dot pulse (2.8 s), and the satellite glyph orbiting while playing. Present mode adds a slow 8° bearing orbit over 40 s in Full motion only; it stops on any input.

#### 5.3 Reduced-motion matrix

The motion level is System, Full, Reduced or Off. It is chosen from the ⛭ menu or the `M` key and stored in localStorage inside try/catch.

| Element | Full | Reduced | Off |
|---|---|---|---|
| Boot | 2.4 s | skipped (static checklist) | skipped |
| Camera flight | 1200 ms | 150 ms fade cut | jump |
| Scrub interpolation | GPU tween | tween (user-driven) | snap to frames |
| Playback | 800 + 800 | no tween, 2.5 s per frame | step buttons only, 3 s |
| Terminator | 700 sweep | 150 fade | jump |
| Tickers, odometer | roll | jump | jump |
| NOW crossing | pulse, fog ramp, unfurl | fog jump + toast | toast only |
| Panels | stagger + blur | opacity 120 ms | none |
| Ripple, develop | radial, dissolve | 200 fade | jump |
| Ambient, orbit | yes | none | none |

Playback never autostarts (WCAG 2.2.2). Nothing flashes above 3 Hz; the fastest playback is 0.8 s per frame.

### 6. Map engine

#### 6.1 Layer stack (bottom → top)

1. maplibre basemap (v1 `Basemap.jsx` health fallback kept).
2. Optional hillshade bitmap.
3. **`ThermalColumnLayer`** (1 km) and/or **`ThermalRasterLayer`** (250 m), both with `ThermalSlotsExtension`. In compare mode each has a second instance with `ScreenSplitExtension`.
4. In-shader VSUP, AOA hatch, brushing mask and isotherms (raster only, `fwidth` anti-aliased, 1 °C step, every 5th line bold).
5. District boundaries (`GeoJsonLayer`, hairline; hovered district at 1.5 px ink).
6. Labels (`TextLayer` + `CollisionFilterExtension`, from v1).
7. Lens mask circle (`ScatterplotLayer`, `operation:'mask'`) and its rim.
8. Pinned-cell layer (v1, restyled to the white reticle) and the hover reticle.
9. Boot only: `SwathSweepLayer` (PathLayer band).

#### 6.2 The two-slot contract (one function, two implementations)

`src/engine/mixFrame.js` is the CPU reference, unit-tested. The GLSL mirrors it exactly.

```js
// shape: 0 fade | 1 sweep (east→west) | 2 radial | 3 split (screen x; GPU only, CPU uses two instances)
export function mixWeight(i, { shape, mix, lonNorm, sweepPos, feather, cx, cy, radius, x, y }) { /* returns m in [0,1] */ }
export function mixFrame({ a, b, scaleA, scaleB, nodata, shape, params, out /* Float32Array */ }) { /* out[i] = lerp(A,B,m_i) or NaN */ }
```

**Uniform module `thermal`:** `mix`, `shape`, `sweepPos`, `feather`, `center`, `radius`, `domainMin`, `domainMax`, `rampRowA`, `rampRowB`, `rampMix`, `fogStrength`, `vsupOn`, `hatchOn`, `heightMode`, `heightRef` (mixed NCR mean), `heightCap`, `maskOn`, `isoStep`.

**Column attributes**, added in the extension's `initializeState` through `attributeManager.addInstanced`:
- `instanceValueA`, `instanceValueB` (f32);
- `instanceAux` (unorm8×4: uncertainty tier A, uncertainty tier B, AOA bits, brush mask).

Slots are rebound only when the bracket changes: 2 × 55,150 × 4 B ≈ 441 kB.

**Elevation.** `getElevation` is the constant 0. The extension injects into `vs:DECKGL_FILTER_SIZE`:

```glsl
float v = mix(instanceValueA, instanceValueB, m);
float e = heightMode == 1 ? clamp(v - heightRef, 0., heightCap)
                          : (heightMode == 2 ? max(v - domainMin, 0.) : 0.);
size.z += project_size(e * elevPerDegree * (positions.z + 1.0) / 2.0 * column.elevationScale);
```

- This was verified against deck 9.4.0 `column-layer-vertex.glsl.js`: `pos` is added to `centroidPosition` after `DECKGL_FILTER_SIZE`.
- Pin `@deck.gl/*` to `~9.4`.
- A Vitest test checks that the hook string exists in the installed shader source.
- v1's `zoomElevationFactor` damping is kept through `elevationScale`.

**Colour.**
- Sampled from the LUT texture row, with `rampMix` for the layer crossfade.
- **Top faces (normal.z > 0.9) are unlit, exact LUT colour.** Side faces use the v1 satin lighting plus a faint Fresnel rim at 0.25 (B's holographic edge, side faces only).
- VSUP quantises and desaturates in OKLab, then mixes toward fog.
- Hatch: `mod(gl_FragCoord.x + gl_FragCoord.y, 6.) < 1.5` darkens by 35 %.
- The brush mask dims to 25 %.

**Categorical layers** (driver, zones) keep the v1 CPU colour path with no tween.

**CPU fallback** (`?shader=off`, compile failure, or perf tier 3):
- `mixFrame` per rAF (about 1 ms for 55k cells), colour by LUT lookup, binary `data.attributes`, throttled to 30 Hz while scrubbing.
- Sweep and radial run per instance through `mixWeight`. Split uses two instances with `ScreenSplitExtension`, which is trivial and always available.
- **This path ships first (milestone M1). The GPU extension is M2.**

#### 6.3 `ThermalRasterLayer` (250 m)

- A subclass of `BitmapLayer` with a custom fragment shader. It uses `_imageCoordinateSystem: COORDINATE_SYSTEM.LNGLAT` with rectangular `bounds` from `raster_index.json`. **Rasters are EPSG:4326 only.**
- Textures A and B are created from the RGBA bytes decoded in the data worker (pure-JS PNG decoder, see PNG decode below) and transferred to the main thread. Filtering is NEAREST.
- Decode: `R == 0` → discard; value = `lo + (R·255 − 1)·(hi − lo)/254`; G holds the flags.
- The same LUT, domain, sweep, VSUP, hatch and split as the columns, so switching resolution never changes colours.
- **PNG decode:** rasters are decoded in the data worker by the pure-JS PNG decoder (exact bytes; no canvas pixel readback, no ImageBitmap kept).
- **Hover readout:** `MapEngine.readRaster` reads the decoded values of the current frame (lon/lat → pixel, no GPU picking). The 1 km parent cell is found through a lon/lat bin index built once.
- **Cache:** an LRU of 8 textures (about 58 MB VRAM worst case). Prefetch ±1 frame for the current mode and SSP.
- Availability is per frame from the manifest. The 250 m toggle shows a reason when unavailable, e.g. "1990: not downscaled".

#### 6.4 Downscale lens (`Z`)

- A circle of 110 px desktop radius, following the pointer, throttled to rAF.
- `MaskExtension`: the raster shows inside the circle; the columns use `maskInverted: true` outside.
- The rim is a 1 px signal ring with the tag "250 m · DOWNSCALED".
- Disabled on touch (tap-and-hold instead) and at perf tier ≥ 2.

#### 6.5 Render loop and React boundary

- `src/engine/MapEngine.js` owns the deck instance through the `DeckGL` ref. It subscribes to `timeStore` and `viewStore` through `subscribe`/`getState`, and calls `deck.setProps({layers})` in one rAF loop, only when uniforms or slots change. **React never re-renders on scrub.**
- When the stage is dimmed, hidden or idle for 2 s in Analysis mode, set `_animate:false` and stop redraws.
- `useDevicePixels: min(devicePixelRatio, 1.5)`.
- Keep v1's `EVENT_RECOGNIZER_OPTIONS` click fix. Hover picking is limited to 30 Hz and is off during play or drag.
- Camera home: manifest centre, zoom 7.7, pitch 40, bearing −12. 2-D on mobile and in Reduced motion. Keyboard camera is on.
- Lose-context handling: a `webgl-lost` card with Retry.

#### 6.6 Perf governor (`src/engine/perfGovernor.js`)

- The governor samples the per-frame **work time** (main-thread engine frame time + deck CPU/GPU time), not the render interval. Demote one tier and show a `PerfChip` with undo when the work exceeds 22 ms, or the interval exceeds max(1.5 × the vsync period, 25 ms), for 2 s. Recover after 10 s under min(14 ms, 0.9 × the vsync period) with a healthy interval. Undo starts a 30 s hold without changing the user floor; when the current tier is the user's own choice (tier = floor) there is nothing automatic to undo, so Undo writes the previous tier as a new user choice.
- **Vsync estimate.** The smaller of (a) an idle rAF probe: after an animation ends, at most every 30 s, a burst of ~24 empty rAF callbacks measures the display refresh while nothing renders (aborted as soon as the engine renders again), and (b) a long-window minimum of the rendered intervals (25th percentile of the last 120, allowed to rise towards slower values only with a 60 s time constant). A GPU-bound map (deck reports no GPU time without timer queries) therefore cannot teach the governor its own slow interval as "vsync". Without any probe sample, a device that is slow from the very first frame is indistinguishable from a slow display and stays at T0.
- `?perf=1` shows a dev HUD with fps, frame ms, GPU memory estimate and tier.

| Tier | Action |
|---|---|
| T1 | solid panels (no backdrop blur) |
| T2 | flat lighting, lens off, DPR 1, isotherms off |
| T3 | 2-D, CPU path, raster only on pause |

### 7. State architecture and data hooks

```
src/state/
  stores/timeStore.js       zustand: { year, scrubT (float), playing, speed, loop, snap, mode, ssp,
                                       bracket:{iA,iB,mix}, compare:{kind,a,b,splitPx} }
                            actions: setYear, scrubTo, release, play, pause, step(±1), jumpTier(±1),
                                     setMode, cycleSsp, setCompare
  stores/viewStore.js       { route, layer, shapFeature, variable, renderMode, heightMode, quantile,
                              lens, analyst{opacity,h3,labels,boundaries,hillshade}, motionPref,
                              perfTier, briefing{active,step}, domainMode }
  stores/selectionStore.js  { hoverIndex, pinnedIndex, districtId, zoneId, brushMask (Uint8Array|null) }
  urlSync.js                two-way sync of the URL schema (§2.2), replaceState debounced 250 ms
  DataContext.jsx           BundleStore: manifest, timeline, series, districts, model, metrics, zones,
                            validation, scenario worker. Exposes useData() facade so v1 components work.
```

**Hooks (`src/data/hooks.js`).** These are the interfaces engineers code against. All return `{status:'idle'|'loading'|'ready'|'unavailable'|'error', data, reason}`.

```js
useTimeline()                       // frames[], now, tiers per year×mode, domains, scenarios, annotations, harmonised
useFrameTier(year, mode, ssp)       // {tier, sensor, overpass, window, scenes, coverage}
useCube(mode, series)               // series: 'obs' | 'ssp245' …  → {values: Int16Array, years[], n, scale, nodata}
useFrameValues(year, mode, ssp, q)  // Float32Array view for an exact frame (used by inspector, charts)
useBracket()                        // {iA, iB, mix, yA, yB}  (coarse subscription; engine reads getState())
useSeries(scope, mode)              // scope 'ncr' | 'd:<id>' | 'z:<id>' → {annual[], frames[], ssp:{p05..p95}[]}
useCellTimeline(index, mode)        // per-cell values across all frames, from cubes (worker gather)
useXai(year, mode)                  // features + SHAP columns for frames with xai:true (lazy, idle prefetch)
useRaster(key, {preview})           // {values, flags, width, height, bounds, lo, hi, tier, downscaled}: bytes decoded by the pure-JS PNG decoder in the worker (no ImageBitmap kept, §6.3, D22 d); LRU-managed (8)
useDomain(mode, variable)           // fixed domain from manifest (or stretched if domainMode==='frame')
useFrameStats(year, mode, ssp)      // NCR mean, UHI signed (urban>50 % vs rural<5 %), hot-core %, hottest district
useGuardedCopy(templateId)          // {text, guardPassed} from bundle stats
```

**v1 compatibility.** If `manifest.schema_version` is below "2.0":
- `useTimeline()` synthesises frames from v1 epochs (day only, observed, MODIS Terra);
- night, projections and rasters show the `unavailable` state with reasons.

The v2 UI therefore runs on the current real bundle from day one.

### 8. Component inventory and file layout (`dashboard/src/`)

```
design/      tokens.js  tokens.css  tokens.test.js  motion.js  ramps.js (LUT bake, reuses lib/colors.js)  glyphs.jsx
state/       stores/{timeStore,viewStore,selectionStore}.js  urlSync.js  DataContext.jsx (refactor)  contextLogic.js (kept)
data/        timeline.js  cubes.js  rasters.js  series.js  xai.js  hooks.js  dataWorker.js  validateV2.js
             fixtures/synthV2.js (1990–2050, day/night, 3 SSP, rasters, realistic ranges incl. negative day UHI)
engine/      MapEngine.js  mixFrame.js (+ .test.js)  perfGovernor.js  lighting.js
             extensions/ThermalSlotsExtension.js  extensions/ScreenSplitExtension.js
             layers/ThermalColumnLayer.js  layers/ThermalRasterLayer.js  layers/lens.js  layers/swath.js
             layers/overlays.js (boundaries, labels, reticle; moved from components/map/layers.js)
             shaders/thermal.glsl.js
shell/       AppShell.jsx  CommandBar.jsx  NavRail.jsx  CommandPalette.jsx  BootSequence.jsx  ShortcutSheet.jsx
             SettingsMenu.jsx  LiveAnnouncer.jsx  ToastHost.jsx  PerfChip.jsx  ThermalStage.jsx (persistent map)
time/        TimeRibbon.jsx  RibbonSparkline.jsx  RibbonTrack.jsx  EpochTick.jsx  Playhead.jsx  WarmingStripes.jsx
             TracksDrawer.jsx  PlaybackControls.jsx  SspChips.jsx  YearOdometer.jsx  DiurnalSwitch.jsx
             ScenarioPicker.jsx  playback.js (scheduler)  ribbonScale.js (+ .test.js)
views/control/   MissionControl.jsx  TelemetryStrip.jsx  TelemetryItem.jsx  FrameCard.jsx  ContextChip.jsx
                 LayerDock.jsx  ThermalLegend.jsx  VsupWedge.jsx  MapToolbar.jsx  AnalystPopover.jsx  RenderSwitch.jsx
                 CompareDivider.jsx  CompareChips.jsx  HoverCard.jsx  DescribeMap.jsx
                 inspector/{InspectorPanel,DistrictSummary,MiniFanChart,CellSummary,FeatureTable,CellTimeline,AoaBadge,BottomSheet}.jsx
                 briefing/{Briefing.jsx, steps.js, guards.js, guards.test.js}
views/timeline/  TimelineView.jsx  ScopePicker.jsx  KeyFigures.jsx  AtlasStrip.jsx  DistrictLedger.jsx
                 DayNightDumbbell.jsx  RankBump.jsx  ZoneShareArea.jsx  ThresholdYearTable.jsx  FutureDecomposition.jsx
views/drivers/   DriversView.jsx  ImportanceDiff.jsx  ImportanceTrend.jsx  (+ v1 components/shap/* reused in place)
views/zones/     ZonesView.jsx  ZoneAlluvial.jsx  CaveatPip.jsx  (+ v1 components/zones/* reused)
views/lab/       ModelLab.jsx  HonestSkill.jsx  SkillScoreboard.jsx  ErrorDistance.jsx  FoldMap.jsx  AoaPanel.jsx
                 DownscaleValidation.jsx  HindcastPanel.jsx  UncertaintyBudget.jsx  ProjectionMethod.jsx  ModelCard.jsx
                 (+ v1 components/performance/* reused)
views/sources/   SourcesView.jsx  ProvenanceSwimlanes.jsx  FrameProvenanceTable.jsx  CaveatsList.jsx  Downloads.jsx
viz/         FanChart.jsx  Sparkline.jsx  Sparkfan.jsx  ThermalBarcode.jsx (canvas)  SmallMultiples.jsx
             thumbWorker.js (OffscreenCanvas rasteriser)  Hatch.jsx (SVG patterns)  ChartTable.jsx
components/ui/   v1 primitives re-tokenised + HudFrame.jsx MicroLabel.jsx TierGlyph.jsx Delta.jsx ScanSkeleton.jsx Segmented.jsx
```

**Key component props and states.**

| Component | Props | States |
|---|---|---|
| `ThermalStage` | — (engine-driven); `onPick`, `onHover` | live, dimmed-paused, lite, compare, lens, webgl-lost |
| `TimeRibbon` | `variant:'full'\|'compact'\|'tape'` | idle, hover, dragging, snapping, playing, buffering, bracket |
| `EpochTick` | `year, tier, window, available` | default, hover, current, unavailable, loading |
| `DiurnalSwitch` | `value, available{day,night,dtr}` | night shows ◇ "modelled" when tier=modelled |
| `ScenarioPicker` | `ssp, options` | soft-disabled when year ≤ now ("applies 2030–2050") |
| `FrameCard` | `year, tier, sensor, overpass, window, res, ci, aoaPct, interpolated` | observed, sparse, reconstructed, modelled, projected, interpolated, unavailable, loading |
| `TelemetryItem` | `label, value, unit, delta, semantics, spark, tier, interpolating` | exact, interpolating, loading, n/a |
| `LayerDock` | `value, shapFeature` | item available, unavailable-for-frame (reason), loading |
| `ThermalLegend` | `ramp, domain, unit, variable, heightMode, vsup, aoa, domainMode` | single, shared-scale, categorical, stretched-warning |
| `InspectorPanel` | `open` | empty, district, cell, playing-frozen, xai-unavailable |
| `FanChart` | `series, mode, ssps, selectedSsp, showAnnual, cursorRef` | loading, empty, partial (gaps never interpolated silently) |
| `Briefing` | `steps` | step n/N, guard-alt, done |
| `BootSequence` | `progress` | sweeping, waiting, done, skipped |

**Mapping v1 to v2.**

| v1 | v2 |
|---|---|
| `MapContainer.jsx` | splits into `ThermalStage` + `MissionControl` + `engine/*` |
| `LayerControls.jsx` | `LayerDock` + `AnalystPopover` |
| `KpiChips.jsx` | `TelemetryStrip` |
| `MapLegend.jsx` | `ThermalLegend` |
| `CellInspector.jsx` | `InspectorPanel` (CellWaterfall kept) |
| `ScenarioChip.jsx` | moves into the what-if result card |
| `ShapDependenceViewer.jsx` | `DriversView` |
| `GovernanceZoning.jsx` | `ZonesView` |
| `ModelPerformance.jsx` | `ModelLab` |
| `LoadingScreen.jsx` | `BootSequence` |
| `App.jsx` header epoch pills | `TimeRibbon` |
| `components/ui/Skeleton.jsx` | `ScanSkeleton` |
| `DataCaveats` | `CaveatsList` + `CaveatPip` |
| `useH3Aggregation.js` | kept, with `h3-js` dynamically imported |

**Kept unchanged in logic:** `lib/data.js`, `validate.js` (extended), `model.js`, `scenario*`, `uncertainty.js`, `shapMath`, `perfModel`, `zoneModel`, `mapMetrics`, `colors.js` OKLab, `ErrorBoundary`, `EmptyState`, `ErrorState`, `DataModeBanner` (synthetic banner persistent per SPEC §5), all existing tests.

### 9. Content and integrity rules

- **Tier chip text examples:**
  - `● Landsat 8/9 C2 ST · 10:40 IST · 2024–26 Apr–Jun · n=11 scenes`
  - `● Aqua + VIIRS · 01:30/02:06 IST`
  - `◇ Modelled (ERA5-Land-driven) · no satellite night LST before 2003`
  - `○ SSP2-4.5 · p50 [p5–p95] · 34 GCMs`
  - `250 m · DOWNSCALED`
- **UHI copy:** always "Surface UHI (urban − rural)", signed and mode-tagged. Example: "−1.6 °C by day: built-up land is cooler than the bare semi-arid fringe at mid-morning." The night clause appears only when the guard passes.
- **Accuracy copy:** "Spatial-block CV R² 0.xx (pooled, 20 km blocks): skill in unseen areas." Random CV always carries the tag "optimistic upper bound". The v1→v2 comparison states the metric change (mean-of-folds → pooled).
- **Trend copy:** never inferred from frame means. Only shown when the exported trend CI excludes 0. "No clear trend: year-to-year weather dominates." only when an exported CI includes 0; when no trend with a CI is exported: "no trend with a confidence interval is exported in this bundle — rerun notebook v2".
- **Projection copy:** "Model + CMIP6 scenario, not observations." AOA % is always shown.
- **Projected change copy:** "Δ vs weather-normalised 2025 baseline (p50)", with the baseline value and a note that
  the observed 2025 value includes the 2024–26 weather anomaly. Fans, strands and sparkfans start at the scope baseline
  (the first projected frame's `baseline_c`) with a hollow "baseline" marker, never at a zero-width observed point.
- **Zone names:** `display_name ?? name` everywhere a zone name appears; `label_caveat` is shown next to it when present.
- **Unsupported browser:** without `DecompressionStream` the app shows an explicit unsupported-browser state
  (Chrome/Edge 80+, Firefox 113+, Safari 16.4+), not a generic data error.

### 10. Data the UI needs (v2 bundle; to be added to `docs/SPEC.md`)

| File | Content | Size (gz) | When loaded |
|---|---|---|---|
| `manifest.json` (`schema_version` "2.0") | `timeline: {now, harmonised, reference_period, frames:[{year, window:[y0,y1], kind, day:{tier,sensor,overpass_ist,scenes,coverage,native_m}, night:{…}, xai:{day,night}, raster:{day,night}}], scenarios:[{id,label}], domains:{day:{abs,anom,suhi},night:{…},dtr:{…},spread}, annotations:[{year,label,kind}], cube_index, raster_index}`, plus existing v1 fields | ~25 kB | boot |
| `timeline_series.json.gz` | per scope (ncr, 25 districts, zones) × mode: `annual[]` (ERA5-Land skin-T anomaly 1990–2025; VIIRS/Aqua annual 2003–2025 where available), `frames[] {mean, ci}`, `ssp: {id: [{year,p05,p25,p50,p75,p95}]}`, `uhi`, `hot_core_km2`, `zone_share`, `threshold_years`, `trend {slope, ci}`, `decomposition {climate, land, pop}`, `uncertainty_budget {gcm, sensitivity, land, model}` | 80–160 kB | boot |
| `cube_obs_day.i16.gz`, `cube_obs_night.i16.gz` | Int16 LE °C×100, −32768 = nodata, [frames × n] in canonical `cell_id` order | ~0.6 MB each | day at boot; night on first toggle or idle |
| `cube_<ssp>_<mode>.i16.gz` | p50 [5 × n] | ~0.4 MB | on first projected visit, or idle |
| `cube_<ssp>_<mode>_q.u8.gz` | Uint8 ×3 per cell: p05 offset, p95 offset (×0.05 °C), flags (AOA bit, uncertainty tier) | ~0.3 MB | with p50 |
| `raster_index.json` | `{crs:"EPSG:4326", bounds:[W,S,E,N], width, height, frames:{key:{file, preview, lo, hi}}}` | small | boot |
| `raster/<mode>_<year>[_<ssp>].png` (+ `_500m.png`) | 8-bit RGB (R value code, G flags) | 0.4–0.8 MB (preview ~0.15) | lazy, LRU 8 |
| `xai_<year>_<mode>.bin.gz` (preferred) or v1 `epoch_<year>.json.gz` | features + SHAP columns (Int16 quantised, JSON header with scales) | ~2–3 MB | idle after first paint / Drivers |
| `metrics.json` (extended) | per mode × scheme × model: pooled + per-fold; error-vs-distance bins; fold geometry; LOEO; downscaling `{r2,rmse,bias,n,by_lc}`; hindcast `{r2,rmse,persistence_rmse,fom}`; AOA `{di_threshold, pct_inside per frame}` | ~50 kB | lazy (Model Lab) |
| `provenance.json` | sources and swimlanes | small | lazy |

Every binary file is described in `cube_index` (`dtype, scale, offset, nodata, years, n`). `validateV2.js` checks:
- sizes = frames × n;
- year order;
- domain coverage;
- tier vocabulary;
- that SHAP additivity holds on a sample.

### 11. Performance budgets

| Item | Budget |
|---|---|
| Initial JS (gz) | ≤ 800 kB (vendor-geo ~570 + react 46 + shell/engine/time ≤ 150 + zustand 1.2); recharts, h3-js and every non-Control route lazy |
| Each lazy route chunk | ≤ 80 kB gz beyond vendor-charts |
| Fonts | ≤ 100 kB |
| Boot data | ≤ 1.2 MB (manifest + series + districts + cube_obs_day + raster_index); XAI deferred to idle |
| First map paint | ≤ 2.5 s at 50 Mbps on a cold cache |
| Scrub/play frame time | p95 ≤ 20 ms at 1440×900 on a GTX 1650 / Iris Xe; main-thread JS ≤ 4 ms per frame; no React commit > 8 ms while scrubbing |
| GPU memory | ≤ 300 MB |
| INP | ≤ 200 ms |
| Blurred panels over the map | ≤ 6; all solid during playback |

### 12. Accessibility (WCAG 2.2 AA)

**Contrast and colour.**
- Text tokens are ≥ 4.5:1 on every surface (the faintest is 5.11:1). Non-text is ≥ 3:1.
- Tier = glyph + pattern + text. Mode = icon + label + ramp family. SSP = label + dash + colour.
- Ramps are monotonic in L, so they read in greyscale.

**Ribbon semantics.**
- `role="slider"`, `aria-valuemin=1990`, `aria-valuemax=2050`, `aria-valuenow`.
- `aria-valuetext="2040, projected under SSP2-4.5, night, NCR mean 31.2 °C (30.4 to 32.1)"`. Interpolated positions say "interpolated between 2035 and 2040".
- Play uses `aria-pressed`. Ticks are not separate tab stops. Track content is mirrored in a "Timeline details" table.

**Live region.** `aria-live="polite"`, debounced 500 ms. It announces only on snap, mode or SSP change, and scenario result; never during playback.

**Map alternatives.**
- `DescribeMap` sentence.
- District data table toggle.
- Keyboard cell walking: district select plus arrow keys, and `H` for the hottest cell.
- Every chart has a table view.

**Keyboard.** Complete on every route; roving tabindex in the rail, dock, chips and segmented controls; drawers trap focus; focus ring is 2 px signal with a 2 px offset.

**Preferences.**
| Preference | Effect |
|---|---|
| `prefers-reduced-transparency` | solid panels |
| `prefers-contrast: more` | ink-faint → ink-muted; hairlines 0.32; no grain |
| `forced-colors` | system colours; glow, grain and vignette hidden; hatch in CanvasText |

**Targets and reflow.** Targets ≥ 24 px (44 px on touch); the playhead hit area is 32 px. Works at 320 px width and 200 % zoom, with no horizontal page scroll.

**Tests.** vitest-axe on chrome components; a manual NVDA + Edge pass; a keyboard-only run of the Briefing and of a scenario.

### 13. Dependencies

| Package | Decision |
|---|---|
| `zustand` | **Add** (~1.2 kB) |
| `@fontsource-variable/{inter,space-grotesk,jetbrains-mono}` | **Add** (self-hosted; drop the Google Fonts link) |
| `vitest-axe`, `jsdom` (dev) | **Add** (dev only) |
| three / R3F / drei | **Reject** (second WebGL context, about 150–250 kB) |
| GSAP, Lottie, visx | **Reject** |
| Bloom or post-processing | **Reject** |
| cmdk | **Reject** (hand-rolled listbox) |

### 14. Engineering split (5 engineers, parallel)

**Week 0: interface freeze (1–2 days, all engineers).** The frozen items:
- `design/tokens.js` names;
- store shapes (§7);
- hook signatures (§7);
- the `mixFrame` and `thermal` uniform contract (§6.2);
- the manifest v2 schema (§10);
- the synthetic fixture shape.

| Eng | Stream | Scope (files) | Depends on | Milestones |
|---|---|---|---|---|
| **E1** | Foundations + Shell + a11y harness | `design/*`, `components/ui/*` new primitives, `shell/*` (AppShell, CommandBar, NavRail, CommandPalette, BootSequence, ShortcutSheet, SettingsMenu, LiveAnnouncer, ToastHost), routing + `urlSync.js`, fonts, Tailwind wiring, `tokens.test.js`, vitest-axe setup | — | M1: shell with v1 views mounted under the new nav; M2: boot and palette |
| **E2** | Data + State | `state/stores/*`, DataContext refactor + `useData` facade, `data/*` (loaders, worker decode with `DecompressionStream`, raster LRU, v1-compat timeline synthesis), `validateV2.js`, `fixtures/synthV2.js`, `useFrameStats`/`useGuardedCopy` | pipeline schema (§10) | M1: v1 bundle served via v2 hooks; M2: synthetic v2 fixture passes the validator |
| **E3** | Map engine | `engine/*`: `mixFrame` + tests, ThermalColumnLayer (CPU path first), ThermalSlotsExtension (GPU, DECKGL_FILTER_SIZE elevation), ThermalRasterLayer (LNGLAT, decode, isotherms), ScreenSplitExtension, lens, lighting presets, perf governor, picking parity, `ThermalStage` | E2 hooks (synthetic first) | M1: CPU tween + sweep + split at 55k cells; M2: GPU path ≥ 55 fps; M3: raster + lens |
| **E4** | Time + Control chrome | `time/*` (ribbon, sparkline, track, stripes, tracks drawer, playhead, playback scheduler, odometer, DiurnalSwitch, ScenarioPicker), `views/control/*` (Telemetry, FrameCard, LayerDock, Legend + VSUP wedge, Toolbar, Analyst popover, Inspector + BottomSheet, Compare UI, HoverCard, DescribeMap, Briefing + guards) | E1 tokens, E2 stores, E3 engine API | M1: ribbon driving the map; M2: NOW choreography, compare, inspector; M3: Briefing |
| **E5** | Analysis views | `viz/*` (FanChart, Sparkfan, Barcode, SmallMultiples + worker, ChartTable), `views/timeline/*`, `views/drivers/*` (restyle + ImportanceDiff/Trend + brushing mask), `views/zones/*` (+ ZoneAlluvial, CaveatPip), `views/lab/*` (HonestSkill, Scoreboard, ErrorDistance, FoldMap, AOA, Downscale, Hindcast, UncertaintyBudget, ModelCard), `views/sources/*` | E1, E2 | M1: Timeline on the v1-compat bundle; M2: Lab + Sources; M3: polish |

**QA is shared.** E1 owns axe and keyboard tests. E3 owns the fps harness (Puppeteer: boot → play 1990→2050 at 1440×900; record `onAfterRender` timings). E5 owns snapshots in the screenshot matrix (1440×900, 1280×720, 768×1024, 390×844; perf tiers 0 and 3; Full and Reduced motion).

**Branching.** `feature/v2-<stream>` branches merge into `v2` behind `?v2=1` until parity. v1 stays the default build until acceptance.

### 15. Acceptance criteria

- [ ] Scrubbing 1990↔2050 holds p95 ≤ 20 ms on a GTX 1650 at 1440×900 in grid 3-D (GPU path), and ≤ 33 ms on the CPU path.
- [ ] Numeric readouts never present a value for a non-frame year without "≈" and the bracket.
- [ ] Every value, tick, chip and tooltip shows a tier glyph that comes from the manifest. A grep test confirms no hard-coded tier-by-year mapping exists.
- [ ] Colour domains are fixed across frames by default. A test asserts that the domain is invariant across years.
- [ ] Prism top-face colour equals `LUT(value)` for the readout value (pixel test on the CPU path).
- [ ] The Day↔Night sweep takes 700 ms, or ≤ 150 ms under Reduced.
- [ ] Every Briefing guard is tested on the real and synthetic bundles. The daytime UHI copy reads as negative on the real bundle.
- [ ] The 250 m raster aligns with district boundaries within ≤ 1 px at zoom 11.
- [ ] axe reports 0 serious or critical issues. Keyboard-only users can complete the Briefing and a what-if.
- [ ] Initial JS ≤ 800 kB gz; boot data ≤ 1.2 MB.
- [ ] The v1 real bundle loads in v2 (compat mode) with all v1 features reachable.
- [ ] The synthetic-mode banner stays persistent (SPEC §5).

### 16. Open items for the pipeline team (do not block the UI; designed as `unavailable` states)

1. Night tier before 2003: the method for ERA5-Land-driven modelling, and whether 1990/1995 night is exported at all.
2. Whether 1990/1995 day is flagged OBSERVED-SPARSE, and how the 2005 SLC-off frame is flagged.
3. The annual series: ERA5-Land and VIIRS/Aqua per district.
4. The definition of the projection quantiles (Monte Carlo over GCM × sensitivity × land × model error) and whether p25/p75 are available.
5. XAI for projected frames: the UI is designed for both cases.
6. Whether ssp126/ssp370 come from AWS NEX-GDDP. The UI reads `scenarios[]`.
7. The final feature list for v2. The driver palette groups features into families when there are more than 17.