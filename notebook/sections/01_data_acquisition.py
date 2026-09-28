# %% [markdown]
# # 1. Data acquisition
#
# **Study area.** Delhi National Capital Region (NCR): Delhi NCT plus 24 districts of Haryana, Uttar
# Pradesh and Rajasthan (~55,000 km²), delineated from geoBoundaries ADM2 (fallback FAO GAUL 2015 level 2,
# final fallback an approximate NCR outline).
#
# **Grid.** All variables are brought onto one explicit grid in UTM zone 43N (`EPSG:32643`) with square
# cells of `CFG.GRID_RES_M` (1 km default) whose edges are multiples of the cell size. Land cover is
# extracted on a nested fine grid (`CFG.fine_res()`, 25 m in Earth Engine mode) sharing the same origin, so
# every coarse cell contains exactly `f × f` fine pixels (`f = GRID_RES_M / FINE_RES_M`).
#
# | Variable(s) | Source (Earth Engine asset) | Processing |
# |---|---|---|
# | `lst_day_c`, `lst_obs_count` | `MODIS/061/MOD11A2` `LST_Day_1km`, `QC_Day` | QC bits 0–1 ∈ {0,1} and LST-error bits 6–7 ≤ 1 (≤ 2 K); ×0.02 − 273.15; seasonal **median**; number of valid 8-day composites; a cell needs ≥ `CFG.LST_MIN_OBS` (3) valid composites and ≥ `CFG.LST_MIN_COVERAGE` (50 %) valid area, else no target |
# | `ndvi`, `ndwi`, `ndbi` | `MODIS/061/MOD09A1` | StateQA cloud bits 0–1 = 0, shadow bit 2 = 0, internal cloud bit 10 = 0; ×0.0001; NDVI (b2,b1), NDWI McFeeters (b4,b2), NDBI (b6,b2); seasonal median; 500 m → cell mean |
# | `elevation`, `slope`, `aspect_sin`, `aspect_cos` | `USGS/SRTMGL1_003` | `ee.Terrain.products`; aspect sin/cos at 30 m **before** averaging (circular variable); static |
# | `ntl` | `NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG` (≥ 2014), `NOAA/DMSP-OLS/NIGHTTIME_LIGHTS` F18 (2010) | VIIRS annual median of the months with cloud-free coverage (`cf_cvg > 0`) of `avg_rad`, clamp ≥ 0, log1p; DMSP F18 2010 is first intercalibrated to F18 2013 (robust quadratic fit on pseudo-invariant pixels), then mapped into VIIRS log1p space by isotonic regression fitted on DMSP F18 2013 vs the first VIIRS year (2014; VIIRS monthly composites start in January 2014) |
# | `pop_density` | `WorldPop/GP/100m/pop` (≤ 2020), `JRC/GHSL/P2023A/GHS_POP` (2025) | area-exact aggregation of counts → persons/km²; GHS-POP rescaled to the WorldPop-2020 ROI total |
# | land cover (fine) | GLC_FCS30D annual (2010, 2015), ESA WorldCover v100 (2020), Dynamic World V1 annual mode (2025) | remapped to 6 harmonised classes, mode-resampled to the fine grid |
#
# **Temporal design.** Four epochs (2010, 2015, 2020, 2025), each summarised over the pre-monsoon season
# (1 April – 30 June) of that year, when the surface energy balance is dominated by sensible heat and
# vegetation/water contrasts are strongest. Terrain is static.
#
# **Caveats** (also exported in the manifest): land cover comes from three different products (class
# definitions and accuracies differ between epochs); DMSP saturates in urban cores, has no on-board calibration
# (2010 is intercalibrated to 2013 empirically) and is only approximately harmonised with VIIRS; Terra's orbit drifts
# after 2022 (earlier overpass, slightly cooler LST); GHS-POP 2025 is a projection; MODIS LST is a 1 km radiometric
# skin temperature, not air temperature. If both administrative boundary layers fail, districts fall back to an
# approximate outline with nearest-HQ districts and the manifest flags `study_area.boundary_approximate`.
#
# When Earth Engine is not available (and `LST_RUN_MODE` is not `gee`), a **synthetic twin** with the same
# grid, variables, dtypes and a documented *planted* non-linear LST response is generated instead, and every
# downstream artefact is flagged as synthetic.

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

NCR_OUTLINE = [
    (76.45, 29.95), (76.85, 29.95), (77.20, 29.75), (77.55, 29.75), (78.10, 29.55), (78.20, 29.20),
    (78.45, 28.60), (78.45, 28.20), (78.00, 28.05), (77.55, 27.95), (77.55, 27.50), (77.85, 27.20),
    (77.65, 26.75), (77.20, 26.70), (76.90, 27.05), (76.25, 27.05), (76.10, 27.40), (76.20, 27.90),
    (75.95, 28.00), (75.45, 28.40), (75.55, 28.90), (75.85, 29.05), (75.95, 29.55), (76.20, 29.60),
    (76.45, 29.95),
]
YAMUNA = [(77.19, 29.95), (77.13, 29.55), (77.12, 29.20), (77.22, 28.85), (77.25, 28.62), (77.30, 28.45),
          (77.45, 28.20), (77.52, 27.90), (77.68, 27.55)]
GANGA = [(78.03, 29.75), (78.10, 29.30), (78.18, 28.95), (78.32, 28.60), (78.45, 28.30)]
ARAVALLI = [(77.17, 28.62), (77.10, 28.40), (76.85, 28.15), (76.60, 27.80), (76.40, 27.35)]

# Harmonised land-cover classes (SPEC §1)
LC_NODATA, LC_BUILT, LC_FOREST, LC_WATER, LC_CROPLAND, LC_BARREN, LC_OTHER_VEG = 0, 1, 2, 3, 4, 5, 6
LC_CLASS_NAMES = {0: "nodata", 1: "built/impervious", 2: "tree/forest", 3: "water", 4: "cropland",
                  5: "barren/bare", 6: "other vegetation"}
LC_CLASS_COLORS = {0: "#000000", 1: "#e11d48", 2: "#15803d", 3: "#0ea5e9", 4: "#facc15", 5: "#a8a29e",
                   6: "#86efac"}
LC_REMAPS = {
    "esa_worldcover": {10: 2, 20: 6, 30: 6, 40: 4, 50: 1, 60: 5, 70: 6, 80: 3, 90: 6, 95: 2, 100: 6},
    "dynamic_world": {0: 3, 1: 2, 2: 6, 3: 6, 4: 4, 5: 6, 6: 1, 7: 5, 8: 6},
    "glc_fcs30d": {**{c: 4 for c in (10, 11, 12, 20)},
                   **{c: 2 for c in (51, 52, 61, 62, 71, 72, 81, 82, 91, 92)},
                   **{c: 6 for c in (120, 121, 122, 130, 140, 150, 152, 153, *range(181, 188))},
                   190: 1, 200: 5, 201: 5, 202: 5, 210: 3, 220: 6},
}

NODATA_FLOAT = -9999.0     # sentinel written by .unmask() for continuous bands, converted to NaN locally
NODATA_LC = 0              # land-cover nodata class
NODATA_DISTRICT = -1       # DISTRICT_IDX outside the ROI
RAW_BANDS = ["lst_day_c", "lst_obs_count", "ndvi", "ndwi", "ndbi", "elevation", "slope", "aspect_sin",
             "aspect_cos", "ntl", "pop_density"]
TERRAIN_BANDS = ["elevation", "slope", "aspect_sin", "aspect_cos"]
log(f"{len(NCR_DISTRICTS)} canonical districts, {len(RAW_BANDS)} raw bands, LC sources {CFG.LC_SOURCES}")

# %% [markdown]
# ## 1.2 Grid definition (`GridSpec`)
# Coordinates are transformed with `pyproj` (`always_xy=True`: lon, lat order). If pyproj is missing, a
# closed-form transverse-Mercator series (Snyder 1987, USGS PP 1395, eqs. 8-9 … 8-25) is used for UTM
# north zones — accurate to well below a metre inside the zone, far below the 25 m pixel size.

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

    def bounds_lonlat(self) -> list:
        """[min_lon, min_lat, max_lon, max_lat] of the grid rectangle."""
        ring = [(self.x0, self.y0), (self.x0 + self.width * self.res, self.y0),
                (self.x0 + self.width * self.res, self.y0 - self.height * self.res),
                (self.x0, self.y0 - self.height * self.res), (self.x0, self.y0)]
        pts = _densify_ring(ring, 20)
        lon, lat = _grid_xy_to_lonlat(pts[:, 0], pts[:, 1], self.crs)
        return [float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max())]

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


_probe_grid = _outline_grid(CFG.GRID_RES_M)
log(f"NCR outline grid preview: {_probe_grid.width}x{_probe_grid.height} cells of {_probe_grid.res} m, "
    f"lon/lat bounds {np.round(_probe_grid.bounds_lonlat(), 3).tolist()}")
del _probe_grid

# %% [markdown]
# ## 1.3 Earth Engine initialisation and data-mode decision
# Credential order: (1) Kaggle secret `GEE_SERVICE_ACCOUNT_KEY`, or env `LST_GEE_SERVICE_ACCOUNT_KEY` /
# `GOOGLE_APPLICATION_CREDENTIALS` → `ee.ServiceAccountCredentials`; (2) persisted user credentials;
# (3) interactive `ee.Authenticate(auth_mode="notebook")` (live notebooks only). All sessions use the
# **high-volume endpoint**, which is designed for many parallel `computePixels` requests.
# In `auto` mode any failure falls back to the synthetic twin with a loud banner; in `gee` mode it raises.

# %%
_EE_HIGHVOLUME_URL = "https://earthengine-highvolume.googleapis.com"


def _service_account_key_text() -> Optional[str]:
    """Service-account JSON text from Kaggle secrets / env var (JSON or path) / GOOGLE_APPLICATION_CREDENTIALS.

    Logs which source was used (never the key itself) and warns loudly about a value that is set but unusable,
    because silently ignoring it would push the run into interactive OAuth login instead.
    """
    candidates = [("Kaggle secret GEE_SERVICE_ACCOUNT_KEY", _kaggle_secret("GEE_SERVICE_ACCOUNT_KEY")),
                  ("env LST_GEE_SERVICE_ACCOUNT_KEY", _env_str("LST_GEE_SERVICE_ACCOUNT_KEY")),
                  ("env GOOGLE_APPLICATION_CREDENTIALS", _env_str("GOOGLE_APPLICATION_CREDENTIALS"))]
    for source, value in candidates:
        if not value:
            continue
        text = value.strip().strip("'\"").strip()  # tolerate a key pasted inside quotes
        if text.startswith("{"):
            log(f"Earth Engine service-account key found in {source}")
            return text
        path = Path(text).expanduser()
        if path.is_file():
            file_text = path.read_text(encoding="utf-8")
            try:
                if json.loads(file_text).get("type") == "service_account":
                    log(f"Earth Engine service-account key file found via {source}: {path}")
                    return file_text
                log(f"{source} points to {path}, which is not a service-account key; ignoring", "WARNING")
            except json.JSONDecodeError:
                log(f"credential file {path} ({source}) is not valid JSON; ignoring", "WARNING")
            continue
        log(f"{source} is set but is neither JSON nor an existing file. Paste the ENTIRE key file contents "
            "(it starts with '{' and contains \"type\": \"service_account\").", "WARNING")
    if _IS_KAGGLE:
        log("No Earth Engine service-account key found. On Kaggle: Add-ons -> Secrets -> add "
            "GEE_SERVICE_ACCOUNT_KEY and make sure its checkbox is ticked for THIS notebook.", "WARNING")
    return None


def _service_account_hint(message: str) -> str:
    """Map common service-account failures to the setup step that fixes them."""
    low = message.lower()
    if "not signed up" in low or "not registered" in low or "register" in low:
        return ("the Cloud project is not registered for Earth Engine: register it at "
                "https://code.earthengine.google.com/register")
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
    """Initialise Earth Engine on the high-volume endpoint. Returns ``(ok, message)`` and never raises."""
    if ee is None:
        return False, "earthengine-api is not installed"
    project = project or CFG.GEE_PROJECT
    log(f"Earth Engine project: {project or '(not set - will use the key file project_id)'}")
    errors = []
    key_text = _service_account_key_text()
    if key_text:
        # A supplied key is the user's explicit choice: report ITS failure instead of silently falling through to
        # interactive OAuth, whose own errors (e.g. "incompatible OAuth2 Client configuration") hide the real cause.
        email = "?"
        try:
            info = json.loads(key_text)
            email = info["client_email"]
            credentials = ee.ServiceAccountCredentials(email, key_data=key_text)
            use_project = project or info.get("project_id")
            ee.Initialize(credentials, project=use_project, opt_url=_EE_HIGHVOLUME_URL)
            _ee_smoke_test()
            return True, f"service account {email} (project {use_project})"
        except Exception as exc:  # noqa: BLE001 - reported with a remedy below
            detail = f"{type(exc).__name__}: {str(exc)[:400]}"
            hint = _service_account_hint(detail)
            log(f"Service-account login failed for {email}: {detail}\n    Fix: {hint}", "ERROR")
            return False, f"service account {email}: {detail} | fix: {hint}"
    try:
        ee.Initialize(project=project, opt_url=_EE_HIGHVOLUME_URL)
        _ee_smoke_test()
        return True, f"persisted user credentials (project {project})"
    except Exception as exc:  # noqa: BLE001
        errors.append(f"persisted credentials: {type(exc).__name__}: {str(exc)[:300]}")
    if _is_interactive():
        log("Falling back to interactive Earth Engine login (no service-account key). If the login page says "
            "'Project has an incompatible OAuth2 Client configuration', pick (or create) a Cloud project with NO "
            "OAuth 2.0 client IDs for authentication - it may differ from GEE_PROJECT - or, better, use the "
            "GEE_SERVICE_ACCOUNT_KEY secret, which needs no browser login.", "WARNING")
        try:
            ee.Authenticate(auth_mode="notebook")
            ee.Initialize(project=project, opt_url=_EE_HIGHVOLUME_URL)
            _ee_smoke_test()
            return True, f"interactive notebook authentication (project {project})"
        except Exception as exc:  # noqa: BLE001
            errors.append(f"interactive auth: {type(exc).__name__}: {str(exc)[:300]}")
    else:
        errors.append("interactive auth skipped (not a live notebook session)")
    return False, " | ".join(errors)


def _print_synthetic_banner(reason: str) -> None:
    """Impossible-to-miss notice that every number downstream comes from the synthetic twin."""
    bar = "!" * 96
    lines = [
        "SYNTHETIC MODE - RESULTS ARE NOT REAL OBSERVATIONS",
        "Earth Engine data were NOT used. All rasters, models, SHAP values, thresholds and zones below",
        "come from a synthetic twin of Delhi NCR with a PLANTED LST response (see SYNTHETIC_TRUTH).",
        "Use them only to test the pipeline and the dashboard. Every export is flagged data_mode=synthetic.",
        f"Reason: {reason[:260]}",
        "To use real data: attach Kaggle secrets GEE_SERVICE_ACCOUNT_KEY + GEE_PROJECT (or authenticate",
        "interactively) and re-run with LST_RUN_MODE=gee.",
    ]
    print("\n" + bar + "\n" + bar)
    for line in lines:
        print(f"!!!  {line:<88}!!!")
    print(bar + "\n" + bar + "\n", flush=True)


if CFG.RUN_MODE == "synthetic":
    DATA_MODE = "synthetic"
    _MODE_REASON = "LST_RUN_MODE=synthetic"
else:
    _gee_ok, _gee_msg = init_gee()
    if _gee_ok:
        DATA_MODE = "gee"
        _MODE_REASON = f"Earth Engine initialised via {_gee_msg}"
        log(_MODE_REASON)
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
CFG.resolve_mode(DATA_MODE)
if DATA_MODE == "synthetic":
    _print_synthetic_banner(_MODE_REASON)
log(f"DATA_MODE={DATA_MODE} | GRID_RES_M={CFG.GRID_RES_M} | FINE_RES_M={CFG.fine_res()}")

# %% [markdown]
# ## 1.4 Earth Engine: ROI and district matching
# Candidate ADM2 polygons are pulled for the NCR bounding box (attributes + centroid + area only), matched to
# the 25 canonical districts client-side by alias (case/space/diacritic-insensitive) with a bounding-box
# sanity filter, and the matched polygons are tagged with the canonical `did`. Delhi's revenue districts are
# merged into "Delhi NCT". The district raster is produced server-side with `paint()` on the analysis grid.
#
# **Unmatched districts are located, not assumed merged.** For every canonical district still unmatched, the layer
# is queried for the polygon containing its headquarters point: an *unmatched* polygon there (a spelling the alias
# table does not know) is matched by location with a loud warning; a polygon already matched to another district
# means the district is genuinely merged into that parent in this layer (acceptable, SPEC §1.1); no polygon at all is
# reported as an error.

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

    info = retry(lambda: fc.map(_summarise).getInfo(), tries=4, base_delay=3.0, max_delay=60.0)
    records = [{"key": feat["id"], **feat["properties"]} for feat in info.get("features", [])]
    return fc, records


def _gee_hq_hits(fc, dids) -> dict:
    """{did: [system:index of every candidate polygon containing the district's HQ point]} (one server call)."""
    if not dids:
        return {}
    hits = ee.Dictionary({str(did): fc.filterBounds(ee.Geometry.Point(list(NCR_DISTRICTS[did]["hq"])))
                          .aggregate_array("system:index") for did in dids})
    info = retry(lambda: hits.getInfo(), tries=4, base_delay=3.0, max_delay=60.0)
    return {int(k): [str(v) for v in (vals or [])] for k, vals in (info or {}).items()}


def _resolve_unmatched(missing_ids, hq_hits: dict, key_to_did: dict, records_by_key: dict):
    """Classify canonical districts left unmatched by name, using the polygons that contain their HQ point.

    Returns (new_matches {candidate key: did}, messages [(level, text)]). An unmatched polygon at the HQ is matched
    by location (an alias the table does not know); a polygon already matched to another district means the
    district is merged into that parent in this layer; no polygon at all is an error.
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
                                        f"alias table - add it to SPEC §1.1)"))
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
    info = retry(lambda: ee.FeatureCollection(features).getInfo(), tries=4, base_delay=3.0, max_delay=60.0)
    out = []
    for feat in info["features"]:
        props = feat["properties"]
        geometry = feat["geometry"]
        geometry = {"type": geometry["type"], "coordinates": _round_coords(geometry["coordinates"])}
        out.append({"type": "Feature", "geometry": geometry,
                    "properties": {"id": int(props["id"]), "name": props["name"], "state": props["state"]}})
    return {"type": "FeatureCollection", "features": out}


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
# Each tile is an explicit grid request (`crsCode` + `affineTransform` + `dimensions`) returning a structured
# NumPy array. Transient errors (HTTP 429/5xx, "Too many concurrent aggregations", "Earth Engine (memory) capacity
# exceeded", timeouts) are retried with exponential backoff; size/memory errors split the tile into quarters (up to
# depth 3) and are **permanent** once the tile cannot be split further (retrying an identical request that exceeds the
# user memory limit cannot succeed). On the first failure the remaining tiles are cancelled and in-flight tiles stop
# retrying. Every top-level tile is cached as `.npy` under `CFG.CACHE_DIR/tiles/<cache_key>/`, so interrupted runs
# resume; the cache key contains a hash of the serialised Earth Engine expression, so any change of dates, QA rules,
# scale factors, the district mapping or other server-side parameters gets a fresh cache folder.

# %%
_GEE_CACHE_VERSION = "v2"
_GEE_MAX_SPLIT_DEPTH = 3
_GEE_SPLIT_RE = re.compile(r"user memory limit exceeded|computation timed out|too large|request size|"
                           r"response size|out of memory|memory limit", re.IGNORECASE)
_GEE_TIMEOUT_RE = re.compile(r"timed out|deadline", re.IGNORECASE)
_GEE_TRANSIENT_RE = re.compile(r"\b(429|500|502|503|504)\b|too many requests|too many concurrent aggregations|"
                               r"capacity exceeded|"
                               r"quota|rate limit|internal error|service unavailable|backend error|deadline|"
                               r"temporar|connection|reset by peer|timed out|remote end closed|broken pipe|ssl",
                               re.IGNORECASE)


class _GEETransientError(RuntimeError):
    """Retryable Earth Engine failure (quota, 5xx, transient timeouts)."""


class _GEESplitError(RuntimeError):
    """Request too large/slow for one call: subdivide the tile."""


class _GEEAborted(RuntimeError):
    """Another tile of the same request failed permanently: stop retrying this one."""


def _gee_expression_digest(image) -> str:
    """SHA-1 of the serialised Earth Engine expression (captures every server-side parameter).

    Falls back to a random token (cache effectively disabled for that request) if serialisation fails, so a stale
    tile can never be reused under an incomplete key.
    """
    import hashlib
    import uuid

    try:
        text = image.serialize()
    except Exception as exc:  # noqa: BLE001
        log(f"could not serialise the Earth Engine expression ({type(exc).__name__}); tile cache disabled for "
            "this request", "WARNING")
        text = uuid.uuid4().hex
    return hashlib.sha1(str(text).encode("utf-8")).hexdigest()


def _gee_cache_key(name: str, grid: GridSpec, extra: Any = None, image=None) -> str:
    """Stable cache folder name tied to the grid geometry, the request description and (when ``image`` is given)
    the hash of the serialised expression."""
    expr = _gee_expression_digest(image) if image is not None else None
    payload = json.dumps([_GEE_CACHE_VERSION, asdict(grid), extra, expr], sort_keys=True, default=str)
    digest = __import__("hashlib").sha1(payload.encode()).hexdigest()[:10]
    return f"{name}_{grid.res}m_{digest}"


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


def _classify_gee_error(exc: BaseException, allow_split: bool) -> BaseException:
    """Map an Earth Engine exception to split / transient / permanent (returns the exception to raise).

    * size/memory errors split the tile while it can be split; at the maximum depth they are permanent (an
      identical request cannot suddenly fit the per-user memory limit) - except timeouts, which stay retryable;
    * load-related errors (429/5xx, concurrent aggregations, "Earth Engine (memory) capacity exceeded", timeouts,
      connection resets) are transient and retried with backoff;
    * everything else (bad asset, auth, invalid argument) is permanent.
    """
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


def _fetch_tile(image, tile: GridSpec, bands: Sequence[str], dtype, depth: int = 0,
                abort: Optional[threading.Event] = None) -> np.ndarray:
    """Fetch one tile with backoff; quarter it recursively on size/memory errors; stop when ``abort`` is set."""
    can_split = depth < _GEE_MAX_SPLIT_DEPTH and min(tile.width, tile.height) >= 2

    def _on_retry(attempt, exc, delay):
        if abort is not None and abort.is_set():
            raise _GEEAborted("another tile failed; not retrying") from exc
        log(f"computePixels retry {attempt} for {tile.width}x{tile.height} tile in {delay:.1f}s: {str(exc)[:160]}",
            "WARNING")

    if abort is not None and abort.is_set():
        raise _GEEAborted("another tile failed; not fetching")
    try:
        return retry(lambda: _compute_pixels(image, tile, bands, dtype, can_split), tries=CFG.GEE_MAX_RETRIES,
                     base_delay=2.0, max_delay=120.0, retry_on=(_GEETransientError,), on_retry=_on_retry)
    except _GEESplitError as exc:
        log(f"splitting {tile.width}x{tile.height} tile (depth {depth + 1}): {str(exc)[:160]}", "WARNING")
    h1, w1 = tile.height // 2, tile.width // 2
    out = np.empty((len(bands), tile.height, tile.width), dtype=dtype)
    for r0, h in ((0, h1), (h1, tile.height - h1)):
        for c0, w in ((0, w1), (w1, tile.width - w1)):
            out[:, r0:r0 + h, c0:c0 + w] = _fetch_tile(image, tile.tile(r0, c0, h, w), bands, dtype, depth + 1,
                                                       abort)
    return out


def _save_npy_atomic(path: Path, array: np.ndarray) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as fh:
        np.save(fh, array)
    os.replace(tmp, path)


def fetch_grid(image, grid: GridSpec, bands: Sequence[str], tile_px: int, cache_key: str,
               dtype=np.float32) -> np.ndarray:
    """Download ``bands`` of an ee.Image on ``grid`` as a (len(bands), H, W) array.

    Tiles of ``tile_px`` × ``tile_px`` are fetched concurrently (``CFG.GEE_WORKERS`` threads) with retry,
    recursive subdivision and an on-disk cache. For float dtypes the ``NODATA_FLOAT`` sentinel is turned
    into NaN; integer outputs are returned as delivered.
    """
    if ee is None:
        raise RuntimeError("earthengine-api is not available")
    bands, dtype = list(bands), np.dtype(dtype)
    abort = threading.Event()
    cache_dir = CFG.CACHE_DIR / "tiles" / cache_key
    cache_dir.mkdir(parents=True, exist_ok=True)
    tiles = [(r0, c0, min(tile_px, grid.height - r0), min(tile_px, grid.width - c0))
             for r0 in range(0, grid.height, tile_px) for c0 in range(0, grid.width, tile_px)]
    out = np.empty((len(bands), grid.height, grid.width), dtype=dtype)

    def _job(spec):
        r0, c0, h, w = spec
        path = cache_dir / f"r{r0:06d}_c{c0:06d}_{h}x{w}.npy"
        if path.exists():
            try:
                cached = np.load(path)
                if cached.shape == (len(bands), h, w):
                    return spec, cached.astype(dtype, copy=False), True
            except (OSError, ValueError) as exc:
                log(f"ignoring unreadable cache tile {path.name}: {exc}", "WARNING")
        arr = _fetch_tile(image, grid.tile(r0, c0, h, w), bands, dtype, abort=abort)
        _save_npy_atomic(path, arr)
        return spec, arr, False

    n_done, n_cached, step = 0, 0, max(1, len(tiles) // 10)
    pool = ThreadPoolExecutor(max_workers=max(1, min(CFG.GEE_WORKERS, len(tiles))), thread_name_prefix="ee")
    futures = [pool.submit(_job, t) for t in tiles]
    try:
        for future in as_completed(futures):
            (r0, c0, h, w), arr, cached = future.result()
            out[:, r0:r0 + h, c0:c0 + w] = arr
            n_done += 1
            n_cached += int(cached)
            if n_done % step == 0 or n_done == len(tiles):
                log(f"  {cache_key}: {n_done}/{len(tiles)} tiles ({n_cached} from cache)")
    except BaseException:
        # Fail fast: cancel queued tiles, tell in-flight ones to stop retrying, and do not wait for them.
        abort.set()
        pool.shutdown(wait=False, cancel_futures=True)
        raise
    pool.shutdown(wait=True)
    if dtype.kind == "f":
        out[out == NODATA_FLOAT] = np.nan
    return out


# %% [markdown]
# ## 1.6 Earth Engine: per-epoch predictor images
# Every variable is composited in its **native** projection, then aggregated to the analysis grid with an
# area-weighted `reduceResolution` (mean) followed by `reproject` onto the exact grid transform. Composites
# lose their native projection in Earth Engine, so it is restored with `setDefaultProjection` before
# aggregation. Population counts are converted to densities (count / pixel area) **before** the area-weighted
# mean, which makes the aggregate exactly "persons in cell / cell area" (a weighted `sum` reducer would
# weight by output-area fraction and mis-scale counts).

# %%
_NATIVE_SCALE_M = {"modis_lst": 926.625, "modis_sr": 463.313, "srtm": 30.0, "viirs": 463.83, "dmsp": 927.67,
                   "worldpop": 80.0, "ghs_pop": 100.0, "glc_fcs30d": 30.0, "esa_worldcover": 10.0,
                   "dynamic_world": 10.0}


def _season_dates(year: int):
    """[start, end) date strings for the pre-monsoon season of ``year`` (end exclusive, +1 day)."""
    start = f"{year}-{CFG.SEASON[0]}"
    end = (pd.Timestamp(f"{year}-{CFG.SEASON[1]}") + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    return start, end


def _to_grid(image, native_scale_m: float, grid: GridSpec, reducer=None):
    """Aggregate ``image`` (with a valid default projection) onto ``grid``.

    Coarsening uses reduceResolution with ``maxPixels`` sized to the scale ratio (≥ 1024); refining or
    equal scales use a plain reprojection (nearest neighbour).
    """
    if native_scale_m < grid.res * 0.999:
        ratio = (grid.res / native_scale_m) ** 2
        max_pixels = int(min(65535, max(1024, math.ceil(ratio * 2.5))))
        image = image.reduceResolution(reducer=reducer or ee.Reducer.mean(), bestEffort=False, maxPixels=max_pixels)
    return image.reproject(crs=grid.crs, crsTransform=grid.transform_list())


def _gee_lst_bands(year: int, grid: GridSpec):
    """Seasonal median day LST (°C), count of valid 8-day composites, and the masked native median (preview).

    A native pixel needs >= CFG.LST_MIN_OBS valid composites; a grid cell's LST is kept only where >=
    CFG.LST_MIN_COVERAGE of its area has such pixels (reduceResolution's mean is mask-weighted, so without this a
    small valid sliver would stand for the whole cell).
    """
    start, end = _season_dates(year)
    col = ee.ImageCollection("MODIS/061/MOD11A2").filterDate(start, end)
    native = col.first().select("LST_Day_1km").projection()

    def _prep(img):
        qc = img.select("QC_Day")
        good = qc.bitwiseAnd(3).lte(1).And(qc.rightShift(6).bitwiseAnd(3).lte(1))
        return img.select("LST_Day_1km").multiply(0.02).subtract(273.15).updateMask(good).rename("lst_day_c")

    lst_col = col.map(_prep)
    count_native = lst_col.count().rename("lst_obs_count")
    enough = count_native.gte(int(CFG.LST_MIN_OBS))
    median = lst_col.median().rename("lst_day_c").updateMask(enough).setDefaultProjection(native)
    count = count_native.unmask(0).toFloat().setDefaultProjection(native)
    coverage = median.mask().gt(0).unmask(0).toFloat().rename("coverage").setDefaultProjection(native)
    scale = _NATIVE_SCALE_M["modis_lst"]
    lst_grid = _to_grid(median, scale, grid)
    cov_grid = _to_grid(coverage, scale, grid)
    lst_grid = lst_grid.updateMask(cov_grid.gte(float(CFG.LST_MIN_COVERAGE)))
    prov = (f"MODIS/061/MOD11A2 LST_Day_1km {start}..{CFG.SEASON[1]} QC bits0-1<=1 & bits6-7<=1, "
            f"x0.02-273.15, seasonal median (pixels with >= {CFG.LST_MIN_OBS} valid composites, cells with >= "
            f"{100 * CFG.LST_MIN_COVERAGE:.0f}% valid area), mean-aggregated to {grid.res} m")
    provenance = {"lst_day_c": prov,
                  "lst_obs_count": (f"MODIS/061/MOD11A2 LST_Day_1km {start}..{CFG.SEASON[1]} count of QC-valid "
                                    f"8-day composites, mean-aggregated to {grid.res} m")}
    return [lst_grid, _to_grid(count, scale, grid)], provenance, median


def _gee_spectral_bands(year: int, grid: GridSpec):
    """Seasonal median NDVI / NDWI (McFeeters) / NDBI from cloud-screened MOD09A1."""
    start, end = _season_dates(year)
    col = ee.ImageCollection("MODIS/061/MOD09A1").filterDate(start, end)
    native = col.first().select("sur_refl_b01").projection()

    def _prep(img):
        qa = img.select("StateQA")
        clear = (qa.bitwiseAnd(3).eq(0)
                 .And(qa.rightShift(2).bitwiseAnd(1).eq(0))
                 .And(qa.rightShift(10).bitwiseAnd(1).eq(0)))
        refl = img.select(["sur_refl_b01", "sur_refl_b02", "sur_refl_b04", "sur_refl_b06"]).multiply(0.0001)
        ndvi = refl.normalizedDifference(["sur_refl_b02", "sur_refl_b01"]).rename("ndvi")
        ndwi = refl.normalizedDifference(["sur_refl_b04", "sur_refl_b02"]).rename("ndwi")
        ndbi = refl.normalizedDifference(["sur_refl_b06", "sur_refl_b02"]).rename("ndbi")
        return ee.Image.cat([ndvi, ndwi, ndbi]).clamp(-1, 1).updateMask(clear)

    median = col.map(_prep).median().setDefaultProjection(native)
    scale = _NATIVE_SCALE_M["modis_sr"]
    images = [_to_grid(median.select(b), scale, grid) for b in ("ndvi", "ndwi", "ndbi")]
    prov = (f"MODIS/061/MOD09A1 {start}..{CFG.SEASON[1]} StateQA clear (bits0-1=0, bit2=0, bit10=0), x0.0001, "
            "seasonal median of {idx}, mean-aggregated 500 m -> grid")
    return images, {b: prov.format(idx=b.upper()) for b in ("ndvi", "ndwi", "ndbi")}


def _gee_terrain_image(grid: GridSpec):
    """Static SRTM terrain: elevation, slope and aspect sin/cos (computed at 30 m before averaging)."""
    dem = ee.Image("USGS/SRTMGL1_003").select("elevation")
    terrain = ee.Terrain.products(dem)
    aspect = terrain.select("aspect").multiply(math.pi / 180.0)
    stack = ee.Image.cat([dem.toFloat().rename("elevation"), terrain.select("slope").toFloat().rename("slope"),
                          aspect.sin().rename("aspect_sin"), aspect.cos().rename("aspect_cos")])
    scale = _NATIVE_SCALE_M["srtm"]
    bands = [_to_grid(stack.select(b), scale, grid) for b in TERRAIN_BANDS]
    return ee.Image.cat(bands).unmask(NODATA_FLOAT).toFloat()


def _gee_viirs_log(years_to_try: Sequence[int], grid: GridSpec):
    """log1p of the annual median VIIRS avg_rad (clamped ≥ 0) for the first year with data; (image, prov)."""
    for coll_id in ("NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG", "NOAA/VIIRS/DNB/MONTHLY_V1/VCMCFG"):
        for year in years_to_try:
            raw = ee.ImageCollection(coll_id).filterDate(f"{year}-01-01", f"{year + 1}-01-01")
            n_months = retry(lambda: raw.size().getInfo(), tries=4, base_delay=2.0, max_delay=30.0)
            if not n_months:
                continue
            native = raw.first().select("avg_rad").projection()
            # Months without any cloud-free observation (monsoon) report unobserved radiances: mask them first.
            col = raw.map(lambda img: img.select("avg_rad").updateMask(img.select("cf_cvg").gt(0)))
            image = col.median().max(0).add(1).log().rename("ntl").setDefaultProjection(native)
            prov = (f"{coll_id} avg_rad {year} median of the {n_months} monthly composites where cf_cvg > 0 "
                    "(months without cloud-free coverage masked), clamp>=0, log1p")
            return _to_grid(image, _NATIVE_SCALE_M["viirs"], grid), prov, year
    raise RuntimeError(f"no VIIRS monthly composites found for years {list(years_to_try)}")


def _gee_dmsp(year: int, grid: GridSpec):
    """DMSP-OLS F18 stable_lights (F18 exists for 2010-2013; other years use the nearest F18 year, which
    `_validate_epochs` has already reported as a caveat)."""
    f18_year = int(min(max(year, 2010), 2013))
    image = ee.Image(f"NOAA/DMSP-OLS/NIGHTTIME_LIGHTS/F18{f18_year}").select("stable_lights").toFloat()
    return _to_grid(image, _NATIVE_SCALE_M["dmsp"], grid), f18_year


def _density_image(counts, native_proj, factor: float = 1.0):
    """Population counts -> persons/km² in the native projection (count / pixel area × 1e6)."""
    area = ee.Image.pixelArea().reproject(native_proj)
    return counts.divide(area).multiply(1e6 * factor).setDefaultProjection(native_proj)


def _gee_worldpop(year: int):
    if not 2000 <= int(year) <= 2020:
        raise ValueError(f"WorldPop/GP/100m/pop covers 2000-2020, not {year}")
    col = (ee.ImageCollection("WorldPop/GP/100m/pop").filter(ee.Filter.eq("country", "IND"))
           .filter(ee.Filter.eq("year", year)).select("population"))
    native = col.first().projection()
    return col.mosaic().setDefaultProjection(native), native


def _gee_ghs_pop(epoch: int):
    image = ee.Image(f"JRC/GHSL/P2023A/GHS_POP/{epoch}").select("population_count")
    return image, image.projection()


def _gee_roi_total(image, roi_geom) -> float:
    """Population total inside the ROI in the image's native projection (area-weighted sum)."""
    result = image.reduceRegion(reducer=ee.Reducer.sum(), geometry=roi_geom, maxPixels=1e13, tileScale=4,
                                bestEffort=True)
    values = retry(lambda: result.getInfo(), tries=4, base_delay=3.0, max_delay=60.0)
    value = next(iter(values.values()), None) if values else None
    if value is None:
        raise RuntimeError("reduceRegion returned no population total")
    return float(value)


def _ghs_scale_factor(roi_geom, grid: GridSpec, worldpop_2020_grid: Optional[np.ndarray], roi_mask) -> tuple:
    """WorldPop-2020 / GHS-POP-2020 ROI totals, used to put GHS-POP projections on the WorldPop scale."""
    try:
        wp_img, _ = _gee_worldpop(2020)
        ghs_img, _ = _gee_ghs_pop(2020)
        factor = _gee_roi_total(wp_img, roi_geom) / _gee_roi_total(ghs_img, roi_geom)
        how = "reduceRegion(sum) over ROI, native projections"
    except Exception as exc:  # noqa: BLE001 - fall back to the already-aggregated grids
        log(f"reduceRegion population totals failed ({str(exc)[:160]}); using grid totals", "WARNING")
        ghs_img, ghs_proj = _gee_ghs_pop(2020)
        ghs_image = (_to_grid(_density_image(ghs_img, ghs_proj), _NATIVE_SCALE_M["ghs_pop"], grid)
                     .rename("pop").unmask(NODATA_FLOAT).toFloat())
        ghs_grid = fetch_grid(ghs_image, grid, ["pop"], CFG.GEE_TILE_PX,
                              _gee_cache_key("ghs2020", grid, image=ghs_image), np.float32)[0]
        if worldpop_2020_grid is None:
            raise RuntimeError("GHS-POP scaling needs the WorldPop 2020 grid (add 2020 to EPOCHS)") from exc
        factor = float(np.nansum(worldpop_2020_grid[roi_mask]) / np.nansum(ghs_grid[roi_mask]))
        how = "ratio of grid totals over ROI cells"
    if not 0.3 <= factor <= 3.0:
        log(f"GHS-POP scale factor {factor:.3f} looks implausible", "WARNING")
    return factor, how


def _gee_population_band(year: int, grid: GridSpec, ghs_factor: Optional[tuple]):
    """Population density (persons/km²) band + provenance."""
    if year <= 2020:
        counts, native = _gee_worldpop(year)
        prov = f"WorldPop/GP/100m/pop IND {year}, count/pixelArea, area-weighted mean -> persons/km2"
        return _to_grid(_density_image(counts, native), _NATIVE_SCALE_M["worldpop"], grid), prov
    epoch = int(min(2030, max(2025, 5 * round(year / 5))))
    counts, native = _gee_ghs_pop(epoch)
    factor, how = ghs_factor
    prov = (f"JRC/GHSL/P2023A/GHS_POP/{epoch} (projection) x {factor:.4f} (WorldPop2020/GHS2020 ROI totals, {how}), "
            "count/pixelArea, area-weighted mean -> persons/km2")
    return _to_grid(_density_image(counts, native, factor), _NATIVE_SCALE_M["ghs_pop"], grid), prov


def _gee_epoch_image(year: int, grid: GridSpec, ghs_factor: Optional[tuple]):
    """Multi-band per-epoch image (everything except terrain and, before 2014, night lights)."""
    images, prov = [], {}
    lst_imgs, lst_prov, lst_preview = _gee_lst_bands(year, grid)
    images += lst_imgs
    prov.update(lst_prov)
    spec_imgs, spec_prov = _gee_spectral_bands(year, grid)
    images += spec_imgs
    prov.update(spec_prov)
    pop_img, prov["pop_density"] = _gee_population_band(year, grid, ghs_factor)
    images.append(pop_img.rename("pop_density"))
    bands = ["lst_day_c", "lst_obs_count", "ndvi", "ndwi", "ndbi", "pop_density"]
    if year >= 2014:
        ntl_img, prov["ntl"], used_year = _gee_viirs_log(list(range(year, 2013, -1)), grid)
        images.append(ntl_img.rename("ntl"))
        bands.append("ntl")
        if used_year != year:
            log(f"VIIRS {year} unavailable, used {used_year}", "WARNING")
    image = ee.Image.cat(images).rename(bands).unmask(NODATA_FLOAT).toFloat()
    return image, bands, prov, lst_preview


_DMSP_SATURATED_DN = 63


def dmsp_intercalibration(src: np.ndarray, ref: np.ndarray, *, keep: float = 0.8, n_iter: int = 6,
                          min_pixels: int = 200):
    """Robust DN(src year) -> DN(reference year) intercalibration of two DMSP-OLS composites.

    DMSP-OLS has no on-board calibration: the gain of the same satellite drifts from year to year, so raw DN of
    different years are not comparable. Following the invariant-region idea (Elvidge et al. 2009; Wu et al. 2013), a
    quadratic DN_ref = a + b DN_src + c DN_src² is fitted on pixels lit and unsaturated in both years; each iteration
    keeps the ``keep`` share of pixels with the smallest absolute residuals, so pixels whose lighting really changed
    (urban growth) drop out and the fit follows the pseudo-invariant majority. A non-monotone quadratic falls back to
    a linear fit. Returns (coefficients highest power first, info) or (None, info) when too few pixels overlap.
    """
    src, ref = np.asarray(src, dtype=np.float64), np.asarray(ref, dtype=np.float64)
    ok = (np.isfinite(src) & np.isfinite(ref) & (src > 0) & (ref > 0)
          & (src < _DMSP_SATURATED_DN) & (ref < _DMSP_SATURATED_DN))
    info = {"n_pixels": int(ok.sum())}
    if ok.sum() < min_pixels:
        return None, info
    x, y = src[ok], ref[ok]
    sel = np.ones(x.size, dtype=bool)
    coef = np.polyfit(x, y, 2)
    for _ in range(n_iter):   # trimmed least squares: refit on the `keep` share of ALL pixels closest to the fit
        coef = np.polyfit(x[sel], y[sel], 2)
        resid = np.abs(y - np.polyval(coef, x))
        sel = resid <= np.quantile(resid, keep)
    grid = np.linspace(0.0, float(_DMSP_SATURATED_DN), 64)
    if np.any(np.diff(np.polyval(coef, grid)) <= 0):
        lin = np.polyfit(x[sel], y[sel], 1)
        coef = np.array([0.0, lin[0], lin[1]])
        info["fallback"] = "linear (quadratic not monotone on 0..63)"
    info.update({"n_invariant": int(sel.sum()), "coef": [float(c) for c in coef],
                 "r": float(np.corrcoef(np.polyval(coef, x[sel]), y[sel])[0, 1])})
    return coef, info


def apply_dmsp_intercalibration(dn: np.ndarray, coef) -> np.ndarray:
    """Map DN with the intercalibration polynomial; dark pixels (DN 0) stay 0, the result is clipped to 0..63."""
    dn = np.asarray(dn, dtype=np.float64)
    out = np.full(dn.shape, np.nan)
    valid = np.isfinite(dn)
    out[valid] = np.clip(np.polyval(coef, dn[valid]), 0.0, float(_DMSP_SATURATED_DN))
    out[valid & (dn <= 0)] = 0.0
    return out


def _gee_calibrated_dmsp(years: Sequence[int], grid: GridSpec, roi_mask: np.ndarray):
    """DMSP -> VIIRS-log1p calibration; returns ({year: (H,W) float32}, provenance, caveats).

    Step 1 intercalibrates each DMSP year to F18 2013 (``dmsp_intercalibration``); step 2 maps F18-2013 DN into VIIRS
    log1p space with an isotonic regression fitted on DMSP F18 2013 vs the first VIIRS year (2014: the monthly VIIRS
    composites start in January 2014, so the "overlap" is a one-year offset).
    """
    from sklearn.isotonic import IsotonicRegression

    dmsp_cal, cal_year = _gee_dmsp(2013, grid)
    viirs_cal, viirs_prov, viirs_year = _gee_viirs_log([2013, 2014, 2015], grid)
    images, bands = [dmsp_cal.rename("dmsp_cal"), viirs_cal.rename("viirs_cal")], ["dmsp_cal", "viirs_cal"]
    used = {}
    for year in years:
        img, used[year] = _gee_dmsp(year, grid)
        images.append(img.rename(f"dmsp_{year}"))
        bands.append(f"dmsp_{year}")
    stack_image = ee.Image.cat(images).rename(bands).unmask(NODATA_FLOAT).toFloat()
    stack = fetch_grid(stack_image, grid, bands, CFG.GEE_TILE_PX,
                       _gee_cache_key("ntl_calibration", grid, bands, image=stack_image), np.float32)
    x, y = stack[0][roi_mask], stack[1][roi_mask]
    ok = np.isfinite(x) & np.isfinite(y)
    if ok.sum() < 100:
        raise RuntimeError(f"only {ok.sum()} valid DMSP/VIIRS overlap pixels for isotonic calibration")
    iso = IsotonicRegression(increasing=True, out_of_bounds="clip").fit(x[ok], y[ok])
    r = np.corrcoef(iso.predict(x[ok]), y[ok])[0, 1]
    log(f"DMSP F18 {cal_year} -> VIIRS {viirs_year} isotonic calibration on {ok.sum():,} ROI cells (r={r:.3f})")
    out, prov, caveats = {}, {}, []
    for i, year in enumerate(years):
        dmsp = stack[2 + i].astype(np.float64)
        inter_txt = ""
        if used[year] != cal_year:
            coef, info = dmsp_intercalibration(dmsp[roi_mask], stack[0][roi_mask])
            if coef is None:
                log(f"DMSP F18 {used[year]} -> F18 {cal_year} intercalibration impossible ({info['n_pixels']} "
                    "overlapping lit pixels); using raw DN", "WARNING")
                inter_txt = f"NOT intercalibrated to F18{cal_year} (too few overlapping lit pixels), "
                caveats.append(f"DMSP F18 {used[year]} could not be intercalibrated to F18 {cal_year}: its night "
                               "lights carry the uncalibrated inter-year gain difference.")
            else:
                dmsp = apply_dmsp_intercalibration(dmsp, coef)
                log(f"DMSP F18 {used[year]} -> F18 {cal_year} intercalibration: DN' = "
                    f"{coef[0]:.5f} DN² + {coef[1]:.4f} DN + {coef[2]:.3f} on {info['n_invariant']:,} "
                    f"pseudo-invariant of {info['n_pixels']:,} lit pixels (r={info['r']:.3f})"
                    + (f" [{info['fallback']}]" if "fallback" in info else ""))
                inter_txt = (f"intercalibrated to F18{cal_year} (robust quadratic on {info['n_invariant']} "
                             f"pseudo-invariant pixels, r={info['r']:.3f}), ")
        mapped = np.full(dmsp.shape, np.nan, dtype=np.float32)
        valid = np.isfinite(dmsp)
        mapped[valid] = iso.predict(dmsp[valid]).astype(np.float32)
        out[year] = mapped
        prov[year] = (f"NOAA/DMSP-OLS/NIGHTTIME_LIGHTS F18{used[year]} stable_lights "
                      + (f"[nearest available F18 year to {year}] " if used[year] != year else "")
                      + f"{inter_txt}mapped to VIIRS log1p space by isotonic regression fitted on DMSP "
                      f"F18{cal_year} vs {viirs_prov} (first VIIRS year {viirs_year}; ROI, r={r:.3f})")
    return out, prov, caveats


# %% [markdown]
# ## 1.7 Earth Engine: fine land cover
# Each product is remapped to the six harmonised classes in its native grid, then brought to the fine grid:
# majority (`mode`) aggregation when coarsening (10 m → 25 m), nearest neighbour when refining (30 m → 25 m).
# GLC_FCS30D "annual" is an ImageCollection of ~5°×5° tiles with one band per year (`b1` = 2000 … `b23` = 2022);
# the band is resolved from the tile's actual band list at run time.

# %%
_GLC_ANNUAL = "projects/sat-io/open-datasets/GLC-FCS30D/annual"


def _remap(image, source: str):
    table = LC_REMAPS[source]
    return image.remap(list(table.keys()), list(table.values()), 0).rename("lc")


def _gee_landcover_image(source: str, year: int, roi_geom, fine_grid: GridSpec):
    """Harmonised fine land cover for one epoch as a uint8 ee.Image (band 'lc'), plus provenance."""
    if source == "glc_fcs30d":
        col = ee.ImageCollection(_GLC_ANNUAL).filterBounds(roi_geom)
        band_names = retry(lambda: col.first().bandNames().getInfo(), tries=4, base_delay=2.0, max_delay=30.0)
        band_year = int(min(max(year, 2000), 2000 + len(band_names) - 1))
        band = f"b{band_year - 1999}" if f"b{band_year - 1999}" in band_names else band_names[band_year - 2000]
        if len(band_names) != 23:
            log(f"GLC_FCS30D tiles expose {len(band_names)} bands (expected 23 for 2000-2022)", "WARNING")
        native = col.first().select(band).projection()
        classes = _remap(col.select(band).mosaic(), source).setDefaultProjection(native)
        prov = f"{_GLC_ANNUAL} band {band} (= {band_year}), remapped to harmonised classes"
        if band_year != year:
            prov += f" [nearest available year to {year}]"
    elif source == "esa_worldcover":
        image = ee.ImageCollection("ESA/WorldCover/v100").first().select("Map")
        classes = _remap(image, source).setDefaultProjection(image.projection())
        prov = "ESA/WorldCover/v100 (2020) Map, remapped to harmonised classes"
    elif source == "dynamic_world":
        col = (ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1").filterBounds(roi_geom)
               .filterDate(f"{year}-01-01", f"{year + 1}-01-01").select("label"))
        mode = col.reduce(ee.Reducer.mode()).rename("label")
        classes = _remap(mode, source).setDefaultProjection(ee.Projection(CFG.CRS).atScale(10))
        prov = f"GOOGLE/DYNAMICWORLD/V1 label, annual mode {year}, remapped to harmonised classes"
    else:
        raise ValueError(f"unknown land-cover source {source!r}")
    native_scale = _NATIVE_SCALE_M[source]
    if native_scale < fine_grid.res * 0.999:
        ratio = (fine_grid.res / native_scale) ** 2
        classes = classes.reduceResolution(reducer=ee.Reducer.mode(), bestEffort=False,
                                           maxPixels=int(max(1024, math.ceil(ratio * 2.5))))
        prov += f", mode-aggregated to {fine_grid.res} m"
    else:
        prov += f", nearest-neighbour to {fine_grid.res} m"
    image = classes.reproject(crs=fine_grid.crs, crsTransform=fine_grid.transform_list()).unmask(0).toUint8()
    return image.rename("lc"), prov


def _default_lc_source(year: int) -> str:
    return CFG.LC_SOURCES.get(year) or ("glc_fcs30d" if year <= 2022 else "dynamic_world")


# %% [markdown]
# ## 1.8 Earth Engine: orchestration
# ROI → grid → district raster → static terrain → per-epoch stacks → DMSP calibration → fine land cover.

# %%
_GEE_PREVIEW: dict = {}


def _gee_build_roi(res: int):
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
        return {"source": asset, "fc": roi_fc, "geom": roi_fc.geometry(100), "boundary": boundary,
                "grid": grid, "area_km2": area, "local_districts": None}
    log("No administrative boundary source usable; falling back to the approximate NCR outline + "
        "nearest-HQ (Voronoi) districts", "WARNING")
    grid = _outline_grid(res)
    roi_mask, district_idx, boundary = _outline_districts(grid)
    geom = ee.Geometry.Polygon([list(p) for p in NCR_OUTLINE], None, False)
    return {"source": "approximate NCR outline (SPEC §1.2) with Voronoi districts", "fc": None, "geom": geom,
            "boundary": boundary, "grid": grid, "area_km2": float(roi_mask.sum() * grid.cell_area_km2),
            "local_districts": (roi_mask, district_idx)}


def _validate_epochs(epochs: Sequence[int]) -> list:
    """Check CFG.EPOCHS against each source's availability; raise for impossible years, return caveats otherwise.

    MODIS MOD11A2/MOD09A1 start in 2000; population needs WorldPop (2000-2020) or GHS-POP (2025/2030 epochs); DMSP
    F18 exists for 2010-2013 only, so a pre-VIIRS year outside that range uses the nearest F18 year (caveat).
    """
    caveats = []
    this_year = datetime.now().year
    for year in epochs:
        year = int(year)
        if year < 2000 or year > this_year:
            raise ValueError(f"epoch {year}: MODIS LST/reflectance (MOD11A2/MOD09A1) exist from 2000 to the present")
        if year > 2030:
            raise ValueError(f"epoch {year}: no population source (GHS-POP P2023A projections end in 2030)")
        if year < 2014 and not 2010 <= year <= 2013:
            msg = (f"epoch {year}: DMSP-OLS F18 covers 2010-2013 only; night lights use F18 "
                   f"{min(max(year, 2010), 2013)} [nearest available year], intercalibrated to 2013")
            log(msg, "WARNING")
            caveats.append(msg + ".")
        if 2020 < year < 2025:
            msg = (f"epoch {year}: population uses the GHS-POP {int(min(2030, max(2025, 5 * round(year / 5))))} "
                   "projection [nearest epoch]")
            log(msg, "WARNING")
            caveats.append(msg + ".")
    return caveats


def acquire_gee_dataset() -> dict:
    """Run the complete Earth Engine extraction; returns the section-1 globals as a dict (plus GRID, CAVEATS)."""
    caveats = _validate_epochs(CFG.EPOCHS)
    res = CFG.GRID_RES_M
    roi = _gee_build_roi(res)
    grid = roi["grid"]
    log(f"GEE grid: {grid.width}x{grid.height} cells @ {res} m, origin ({grid.x0:.0f}, {grid.y0:.0f}) {grid.crs}")
    if roi["local_districts"] is None:
        paint = ee.Image.constant(NODATA_DISTRICT).toInt16().paint(roi["fc"], "did").toInt16().rename("did")
        district_idx = fetch_grid(paint, grid, ["did"], CFG.GEE_TILE_PX,
                                  _gee_cache_key("districts", grid, roi["source"], image=paint), np.int16)[0]
        roi_mask = district_idx >= 0
    else:
        roi_mask, district_idx = roi["local_districts"]
        caveats.append("District boundaries are APPROXIMATE (nearest-HQ Voronoi partition of the SPEC §1.2 outline): "
                       "the administrative boundary layers (geoBoundaries, FAO GAUL) were unavailable, so district "
                       "names and per-district statistics describe approximate areas.")
    log(f"ROI: {int(roi_mask.sum()):,} cells = {roi_mask.sum() * grid.cell_area_km2:,.0f} km2 ({roi['source']})")

    sources: dict = {b: {} for b in RAW_BANDS}
    sources["land_cover"], sources["roi"] = {}, {}
    terrain_image = _gee_terrain_image(grid)
    terrain = fetch_grid(terrain_image, grid, TERRAIN_BANDS, CFG.GEE_TILE_PX,
                         _gee_cache_key("terrain", grid, image=terrain_image), np.float32)
    terrain_prov = f"USGS/SRTMGL1_003 via ee.Terrain.products, 30 m, aspect sin/cos before averaging, mean to {res} m"

    stacks, ghs_factor = {}, None
    for year in CFG.EPOCHS:
        if year > 2020 and ghs_factor is None:
            wp2020 = stacks.get(2020, {}).get("pop_density")
            ghs_factor = _ghs_scale_factor(roi["geom"], grid, wp2020, roi_mask)
            log(f"GHS-POP scale factor = {ghs_factor[0]:.4f} ({ghs_factor[1]})")
        with timer(f"01 GEE stack {year}"):
            image, bands, prov, lst_preview = _gee_epoch_image(year, grid, ghs_factor)
            arr = fetch_grid(image, grid, bands, CFG.GEE_TILE_PX,
                             _gee_cache_key(f"epoch{year}", grid, bands, image=image), np.float32)
        stacks[year] = {b: arr[i] for i, b in enumerate(bands)}
        for i, b in enumerate(TERRAIN_BANDS):
            stacks[year][b] = terrain[i].copy()
            sources[b][year] = terrain_prov
        for b, text in prov.items():
            sources[b][year] = text
        if year == CFG.EPOCHS[-1]:
            # masked native-resolution median clipped to the ROI (EE pyramids it natively; no -9999 fill)
            _GEE_PREVIEW["lst"] = lst_preview.clip(roi["geom"])
        del arr

    pre_viirs = [y for y in CFG.EPOCHS if y < 2014]
    if pre_viirs:
        with timer("01 GEE DMSP calibration"):
            mapped, prov, dmsp_caveats = _gee_calibrated_dmsp(pre_viirs, grid, roi_mask)
        caveats.extend(dmsp_caveats)
        for year in pre_viirs:
            stacks[year]["ntl"] = mapped[year]
            sources["ntl"][year] = prov[year]

    for year in CFG.EPOCHS:
        for b in RAW_BANDS:
            band = stacks[year][b].astype(np.float32, copy=False)
            band[~roi_mask] = np.nan
            stacks[year][b] = band
        stacks[year] = {b: stacks[year][b] for b in RAW_BANDS}
        sources["roi"][year] = roi["source"]

    fine_res = CFG.fine_res()
    fine_grid = grid.fine(fine_res)
    f = grid.res // fine_res
    lc_fine = {}
    for year in CFG.EPOCHS:
        source = _default_lc_source(year)
        with timer(f"01 GEE land cover {year} ({source})"):
            image, prov = _gee_landcover_image(source, year, roi["geom"], fine_grid)
            lc = fetch_grid(image, fine_grid, ["lc"], CFG.GEE_FINE_TILE_PX,
                            _gee_cache_key(f"lc{year}_{source}", fine_grid, image=image), np.uint8)[0]
        _mask_fine_inplace(lc, roi_mask, f)
        lc_fine[year] = lc
        sources["land_cover"][year] = prov
        shares = np.bincount(lc.ravel(), minlength=7)[1:] / max(1, int((lc > 0).sum()))
        log(f"  LC {year}: " + ", ".join(f"{LC_CLASS_NAMES[c].split('/')[0]} {100 * s:.1f}%"
                                          for c, s in zip(range(1, 7), shares)))
    if roi["fc"] is not None:
        _GEE_PREVIEW["roi"] = roi["fc"]
    return {"GRID": grid, "ROI_MASK": roi_mask, "DISTRICT_IDX": district_idx.astype(np.int16),
            "BOUNDARY_GEOJSON": roi["boundary"], "RAW_STACKS": stacks, "LC_FINE": lc_fine,
            "SYNTHETIC_TRUTH": None, "DATA_SOURCES": sources, "CAVEATS": caveats,
            "BOUNDARY_APPROXIMATE": roi["local_districts"] is not None}


# %% [markdown]
# ## 1.9 Synthetic twin (fallback / offline development)
# A physically-plausible stand-in with the same grid, globals and dtypes as the Earth Engine path:
#
# * **ROI & districts** — the approximate NCR outline, partitioned into the 25 districts by nearest
#   headquarters (a Voronoi partition in UTM metres, identical for the raster and the GeoJSON).
# * **Geography** — a gently N→SE sloping plain (180–260 m) plus a Gaussian Aravalli ridge whose relief grows
#   from ~300 m at the Delhi ridge to ~650 m near Alwar; slope/aspect from finite differences.
# * **Urbanisation** — Gaussian kernels at 20 real urban centres combined as a probabilistic union; radii grow
#   12–18 % per 5-year epoch (Gurugram, Noida, Greater Noida and Manesar fastest). Built-up area only grows.
# * **Land cover** (fine grid) — rivers (Yamuna, Ganga) as narrow channels with sand bars and riparian
#   vegetation, random ponds, ridge forest and rocky foothills, arid barren land in SW Haryana/Rajasthan,
#   parks inside cities, villages, cropland elsewhere; texture from spatially-correlated noise that is shared
#   by all epochs (temporal coherence).
# * **Predictors** — NDVI/NDWI/NDBI as mixtures of class signatures (pre-monsoon: harvested wheat is bare-ish,
#   the western-UP sugarcane belt stays green) + noise; log1p night lights and population from urban intensity.
# * **LST** — an explicitly *planted* non-linear response (saturating NDVI cooling, exponential water-cooling
#   reach, impervious power law and an impervious × low-NDVI interaction) plus spatially-correlated and white
#   noise; recorded in `SYNTHETIC_TRUTH` so section 4 can check whether SHAP recovers it.

# %%
_SYN_URBAN_CENTRES = [
    # name, lon, lat, amplitude, 2010 radius (km), radius growth per 5-year epoch
    ("Delhi", 77.20, 28.63, 1.00, 13.0, 0.12), ("Gurugram", 77.03, 28.46, 0.90, 6.0, 0.18),
    ("Noida", 77.36, 28.57, 0.90, 5.0, 0.18), ("Greater Noida", 77.50, 28.47, 0.70, 4.0, 0.18),
    ("Ghaziabad", 77.44, 28.67, 0.85, 5.5, 0.14), ("Faridabad", 77.31, 28.40, 0.85, 5.5, 0.13),
    ("Meerut", 77.71, 28.98, 0.80, 5.0, 0.12), ("Sonipat", 77.02, 28.99, 0.65, 3.0, 0.14),
    ("Panipat", 76.97, 29.39, 0.70, 3.5, 0.13), ("Karnal", 76.99, 29.69, 0.65, 3.5, 0.12),
    ("Rohtak", 76.61, 28.90, 0.70, 3.5, 0.12), ("Bahadurgarh", 76.92, 28.69, 0.60, 2.5, 0.15),
    ("Manesar", 76.93, 28.36, 0.60, 2.5, 0.18), ("Rewari", 76.62, 28.19, 0.60, 2.5, 0.12),
    ("Alwar", 76.60, 27.55, 0.70, 3.5, 0.12), ("Bharatpur", 77.49, 27.22, 0.65, 3.0, 0.12),
    ("Bulandshahr", 77.85, 28.40, 0.60, 2.5, 0.12), ("Muzaffarnagar", 77.70, 29.47, 0.65, 3.0, 0.12),
    ("Hapur", 77.78, 28.73, 0.60, 2.5, 0.13), ("Bhiwani", 76.13, 28.79, 0.60, 3.0, 0.12),
]
_SYN_LST_BASE_C = 43.0
_SYN_EPOCH_OFFSETS = {2010: 0.4, 2015: -0.3, 2020: -0.9, 2025: 0.7}
# The planted NDVI saturation must lie INSIDE the simulated NDVI distribution (pre-monsoon NDVI of this twin has
# median ~0.21 and p99 ~0.42): a threshold above the data support cannot be recovered by any estimator, which would
# make the planted-vs-recovered check in section 4 meaningless. 0.28 sits near the 85th percentile.
_SYN_NDVI_SAT, _SYN_WATER_SCALE, _SYN_IMP_EXP = 0.28, 0.08, 0.8
_SYN_COEF = {"frac_barren": 4.0, "frac_cropland": 1.2, "frac_impervious_pow": 2.5, "impervious_x_lowndvi": 1.5,
             "ndvi_cooling": -5.0, "water_cooling": -3.5, "ndbi": 1.5, "elevation_lapse_per_m": -0.006,
             "ntl": 0.25}
# missing_fraction: LST gaps (cells dropped from DF); spectral_missing_fraction: cloud-masked MOD09A1 gaps in
# NDVI/NDWI/NDBI (kept as NaN predictors, exercising the NaN-handling paths of every model and export).
_SYN_NOISE = {"spatial_sd": 0.7, "spatial_corr_km": 8.0, "white_sd": 0.4, "missing_fraction": 0.005,
              "spectral_missing_fraction": 0.003}
_SYN_LST_FORMULA = (
    f"lst = base(43.0) + offset[year] + 4.0*frac_barren + 1.2*frac_cropland + 2.5*frac_impervious**0.8 "
    f"+ 1.5*frac_impervious*(ndvi<0.2) - 5.0*clip(ndvi,0,{_SYN_NDVI_SAT})/{_SYN_NDVI_SAT} "
    f"- 3.5*(1-exp(-frac_water/0.08)) + 1.5*ndbi - 0.006*(elevation-220) + 0.25*ntl "
    f"+ N_spatial(sd 0.7, ~8 km) + N_white(sd 0.4)")
# class signatures (pre-monsoon) of the spectral indices, order: built, forest, water, crop, barren, other
_SYN_SIGNATURES = {"ndvi": (0.10, 0.52, -0.12, 0.22, 0.10, 0.33),
                   "ndwi": (-0.10, -0.42, 0.30, -0.22, -0.12, -0.33),
                   "ndbi": (0.12, -0.22, -0.40, 0.06, 0.16, -0.08)}


def _syn_rng(seed: int, *tags: int) -> np.random.Generator:
    """Independent, reproducible random stream per (seed, tags) - stable regardless of call order."""
    return np.random.default_rng(np.random.SeedSequence([int(seed), *[int(t) for t in tags]]))


def _correlated_noise(shape, sigma_px: float, rng: np.random.Generator) -> np.ndarray:
    """Zero-mean, unit-variance Gaussian random field with correlation length ≈ ``sigma_px`` pixels.

    Large kernels are synthesised on a coarser lattice and bilinearly upsampled (identical statistics
    at a fraction of the cost of filtering a full-resolution field).
    """
    h, w = shape
    if sigma_px < 0.5:
        return rng.standard_normal(shape, dtype=np.float32)
    k = max(1, int(sigma_px // 3))
    small = rng.standard_normal((-(-h // k) + 1, -(-w // k) + 1), dtype=np.float32)
    small = ndimage.gaussian_filter(small, sigma_px / k, mode="reflect")
    field = _upsample(small, k)[:h, :w]
    field -= field.mean()
    field /= field.std() + 1e-12
    return field


def _interp_axis(a: np.ndarray, f: int, axis: int) -> np.ndarray:
    """Linear interpolation of cell-centred samples onto an f-times finer grid along one axis (edges clamped)."""
    n = a.shape[axis]
    pos = np.clip((np.arange(n * f) + 0.5) / f - 0.5, 0.0, n - 1)
    i0 = np.floor(pos).astype(np.intp)
    i1 = np.minimum(i0 + 1, n - 1)
    shape = [1] * a.ndim
    shape[axis] = -1
    weight = (pos - i0).astype(np.float32).reshape(shape)
    lo = np.take(a, i0, axis=axis)
    return lo + (np.take(a, i1, axis=axis) - lo) * weight


def _upsample(field: np.ndarray, f: int) -> np.ndarray:
    """Bilinear upsampling of a cell-centred field by an integer factor (pixel-edge aligned, float32).

    Equivalent to ``ndimage.zoom(order=1, grid_mode=True, mode="nearest")`` but separable and ~5x faster.
    """
    field = field.astype(np.float32, copy=f == 1)
    if f == 1:
        return field
    return _interp_axis(_interp_axis(field, f, 0), f, 1)


def _polyline_distance_position(xs: np.ndarray, ys: np.ndarray, line_xy: np.ndarray, chunk_rows: int = 256):
    """Distance (m) from every grid point (xs[j], ys[i]) to a polyline and the along-line position (0..1).

    Works row-chunk by row-chunk in float32 on coordinates relative to the grid origin (precision ~cm).
    """
    ox, oy = float(xs[0]), float(ys[0])
    xr = (xs - ox).astype(np.float32)[None, :]
    a = (line_xy[:-1] - (ox, oy)).astype(np.float32)
    b = (line_xy[1:] - (ox, oy)).astype(np.float32)
    seg_len = np.hypot(*(b - a).T)
    cum = np.concatenate([[0.0], np.cumsum(seg_len)]) / max(seg_len.sum(), 1e-9)
    dist = np.empty((len(ys), len(xs)), np.float32)
    pos = np.empty_like(dist)
    for r0 in range(0, len(ys), chunk_rows):
        yr = (ys[r0:r0 + chunk_rows] - oy).astype(np.float32)[:, None]
        best = np.full((len(yr), len(xs)), np.inf, np.float32)
        best_pos = np.zeros_like(best)
        for i in range(len(a)):
            (ax, ay), (dx, dy) = a[i], b[i] - a[i]
            t = np.clip(((xr - ax) * dx + (yr - ay) * dy) / max(dx * dx + dy * dy, 1e-9), 0.0, 1.0)
            d2 = (xr - ax - t * dx) ** 2 + (yr - ay - t * dy) ** 2
            closer = d2 < best
            best = np.where(closer, d2, best)
            best_pos = np.where(closer, cum[i] + t * (cum[i + 1] - cum[i]), best_pos)
        dist[r0:r0 + chunk_rows] = np.sqrt(best)
        pos[r0:r0 + chunk_rows] = best_pos
    return dist, pos


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
    d2 = (x[..., None] - hq_xy[:, 0]) ** 2 + (y[..., None] - hq_xy[:, 1]) ** 2
    district_idx = np.argmin(d2, axis=-1).astype(np.int16)
    district_idx[~roi_mask] = NODATA_DISTRICT
    boundary = _voronoi_boundary_geojson(hq_xy, outline_xy, district_idx, grid)
    return roi_mask, district_idx, boundary


def _syn_geography(grid: GridSpec, lon: np.ndarray, lat: np.ndarray, seed: int) -> dict:
    """Static coarse fields: elevation, slope, aspect sin/cos, ridge proximity, aridity."""
    xs, ys = grid.x_centers(), grid.y_centers()
    ridge_d, ridge_t = _polyline_distance_position(xs, ys, _lonlat_array_to_xy(ARAVALLI))
    relief = 80.0 + 470.0 * ridge_t ** 1.3                       # ~300 m a.s.l. at Delhi ridge, ~650 m near Alwar
    width = 3000.0 + 7000.0 * ridge_t
    undulation = 0.75 + 0.25 * np.tanh(_correlated_noise(grid.shape, 6000.0 / grid.res, _syn_rng(seed, 1)))
    ridge = relief * undulation * np.exp(-0.5 * (ridge_d / width) ** 2)
    plain = np.clip(205.0 + 22.0 * (lat - 28.3) - 12.0 * (lon - 77.2), 180.0, 260.0)
    elevation = plain + ridge + 2.0 * _correlated_noise(grid.shape, 1.5, _syn_rng(seed, 2))
    dz_row, dz_col = np.gradient(elevation, grid.res)
    gx, gy_north = dz_col, -dz_row                               # rows run southwards
    slope = np.degrees(np.arctan(np.hypot(gx, gy_north)))
    aspect = np.arctan2(-gx, -gy_north)                          # direction the slope faces, clockwise from north
    ridge_prox = np.exp(-0.5 * (ridge_d / (1.3 * width)) ** 2) * np.clip(relief / 300.0, 0.3, 1.0)
    aridity = 1.0 / (1.0 + np.exp(-((76.5 - lon) + (28.3 - lat)) / 0.35))
    return {"elevation": elevation.astype(np.float32), "slope": slope.astype(np.float32),
            "aspect_sin": np.sin(aspect).astype(np.float32), "aspect_cos": np.cos(aspect).astype(np.float32),
            "ridge_prox": ridge_prox.astype(np.float32), "aridity": aridity.astype(np.float32)}


def _syn_urban_intensity(grid: GridSpec, year: int) -> np.ndarray:
    """Probabilistic union of Gaussian urban kernels with epoch-dependent radii (0..1)."""
    x, y = grid.cell_centers_xy()
    centres = _lonlat_array_to_xy([(c[1], c[2]) for c in _SYN_URBAN_CENTRES])
    steps = (year - 2010) / 5.0
    not_urban = np.ones(grid.shape, np.float64)
    for (name, _, _, amp, r_km, growth), (cx, cy) in zip(_SYN_URBAN_CENTRES, centres):
        radius = r_km * 1000.0 * (1.0 + growth) ** steps
        not_urban *= 1.0 - amp * np.exp(-0.5 * ((x - cx) ** 2 + (y - cy) ** 2) / radius**2)
    return (1.0 - not_urban).astype(np.float32)


def _polyline_distance_capped(xs: np.ndarray, ys: np.ndarray, line_xy: np.ndarray, cap_m: float) -> np.ndarray:
    """Distance (m) to a polyline, exact up to ``cap_m`` and clipped to ``cap_m`` beyond.

    Only the window around each segment (its bounding box grown by ``cap_m``) is evaluated, so the cost scales
    with the river length rather than with the size of the fine grid (~100x faster than a full transform).
    ``xs`` must increase and ``ys`` decrease (north-up grid).
    """
    dist = np.full((len(ys), len(xs)), cap_m, np.float32)
    neg_ys = -ys
    for (ax, ay), (bx, by) in zip(line_xy[:-1], line_xy[1:]):
        c0 = int(np.searchsorted(xs, min(ax, bx) - cap_m))
        c1 = int(np.searchsorted(xs, max(ax, bx) + cap_m, side="right"))
        r0 = int(np.searchsorted(neg_ys, -(max(ay, by) + cap_m)))
        r1 = int(np.searchsorted(neg_ys, -(min(ay, by) - cap_m), side="right"))
        if c0 >= c1 or r0 >= r1:
            continue
        xw = (xs[c0:c1] - ax).astype(np.float32)[None, :]
        yw = (ys[r0:r1] - ay).astype(np.float32)[:, None]
        dx, dy = float(bx - ax), float(by - ay)
        t = np.clip((xw * dx + yw * dy) / max(dx * dx + dy * dy, 1e-9), 0.0, 1.0)
        window = dist[r0:r1, c0:c1]
        np.minimum(window, np.sqrt((xw - t * dx) ** 2 + (yw - t * dy) ** 2), out=window)
    return dist


def _syn_lakes(grid: GridSpec, fine: GridSpec, roi_mask: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Random elliptical ponds / jheels (~1 per 150 km² of ROI, 150-700 m semi-axes) on the fine grid."""
    f = grid.res // fine.res
    lakes = np.zeros(fine.shape, bool)
    roi_cells = np.flatnonzero(roi_mask)
    n_lakes = max(8, int(roi_cells.size * grid.cell_area_km2 / 150.0))
    for cell in rng.choice(roi_cells, size=min(n_lakes, roi_cells.size), replace=False):
        r, c = divmod(int(cell), grid.width)
        cy, cx = (r + rng.random()) * f, (c + rng.random()) * f             # fine-pixel coordinates
        ry, rx = rng.uniform(150, 700) / fine.res, rng.uniform(150, 700) / fine.res
        r0, r1 = max(0, int(cy - ry) - 1), min(fine.height, int(cy + ry) + 2)
        c0, c1 = max(0, int(cx - rx) - 1), min(fine.width, int(cx + rx) + 2)
        yy, xx = np.mgrid[r0:r1, c0:c1]
        lakes[r0:r1, c0:c1] |= ((yy + 0.5 - cy) / max(ry, 0.5)) ** 2 + ((xx + 0.5 - cx) / max(rx, 0.5)) ** 2 <= 1.0
    return lakes


def _syn_static_fine(grid: GridSpec, fine: GridSpec, geo: dict, roi_mask: np.ndarray, seed: int) -> dict:
    """Epoch-independent fine-resolution layers (shared noise => temporally coherent land cover).

    Returns the "rural" base map (cropland / other vegetation / barren / forest, before urbanisation and water),
    the static part of the built-up score, park/lawn candidates, village seeds and the water mask. Rules are
    applied in order, later rules overriding earlier ones.
    """
    fr, f = fine.res, grid.res // fine.res
    xs, ys = fine.x_centers(), fine.y_centers()
    cap = 4000.0
    meander = 120.0 * _correlated_noise(fine.shape, 800.0 / fr, _syn_rng(seed, 10))
    d_yam = _polyline_distance_capped(xs, ys, _lonlat_array_to_xy(YAMUNA), cap)
    d_gan = _polyline_distance_capped(xs, ys, _lonlat_array_to_xy(GANGA), cap)
    river_rel = np.minimum((d_yam + meander) / 170.0, (d_gan + meander) / 320.0)   # in channel half-widths
    river_m = np.minimum(d_yam, d_gan)
    del d_yam, d_gan, meander

    tex = _correlated_noise(fine.shape, 250.0 / fr, _syn_rng(seed, 12))        # field-scale texture
    patch = _correlated_noise(fine.shape, 1500.0 / fr, _syn_rng(seed, 13))     # landscape-scale patches
    ridge = _upsample(geo["ridge_prox"], f)
    base = np.full(fine.shape, LC_CROPLAND, np.uint8)
    base[0.6 * patch + 0.4 * tex > 0.72] = LC_OTHER_VEG                                  # grass / fallow / shrub
    base[(river_m < 3000) & (0.5 * patch + 0.5 * tex > 0.6)] = LC_OTHER_VEG             # floodplain grassland
    base[_upsample(geo["aridity"], f) + 0.45 * patch + 0.2 * tex > 1.25] = LC_BARREN    # SW Haryana / Rajasthan
    base[(ridge > 0.25) & (ridge + 0.35 * patch > 0.85)] = LC_BARREN                    # rocky foothills
    base[(river_rel > 1.0) & (river_rel < 1.0 + 700.0 / 170.0) & (tex > 0.3)] = LC_BARREN   # sand bars / riverbed
    base[ridge + 0.3 * tex > 0.75] = LC_FOREST                                          # Aravalli scrub forest
    base[(river_m < 1500) & (tex > 1.0)] = LC_FOREST                                    # riparian trees
    base[tex > 2.1] = LC_FOREST                                                          # groves / farm forestry
    del ridge

    park = _correlated_noise(fine.shape, 150.0 / fr, _syn_rng(seed, 14))
    static = {
        "base": base,
        "built_noise": (0.22 * tex + 0.10 * patch).astype(np.float32),
        "village": _correlated_noise(fine.shape, 120.0 / fr, _syn_rng(seed, 15)),
        "park": park > 1.9,
        "lawn": (park > 1.5) & (park <= 1.9),
        "water": (river_rel < 1.0) | _syn_lakes(grid, fine, roi_mask, _syn_rng(seed, 11)),
    }
    del tex, patch, park, river_rel, river_m
    return static


def _syn_landcover(static: dict, urban_fine: np.ndarray, roi_mask: np.ndarray, f: int,
                   previous_built: Optional[np.ndarray], epoch_step: float) -> np.ndarray:
    """Epoch land cover (uint8 1..6, 0 outside ROI): rural base + urbanisation + urban green + water."""
    urban_core = urban_fine > 0.35
    if previous_built is not None:
        urban_core &= ~previous_built                                          # urbanisation is irreversible
    parks = urban_core & static["park"]
    lawns = urban_core & static["lawn"]
    built = (urban_fine + static["built_noise"] > 0.45) | (static["village"] > 2.35 - 0.05 * epoch_step)
    built &= ~(parks | lawns)
    if previous_built is not None:
        built |= previous_built
    lc = static["base"].copy()
    lc[built] = LC_BUILT
    lc[lawns] = LC_OTHER_VEG
    lc[parks] = LC_FOREST
    lc[static["water"]] = LC_WATER
    _mask_fine_inplace(lc, roi_mask, f)
    return lc


def _lc_block_fractions(lc: np.ndarray, f: int) -> np.ndarray:
    """(H, W, 6) fractions of classes 1..6 inside each f×f block (0 where the block is nodata)."""
    h, w = lc.shape[0] // f, lc.shape[1] // f
    block_of_row = (np.arange(lc.shape[0]) // f) * w
    block_of_col = np.arange(lc.shape[1]) // f
    key = (block_of_row[:, None] + block_of_col[None, :]) * 7 + lc          # (block id, class) -> one integer
    counts = np.bincount(key.ravel(), minlength=h * w * 7).reshape(h, w, 7)
    return (counts[..., 1:] / float(f * f)).astype(np.float32)


def _syn_epoch_stack(year: int, step: float, fracs: np.ndarray, urban: np.ndarray, geo: dict, lon, lat,
                     roi_mask: np.ndarray, static_lst_noise: np.ndarray, grid: GridSpec, seed: int) -> dict:
    """All 1 km bands for one epoch from land-cover fractions, urban intensity and geography."""
    shape = grid.shape
    rng = _syn_rng(seed, 100, year)
    corr = lambda km, tag: _correlated_noise(shape, km * 1000.0 / grid.res, _syn_rng(seed, 200 + tag, year))  # noqa: E731
    imp, forest, water, crop, barren, other = (fracs[..., i] for i in range(6))

    signatures = {k: np.tensordot(fracs, np.asarray(v, np.float32), axes=([-1], [0])) for k, v in _SYN_SIGNATURES.items()}
    sugarcane = 1.0 / (1.0 + np.exp(-((lon - 77.45) / 0.12))) * 1.0 / (1.0 + np.exp(-((lat - 28.75) / 0.12)))
    crop_green = crop * (0.12 * sugarcane + 0.04 * corr(15, 1))                 # green sugarcane belt, irrigation
    ndvi = signatures["ndvi"] + crop_green + 0.035 * corr(5, 2) + 0.015 * rng.standard_normal(shape) - 0.01 * step
    ndwi = signatures["ndwi"] - 0.6 * crop_green + 0.03 * corr(5, 3) + 0.015 * rng.standard_normal(shape)
    ndbi = signatures["ndbi"] - 0.5 * crop_green + 0.03 * corr(5, 4) + 0.015 * rng.standard_normal(shape)
    ndvi, ndwi, ndbi = (np.clip(a, -1.0, 1.0) for a in (ndvi, ndwi, ndbi))

    radiance = (0.25 + 70.0 * urban ** 1.4 + 12.0 * imp) * (1.0 + 0.1 * step) * np.exp(0.15 * corr(10, 5))
    ntl = np.clip(np.log1p(radiance) + 0.05 * rng.standard_normal(shape), 0.0, 5.2)
    rural = 380.0 * 1.05 ** step * np.exp(0.3 * corr(12, 6))
    pop = np.clip((rural + 32000.0 * urban ** 3.0 + 1500.0 * imp) * (1.0 - water), 0.0, 40000.0)

    epoch_noise = corr(_SYN_NOISE["spatial_corr_km"], 7)
    spatial = _SYN_NOISE["spatial_sd"] * (np.sqrt(0.6) * static_lst_noise + np.sqrt(0.4) * epoch_noise)
    lst = (_SYN_LST_BASE_C + _SYN_EPOCH_OFFSETS.get(year, 0.0)
           + _SYN_COEF["frac_barren"] * barren + _SYN_COEF["frac_cropland"] * crop
           + _SYN_COEF["frac_impervious_pow"] * imp ** _SYN_IMP_EXP
           + _SYN_COEF["impervious_x_lowndvi"] * imp * (ndvi < 0.2)
           + _SYN_COEF["ndvi_cooling"] * np.clip(ndvi, 0.0, _SYN_NDVI_SAT) / _SYN_NDVI_SAT
           + _SYN_COEF["water_cooling"] * (1.0 - np.exp(-water / _SYN_WATER_SCALE))
           + _SYN_COEF["ndbi"] * ndbi + _SYN_COEF["elevation_lapse_per_m"] * (geo["elevation"] - 220.0)
           + _SYN_COEF["ntl"] * ntl + spatial + _SYN_NOISE["white_sd"] * rng.standard_normal(shape))
    obs_count = np.clip(np.rint(10.2 + 1.3 * corr(20, 8) + 0.7 * rng.standard_normal(shape)), 5, 12)

    missing = roi_mask & (rng.random(shape) < _SYN_NOISE["missing_fraction"])
    lst[missing] = np.nan
    obs_count[missing] = 0.0
    # Cloud-masked reflectance gaps hit the three indices together (same MOD09A1 composite); the planted LST above
    # was computed from the true indices, as a real surface would not care whether the satellite saw it.
    spectral_gap = roi_mask & (rng.random(shape) < _SYN_NOISE["spectral_missing_fraction"])
    for band in (ndvi, ndwi, ndbi):
        band[spectral_gap] = np.nan
    stack = {"lst_day_c": lst, "lst_obs_count": obs_count, "ndvi": ndvi, "ndwi": ndwi, "ndbi": ndbi,
             "elevation": geo["elevation"], "slope": geo["slope"], "aspect_sin": geo["aspect_sin"],
             "aspect_cos": geo["aspect_cos"], "ntl": ntl, "pop_density": pop}
    out = {}
    for band in RAW_BANDS:
        arr = np.array(stack[band], dtype=np.float32, copy=True)
        arr[~roi_mask] = np.nan
        out[band] = arr
    return out


def _synthetic_truth(epochs: Sequence[int], seed: int, lst_means: dict) -> dict:
    """Machine-readable description of the planted LST response (for SHAP-recovery checks in section 4)."""
    return {
        "generator": "delhi-ncr-synthetic-v1", "seed": int(seed), "formula": _SYN_LST_FORMULA,
        "lst_base_c": _SYN_LST_BASE_C,
        "epoch_offsets": {int(y): float(_SYN_EPOCH_OFFSETS.get(y, 0.0)) for y in epochs},
        "epoch_roi_mean_lst": {int(y): float(v) for y, v in lst_means.items()},
        "coefficients": dict(_SYN_COEF),
        "ndvi_saturation": _SYN_NDVI_SAT,
        "water_cooling_scale": _SYN_WATER_SCALE, "water_scale": _SYN_WATER_SCALE,
        "impervious_exponent": _SYN_IMP_EXP,
        "interaction": {"features": ["frac_impervious", "ndvi"], "coefficient": 1.5, "ndvi_below": 0.2,
                        "description": "extra warming of impervious surface where NDVI < 0.2"},
        # Values are expressed in the SPEC 4.4 threshold definitions so section 4 can compare like with like:
        # * ndvi: piecewise-linear cooling, slope exactly 0 above the saturation -> saturation = _SYN_NDVI_SAT;
        # * frac_water: -3.5 (1 - exp(-w / s)) has slope (3.5 / s) exp(-w / s); SPEC "saturation" is where |slope|
        #   drops below 10 % of its maximum (at w = 0), i.e. w = s ln 10 (95 % of the effect is reached at 3 s).
        "planted_thresholds": {
            "ndvi": {"saturation": _SYN_NDVI_SAT, "direction": "cooling"},
            "frac_water": {"saturation": round(_SYN_WATER_SCALE * math.log(10.0), 4), "e_folding": _SYN_WATER_SCALE,
                           "effect_95pct_at": round(3 * _SYN_WATER_SCALE, 4), "direction": "cooling"},
            "frac_impervious": {"exponent": _SYN_IMP_EXP, "direction": "warming"},
            "frac_barren": {"direction": "warming"}, "frac_cropland": {"direction": "warming"},
            "ndbi": {"direction": "warming"}, "elevation": {"direction": "cooling"}, "ntl": {"direction": "warming"},
        },
        "noise": dict(_SYN_NOISE),
        "irrelevant_by_construction": ["slope", "aspect_sin", "aspect_cos", "log_pop", "frac_forest", "lm_pd",
                                       "lm_ed", "lm_contag"],
        "note": "Features not in the formula act only through correlation with planted drivers.",
    }


def generate_synthetic_dataset(grid: GridSpec, fine_res: int, epochs: Sequence[int], seed: int) -> dict:
    """Build the synthetic twin; returns the section-1 globals (same keys/dtypes as the Earth Engine path)."""
    if grid.res % fine_res:
        raise ValueError(f"fine_res {fine_res} must divide grid res {grid.res}")
    f = grid.res // fine_res
    fine = grid.fine(fine_res)
    if fine.width * fine.height > 60_000_000:
        log(f"synthetic fine grid is large ({fine.width}x{fine.height}); expect high memory use", "WARNING")
    t0 = time.perf_counter()
    lon, lat = grid.lonlat()
    roi_mask, district_idx, boundary = _outline_districts(grid)
    geo = _syn_geography(grid, lon, lat, seed)
    static = _syn_static_fine(grid, fine, geo, roi_mask, seed)
    static_lst_noise = _correlated_noise(grid.shape, _SYN_NOISE["spatial_corr_km"] * 1000.0 / grid.res, _syn_rng(seed, 3))
    log(f"synthetic static fields ready in {time.perf_counter() - t0:.1f}s (fine grid {fine.width}x{fine.height})")

    stacks, lc_fine, previous_built, lst_means = {}, {}, None, {}
    for year in epochs:
        step = (year - 2010) / 5.0
        urban = _syn_urban_intensity(grid, year)
        lc = _syn_landcover(static, _upsample(urban, f), roi_mask, f, previous_built, step)
        previous_built = lc == LC_BUILT
        fracs = _lc_block_fractions(lc, f)
        stacks[year] = _syn_epoch_stack(year, step, fracs, urban, geo, lon, lat, roi_mask, static_lst_noise, grid, seed)
        lc_fine[year] = lc
        lst_means[year] = float(np.nanmean(stacks[year]["lst_day_c"][roi_mask]))
        del urban, fracs
    del static, previous_built

    desc = f"SYNTHETIC twin (seed={seed}, generator delhi-ncr-synthetic-v1)"
    sources = {b: {y: f"{desc}: {b}" for y in epochs} for b in RAW_BANDS}
    sources["lst_day_c"] = {y: f"{desc}: planted response {_SYN_LST_FORMULA}" for y in epochs}
    sources["land_cover"] = {y: f"{desc}: rule-based land cover at {fine_res} m" for y in epochs}
    sources["roi"] = {y: "approximate NCR outline (SPEC §1.2) with nearest-HQ (Voronoi) districts" for y in epochs}
    log(f"synthetic dataset generated in {time.perf_counter() - t0:.1f}s")
    return {"ROI_MASK": roi_mask, "DISTRICT_IDX": district_idx, "BOUNDARY_GEOJSON": boundary,
            "RAW_STACKS": stacks, "LC_FINE": lc_fine, "SYNTHETIC_TRUTH": _synthetic_truth(epochs, seed, lst_means),
            "DATA_SOURCES": sources}


# %% [markdown]
# ## 1.10 Run the acquisition
# Earth Engine first when available. In `auto` mode an extraction failure falls back to the synthetic twin (with
# the banner) **only when no service-account key was supplied**: with a key the user clearly wants real data, so the
# error is raised instead of silently replacing hours of extraction by synthetic output (re-running resumes from the
# tile cache).

# %%
_ACQ = None
if DATA_MODE == "gee":
    try:
        with timer("01 GEE acquisition"):
            _ACQ = acquire_gee_dataset()
        GRID = _ACQ.pop("GRID")
    except Exception as _exc:  # noqa: BLE001 - auto mode must not crash
        if CFG.RUN_MODE == "gee" or _service_account_key_text():
            if CFG.RUN_MODE != "gee":
                log("Earth Engine extraction failed although a service-account key was supplied; stopping instead "
                    "of falling back to synthetic data (set LST_RUN_MODE=synthetic to force the synthetic twin)",
                    "ERROR")
            raise
        log(f"Earth Engine extraction failed: {type(_exc).__name__}: {_exc}", "ERROR")
        DATA_MODE = "synthetic"
        CFG.resolve_mode(DATA_MODE)
        _MODE_REASON = f"Earth Engine extraction failed: {type(_exc).__name__}: {str(_exc)[:300]}"
        _print_synthetic_banner(_MODE_REASON)
        _ACQ = None
if DATA_MODE == "synthetic":
    GRID = _outline_grid(CFG.GRID_RES_M)
    with timer("01 synthetic dataset"):
        _ACQ = generate_synthetic_dataset(GRID, CFG.fine_res(), CFG.EPOCHS, CFG.SEED)

# Why this data mode was used (exported as manifest.data_mode_reason; the dashboard banner shows it).
DATA_MODE_REASON = str(_MODE_REASON)
ROI_MASK = _ACQ["ROI_MASK"]
DISTRICT_IDX = _ACQ["DISTRICT_IDX"]
BOUNDARY_GEOJSON = _ACQ["BOUNDARY_GEOJSON"]
RAW_STACKS = _ACQ["RAW_STACKS"]
LC_FINE = _ACQ["LC_FINE"]
SYNTHETIC_TRUTH = _ACQ["SYNTHETIC_TRUTH"]
DATA_SOURCES = _ACQ["DATA_SOURCES"]
# True when district boundaries are the approximate outline + nearest-HQ partition (synthetic mode, or GEE mode
# after both boundary layers failed); exported as manifest.study_area.boundary_approximate.
BOUNDARY_APPROXIMATE = bool(_ACQ.get("BOUNDARY_APPROXIMATE", DATA_MODE == "synthetic"))
# Caveats for the manifest "notes" (kept separate so DATA_SOURCES stays strictly variable -> {year: provenance}).
DATA_CAVEATS = [
    "Land cover comes from different products per epoch (GLC_FCS30D, ESA WorldCover, Dynamic World); "
    "class definitions and accuracies differ, so part of the land-cover change is product inconsistency.",
    "DMSP-OLS (2010) saturates in urban cores and has no on-board calibration: 2010 DN are intercalibrated to "
    "F18 2013 with a robust fit on pseudo-invariant pixels and then mapped to VIIRS log radiance by an isotonic "
    "regression fitted on DMSP 2013 vs VIIRS 2014; both steps are approximate, so 2010-vs-later night-light "
    "differences should not be over-read.",
    "Terra's orbit drifts after 2022 (earlier overpass), biasing 2025 MODIS day LST slightly low.",
    "GHS-POP 2025 is a model projection rescaled to WorldPop 2020, not a census estimate.",
] + list(_ACQ.get("CAVEATS") or []) + (
    ["SYNTHETIC DATA: every variable is simulated from a planted response; see SYNTHETIC_TRUTH."]
    if DATA_MODE == "synthetic" else [])
for _caveat in DATA_CAVEATS:
    log(f"caveat: {_caveat}")
del _ACQ
log(f"GRID {GRID.width}x{GRID.height} @ {GRID.res} m | ROI {int(ROI_MASK.sum()):,} cells "
    f"({ROI_MASK.sum() * GRID.cell_area_km2:,.0f} km2) | fine {CFG.fine_res()} m | mode {DATA_MODE}")

# %% [markdown]
# ## 1.11 Contract check
# Verifies the section-1 interface (SPEC §3) so downstream sections can rely on shapes and dtypes.

# %%
def _validate_acquisition() -> None:
    """Raise AssertionError with a precise message if any section-1 global violates the contract."""
    h, w = GRID.shape
    f = GRID.res // CFG.fine_res()
    assert DATA_MODE in ("gee", "synthetic"), DATA_MODE
    assert ROI_MASK.shape == (h, w) and ROI_MASK.dtype == bool, (ROI_MASK.shape, ROI_MASK.dtype)
    assert DISTRICT_IDX.shape == (h, w) and DISTRICT_IDX.dtype == np.int16, (DISTRICT_IDX.shape, DISTRICT_IDX.dtype)
    assert np.all(DISTRICT_IDX[~ROI_MASK] == NODATA_DISTRICT), "DISTRICT_IDX must be -1 outside the ROI"
    assert DISTRICT_IDX.max() < len(DISTRICTS), "district id out of range"
    assert len(DISTRICTS) == 25 and all(set(d) == {"id", "name", "state"} for d in DISTRICTS)
    assert BOUNDARY_GEOJSON["type"] == "FeatureCollection" and BOUNDARY_GEOJSON["features"]
    for feat in BOUNDARY_GEOJSON["features"]:
        assert set(feat["properties"]) == {"id", "name", "state"}, feat["properties"]
    assert sorted(RAW_STACKS) == sorted(CFG.EPOCHS), sorted(RAW_STACKS)
    for year in CFG.EPOCHS:
        assert list(RAW_STACKS[year]) == RAW_BANDS, (year, list(RAW_STACKS[year]))
        for band, arr in RAW_STACKS[year].items():
            assert arr.shape == (h, w) and arr.dtype == np.float32, (year, band, arr.shape, arr.dtype)
            assert np.all(np.isnan(arr[~ROI_MASK])), f"{band} {year} must be NaN outside the ROI"
        lc = LC_FINE[year]
        assert lc.shape == (h * f, w * f) and lc.dtype == np.uint8, (year, lc.shape, lc.dtype)
        assert int(lc.max()) <= 6, f"LC_FINE[{year}] has classes > 6"
    assert (SYNTHETIC_TRUTH is None) == (DATA_MODE == "gee")


_validate_acquisition()
log("section-1 contract check passed")

# %% [markdown]
# ## 1.12 Optional interactive preview (geemap)
# Only in live notebooks with Earth Engine data and geemap installed; skipped otherwise.

# %%
if DATA_MODE == "gee" and _is_interactive() and _is_importable("geemap") and "lst" in _GEE_PREVIEW:
    try:
        import geemap
        from IPython.display import display

        _map = geemap.Map(center=[28.6, 77.2], zoom=8)
        _map.addLayer(_GEE_PREVIEW["lst"], {"min": 35, "max": 50,
                                            "palette": ["313695", "74add1", "fed976", "feb24c", "f03b20", "bd0026"]},
                      f"LST {CFG.EPOCHS[-1]} (°C)")
        if "roi" in _GEE_PREVIEW:
            _map.addLayer(_GEE_PREVIEW["roi"].style(color="ffffff", fillColor="00000000", width=1), {}, "districts")
        display(_map)
    except Exception as _exc:  # noqa: BLE001 - preview is cosmetic
        log(f"geemap preview failed: {_exc}", "WARNING")
else:
    log("geemap preview skipped (needs gee mode, a live notebook and geemap)")

# %% [markdown]
# ## 1.13 Quality-assurance figures and per-epoch statistics

# %%
def _masked(arr: np.ndarray) -> np.ma.MaskedArray:
    return np.ma.masked_invalid(np.where(ROI_MASK, arr, np.nan))


def _save_show(fig, name: str) -> None:
    fig.savefig(CFG.FIG_DIR / name, dpi=110, bbox_inches="tight")
    plt.show()
    plt.close(fig)


_mode_tag = " [SYNTHETIC]" if DATA_MODE == "synthetic" else ""
_extent_km = [0, GRID.width * GRID.res / 1000, 0, GRID.height * GRID.res / 1000]

_all_lst = np.concatenate([RAW_STACKS[y]["lst_day_c"][ROI_MASK] for y in CFG.EPOCHS])
_vmin, _vmax = np.nanpercentile(_all_lst, [2, 98])
fig, axes = plt.subplots(1, len(CFG.EPOCHS), figsize=(4.2 * len(CFG.EPOCHS), 4.6), constrained_layout=True)
for ax, year in zip(np.atleast_1d(axes), CFG.EPOCHS):
    im = ax.imshow(_masked(RAW_STACKS[year]["lst_day_c"]), cmap="inferno", vmin=_vmin, vmax=_vmax, extent=_extent_km)
    ax.set_title(f"LST {year}{_mode_tag}")
    ax.set_xlabel("km")
fig.colorbar(im, ax=axes, shrink=0.8, label="Day LST (°C), shared scale")
_save_show(fig, "01_lst_epochs.png")

_last = CFG.EPOCHS[-1]
_driver_panels = [("ndvi", "NDVI", "YlGn", None), ("ndbi", "NDBI", "RdPu", None),
                  ("ntl", "Night lights log1p(nW cm⁻² sr⁻¹)", "magma", None),
                  ("pop_density", "log10 population (persons/km²)", "viridis", np.log10),
                  ("elevation", "Elevation (m)", "terrain", None), ("lst_obs_count", "Valid LST composites", "Blues", None)]
fig, axes = plt.subplots(2, 3, figsize=(14, 9), constrained_layout=True)
for ax, (band, label, cmap, transform) in zip(axes.ravel(), _driver_panels):
    data = RAW_STACKS[_last][band]
    if transform is not None:
        data = transform(np.maximum(data, 1.0))
    im = ax.imshow(_masked(data), cmap=cmap, extent=_extent_km)
    ax.set_title(f"{label} — {_last}{_mode_tag}", fontsize=10)
    fig.colorbar(im, ax=ax, shrink=0.8)
_save_show(fig, f"01_drivers_{_last}.png")

from matplotlib.colors import BoundaryNorm, ListedColormap
_lc_cmap = ListedColormap([LC_CLASS_COLORS[c] for c in range(7)])
_lc_norm = BoundaryNorm(np.arange(-0.5, 7.5), _lc_cmap.N)
_stride = max(1, max(LC_FINE[_last].shape) // 1200)
fig, axes = plt.subplots(1, len(CFG.EPOCHS), figsize=(4.2 * len(CFG.EPOCHS), 4.8), constrained_layout=True)
for ax, year in zip(np.atleast_1d(axes), CFG.EPOCHS):
    ax.imshow(LC_FINE[year][::_stride, ::_stride], cmap=_lc_cmap, norm=_lc_norm, extent=_extent_km,
              interpolation="nearest")
    ax.set_title(f"Land cover {year}{_mode_tag}")
_handles = [plt.matplotlib.patches.Patch(color=LC_CLASS_COLORS[c], label=LC_CLASS_NAMES[c]) for c in range(1, 7)]
fig.legend(handles=_handles, loc="lower center", ncol=6, fontsize=8, bbox_to_anchor=(0.5, -0.06))
_save_show(fig, "01_landcover_epochs.png")

_rows = []
_f = GRID.res // CFG.fine_res()
for year in CFG.EPOCHS:
    stack = RAW_STACKS[year]
    lst = stack["lst_day_c"][ROI_MASK]
    lc_counts = np.bincount(LC_FINE[year].ravel(), minlength=7)[1:]
    lc_share = lc_counts / max(1, lc_counts.sum())
    _rows.append({"year": year, "cells": int(ROI_MASK.sum()), "lst_valid": int(np.isfinite(lst).sum()),
                  "lst_mean": np.nanmean(lst), "lst_std": np.nanstd(lst), "lst_p02": np.nanpercentile(lst, 2),
                  "lst_p98": np.nanpercentile(lst, 98), "ndvi_mean": np.nanmean(stack["ndvi"][ROI_MASK]),
                  "ntl_mean": np.nanmean(stack["ntl"][ROI_MASK]),
                  "pop_total_M": np.nansum(stack["pop_density"][ROI_MASK]) * GRID.cell_area_km2 / 1e6,
                  **{f"lc_{LC_CLASS_NAMES[c].split('/')[0].split(' ')[0]}_%": 100 * lc_share[c - 1] for c in range(1, 7)}})
_EPOCH_QA = pd.DataFrame(_rows).set_index("year").round(3)
print(f"Per-epoch ROI statistics{_mode_tag}")
_show(_EPOCH_QA)
_district_cells = pd.Series(np.bincount(DISTRICT_IDX[ROI_MASK], minlength=len(DISTRICTS)),
                            index=[d["name"] for d in DISTRICTS], name="cells")
log("cells per district: " + ", ".join(f"{k} {v}" for k, v in _district_cells.items()))
if (_district_cells == 0).any():
    log(f"districts without cells (absent in the boundary layer): {list(_district_cells[_district_cells == 0].index)}",
        "WARNING")
del _all_lst, _rows, _f
free_memory()
