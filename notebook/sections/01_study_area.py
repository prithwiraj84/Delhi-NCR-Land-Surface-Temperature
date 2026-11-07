# %% [markdown]
# # 1. Study area, grids and data mode
#
# **Study area.** Delhi National Capital Region (NCR): Delhi NCT plus 24 districts of Haryana, Uttar Pradesh and
# Rajasthan (~55,000 km²), delineated from geoBoundaries ADM2 (fallback FAO GAUL 2015 level 2, final fallback an
# approximate NCR outline partitioned into nearest-headquarters districts). The 25 canonical districts, their aliases
# (incl. geoBoundaries' spelling "Samli" for Shamli) and the outline are fixed by `SPEC_v1.md` §1.1-§1.2.
#
# **Grids.** Everything lives on explicit grids in UTM zone 43N (`EPSG:32643`) whose edges are multiples of the cell
# size:
#
# | Grid | Resolution | Role |
# |---|---|---|
# | `GRID` | `CFG.GRID_RES_M` (1 km) | analysis grid: features, models, SHAP, zones, projections |
# | `GRID_FINE` | `GRID_RES_M / FINE_FACTOR` (250 m) | Landsat day field, downscaled night field, rasters; fine pixel (r, c) lies in cell (r // 4, c // 4) |
# | land-cover grid | `CFG.fine_res()` (50 m gee / 100 m synthetic) | landscape metrics only (built in section 05 / 02) |
#
# **Canonical cell order.** All ROI cells sorted by `cell_id = row × W + col`. `N_CELLS`, `CELL_IDS`, `CELL_ROWS`,
# `CELL_COLS`, `CELL_LON`, `CELL_LAT` define the order and length of every exported per-cell array (frames with
# partial coverage keep the full length and carry nodata).
#
# **Data mode.** Earth Engine is initialised here (service account → persisted credentials → interactive login).
# `auto` falls back to the clearly-labelled synthetic twin with a loud banner when Earth Engine is unavailable; once a
# service-account key was supplied, a failure while building the study area stops the run instead (the user clearly
# asked for real data). Sections 03-05 run only in gee mode, section 02 only in synthetic mode.

# %% [markdown]
# ## 1.1 Constants: districts, reference geography, land-cover classes

# %%
import functools
import unicodedata

NCR_DISTRICTS = [
    {"id": 0, "name": "Delhi NCT", "state": "Delhi", "hq": (77.21, 28.61),
     "aliases": ["delhi", "nct of delhi", "national capital territory of delhi"]},
    {"id": 1, "name": "Gurugram", "state": "Haryana", "hq": (77.03, 28.46), "aliases": ["gurgaon", "gurugram"]},
    {"id": 2, "name": "Faridabad", "state": "Haryana", "hq": (77.31, 28.41), "aliases": ["faridabad"]},
    {"id": 3, "name": "Palwal", "state": "Haryana", "hq": (77.33, 28.14), "aliases": ["palwal"]},
    {"id": 4, "name": "Nuh", "state": "Haryana", "hq": (77.00, 28.10), "aliases": ["mewat", "nuh"]},
    {"id": 5, "name": "Rewari", "state": "Haryana", "hq": (76.62, 28.19), "aliases": ["rewari"]},
    {"id": 6, "name": "Jhajjar", "state": "Haryana", "hq": (76.66, 28.61), "aliases": ["jhajjar"]},
    {"id": 7, "name": "Rohtak", "state": "Haryana", "hq": (76.61, 28.90), "aliases": ["rohtak"]},
    {"id": 8, "name": "Sonipat", "state": "Haryana", "hq": (77.02, 28.99), "aliases": ["sonipat", "sonepat"]},
    {"id": 9, "name": "Panipat", "state": "Haryana", "hq": (76.97, 29.39), "aliases": ["panipat"]},
    {"id": 10, "name": "Karnal", "state": "Haryana", "hq": (76.99, 29.69), "aliases": ["karnal"]},
    {"id": 11, "name": "Jind", "state": "Haryana", "hq": (76.32, 29.32), "aliases": ["jind"]},
    {"id": 12, "name": "Bhiwani", "state": "Haryana", "hq": (76.13, 28.79), "aliases": ["bhiwani"]},
    {"id": 13, "name": "Charkhi Dadri", "state": "Haryana", "hq": (76.27, 28.59),
     "aliases": ["charkhi dadri", "dadri"]},
    {"id": 14, "name": "Mahendragarh", "state": "Haryana", "hq": (76.11, 28.05),
     "aliases": ["mahendragarh", "mahendergarh", "narnaul"]},
    {"id": 15, "name": "Meerut", "state": "Uttar Pradesh", "hq": (77.71, 28.98), "aliases": ["meerut"]},
    {"id": 16, "name": "Ghaziabad", "state": "Uttar Pradesh", "hq": (77.44, 28.67), "aliases": ["ghaziabad"]},
    {"id": 17, "name": "Gautam Buddh Nagar", "state": "Uttar Pradesh", "hq": (77.49, 28.47),
     "aliases": ["gautam buddha nagar", "gautam buddh nagar", "gautambudhnagar", "noida"]},
    {"id": 18, "name": "Bulandshahr", "state": "Uttar Pradesh", "hq": (77.85, 28.40),
     "aliases": ["bulandshahr", "bulandshahar"]},
    {"id": 19, "name": "Baghpat", "state": "Uttar Pradesh", "hq": (77.22, 28.94), "aliases": ["baghpat", "bagpat"]},
    {"id": 20, "name": "Hapur", "state": "Uttar Pradesh", "hq": (77.78, 28.73), "aliases": ["hapur", "panchsheel nagar"]},
    # geoBoundaries (v6 IND ADM2) spells the district "Samli".
    {"id": 21, "name": "Shamli", "state": "Uttar Pradesh", "hq": (77.31, 29.45),
     "aliases": ["shamli", "samli", "prabudh nagar", "prabuddh nagar"]},
    {"id": 22, "name": "Muzaffarnagar", "state": "Uttar Pradesh", "hq": (77.70, 29.47), "aliases": ["muzaffarnagar"]},
    {"id": 23, "name": "Alwar", "state": "Rajasthan", "hq": (76.60, 27.55), "aliases": ["alwar"]},
    {"id": 24, "name": "Bharatpur", "state": "Rajasthan", "hq": (77.49, 27.22), "aliases": ["bharatpur"]},
]
DISTRICTS = [{"id": d["id"], "name": d["name"], "state": d["state"]} for d in NCR_DISTRICTS]

# "Dadri" is also a tehsil of Gautam Buddh Nagar (UP): only accept it on the Haryana side.
_ALIAS_LON_MAX = {"dadri": 76.9}
# Delhi's revenue districts (geoBoundaries has no ADM1 attribute, so Delhi is matched by name + bbox).
DELHI_SUBDISTRICTS = ["Central", "East", "New Delhi", "North", "North East", "North West", "Shahdara",
                      "South", "South East", "South West", "West"]
DELHI_BBOX = (76.83, 28.40, 77.35, 28.89)          # lon_min, lat_min, lon_max, lat_max
NCR_SANITY_BBOX = (75.3, 26.6, 78.6, 30.1)         # duplicate district names exist elsewhere in India

# Approximate NCR outline (SPEC_v1 §1.2): synthetic ROI and final GEE fallback.
NCR_OUTLINE = [
    (76.45, 29.95), (76.85, 29.95), (77.20, 29.75), (77.55, 29.75), (78.10, 29.55), (78.20, 29.20),
    (78.45, 28.60), (78.45, 28.20), (78.00, 28.05), (77.55, 27.95), (77.55, 27.50), (77.85, 27.20),
    (77.65, 26.75), (77.20, 26.70), (76.90, 27.05), (76.25, 27.05), (76.10, 27.40), (76.20, 27.90),
    (75.95, 28.00), (75.45, 28.40), (75.55, 28.90), (75.85, 29.05), (75.95, 29.55), (76.20, 29.60),
    (76.45, 29.95),
]
# Reference geography polylines (lon, lat) shared with the synthetic world (section 02).
YAMUNA = [(77.19, 29.95), (77.13, 29.55), (77.12, 29.20), (77.22, 28.85), (77.25, 28.62), (77.30, 28.45),
          (77.45, 28.20), (77.52, 27.90), (77.68, 27.55)]
GANGA = [(78.03, 29.75), (78.10, 29.30), (78.18, 28.95), (78.32, 28.60), (78.45, 28.30)]
ARAVALLI = [(77.17, 28.62), (77.10, 28.40), (76.85, 28.15), (76.60, 27.80), (76.40, 27.35)]

# Harmonised land-cover classes (SPEC_v1 §1) and the GLC_FCS30D remap used for every v2 frame (SPEC §1.4).
LC_NODATA, LC_BUILT, LC_FOREST, LC_WATER, LC_CROPLAND, LC_BARREN, LC_OTHER_VEG = 0, 1, 2, 3, 4, 5, 6
LC_CLASS_NAMES = {0: "nodata", 1: "built/impervious", 2: "tree/forest", 3: "water", 4: "cropland",
                  5: "barren/bare", 6: "other vegetation"}
LC_CLASS_COLORS = {0: "#000000", 1: "#e11d48", 2: "#15803d", 3: "#0ea5e9", 4: "#facc15", 5: "#a8a29e",
                   6: "#86efac"}
LC_REMAPS = {
    "glc_fcs30d": {**{c: 4 for c in (10, 11, 12, 20)},
                   **{c: 2 for c in (51, 52, 61, 62, 71, 72, 81, 82, 91, 92)},
                   **{c: 6 for c in (120, 121, 122, 130, 140, 150, 152, 153, *range(181, 188))},
                   190: 1, 200: 5, 201: 5, 202: 5, 210: 3, 220: 6},
    "esa_worldcover": {10: 2, 20: 6, 30: 6, 40: 4, 50: 1, 60: 5, 70: 6, 80: 3, 90: 6, 95: 2, 100: 6},
    "dynamic_world": {0: 3, 1: 2, 2: 6, 3: 6, 4: 4, 5: 6, 6: 1, 7: 5, 8: 6},
}

NODATA_FLOAT = -9999.0     # sentinel written by .unmask() for continuous bands, converted to NaN locally
NODATA_LC = 0              # land-cover nodata class
NODATA_DISTRICT = -1       # DISTRICT_IDX outside the ROI
# The snapped 1 km grid of the user's real v1 run (geoBoundaries ROI) - logged for comparison only.
_S01_V1_REAL_GRID = {"res": 1000, "x0": 545000.0, "y0": 3321000.0, "width": 297, "height": 366}
log(f"{len(NCR_DISTRICTS)} canonical districts; frames {CFG.FRAMES_OBS}; land cover {sorted(set(CFG.LC_SOURCES.values()))}")

# %% [markdown]
# ## 1.2 Grid definition (`GridSpec`)
# Coordinates are transformed with `pyproj` (`always_xy=True`: lon, lat order). If pyproj is missing, a closed-form
# transverse-Mercator series (Snyder 1987, USGS PP 1395, eqs. 8-9 … 8-25) is used for UTM north zones — accurate to
# well below a metre inside the zone, far below any pixel size used here. `GridSpec.fine(res)` nests a finer grid on
# the same origin, so fine/coarse correspondences are pure integer arithmetic (`r // f`, `c // f`).

# %%
_WGS84_A = 6378137.0
_WGS84_F = 1 / 298.257223563
_UTM_K0 = 0.9996


def _utm_zone(crs: str) -> int:
    """Zone number for a WGS84 / UTM north CRS code such as ``EPSG:32643``."""
    match = re.fullmatch(r"EPSG:326(\d{2})", crs.strip().upper())
    if not match:
        raise ValueError(f"pyproj is unavailable and {crs} is not a WGS84 UTM-north code; install pyproj")
    return int(match.group(1))


def _utm_forward(lon, lat, zone: int):
    """Geographic (deg) -> UTM north (m), Snyder's series."""
    e2 = _WGS84_F * (2 - _WGS84_F)
    ep2 = e2 / (1 - e2)
    phi, lam = np.radians(lat), np.radians(lon)
    lam0 = np.radians(-183.0 + 6.0 * zone)
    n = _WGS84_A / np.sqrt(1 - e2 * np.sin(phi) ** 2)
    t = np.tan(phi) ** 2
    c = ep2 * np.cos(phi) ** 2
    a = np.cos(phi) * (lam - lam0)
    m = _WGS84_A * ((1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256) * phi
                    - (3 * e2 / 8 + 3 * e2**2 / 32 + 45 * e2**3 / 1024) * np.sin(2 * phi)
                    + (15 * e2**2 / 256 + 45 * e2**3 / 1024) * np.sin(4 * phi)
                    - (35 * e2**3 / 3072) * np.sin(6 * phi))
    x = _UTM_K0 * n * (a + (1 - t + c) * a**3 / 6 + (5 - 18 * t + t**2 + 72 * c - 58 * ep2) * a**5 / 120) + 500000.0
    y = _UTM_K0 * (m + n * np.tan(phi) * (a**2 / 2 + (5 - t + 9 * c + 4 * c**2) * a**4 / 24
                                          + (61 - 58 * t + t**2 + 600 * c - 330 * ep2) * a**6 / 720))
    return x, y


def _utm_inverse(x, y, zone: int):
    """UTM north (m) -> geographic (deg), Snyder's footpoint-latitude series."""
    e2 = _WGS84_F * (2 - _WGS84_F)
    ep2 = e2 / (1 - e2)
    e1 = (1 - np.sqrt(1 - e2)) / (1 + np.sqrt(1 - e2))
    mu = (np.asarray(y, dtype=np.float64) / _UTM_K0) / (_WGS84_A * (1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1**3 / 32) * np.sin(2 * mu) + (21 * e1**2 / 16 - 55 * e1**4 / 32) * np.sin(4 * mu)
            + (151 * e1**3 / 96) * np.sin(6 * mu) + (1097 * e1**4 / 512) * np.sin(8 * mu))
    n1 = _WGS84_A / np.sqrt(1 - e2 * np.sin(phi1) ** 2)
    t1 = np.tan(phi1) ** 2
    c1 = ep2 * np.cos(phi1) ** 2
    r1 = _WGS84_A * (1 - e2) / (1 - e2 * np.sin(phi1) ** 2) ** 1.5
    d = (np.asarray(x, dtype=np.float64) - 500000.0) / (n1 * _UTM_K0)
    lat = phi1 - (n1 * np.tan(phi1) / r1) * (d**2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * ep2) * d**4 / 24
                                             + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * ep2 - 3 * c1**2) * d**6 / 720)
    lon = np.radians(-183.0 + 6.0 * zone) + (d - (1 + 2 * t1 + c1) * d**3 / 6
                                              + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * ep2 + 24 * t1**2) * d**5 / 120) / np.cos(phi1)
    return np.degrees(lon), np.degrees(lat)


@functools.lru_cache(maxsize=8)
def _grid_transformer(src: str, dst: str):
    return pyproj.Transformer.from_crs(src, dst, always_xy=True)


def _grid_lonlat_to_xy(lon, lat, crs: str):
    """(lon, lat) degrees -> projected metres in ``crs`` (arrays of any shape)."""
    lon, lat = np.asarray(lon, dtype=np.float64), np.asarray(lat, dtype=np.float64)
    if pyproj is not None:
        return _grid_transformer("EPSG:4326", crs).transform(lon, lat)
    return _utm_forward(lon, lat, _utm_zone(crs))


def _grid_xy_to_lonlat(x, y, crs: str):
    """Projected metres in ``crs`` -> (lon, lat) degrees (arrays of any shape)."""
    x, y = np.asarray(x, dtype=np.float64), np.asarray(y, dtype=np.float64)
    if pyproj is not None:
        return _grid_transformer(crs, "EPSG:4326").transform(x, y)
    return _utm_inverse(x, y, _utm_zone(crs))


def _densify_ring(points, n_per_edge: int = 40) -> np.ndarray:
    """Insert points along each edge of a lon/lat ring so its projected extent is exact (edges curve in UTM)."""
    pts = np.asarray(points, dtype=np.float64)
    t = np.linspace(0.0, 1.0, n_per_edge, endpoint=False)[:, None]
    parts = [pts[i] + t * (pts[i + 1] - pts[i]) for i in range(len(pts) - 1)]
    return np.vstack(parts + [pts[-1:]])


@dataclass(frozen=True)
class GridSpec:
    """North-up raster grid: ``x0``/``y0`` are the LEFT/TOP edges (m) in ``crs``; rows run southwards."""

    crs: str
    res: int
    x0: float
    y0: float
    width: int
    height: int

    @property
    def shape(self) -> tuple:
        return (self.height, self.width)

    @property
    def cell_area_km2(self) -> float:
        return (self.res / 1000.0) ** 2

    def x_centers(self) -> np.ndarray:
        return self.x0 + (np.arange(self.width) + 0.5) * self.res

    def y_centers(self) -> np.ndarray:
        return self.y0 - (np.arange(self.height) + 0.5) * self.res

    def cell_centers_xy(self):
        """(X, Y) 2-D arrays (float64, metres) of cell centres, shape (height, width)."""
        return np.meshgrid(self.x_centers(), self.y_centers())

    def lonlat(self):
        """(LON, LAT) 2-D arrays (float64, degrees) of cell centres."""
        x, y = self.cell_centers_xy()
        return _grid_xy_to_lonlat(x, y, self.crs)

    def affine(self) -> dict:
        """``affineTransform`` dict for ``ee.data.computePixels`` (north-up, negative scaleY)."""
        return {"scaleX": float(self.res), "shearX": 0.0, "translateX": float(self.x0),
                "shearY": 0.0, "scaleY": -float(self.res), "translateY": float(self.y0)}

    def transform_list(self) -> list:
        """Six-element affine ``[scaleX, shearX, translateX, shearY, scaleY, translateY]`` (EE crsTransform)."""
        return [float(self.res), 0.0, float(self.x0), 0.0, -float(self.res), float(self.y0)]

    def fine(self, res: int) -> "GridSpec":
        """Nested grid at ``res`` metres sharing the origin; ``res`` must divide ``self.res``."""
        res = int(res)
        if res <= 0 or self.res % res:
            raise ValueError(f"fine resolution {res} m must divide the grid resolution {self.res} m")
        f = self.res // res
        return GridSpec(self.crs, res, self.x0, self.y0, self.width * f, self.height * f)

    def tile(self, row0: int, col0: int, height: int, width: int) -> "GridSpec":
        """Sub-grid starting at (row0, col0) with the given size."""
        return GridSpec(self.crs, self.res, self.x0 + col0 * self.res, self.y0 - row0 * self.res, width, height)

    def bounds_xy(self) -> list:
        """[x_left, y_bottom, x_right, y_top] in metres."""
        return [float(self.x0), float(self.y0 - self.height * self.res),
                float(self.x0 + self.width * self.res), float(self.y0)]

    def bounds_lonlat(self) -> list:
        """[min_lon, min_lat, max_lon, max_lat] of the grid rectangle."""
        ring = [(self.x0, self.y0), (self.x0 + self.width * self.res, self.y0),
                (self.x0 + self.width * self.res, self.y0 - self.height * self.res),
                (self.x0, self.y0 - self.height * self.res), (self.x0, self.y0)]
        pts = _densify_ring(ring, 20)
        lon, lat = _grid_xy_to_lonlat(pts[:, 0], pts[:, 1], self.crs)
        return [float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max())]

    def to_dict(self) -> dict:
        """Manifest form ``{crs, res, x0, y0, width, height}`` (SPEC §5.3 ``study_area.grid``)."""
        return {"crs": self.crs, "res": int(self.res), "x0": float(self.x0), "y0": float(self.y0),
                "width": int(self.width), "height": int(self.height)}

    @classmethod
    def from_lonlat_points(cls, lonlat_points, crs: str, res: int, margin_cells: int = 1) -> "GridSpec":
        """Smallest grid covering the points, edges snapped OUTWARD to multiples of ``res`` (+ margin)."""
        pts = np.asarray(lonlat_points, dtype=np.float64)
        x, y = _grid_lonlat_to_xy(pts[:, 0], pts[:, 1], crs)
        res = int(res)
        x_left = (math.floor(np.min(x) / res) - margin_cells) * res
        x_right = (math.ceil(np.max(x) / res) + margin_cells) * res
        y_bottom = (math.floor(np.min(y) / res) - margin_cells) * res
        y_top = (math.ceil(np.max(y) / res) + margin_cells) * res
        return cls(crs, res, float(x_left), float(y_top), int((x_right - x_left) // res), int((y_top - y_bottom) // res))


def _outline_grid(res: int) -> GridSpec:
    """Grid covering the approximate NCR outline (synthetic mode / final fallback)."""
    return GridSpec.from_lonlat_points(_densify_ring(NCR_OUTLINE), CFG.CRS, res)


def _mask_fine_inplace(lc: np.ndarray, roi_mask: np.ndarray, f: int) -> None:
    """Zero fine pixels whose parent cell is outside the ROI, without materialising a fine-resolution mask."""
    h, w = roi_mask.shape
    if not lc.flags.c_contiguous or lc.shape != (h * f, w * f):
        raise ValueError(f"fine raster must be C-contiguous with shape {(h * f, w * f)}, got {lc.shape}")
    view = lc.reshape(h, f, w, f)
    view *= roi_mask[:, None, :, None].astype(lc.dtype)


def block_mean(fine: np.ndarray, f: int, min_valid_frac: float = 0.0) -> np.ndarray:
    """NaN-aware mean of every ``f × f`` block of a fine raster → coarse raster (float32).

    A block whose share of finite pixels is below ``min_valid_frac`` (or that has none) is NaN. Used for the fine →
    1 km aggregation (e.g. the 4 × 4 block means of SPEC §4.8 and the ≥ 50 % valid rule of §4.1).
    """
    fine = np.asarray(fine, dtype=np.float32)
    h, w = fine.shape[0] // f, fine.shape[1] // f
    if fine.shape != (h * f, w * f):
        raise ValueError(f"fine raster shape {fine.shape} is not a multiple of {f}")
    blocks = fine.reshape(h, f, w, f)
    valid = np.isfinite(blocks)
    n_valid = valid.sum(axis=(1, 3))
    total = np.where(valid, blocks, 0.0).sum(axis=(1, 3), dtype=np.float64)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = (total / n_valid).astype(np.float32)
    out[(n_valid == 0) | (n_valid < min_valid_frac * f * f)] = np.nan
    return out


def upsample_repeat(coarse: np.ndarray, f: int) -> np.ndarray:
    """Nearest-neighbour (block-repeat) upsampling of a coarse raster by an integer factor."""
    return np.repeat(np.repeat(np.asarray(coarse), f, axis=0), f, axis=1)


_probe_grid = _outline_grid(CFG.GRID_RES_M)
log(f"NCR outline grid preview: {_probe_grid.width}x{_probe_grid.height} cells of {_probe_grid.res} m, "
    f"lon/lat bounds {np.round(_probe_grid.bounds_lonlat(), 3).tolist()}")
del _probe_grid

# %% [markdown]
# ## 1.3 Earth Engine initialisation and data-mode decision
# Credential order: (1) Kaggle secret `GEE_SERVICE_ACCOUNT_KEY`, or env `LST_GEE_SERVICE_ACCOUNT_KEY` /
# `GOOGLE_APPLICATION_CREDENTIALS` → `ee.ServiceAccountCredentials`; (2) persisted user credentials; (3) interactive
# `ee.Authenticate(auth_mode="notebook")` (live notebooks only). Sessions use the **standard endpoint** by default
# (`LST_GEE_ENDPOINT=standard`): this pipeline's requests are heavy computations (30 m Landsat medians, multi-year
# MODIS stacks), and Google recommends the **high-volume endpoint** only for many small, cacheable requests such as
# simple tile reads; `LST_GEE_ENDPOINT=highvolume` is an opt-in. Both endpoints share the same per-project quota of
# 40 concurrent requests. After a successful login the client request deadline is set to `LST_GEE_DEADLINE_S`
# (420 s; at least 330 s, above the ~300 s interactive server limit) with 3 HTTP-level retries. The Earth Engine
# work of sections 03, 04 and 05 runs under the **workload tags** `lst-v2-s03`, `lst-v2-s04`, `lst-v2-s05`, so Google
# Cloud Monitoring (Earth Engine -> *Completed EECU-seconds*, grouped by `workload_tag`) shows the EECU cost of each
# section. A supplied key that fails is reported with the setup step that fixes it (instead of silently falling
# through to OAuth, whose errors hide the real cause).
#
# With `LST_GEE_EXPORT=asset` the asset folder `CFG.GEE_ASSET_ROOT` is checked (and created) here, so a missing
# *Earth Engine Resource Writer* role is reported before hours of computation; on failure the run continues in
# `interactive` mode with a warning.

# %%
_EE_HIGHVOLUME_URL = "https://earthengine-highvolume.googleapis.com"
_S01_KEY_SUPPLIED = False        # set by init_gee: a service-account key was found (user wants real data)
_S01_EE_MAX_RETRIES = 3          # HTTP-level retries of the Earth Engine client (ee.data.setMaxRetries)


def _ee_init_kwargs() -> dict:
    """``ee.Initialize`` endpoint argument: none for the standard endpoint, ``opt_url`` for high-volume (D1)."""
    if CFG.GEE_ENDPOINT == "highvolume":
        return {"opt_url": _EE_HIGHVOLUME_URL}
    if CFG.GEE_ENDPOINT != "standard":
        raise ValueError(f"LST_GEE_ENDPOINT={CFG.GEE_ENDPOINT!r}; choose 'standard' or 'highvolume'")
    return {}


def _ee_configure_session() -> None:
    """Request deadline + client retries after a successful Initialize (guarded: older clients lack the setters)."""
    deadline_ms = int(float(CFG.GEE_DEADLINE_S) * 1000)
    done = []
    if hasattr(ee.data, "setDeadline"):
        ee.data.setDeadline(deadline_ms)
        done.append(f"deadline {deadline_ms / 1000:.0f} s")
    if hasattr(ee.data, "setMaxRetries"):
        ee.data.setMaxRetries(_S01_EE_MAX_RETRIES)
        done.append(f"max retries {_S01_EE_MAX_RETRIES}")
    url = _EE_HIGHVOLUME_URL if CFG.GEE_ENDPOINT == "highvolume" else "standard (earthengine.googleapis.com)"
    log(f"Earth Engine session: endpoint {CFG.GEE_ENDPOINT} [{url}], {', '.join(done) or 'client defaults'}")


@contextmanager
def gee_workload_tag(tag: str):
    """Run the enclosed Earth Engine work under a workload tag (EECU per section in Cloud Monitoring).

    Uses ``ee.data.workloadTagContext`` when available, else ``setWorkloadTag`` / ``resetWorkloadTag``, else does
    nothing. The tag is reset on any exit (also on exceptions and LSTStop). The Earth Engine client keeps the tag in
    process-wide state, so worker threads started inside the block inherit it.
    """
    data = getattr(ee, "data", None) if ee is not None else None
    ctx = getattr(data, "workloadTagContext", None) if data is not None else None
    if callable(ctx):
        with ctx(tag):
            yield
        return
    setter = getattr(data, "setWorkloadTag", None) if data is not None else None
    resetter = getattr(data, "resetWorkloadTag", None) if data is not None else None
    if callable(setter):
        setter(tag)
        try:
            yield
        finally:
            if callable(resetter):
                resetter()
            else:
                setter("")
        return
    yield


def _service_account_key_text(verbose: bool = True) -> Optional[str]:
    """Service-account JSON text from Kaggle secrets / env var (JSON or path) / GOOGLE_APPLICATION_CREDENTIALS.

    Logs which source was used (never the key itself) and warns loudly about a value that is set but unusable,
    because silently ignoring it would push the run into interactive OAuth login instead.
    """
    say = log if verbose else (lambda *a, **k: None)
    candidates = [("Kaggle secret GEE_SERVICE_ACCOUNT_KEY", _kaggle_secret("GEE_SERVICE_ACCOUNT_KEY")),
                  ("env LST_GEE_SERVICE_ACCOUNT_KEY", _env_str("LST_GEE_SERVICE_ACCOUNT_KEY")),
                  ("env GOOGLE_APPLICATION_CREDENTIALS", _env_str("GOOGLE_APPLICATION_CREDENTIALS"))]
    for source, value in candidates:
        if not value:
            continue
        text = value.strip().strip("'\"").strip()  # tolerate a key pasted inside quotes
        if text.startswith("{"):
            say(f"Earth Engine service-account key found in {source}")
            return text
        path = Path(text).expanduser()
        if path.is_file():
            try:
                file_text = path.read_text(encoding="utf-8")
                if json.loads(file_text).get("type") == "service_account":
                    say(f"Earth Engine service-account key file found via {source}: {path}")
                    return file_text
                say(f"{source} points to {path}, which is not a service-account key; ignoring", "WARNING")
            except (OSError, json.JSONDecodeError, AttributeError) as exc:
                say(f"credential file {path} ({source}) is not a readable JSON key ({type(exc).__name__}); "
                    "ignoring", "WARNING")
            continue
        say(f"{source} is set but is neither JSON nor an existing file. Paste the ENTIRE key file contents "
            "(it starts with '{' and contains \"type\": \"service_account\").", "WARNING")
    if _IS_KAGGLE:
        say("No Earth Engine service-account key found. On Kaggle: Add-ons -> Secrets -> add "
            "GEE_SERVICE_ACCOUNT_KEY and make sure its checkbox is ticked for THIS notebook.", "WARNING")
    return None


def _service_account_hint(message: str) -> str:
    """Map common service-account failures to the setup step that fixes them."""
    low = message.lower()
    if "not signed up" in low or "not registered" in low or "register" in low:
        return ("the Cloud project is not registered for Earth Engine: register it at "
                "https://code.earthengine.google.com/register (noncommercial; the Contributor tier gives "
                "1,000 EECU-h/month)")
    if "serviceusage" in low or "user_project_denied" in low or "caller does not have required permission" in low:
        return ("grant the service account the roles 'Service Usage Consumer' and 'Earth Engine Resource Viewer' "
                "in the Cloud project, and enable the Earth Engine API there")
    if "has not been used in project" in low or "is disabled" in low:
        return "enable the 'Google Earth Engine API' in the Cloud project (APIs & Services -> Library)"
    if "invalid_grant" in low or "invalid jwt" in low or "account not found" in low:
        return "the key was deleted/revoked or belongs to a deleted account: create a new JSON key"
    if "project" in low and ("not found" in low or "no project" in low or "required" in low):
        return "set the Kaggle secret GEE_PROJECT (or LST_GEE_PROJECT) to the Cloud project id"
    if "keyerror" in low or "client_email" in low or "jsondecodeerror" in low:
        return "the secret is not a complete service-account key: paste the whole JSON key file"
    return "check the key, the project id and the service account's roles"


def _ee_smoke_test() -> None:
    """Round-trip a trivial computation so we fail fast on bad credentials / unregistered projects."""
    if ee.Number(1).add(1).getInfo() != 2:
        raise RuntimeError("Earth Engine smoke test returned an unexpected value")


def init_gee(project: Optional[str] = None) -> tuple:
    """Initialise Earth Engine. Returns ``(ok, message)`` and never raises.

    The endpoint is ``CFG.GEE_ENDPOINT``: ``standard`` (default; no ``opt_url``) or ``highvolume`` (``opt_url`` =
    the high-volume URL). After every successful ``ee.Initialize`` + smoke test the request deadline is set to
    ``CFG.GEE_DEADLINE_S`` and the client retries to 3. On success ``CFG.GEE_PROJECT`` holds the project actually
    used (the key's ``project_id`` when no project was configured) and ``CFG.GEE_ASSET_ROOT`` defaults to
    ``projects/<project>/assets/ncr_lst_v2``.
    """
    global _S01_KEY_SUPPLIED
    if ee is None:
        return False, "earthengine-api is not installed"
    project = project or CFG.GEE_PROJECT
    _ee_init_kwargs()                # ValueError for an invalid LST_GEE_ENDPOINT (never silently another endpoint)
    log(f"Earth Engine project: {project or '(not set - will use the key file project_id)'}, endpoint "
        f"{CFG.GEE_ENDPOINT}")
    errors = []
    key_text = _service_account_key_text()
    _S01_KEY_SUPPLIED = bool(key_text)
    used_project = None
    if key_text:
        email = "?"
        try:
            info = json.loads(key_text)
            email = info["client_email"]
            credentials = ee.ServiceAccountCredentials(email, key_data=key_text)
            used_project = project or info.get("project_id")
            ee.Initialize(credentials, project=used_project, **_ee_init_kwargs())
            _ee_smoke_test()
            _ee_configure_session()
            message = f"service account {email} (project {used_project})"
        except Exception as exc:  # noqa: BLE001 - reported with a remedy below
            detail = f"{type(exc).__name__}: {str(exc)[:400]}"
            hint = _service_account_hint(detail)
            log(f"Service-account login failed for {email}: {detail}\n    Fix: {hint}", "ERROR")
            return False, f"service account {email}: {detail} | fix: {hint}"
    else:
        message = None
        try:
            ee.Initialize(project=project, **_ee_init_kwargs())
            _ee_smoke_test()
            _ee_configure_session()
            used_project, message = project, f"persisted user credentials (project {project})"
        except Exception as exc:  # noqa: BLE001
            errors.append(f"persisted credentials: {type(exc).__name__}: {str(exc)[:300]}")
        if message is None and _is_interactive():
            log("Falling back to interactive Earth Engine login (no service-account key). If the login page says "
                "'Project has an incompatible OAuth2 Client configuration', pick (or create) a Cloud project with "
                "NO OAuth 2.0 client IDs for authentication - or, better, use the GEE_SERVICE_ACCOUNT_KEY secret, "
                "which needs no browser login.", "WARNING")
            try:
                ee.Authenticate(auth_mode="notebook")
                ee.Initialize(project=project, **_ee_init_kwargs())
                _ee_smoke_test()
                _ee_configure_session()
                used_project, message = project, f"interactive notebook authentication (project {project})"
            except Exception as exc:  # noqa: BLE001
                errors.append(f"interactive auth: {type(exc).__name__}: {str(exc)[:300]}")
        elif message is None:
            errors.append("interactive auth skipped (not a live notebook session)")
        if message is None:
            return False, " | ".join(errors)
    if used_project and not CFG.GEE_PROJECT:
        CFG.GEE_PROJECT = used_project
    if CFG.GEE_ASSET_ROOT is None and CFG.GEE_PROJECT:
        CFG.GEE_ASSET_ROOT = f"projects/{CFG.GEE_PROJECT}/assets/ncr_lst_v2"
    return True, message


def _s01_prepare_asset_root() -> tuple:
    """Ensure ``CFG.GEE_ASSET_ROOT`` exists for ``GEE_EXPORT=asset`` (creating the folder); ``(ok, message)``."""
    root = CFG.GEE_ASSET_ROOT
    if not root:
        return False, "no asset root: GEE_PROJECT is unknown (set the GEE_PROJECT secret or LST_GEE_ASSET_ROOT)"
    try:
        retry(lambda: ee.data.getAsset(root), tries=2, base_delay=2.0, max_delay=10.0)
        return True, f"asset folder {root} exists"
    except Exception as exc:  # noqa: BLE001 - "not found" is expected on the first run
        missing = re.search(r"not found|does not exist|404", str(exc), re.IGNORECASE)
        if not missing:
            return False, (f"cannot read asset folder {root}: {type(exc).__name__}: {str(exc)[:200]} | fix: grant "
                           "the service account the IAM role 'Earth Engine Resource Writer'")
    try:
        ee.data.createAsset({"type": "FOLDER"}, root)
        return True, f"asset folder {root} created"
    except Exception as exc:  # noqa: BLE001
        return False, (f"cannot create asset folder {root}: {type(exc).__name__}: {str(exc)[:200]} | fix: grant the "
                       "service account the IAM role 'Earth Engine Resource Writer' (or set LST_GEE_EXPORT="
                       "interactive)")


def _print_synthetic_banner(reason: str) -> None:
    """Impossible-to-miss notice that every number downstream comes from the synthetic twin."""
    bar = "!" * 96
    lines = [
        "SYNTHETIC MODE - RESULTS ARE NOT REAL OBSERVATIONS",
        "Earth Engine data were NOT used. All rasters, models, SHAP values, thresholds, zones, timelines and "
        "projections below come from a synthetic twin of Delhi NCR with PLANTED responses (SYNTHETIC_TRUTH). "
        "Use them only to test the pipeline and the dashboard. Every export is flagged data_mode=synthetic.",
        f"Reason: {reason[:300]}",
        "To use real data: attach the Kaggle secrets GEE_SERVICE_ACCOUNT_KEY + GEE_PROJECT (or authenticate "
        "interactively) and re-run with LST_RUN_MODE=gee.",
    ]
    import textwrap

    print("\n" + bar + "\n" + bar)
    for line in lines:
        for piece in textwrap.wrap(line, 88) or [""]:
            print(f"!!!  {piece:<88}!!!")
    print(bar + "\n" + bar + "\n", flush=True)


_S01_ASSET_CAVEAT = None
if CFG.RUN_MODE == "synthetic":
    DATA_MODE = "synthetic"
    _MODE_REASON = "LST_RUN_MODE=synthetic"
else:
    _gee_ok, _gee_msg = init_gee()
    if _gee_ok:
        DATA_MODE = "gee"
        _MODE_REASON = f"Earth Engine initialised via {_gee_msg}"
        log(_MODE_REASON)
        if CFG.GEE_EXPORT == "asset":
            _asset_ok, _asset_msg = _s01_prepare_asset_root()
            if _asset_ok:
                log(f"GEE_EXPORT=asset: {_asset_msg}")
            else:
                log(f"GEE_EXPORT=asset unavailable - continuing with interactive computePixels: {_asset_msg}",
                    "WARNING")
                CFG.GEE_EXPORT = "interactive"
                _S01_ASSET_CAVEAT = ("Batch asset export was requested but unavailable (" + _asset_msg[:200]
                                     + "); extraction used interactive computePixels.")
            del _asset_ok, _asset_msg
    elif CFG.RUN_MODE == "gee":
        raise RuntimeError(
            "LST_RUN_MODE=gee but Earth Engine could not be initialised.\n"
            f"Details: {_gee_msg}\n"
            "Fix: on Kaggle add Secrets GEE_SERVICE_ACCOUNT_KEY (full service-account JSON key; the account "
            "must be registered for Earth Engine) and GEE_PROJECT (Cloud project with the Earth Engine API "
            "enabled), enable Internet, or run interactively to authenticate; elsewhere set "
            "LST_GEE_SERVICE_ACCOUNT_KEY / GOOGLE_APPLICATION_CREDENTIALS and LST_GEE_PROJECT. "
            "Use LST_RUN_MODE=auto to fall back to synthetic data instead.")
    else:
        DATA_MODE = "synthetic"
        _MODE_REASON = f"Earth Engine unavailable ({_gee_msg})"
    del _gee_ok, _gee_msg
CFG.resolve_mode(DATA_MODE)
if DATA_MODE == "synthetic":
    _print_synthetic_banner(_MODE_REASON)
log(f"DATA_MODE={DATA_MODE} | GRID_RES_M={CFG.GRID_RES_M} | fine grid {CFG.grid_fine_res()} m | "
    f"land-cover grid {CFG.fine_res()} m | GEE_EXPORT={CFG.GEE_EXPORT}")

# %% [markdown]
# ## 1.4 Earth Engine: ROI and district matching
# Candidate ADM2 polygons are pulled for the NCR bounding box (attributes + centroid + area only), matched to the 25
# canonical districts client-side by alias (case/space/diacritic-insensitive) with a bounding-box sanity filter, and
# the matched polygons are tagged with the canonical `did`. Delhi's revenue districts are merged into "Delhi NCT".
#
# **Unmatched districts are located, not assumed merged.** For every canonical district still unmatched, the layer is
# queried for the polygon containing its headquarters point: an *unmatched* polygon there (a spelling the alias table
# does not know) is matched by location with a loud warning; a polygon already matched to another district means the
# district is genuinely merged into that parent in this layer (acceptable); no polygon at all is reported as an error.

# %%
_GEOBOUNDARIES_ADM2 = "WM/geoLab/geoBoundaries/600/ADM2"
_GAUL_ADM2 = "FAO/GAUL/2015/level2"


def _norm_name(text) -> str:
    """Lower-case ASCII alphanumerics only ("Gautam Buddha Nagar" -> "gautambuddhanagar")."""
    ascii_text = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", ascii_text.lower())


def _strip_admin_words(norm: str) -> str:
    for word in ("district", "delhi", "nctof", "nct"):
        norm = norm.replace(word, "")
    return norm


_ALIAS_TO_ID = {_norm_name(a): d["id"] for d in NCR_DISTRICTS[1:] for a in d["aliases"]}
_DELHI_NAME_KEYS = {_strip_admin_words(_norm_name(s)) for s in DELHI_SUBDISTRICTS} | {""}
_DELHI_ADM1_KEYS = {_norm_name(a) for a in NCR_DISTRICTS[0]["aliases"]}


def _in_bbox(lon: float, lat: float, bbox) -> bool:
    return bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]


def _match_district(record: dict) -> Optional[int]:
    """Canonical district id for one candidate ADM2 record, or None if it is not an NCR district."""
    lon, lat = record.get("lon"), record.get("lat")
    if lon is None or lat is None or not _in_bbox(lon, lat, NCR_SANITY_BBOX):
        return None
    name = _norm_name(record.get("name"))
    adm1 = _norm_name(record.get("adm1")) if record.get("adm1") else None
    stripped = _strip_admin_words(name)
    for key in (name, stripped):
        did = _ALIAS_TO_ID.get(key)
        if did is None:
            continue
        if key in _ALIAS_LON_MAX and lon > _ALIAS_LON_MAX[key]:
            return None
        state_norm = _norm_name(NCR_DISTRICTS[did]["state"])
        if adm1 is not None and state_norm not in adm1 and adm1 not in state_norm:
            continue
        return did
    in_delhi_box = _in_bbox(lon, lat, DELHI_BBOX)
    if adm1 is not None:
        return 0 if (adm1 in _DELHI_ADM1_KEYS and in_delhi_box) else None
    return 0 if (stripped in _DELHI_NAME_KEYS and in_delhi_box) else None


def _gee_candidates(source: str):
    """(server FeatureCollection, client records) of ADM2 units intersecting the NCR sanity box."""
    rect = ee.Geometry.Rectangle(list(NCR_SANITY_BBOX), None, False)
    if source == "geoboundaries":
        fc = ee.FeatureCollection(_GEOBOUNDARIES_ADM2).filter(ee.Filter.eq("shapeGroup", "IND")).filterBounds(rect)
        name_prop, adm1_prop = "shapeName", None
    else:
        fc = ee.FeatureCollection(_GAUL_ADM2).filter(ee.Filter.eq("ADM0_NAME", "India")).filterBounds(rect)
        name_prop, adm1_prop = "ADM2_NAME", "ADM1_NAME"

    def _summarise(feature):
        geom = feature.geometry()
        centroid = geom.centroid(500).coordinates()
        props = {"name": feature.get(name_prop), "lon": centroid.get(0), "lat": centroid.get(1),
                 "area_km2": geom.area(500).divide(1e6)}
        if adm1_prop:
            props["adm1"] = feature.get(adm1_prop)
        return ee.Feature(None, props)

    info = retry(lambda: _gee_getinfo_guarded(fc.map(_summarise)), tries=4, base_delay=3.0, max_delay=60.0)
    records = [{"key": feat["id"], **feat["properties"]} for feat in info.get("features", [])]
    return fc, records


def _gee_hq_hits(fc, dids) -> dict:
    """{did: [system:index of every candidate polygon containing the district's HQ point]} (one server call)."""
    if not dids:
        return {}
    hits = ee.Dictionary({str(did): fc.filterBounds(ee.Geometry.Point(list(NCR_DISTRICTS[did]["hq"])))
                          .aggregate_array("system:index") for did in dids})
    info = retry(lambda: _gee_getinfo_guarded(hits), tries=4, base_delay=3.0, max_delay=60.0)
    return {int(k): [str(v) for v in (vals or [])] for k, vals in (info or {}).items()}


def _resolve_unmatched(missing_ids, hq_hits: dict, key_to_did: dict, records_by_key: dict):
    """Classify canonical districts left unmatched by name, using the polygons that contain their HQ point.

    Returns (new_matches {candidate key: did}, messages [(level, text)]). An unmatched polygon at the HQ is matched by
    location (an alias the table does not know); a polygon already matched to another district means the district is
    merged into that parent in this layer; no polygon at all is an error.
    """
    new, messages = {}, []
    for did in missing_ids:
        name = NCR_DISTRICTS[did]["name"]
        keys = list(hq_hits.get(did, []))
        free = [k for k in keys if k not in key_to_did and k not in new and k in records_by_key]
        taken = [k for k in keys if k in key_to_did or k in new]
        if free:
            key = free[0]
            new[key] = did
            messages.append(("WARNING", f"{did:2d} {name}: matched BY LOCATION to polygon "
                                        f"'{records_by_key[key].get('name')}' containing its HQ (name not in the "
                                        f"alias table - add it to SPEC_v1 §1.1)"))
        elif taken:
            parent = key_to_did.get(taken[0], new.get(taken[0]))
            messages.append(("INFO", f"{did:2d} {name}: merged into parent district "
                                     f"{NCR_DISTRICTS[parent]['name']} in this layer (HQ inside its polygon)"))
        else:
            messages.append(("ERROR", f"{did:2d} {name}: no polygon of this layer contains its HQ - the district's "
                                      "territory may be missing from the ROI"))
    return new, messages


def _gee_match_roi(source: str):
    """Match one boundary source; returns (roi_fc, matched {did: [names]}, total area) or None if unusable."""
    fc, records = _gee_candidates(source)
    records_by_key = {rec["key"]: rec for rec in records}
    key_to_did, matched, area = {}, {}, 0.0
    for rec in records:
        did = _match_district(rec)
        if did is None:
            continue
        key_to_did[rec["key"]] = did
    missing_ids = [d["id"] for d in NCR_DISTRICTS if d["id"] not in set(key_to_did.values())]
    if missing_ids:
        try:
            located, messages = _resolve_unmatched(missing_ids, _gee_hq_hits(fc, missing_ids), key_to_did,
                                                   records_by_key)
        except Exception as exc:  # noqa: BLE001 - diagnostics must not lose an otherwise usable layer
            located, messages = {}, [("WARNING", f"HQ location check failed ({type(exc).__name__}: "
                                                 f"{str(exc)[:160]}); unmatched: "
                                                 f"{[NCR_DISTRICTS[d]['name'] for d in missing_ids]}")]
        key_to_did.update(located)
        for level, text in messages:
            log(f"[{source}] {text}", level)
    for key, did in key_to_did.items():
        matched.setdefault(did, []).append(str(records_by_key[key].get("name")))
        area += float(records_by_key[key].get("area_km2") or 0.0)
    log(f"[{source}] {len(records)} candidates, matched {len(matched)}/25 districts, area {area:,.0f} km2")
    for did in sorted(matched):
        log(f"    {did:2d} {NCR_DISTRICTS[did]['name']:<20} <- {', '.join(sorted(set(matched[did])))}")
    if 0 not in matched or len(matched) < 18:
        log(f"[{source}] too few matches (Delhi matched: {0 in matched}); trying the next boundary source", "WARNING")
        return None
    if not 45_000 <= area <= 65_000:
        log(f"[{source}] matched area {area:,.0f} km2 is outside the expected 45,000-65,000 km2", "WARNING")
    mapping = ee.Dictionary({k: v for k, v in key_to_did.items()})
    roi_fc = (fc.filter(ee.Filter.inList("system:index", list(key_to_did)))
                .map(lambda f: f.set("did", mapping.get(f.get("system:index")))))
    return roi_fc, matched, area


def _round_coords(obj, ndigits: int = 5):
    """Round nested GeoJSON coordinate lists."""
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(float(v), ndigits) for v in obj]
        return [_round_coords(v, ndigits) for v in obj]
    return obj


def _gee_boundary_geojson(roi_fc, dids) -> dict:
    """Dissolved, 200 m-simplified district polygons (EPSG:4326) with properties id/name/state."""
    features = []
    for did in sorted(dids):
        meta = NCR_DISTRICTS[did]
        geom = (roi_fc.filter(ee.Filter.eq("did", did)).geometry(100)
                .dissolve(100).simplify(200))
        features.append(ee.Feature(geom, {"id": did, "name": meta["name"], "state": meta["state"]}))
    info = retry(lambda: _gee_getinfo_guarded(ee.FeatureCollection(features)), tries=4, base_delay=3.0, max_delay=60.0)
    out = []
    for feat in info["features"]:
        props = feat["properties"]
        geometry = feat["geometry"]
        geometry = {"type": geometry["type"], "coordinates": _round_coords(geometry["coordinates"])}
        out.append({"type": "Feature", "geometry": geometry,
                    "properties": {"id": int(props["id"]), "name": props["name"], "state": props["state"]}})
    return {"type": "FeatureCollection", "features": out}


def _gee_district_collection(roi_fc, dids):
    """One server-side feature per matched district (dissolved at 100 m) with ``did``, ``name``, ``state``.

    Delhi's revenue districts become a single feature, so ``reduceRegions`` over ``EE_DISTRICTS`` yields exactly one
    row per canonical district. The geometry stays server-side (no coordinates in every request).
    """
    feats = []
    for did in sorted(dids):
        meta = NCR_DISTRICTS[did]
        geom = roi_fc.filter(ee.Filter.eq("did", did)).geometry(100).dissolve(100)
        feats.append(ee.Feature(geom, {"did": int(did), "name": meta["name"], "state": meta["state"]}))
    return ee.FeatureCollection(feats)


def _geojson_lonlat_points(geojson: dict) -> np.ndarray:
    """All vertex (lon, lat) pairs of a FeatureCollection of (Multi)Polygons."""
    pts = []

    def _walk(coords):
        if coords and isinstance(coords[0], (int, float)):
            pts.append(coords[:2])
        else:
            for c in coords:
                _walk(c)

    for feat in geojson["features"]:
        _walk(feat["geometry"]["coordinates"])
    return np.asarray(pts, dtype=np.float64)


# %% [markdown]
# ## 1.5 Earth Engine: tiled `computePixels` extraction with retry, subdivision and caching
# Shared by sections 01 and 03-05. Each tile is an explicit grid request (`crsCode` + `affineTransform` +
# `dimensions`) returning a structured NumPy array. Transient errors (HTTP 429/5xx, "Too many concurrent
# aggregations", "Earth Engine (memory) capacity exceeded", timeouts) are retried with exponential backoff; size/memory/
# time-out errors split the tile into quarters (up to depth 3); once a tile cannot (or, with `allow_split=False`, may
# not) be split, such an error is retried at most twice and then **permanent** (a time-out at the maximum depth of a
# splittable request keeps the full `GEE_MAX_RETRIES` budget). On the first failure the remaining
# tiles are cancelled and in-flight tiles stop retrying; on a clean time-budget stop (`LSTStop`, checked before every
# tile) queued tiles are cancelled while the tiles in flight finish and are cached. Per-call statistics (tiles,
# cached tiles, splits, seconds) are kept in `_GEE_FETCH_STATS[cache_key]` and shown in the progress log. Every
# top-level tile is cached as `.npy` under `CFG.CACHE_DIR/tiles/<cache_key>/`, so interrupted runs resume (also across
# Kaggle sessions through the cache import); the cache key contains a hash of the serialised Earth Engine expression, so
# any change of dates, QA rules, scale factors or other server-side parameters gets a fresh cache folder.
# `gee_tile_px(n_bands, dtype)` returns the largest square tile that respects the 48 MB per-request limit.

# %%
_GEE_CACHE_VERSION = "v2"
_GEE_MAX_SPLIT_DEPTH = 3
_GEE_REQUEST_BYTES_MAX = 50_331_648          # 48 MB uncompressed per computePixels request
_GEE_SPLIT_RE = re.compile(r"user memory limit exceeded|computation timed out|too large|request size|"
                           r"response size|out of memory|memory limit", re.IGNORECASE)
_GEE_TIMEOUT_RE = re.compile(r"timed out|deadline", re.IGNORECASE)
_GEE_TRANSIENT_RE = re.compile(r"\b(429|500|502|503|504)\b|too many requests|too many concurrent aggregations|"
                               r"capacity exceeded|"
                               r"quota|rate limit|internal error|service unavailable|backend error|deadline|"
                               r"temporar|connection|reset by peer|timed out|remote end closed|broken pipe|ssl",
                               re.IGNORECASE)


_GEE_RESTRICTED_RE = re.compile(r"restricted mode", re.IGNORECASE)
GEE_RESTRICTED_REASON = (
    "Earth Engine quota used up: the project is in Restricted Mode (its monthly EECU-hour quota is exhausted; the "
    "free Community tier has 150 EECU-hours per month, and a full run needs several hundred). Switch the project to "
    "the Contributor tier (1,000 EECU-hours per month; needs a linked billing account, noncommercial use is not "
    "charged; takes effect at once) at https://console.cloud.google.com/earth-engine/configuration/manage-tier , or "
    "wait until the quota resets on the 1st of the month (00:00 Pacific time). Everything downloaded so far is "
    "cached: run again to resume.")


def _gee_raise_if_restricted(exc: BaseException) -> None:
    """Stop the run cleanly (``request_stop`` + ``LSTStop``) when ``exc`` says the project is in Earth Engine
    Restricted Mode: the monthly quota is gone, so retrying cannot help, and a clean stop keeps (and packs) every
    tile downloaded so far for the resume."""
    if not _GEE_RESTRICTED_RE.search(str(exc)):
        return
    stop, stop_cls = globals().get("request_stop"), globals().get("LSTStop")
    if callable(stop):
        stop(GEE_RESTRICTED_REASON)
    if isinstance(stop_cls, type) and issubclass(stop_cls, BaseException):
        raise stop_cls(GEE_RESTRICTED_REASON) from exc
    raise RuntimeError(GEE_RESTRICTED_REASON) from exc


def _gee_getinfo_guarded(obj):
    """``obj.getInfo()``, turning Restricted Mode into a clean stop (for the plain ``retry`` calls of this section)."""
    try:
        return obj.getInfo()
    except Exception as exc:  # noqa: BLE001 - re-raised unless it is Restricted Mode
        _gee_raise_if_restricted(exc)
        raise


class _GEETransientError(RuntimeError):
    """Retryable Earth Engine failure (quota, 5xx, transient timeouts)."""


class _GEESplitError(RuntimeError):
    """Request too large/slow for one call: subdivide the tile."""


class _GEEAborted(RuntimeError):
    """Another tile of the same request failed permanently: stop retrying this one."""


def gee_tile_px(n_bands: int, dtype=np.float32, cap: int = 2048, safety: float = 0.8) -> int:
    """Largest square tile side (multiple of 16 px) whose ``n_bands × dtype`` payload stays under the 48 MB limit."""
    bytes_per_px = max(1, int(n_bands)) * np.dtype(dtype).itemsize
    side = int(math.sqrt(_GEE_REQUEST_BYTES_MAX * safety / bytes_per_px))
    return int(max(16, min(int(cap), side // 16 * 16)))


def _gee_expression_digest(image) -> str:
    """SHA-1 of the serialised Earth Engine expression (captures every server-side parameter).

    Falls back to a random token (cache effectively disabled for that request) if serialisation fails, so a stale tile
    can never be reused under an incomplete key.
    """
    import uuid

    try:
        text = image.serialize()
    except Exception as exc:  # noqa: BLE001
        log(f"could not serialise the Earth Engine expression ({type(exc).__name__}); tile cache disabled for "
            "this request", "WARNING")
        text = uuid.uuid4().hex
    return hashlib.sha1(str(text).encode("utf-8")).hexdigest()


def _gee_cache_key(name: str, grid: GridSpec, extra: Any = None, image=None) -> str:
    """Stable cache folder name tied to the grid geometry, the request description and (when ``image`` is given) the
    hash of the serialised expression."""
    expr = _gee_expression_digest(image) if image is not None else None
    payload = json.dumps([_GEE_CACHE_VERSION, asdict(grid), extra, expr], sort_keys=True, default=str)
    digest = hashlib.sha1(payload.encode()).hexdigest()[:10]
    return f"{name}_{grid.res}m_{digest}"


gee_cache_key = _gee_cache_key     # public name for sections 03-05


def _structured_to_stack(raw, bands: Sequence[str], tile: GridSpec, dtype) -> np.ndarray:
    """computePixels NUMPY_NDARRAY result (structured, one field per band) -> (bands, h, w) array."""
    raw = np.asarray(raw)
    if raw.dtype.names:
        missing = [b for b in bands if b not in raw.dtype.names]
        if missing:
            raise RuntimeError(f"computePixels result lacks bands {missing}; got {raw.dtype.names}")
        stack = np.stack([np.asarray(raw[b]) for b in bands])
    elif raw.ndim == 3:
        stack = np.moveaxis(raw, -1, 0)
    else:
        stack = raw[None]
    if stack.shape[1:] != (tile.height, tile.width):
        raise RuntimeError(f"computePixels returned shape {stack.shape[1:]}, expected {(tile.height, tile.width)}")
    return stack.astype(dtype, copy=False)


def _classify_gee_error(exc: BaseException, allow_split: bool) -> BaseException:
    """Map an Earth Engine exception to split / transient / permanent (returns the exception to raise).

    * size/memory errors split the tile while it can be split; at the maximum depth (``_fetch_tile``) they get two
      tries and are then permanent (an identical request cannot suddenly fit the per-user memory limit) - except
      timeouts, which stay retryable with the full ``GEE_MAX_RETRIES`` budget; with ``allow_split=False`` both get
      the two-try limit;
    * load-related errors (429/5xx, concurrent aggregations, capacity exceeded, timeouts, connection resets) are
      transient and retried with backoff;
    * everything else (bad asset, auth, invalid argument) is permanent;
    * Restricted Mode (monthly quota used up) raises a clean stop at once (``_gee_raise_if_restricted``).
    """
    _gee_raise_if_restricted(exc)
    message = str(exc)
    if _GEE_SPLIT_RE.search(message):
        if allow_split:
            return _GEESplitError(message)
        if _GEE_TIMEOUT_RE.search(message):
            return _GEETransientError(message)
        return RuntimeError(f"Earth Engine request still too large at the maximum split depth: {message}")
    if _GEE_TRANSIENT_RE.search(message):
        return _GEETransientError(message)
    return exc


def _compute_pixels(image, tile: GridSpec, bands: Sequence[str], dtype, allow_split: bool) -> np.ndarray:
    """One computePixels call, translating EE errors into split / transient / permanent failures."""
    request = {
        "expression": image,
        "fileFormat": "NUMPY_NDARRAY",
        "bandIds": list(bands),
        "grid": {"dimensions": {"width": int(tile.width), "height": int(tile.height)},
                 "affineTransform": tile.affine(), "crsCode": tile.crs},
    }
    try:
        raw = ee.data.computePixels(request)
    except Exception as exc:  # noqa: BLE001 - classified below
        raise _classify_gee_error(exc, allow_split) from exc
    return _structured_to_stack(raw, bands, tile, dtype)


class _GEENoSplitError(_GEETransientError):
    """Size/time-out error of a request that may not be split: retried at most ``_GEE_NOSPLIT_TRIES`` times."""


_GEE_NOSPLIT_TRIES = 2
_GEE_FETCH_STATS: dict = {}       # cache_key -> {tiles, cached, splits, seconds, fetched}
_GEE_STATS_LOCK = threading.Lock()


def _fetch_tile(image, tile: GridSpec, bands: Sequence[str], dtype, depth: int = 0,
                abort: Optional[threading.Event] = None, allow_split: bool = True,
                stats: Optional[dict] = None) -> np.ndarray:
    """Fetch one tile with backoff; quarter it recursively on size/memory errors; stop when ``abort`` is set.

    With ``allow_split=False`` a size or time-out error is retried at most twice in total and then raised as a
    permanent error, instead of being retried ``GEE_MAX_RETRIES`` times. At the maximum split depth (with
    ``allow_split=True``) a size/memory error gets the same two tries, while a time-out stays a load-related transient
    error and keeps the full ``GEE_MAX_RETRIES`` budget (an 8 km tile that times out under load usually succeeds later).
    ``stats`` (optional dict) counts the splits.
    """
    can_split = bool(allow_split) and depth < _GEE_MAX_SPLIT_DEPTH and min(tile.width, tile.height) >= 2
    size_failures = [0]

    def _once():
        try:
            return _compute_pixels(image, tile, bands, dtype, True)
        except _GEESplitError as exc:
            if can_split:
                raise
            if allow_split and _GEE_TIMEOUT_RE.search(str(exc)):
                raise _GEETransientError(str(exc)) from exc   # max depth: time-outs keep GEE_MAX_RETRIES
            raise _GEENoSplitError(str(exc)) from exc

    def _on_retry(attempt, exc, delay):
        if abort is not None and abort.is_set():
            raise _GEEAborted("another tile failed; not retrying") from exc
        if isinstance(exc, _GEENoSplitError):
            size_failures[0] += 1
            if size_failures[0] >= _GEE_NOSPLIT_TRIES:
                raise RuntimeError(f"Earth Engine request for a {tile.width}x{tile.height} tile failed "
                                   f"{size_failures[0]} times with a size/time-out error and may not be split "
                                   f"further: {str(exc)[:300]}") from exc
        log(f"computePixels retry {attempt} for {tile.width}x{tile.height} tile in {delay:.1f}s: {str(exc)[:160]}",
            "WARNING")

    if abort is not None and abort.is_set():
        raise _GEEAborted("another tile failed; not fetching")
    try:
        return retry(_once, tries=CFG.GEE_MAX_RETRIES, base_delay=2.0, max_delay=120.0,
                     retry_on=(_GEETransientError,), on_retry=_on_retry)
    except _GEESplitError as exc:
        log(f"splitting {tile.width}x{tile.height} tile (depth {depth + 1}): {str(exc)[:160]}", "WARNING")
        if stats is not None:
            with _GEE_STATS_LOCK:
                stats["splits"] = stats.get("splits", 0) + 1
    h1, w1 = tile.height // 2, tile.width // 2
    out = np.empty((len(bands), tile.height, tile.width), dtype=dtype)
    for r0, h in ((0, h1), (h1, tile.height - h1)):
        for c0, w in ((0, w1), (w1, tile.width - w1)):
            out[:, r0:r0 + h, c0:c0 + w] = _fetch_tile(image, tile.tile(r0, c0, h, w), bands, dtype, depth + 1,
                                                       abort, allow_split, stats)
    return out


def _save_npy_atomic(path: Path, array: np.ndarray) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as fh:
        np.save(fh, array)
    os.replace(tmp, path)


def fetch_grid(image, grid: GridSpec, bands: Sequence[str], tile_px: int, cache_key: str,
               dtype=np.float32, allow_split: bool = True, stats: Optional[dict] = None) -> np.ndarray:
    """Download ``bands`` of an ee.Image on ``grid`` as a (len(bands), H, W) array.

    Tiles of ``tile_px`` × ``tile_px`` are fetched concurrently (``CFG.GEE_WORKERS`` threads) with retry, recursive
    subdivision (``allow_split``) and an on-disk cache (also restored from ``cache/packed/*.tar``). For float dtypes
    the ``NODATA_FLOAT`` sentinel is turned into NaN; integer outputs are returned as delivered.

    Per-call statistics {tiles, cached, splits, fetched, seconds} are kept in ``_GEE_FETCH_STATS[cache_key]`` and
    copied into ``stats`` when given. Before every tile the run's time budget is checked (expected duration 1.25 ×
    the slowest tile so far); on a clean stop (``LSTStop``) queued tiles are cancelled, the tiles in flight finish
    and are cached, and ``LSTStop`` is re-raised. On any other failure the remaining tiles are cancelled and
    in-flight tiles stop retrying.
    """
    if ee is None:
        raise RuntimeError("earthengine-api is not available")
    bands, dtype = list(bands), np.dtype(dtype)
    limit = gee_tile_px(len(bands), dtype, cap=1 << 15, safety=1.0)
    if tile_px > limit:
        log(f"{cache_key}: tile_px {tile_px} exceeds the 48 MB request limit for {len(bands)} {dtype} band(s); "
            f"using {limit}", "WARNING")
        tile_px = limit
    abort = threading.Event()
    cache_dir = CFG.CACHE_DIR / "tiles" / cache_key
    cache_dir.mkdir(parents=True, exist_ok=True)
    tiles = [(r0, c0, min(tile_px, grid.height - r0), min(tile_px, grid.width - c0))
             for r0 in range(0, grid.height, tile_px) for c0 in range(0, grid.width, tile_px)]
    out = np.empty((len(bands), grid.height, grid.width), dtype=dtype)
    call_stats = {"tiles": len(tiles), "cached": 0, "splits": 0, "fetched": 0, "seconds": 0.0, "tile_px": tile_px}
    with _GEE_STATS_LOCK:
        _GEE_FETCH_STATS[cache_key] = call_stats
    slowest = [0.0]
    t_start = time.perf_counter()

    def _job(spec):
        r0, c0, h, w = spec
        path = cache_dir / f"r{r0:06d}_c{c0:06d}_{h}x{w}.npy"
        if not path.exists():
            cache_restore(path)
        if path.exists():
            try:
                cached = np.load(path)
                if cached.shape == (len(bands), h, w):
                    return spec, cached.astype(dtype, copy=False), True
            except (OSError, ValueError) as exc:
                log(f"ignoring unreadable cache tile {path.name}: {exc}", "WARNING")
        check_budget(f"Earth Engine tile {cache_key}", 1.25 * slowest[0])
        t0 = time.perf_counter()
        arr = _fetch_tile(image, grid.tile(r0, c0, h, w), bands, dtype, abort=abort, allow_split=allow_split,
                          stats=call_stats)
        _save_npy_atomic(path, arr)
        with _GEE_STATS_LOCK:
            slowest[0] = max(slowest[0], time.perf_counter() - t0)
            call_stats["fetched"] += 1
        return spec, arr, False

    n_done, step = 0, max(1, len(tiles) // 10)
    pool = ThreadPoolExecutor(max_workers=max(1, min(CFG.GEE_WORKERS, len(tiles))), thread_name_prefix="ee")
    futures = [pool.submit(_job, t) for t in tiles]
    try:
        for future in as_completed(futures):
            (r0, c0, h, w), arr, cached = future.result()
            out[:, r0:r0 + h, c0:c0 + w] = arr
            n_done += 1
            with _GEE_STATS_LOCK:
                call_stats["cached"] += int(cached)
                call_stats["seconds"] = round(time.perf_counter() - t_start, 1)
            if n_done % step == 0 or n_done == len(tiles):
                log(f"  {cache_key}: {n_done}/{len(tiles)} tiles ({call_stats['cached']} from cache, "
                    f"{call_stats['splits']} split(s), {call_stats['seconds']:.0f}s)")
    except LSTStop:
        # Clean stop: no new tile starts and in-flight tiles stop retrying; a request already in flight finishes and
        # is cached for the resumed run.
        abort.set()
        pool.shutdown(wait=True, cancel_futures=True)
        raise
    except BaseException:
        # Fail fast: cancel queued tiles, tell in-flight ones to stop retrying, and do not wait for them.
        abort.set()
        pool.shutdown(wait=False, cancel_futures=True)
        raise
    pool.shutdown(wait=True)
    call_stats["seconds"] = round(time.perf_counter() - t_start, 1)
    if stats is not None:
        stats.update(call_stats)
    if dtype.kind == "f":
        out[out == NODATA_FLOAT] = np.nan
    return out


def _grid_ee_geom(grid: GridSpec):
    """Bounding polygon of a GridSpec in EPSG:4326 as an ee.Geometry (planar edges, densified)."""
    ring_xy = [(grid.x0, grid.y0), (grid.x0 + grid.width * grid.res, grid.y0),
               (grid.x0 + grid.width * grid.res, grid.y0 - grid.height * grid.res),
               (grid.x0, grid.y0 - grid.height * grid.res), (grid.x0, grid.y0)]
    pts = _densify_ring(ring_xy, 8)
    lons, lats = _grid_xy_to_lonlat(pts[:, 0], pts[:, 1], grid.crs)
    ring = [[float(lo), float(la)] for lo, la in zip(lons, lats)]
    return ee.Geometry.Polygon([ring], None, False)


grid_ee_geom = _grid_ee_geom       # public name for sections 03-05

# %% [markdown]
# ## 1.6 ROI, districts and the analysis grid
# * **Earth Engine:** geoBoundaries ADM2 → FAO GAUL level 2 → approximate outline. The grid is snapped to the
#   dissolved district polygons (+1 cell margin) and the district raster is painted server-side (`paint` of `did`)
#   on exactly that grid, so it is pixel-identical to everything extracted later. `EE_DISTRICTS` holds one dissolved
#   feature per district (`did`, `name`, `state`) for `reduceRegions`.
# * **Synthetic / last resort:** the approximate NCR outline (SPEC_v1 §1.2), partitioned into the 25 districts by
#   nearest headquarters — a Voronoi partition in UTM metres, identical for the raster (cell-centre nearest HQ) and the
#   GeoJSON (Voronoi polygons clipped to the outline, simplified to 200 m).

# %%
def _lonlat_array_to_xy(points) -> np.ndarray:
    pts = np.asarray(points, dtype=np.float64)
    x, y = _grid_lonlat_to_xy(pts[:, 0], pts[:, 1], CFG.CRS)
    return np.column_stack([x, y])


def _convex_hull(points: np.ndarray) -> np.ndarray:
    """Andrew's monotone chain convex hull (closed ring) - fallback when shapely is unavailable."""
    pts = np.unique(points, axis=0)
    if len(pts) < 3:
        return np.vstack([pts, pts[:1]])

    def _turn(o, a, b):  # z-component of (a - o) x (b - o): > 0 for a counter-clockwise turn
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    def _half(seq):
        hull = []
        for p in seq:
            while len(hull) >= 2 and _turn(hull[-2], hull[-1], p) <= 0:
                hull.pop()
            hull.append(p)
        return hull

    lower, upper = _half(pts), _half(pts[::-1])
    ring = np.array(lower[:-1] + upper[:-1])
    return np.vstack([ring, ring[:1]])


def _xy_ring_to_lonlat(ring_xy: np.ndarray) -> list:
    lon, lat = _grid_xy_to_lonlat(ring_xy[:, 0], ring_xy[:, 1], CFG.CRS)
    return [[round(float(a), 5), round(float(b), 5)] for a, b in zip(lon, lat)]


def _voronoi_boundary_geojson(hq_xy: np.ndarray, outline_xy: np.ndarray, district_idx, grid: GridSpec) -> dict:
    """District polygons = Voronoi cells of the HQs clipped to the outline, simplified to 200 m (EPSG:4326)."""
    features = []
    if shapely is not None:
        from shapely.geometry import MultiPoint, Point, Polygon
        from shapely.ops import voronoi_diagram

        outline = Polygon(outline_xy).buffer(0)
        cells = voronoi_diagram(MultiPoint([tuple(p) for p in hq_xy]), envelope=outline.buffer(100_000))
        for d, hq in zip(NCR_DISTRICTS, hq_xy):
            region = next(c for c in cells.geoms if c.covers(Point(hq)))
            geom = region.intersection(outline).simplify(200, preserve_topology=True)
            polys = [geom] if geom.geom_type == "Polygon" else [g for g in getattr(geom, "geoms", []) if g.geom_type == "Polygon"]
            coords = [[_xy_ring_to_lonlat(np.asarray(p.exterior.coords))]
                      + [_xy_ring_to_lonlat(np.asarray(r.coords)) for r in p.interiors] for p in polys]
            geometry = ({"type": "Polygon", "coordinates": coords[0]} if len(coords) == 1
                        else {"type": "MultiPolygon", "coordinates": coords})
            features.append({"type": "Feature", "geometry": geometry,
                             "properties": {"id": d["id"], "name": d["name"], "state": d["state"]}})
        return {"type": "FeatureCollection", "features": features}
    log("shapely unavailable: district outlines approximated by convex hulls of their cells", "WARNING")
    x, y = grid.cell_centers_xy()
    for d in NCR_DISTRICTS:
        sel = district_idx == d["id"]
        ring = _convex_hull(np.column_stack([x[sel], y[sel]])) if sel.any() else np.repeat(hq_xy[d["id"]][None], 4, 0)
        features.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [_xy_ring_to_lonlat(ring)]},
                         "properties": {"id": d["id"], "name": d["name"], "state": d["state"]}})
    return {"type": "FeatureCollection", "features": features}


def _outline_districts(grid: GridSpec):
    """ROI mask, nearest-HQ district raster and matching Voronoi GeoJSON for the approximate NCR outline."""
    from matplotlib.path import Path as _MplPath

    x, y = grid.cell_centers_xy()
    outline_xy = _lonlat_array_to_xy(_densify_ring(NCR_OUTLINE, 10))
    roi_mask = _MplPath(outline_xy).contains_points(np.column_stack([x.ravel(), y.ravel()])).reshape(grid.shape)
    hq_xy = _lonlat_array_to_xy([d["hq"] for d in NCR_DISTRICTS])
    district_idx = np.full(grid.shape, NODATA_DISTRICT, dtype=np.int16)
    # nearest HQ per cell, row-chunked so the (rows, W, 25) distance block stays small at fine resolutions
    for r0 in range(0, grid.height, 256):
        xs, ys = x[r0:r0 + 256, :, None], y[r0:r0 + 256, :, None]
        d2 = (xs - hq_xy[:, 0]) ** 2 + (ys - hq_xy[:, 1]) ** 2
        district_idx[r0:r0 + 256] = np.argmin(d2, axis=-1).astype(np.int16)
    district_idx[~roi_mask] = NODATA_DISTRICT
    boundary = _voronoi_boundary_geojson(hq_xy, outline_xy, district_idx, grid)
    return roi_mask, district_idx, boundary


def _geojson_to_ee_districts(geojson: dict):
    """ee.FeatureCollection (``did``, ``name``, ``state``) from a district GeoJSON (outline fallback in gee mode)."""
    feats = []
    for feat in geojson["features"]:
        props = feat["properties"]
        geom = ee.Geometry(feat["geometry"], None, False)
        feats.append(ee.Feature(geom, {"did": int(props["id"]), "name": props["name"], "state": props["state"]}))
    return ee.FeatureCollection(feats)


def _gee_build_roi(res: int) -> dict:
    """Try geoBoundaries, then GAUL, then the NCR outline. Returns a dict describing the ROI."""
    for source in ("geoboundaries", "gaul"):
        try:
            matched = _gee_match_roi(source)
        except Exception as exc:  # noqa: BLE001 - try the next source
            log(f"[{source}] boundary query failed: {type(exc).__name__}: {str(exc)[:200]}", "WARNING")
            continue
        if matched is None:
            continue
        roi_fc, districts, area = matched
        boundary = _gee_boundary_geojson(roi_fc, districts.keys())
        grid = GridSpec.from_lonlat_points(_geojson_lonlat_points(boundary), CFG.CRS, res)
        asset = _GEOBOUNDARIES_ADM2 if source == "geoboundaries" else _GAUL_ADM2
        return {"source": asset, "fc": roi_fc, "geom": roi_fc.geometry(), "boundary": boundary,
                "grid": grid, "area_km2": area, "local_districts": None,
                "ee_districts": _gee_district_collection(roi_fc, districts.keys())}
    log("No administrative boundary source usable; falling back to the approximate NCR outline + "
        "nearest-HQ (Voronoi) districts", "WARNING")
    grid = _outline_grid(res)
    roi_mask, district_idx, boundary = _outline_districts(grid)
    geom = ee.Geometry.Polygon([[list(p) for p in NCR_OUTLINE]], None, False)
    return {"source": "approximate NCR outline (SPEC_v1 §1.2) with Voronoi districts", "fc": None, "geom": geom,
            "boundary": boundary, "grid": grid, "area_km2": float(roi_mask.sum() * grid.cell_area_km2),
            "local_districts": (roi_mask, district_idx), "ee_districts": _geojson_to_ee_districts(boundary)}


def acquire_gee_study_area() -> dict:
    """Earth Engine study area: grid, ROI mask, district raster, boundary GeoJSON and EE handles."""
    res = CFG.GRID_RES_M
    roi = _gee_build_roi(res)
    grid = roi["grid"]
    log(f"GEE grid: {grid.width}x{grid.height} cells @ {res} m, origin ({grid.x0:.0f}, {grid.y0:.0f}) {grid.crs}")
    ref = _S01_V1_REAL_GRID
    if res == ref["res"] and roi["local_districts"] is None and (
            grid.width, grid.height, grid.x0, grid.y0) != (ref["width"], ref["height"], ref["x0"], ref["y0"]):
        log(f"grid differs from the v1 real-data grid ({ref['width']}x{ref['height']} at x0 {ref['x0']:.0f}, "
            f"y_top {ref['y0']:.0f}); the boundary layer may have changed", "WARNING")
    if roi["local_districts"] is None:
        paint = ee.Image.constant(NODATA_DISTRICT).toInt16().paint(roi["fc"], "did").toInt16().rename("did")
        district_idx = fetch_grid(paint, grid, ["did"], gee_tile_px(1, np.int16, cap=1024),
                                  _gee_cache_key("districts", grid, roi["source"], image=paint), np.int16)[0]
        district_idx = district_idx.astype(np.int16)
        district_idx[(district_idx < 0) | (district_idx >= len(NCR_DISTRICTS))] = NODATA_DISTRICT
        roi_mask = district_idx >= 0
    else:
        roi_mask, district_idx = roi["local_districts"]
    log(f"ROI: {int(roi_mask.sum()):,} cells = {roi_mask.sum() * grid.cell_area_km2:,.0f} km2 ({roi['source']})")
    return {"GRID": grid, "ROI_MASK": roi_mask, "DISTRICT_IDX": district_idx.astype(np.int16),
            "BOUNDARY_GEOJSON": roi["boundary"], "ROI_SOURCE": roi["source"],
            "BOUNDARY_APPROXIMATE": roi["local_districts"] is not None,
            "EE_DISTRICTS": roi["ee_districts"], "EE_ROI": roi["geom"]}


def synthetic_study_area() -> dict:
    """Synthetic study area: outline grid, nearest-HQ districts (no Earth Engine)."""
    grid = _outline_grid(CFG.GRID_RES_M)
    roi_mask, district_idx, boundary = _outline_districts(grid)
    return {"GRID": grid, "ROI_MASK": roi_mask, "DISTRICT_IDX": district_idx, "BOUNDARY_GEOJSON": boundary,
            "ROI_SOURCE": "approximate NCR outline (SPEC_v1 §1.2) with Voronoi districts [synthetic]",
            "BOUNDARY_APPROXIMATE": True, "EE_DISTRICTS": None, "EE_ROI": None}


_S01_AREA = None
if DATA_MODE == "gee":
    try:
        with timer("01 GEE study area"):
            _S01_AREA = acquire_gee_study_area()
    except Exception as _exc:  # noqa: BLE001 - auto mode without a key must not crash
        if CFG.RUN_MODE == "gee" or _S01_KEY_SUPPLIED:
            if CFG.RUN_MODE != "gee":
                log("Earth Engine study-area construction failed although a service-account key was supplied; "
                    "stopping instead of falling back to synthetic data (set LST_RUN_MODE=synthetic to force the "
                    "synthetic twin)", "ERROR")
            raise
        log(f"Earth Engine study-area construction failed: {type(_exc).__name__}: {_exc}", "ERROR")
        DATA_MODE = "synthetic"
        CFG.resolve_mode(DATA_MODE)
        _MODE_REASON = f"Earth Engine study area failed: {type(_exc).__name__}: {str(_exc)[:300]}"
        _print_synthetic_banner(_MODE_REASON)
        _S01_AREA = None
if DATA_MODE == "synthetic":
    with timer("01 synthetic study area"):
        _S01_AREA = synthetic_study_area()

# %% [markdown]
# ## 1.7 Interface globals: grids, masks, canonical cell order, provenance and caveats
# `ROI_MASK_FINE` marks a fine pixel as inside the ROI iff its parent 1 km cell is (so fine aggregates and 1 km cells
# always describe the same territory). The canonical order is row-major over ROI cells, i.e. ascending `cell_id`.

# %%
GRID = _S01_AREA["GRID"]
ROI_MASK = np.ascontiguousarray(_S01_AREA["ROI_MASK"], dtype=bool)
DISTRICT_IDX = np.ascontiguousarray(_S01_AREA["DISTRICT_IDX"], dtype=np.int16)
DISTRICT_IDX[~ROI_MASK] = NODATA_DISTRICT
BOUNDARY_GEOJSON = _S01_AREA["BOUNDARY_GEOJSON"]
BOUNDARY_APPROXIMATE = bool(_S01_AREA["BOUNDARY_APPROXIMATE"])
EE_DISTRICTS = _S01_AREA["EE_DISTRICTS"] if DATA_MODE == "gee" else None
# Do not use EE_ROI: fc.geometry() of this collection evaluates to an empty MultiPoint on real data (2026-11), so any
# filterBounds or reduction over it silently selects nothing. Use gee_roi_geometry() (section 03) or EE_DISTRICTS.
EE_ROI = _S01_AREA["EE_ROI"] if DATA_MODE == "gee" else None
DATA_MODE_REASON = str(_MODE_REASON)
_S01_ROI_SOURCE = _S01_AREA["ROI_SOURCE"]

FINE_FACTOR = int(CFG.FINE_FACTOR)
GRID_FINE = GRID.fine(CFG.grid_fine_res())
ROI_MASK_FINE = np.ascontiguousarray(upsample_repeat(ROI_MASK, FINE_FACTOR), dtype=bool)

_s01_flat = np.flatnonzero(ROI_MASK.ravel())                 # ascending = canonical order (cell_id = row*W + col)
if _s01_flat.size and _s01_flat.max() > np.iinfo(np.int32).max:
    raise OverflowError("cell ids exceed int32 - grid too large")
N_CELLS = int(_s01_flat.size)
CELL_IDS = _s01_flat.astype(np.int32)
CELL_ROWS = (_s01_flat // GRID.width).astype(np.int32)
CELL_COLS = (_s01_flat % GRID.width).astype(np.int32)
_s01_lon, _s01_lat = GRID.lonlat()
CELL_LON = np.asarray(_s01_lon, dtype=np.float64)[CELL_ROWS, CELL_COLS]
CELL_LAT = np.asarray(_s01_lat, dtype=np.float64)[CELL_ROWS, CELL_COLS]
del _s01_flat, _s01_lon, _s01_lat

# Provenance: variable -> {year: text}. Later sections add one entry per variable and frame.
DATA_SOURCES = {"roi": {int(y): _S01_ROI_SOURCE for y in CFG.FRAMES_OBS}}

# Static caveats for the manifest notes (SPEC §2: acquisition sections append frame-specific ones).
DATA_CAVEATS = [
    "Day LST of the 1990 and 1995 frames comes from Landsat 5 alone: some WRS-2 path/rows have fewer than 6 clear "
    "pre-monsoon scenes in the window, so these frames are tiered 'observed-sparse' and are noisier.",
    "The 2005 day frame includes Landsat 7 ETM+ scenes after the 2003 scan-line-corrector failure (SLC-off): "
    "striped gaps are filled only by other scenes of the window.",
    "Day LST is a ~10:30 IST snapshot; frames are corrected to a common 10:45 IST overpass with an ERA5-Land "
    "skin-temperature heating rate. The correction (typically a few tenths of a degree, more for early Landsat 5 "
    "scenes) carries its own uncertainty, included in the level intervals.",
    "Night LST is in Aqua-equivalent units: the 2025 frame is VIIRS and the 2000 frame Terra (22:30), both "
    "calibrated to Aqua on overlap years; 1990 and 1995 night frames are model hindcasts, not observations.",
    "ERA5-Land climate covariates have ~9-11 km native resolution (bilinearly resampled to the grid) and known "
    "warm/dry biases over irrigated Indo-Gangetic cropland.",
    "Land cover is GLC_FCS30D for every frame (five-yearly maps before 2000, ~81 % global accuracy); the 2025 frame "
    "uses its 2022 map.",
    "GHSL built-up and population for 2025 and 2030 are model extrapolations (GHSL P2023A), and GHSL accuracy "
    "before 2000 is lower (Landsat back-casting).",
    "Projections 2030-2050 are scenario projections, not forecasts: they combine CMIP6 temperature deltas scaled "
    "by an empirical dLST/dTair sensitivity with simulated land change, with Monte-Carlo uncertainty.",
    "SHAP values explain the model's predictions, not causal effects; thresholds and recommendations are model-based "
    "what-if estimates.",
]
if BOUNDARY_APPROXIMATE:
    DATA_CAVEATS.append(
        "District boundaries are APPROXIMATE (nearest-HQ Voronoi partition of the SPEC_v1 §1.2 outline): district "
        "names and per-district statistics describe approximate areas.")
if _S01_ASSET_CAVEAT:
    DATA_CAVEATS.append(_S01_ASSET_CAVEAT)
if CFG.PROFILE == "pilot":
    DATA_CAVEATS.append(f"PILOT RUN: only the {', '.join(str(y) for y in CFG.FRAMES_OBS)} frames and no projections "
                        "(Earth Engine cost probe); not a complete analysis.")
if DATA_MODE == "synthetic":
    DATA_CAVEATS.append("SYNTHETIC DATA: every variable is simulated from planted responses; see SYNTHETIC_TRUTH. "
                        "No result describes the real Delhi NCR.")
for _caveat in DATA_CAVEATS:
    log(f"caveat: {_caveat}")
del _S01_AREA
log(f"GRID {GRID.width}x{GRID.height} @ {GRID.res} m | GRID_FINE {GRID_FINE.width}x{GRID_FINE.height} @ "
    f"{GRID_FINE.res} m | ROI {N_CELLS:,} cells ({N_CELLS * GRID.cell_area_km2:,.0f} km2) | "
    f"land cover {CFG.fine_res()} m | mode {DATA_MODE}")

# %% [markdown]
# ## 1.8 Contract check
# Verifies the section-1 interface (SPEC §3.1) so downstream sections can rely on shapes, dtypes and order.

# %%
def _validate_study_area() -> None:
    """Raise AssertionError with a precise message if any section-1 global violates the contract."""
    h, w = GRID.shape
    f = FINE_FACTOR
    assert DATA_MODE in ("gee", "synthetic"), DATA_MODE
    assert CFG.DATA_MODE == DATA_MODE, (CFG.DATA_MODE, DATA_MODE)
    assert GRID.res == CFG.GRID_RES_M and GRID.crs == CFG.CRS, (GRID.res, GRID.crs)
    assert GRID.x0 % GRID.res == 0 and GRID.y0 % GRID.res == 0, "grid edges must be multiples of the cell size"
    assert (GRID_FINE.width, GRID_FINE.height) == (w * f, h * f) and GRID_FINE.x0 == GRID.x0 \
        and GRID_FINE.y0 == GRID.y0, GRID_FINE
    assert GRID.res % CFG.fine_res() == 0, "LC_FINE_RES_M must divide GRID_RES_M"
    assert ROI_MASK.shape == (h, w) and ROI_MASK.dtype == bool, (ROI_MASK.shape, ROI_MASK.dtype)
    assert ROI_MASK_FINE.shape == (h * f, w * f) and ROI_MASK_FINE.dtype == bool
    assert int(ROI_MASK_FINE.sum()) == N_CELLS * f * f, "ROI_MASK_FINE must cover exactly the ROI cells"
    assert DISTRICT_IDX.shape == (h, w) and DISTRICT_IDX.dtype == np.int16, (DISTRICT_IDX.shape, DISTRICT_IDX.dtype)
    assert np.all(DISTRICT_IDX[~ROI_MASK] == NODATA_DISTRICT), "DISTRICT_IDX must be -1 outside the ROI"
    assert np.all(DISTRICT_IDX[ROI_MASK] >= 0) and DISTRICT_IDX.max() < len(DISTRICTS), "district id out of range"
    assert len(DISTRICTS) == 25 and all(set(d) == {"id", "name", "state"} for d in DISTRICTS)
    assert [d["id"] for d in DISTRICTS] == list(range(25))
    assert BOUNDARY_GEOJSON["type"] == "FeatureCollection" and BOUNDARY_GEOJSON["features"]
    for feat in BOUNDARY_GEOJSON["features"]:
        assert set(feat["properties"]) == {"id", "name", "state"}, feat["properties"]
        assert feat["geometry"]["type"] in ("Polygon", "MultiPolygon"), feat["geometry"]["type"]
    assert N_CELLS > 0 and N_CELLS == int(ROI_MASK.sum())
    for name, arr, dt in (("CELL_IDS", CELL_IDS, np.int32), ("CELL_ROWS", CELL_ROWS, np.int32),
                          ("CELL_COLS", CELL_COLS, np.int32), ("CELL_LON", CELL_LON, np.float64),
                          ("CELL_LAT", CELL_LAT, np.float64)):
        assert arr.shape == (N_CELLS,) and arr.dtype == dt, (name, arr.shape, arr.dtype)
    assert np.all(np.diff(CELL_IDS) > 0), "CELL_IDS must be strictly ascending (canonical order)"
    assert np.array_equal(CELL_IDS, CELL_ROWS * GRID.width + CELL_COLS)
    assert np.all(ROI_MASK[CELL_ROWS, CELL_COLS])
    lon0, lat0, lon1, lat1 = NCR_SANITY_BBOX
    assert np.all((CELL_LON > lon0) & (CELL_LON < lon1) & (CELL_LAT > lat0) & (CELL_LAT < lat1)), \
        "cell centres outside the NCR sanity box"
    assert (EE_DISTRICTS is None) == (DATA_MODE == "synthetic")
    assert isinstance(DATA_SOURCES, dict) and isinstance(DATA_CAVEATS, list)
    assert isinstance(DATA_MODE_REASON, str) and DATA_MODE_REASON


_validate_study_area()
log("section-1 contract check passed")

# %% [markdown]
# ## 1.9 Study-area figure and district table

# %%
def _s01_save_show(fig, name: str) -> None:
    fig.savefig(CFG.FIG_DIR / name, dpi=110, bbox_inches="tight")
    plt.show()
    plt.close(fig)


_s01_tag = " [SYNTHETIC]" if DATA_MODE == "synthetic" else ""
_s01_extent = [GRID.x0 / 1000, (GRID.x0 + GRID.width * GRID.res) / 1000,
               (GRID.y0 - GRID.height * GRID.res) / 1000, GRID.y0 / 1000]
_s01_counts = np.bincount(DISTRICT_IDX[ROI_MASK].astype(np.int64), minlength=len(DISTRICTS))
_s01_img = np.where(ROI_MASK, DISTRICT_IDX, np.nan).astype(np.float32)
from matplotlib.colors import BoundaryNorm as _S01Norm, ListedColormap as _S01Cmap

# 25 distinct colours (tab20 + 5 of Dark2), interleaved with a stride coprime to 25 so consecutive ids differ in hue
_s01_palette = list(plt.get_cmap("tab20").colors) + list(plt.get_cmap("Dark2").colors[:5])
_s01_cmap = _S01Cmap([_s01_palette[(7 * i) % 25] for i in range(25)])
fig, ax = plt.subplots(figsize=(8.5, 9.5), constrained_layout=True)
ax.imshow(np.ma.masked_invalid(_s01_img), cmap=_s01_cmap, norm=_S01Norm(np.arange(-0.5, 25.5), 25),
          extent=_s01_extent, interpolation="nearest")
for _d in DISTRICTS:
    _sel = (CELL_ROWS[DISTRICT_IDX[CELL_ROWS, CELL_COLS] == _d["id"]],
            CELL_COLS[DISTRICT_IDX[CELL_ROWS, CELL_COLS] == _d["id"]])
    if _sel[0].size:
        _xc = GRID.x0 / 1000 + (np.median(_sel[1]) + 0.5) * GRID.res / 1000
        _yc = GRID.y0 / 1000 - (np.median(_sel[0]) + 0.5) * GRID.res / 1000
        ax.text(_xc, _yc, f"{_d['id']}", ha="center", va="center", fontsize=8, color="white",
                bbox={"boxstyle": "round,pad=0.15", "fc": "black", "alpha": 0.55, "lw": 0})
ax.set_title(f"Delhi NCR study area: {len(DISTRICTS)} districts, {N_CELLS:,} cells @ {GRID.res} m "
             f"(fine grid {GRID_FINE.res} m){_s01_tag}", fontsize=10)
ax.set_xlabel("UTM 43N easting (km)")
ax.set_ylabel("UTM 43N northing (km)")
_s01_save_show(fig, "01_study_area.png")

_S01_DISTRICT_TABLE = pd.DataFrame({
    "id": [d["id"] for d in DISTRICTS], "district": [d["name"] for d in DISTRICTS],
    "state": [d["state"] for d in DISTRICTS], "cells": _s01_counts.astype(int),
    "area_km2": np.round(_s01_counts * GRID.cell_area_km2, 0)}).set_index("id")
print(f"Districts on the analysis grid{_s01_tag} (ROI source: {_S01_ROI_SOURCE})")
_show(_S01_DISTRICT_TABLE)
if (_s01_counts == 0).any():
    log(f"districts without cells (merged or absent in the boundary layer): "
        f"{[DISTRICTS[i]['name'] for i in np.flatnonzero(_s01_counts == 0)]}", "WARNING")
del _s01_img, _s01_counts, _s01_extent, _s01_tag, _s01_palette, _s01_cmap, _d, _sel
free_memory()
