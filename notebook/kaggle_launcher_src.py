# %% [markdown]
# # Delhi NCR LST v2 — Kaggle launcher
#
# **Why a launcher?** Kaggle refuses notebooks larger than **1 MB**; the full pipeline notebook
# (`delhi_ncr_lst_pipeline.ipynb`) is ~1.5 MB. This small notebook runs **exactly the same 13 sections** (00–12)
# from an attached code dataset, cell by cell, in this notebook's own namespace — same stage caches, same time
# budget and clean stop, same outputs (`/kaggle/working/outputs/`, `web_bundle.zip`).
#
# **One-time setup**
# 1. On your PC, in the project folder: `python notebook/make_kaggle_code_bundle.py`. It writes
#    `outputs/kaggle/ncr-lst-v2-code.zip` and, next to it, this launcher with `EXPECTED_BUNDLE` filled in.
# 2. kaggle.com → **+ Create → New Dataset** → drop the zip → title `ncr-lst-v2-code` → **Create** (private by
#    default). Wait until Kaggle has finished processing it (it unpacks the zip; either form works).
# 3. **+ Create → New Notebook → File → Import Notebook** → upload `outputs/kaggle/kaggle_launcher.ipynb`.
# 4. **Settings** (right sidebar: *Session options*): **Accelerator → GPU T4 ×2**, **Internet → On** (needs a
#    phone-verified account). **Add-ons → Secrets**: `GEE_SERVICE_ACCOUNT_KEY` (the full JSON key) and `GEE_PROJECT`
#    (the project id), both attached to this notebook.
# 5. Right sidebar → **Input → + Add Input** (older editor: *Add Data*) → **Datasets → Your Work →
#    `ncr-lst-v2-code` → (+)**.
#
# **Each run**
# 1. Check the run settings in the next cell (`pilot` first, then `full`).
# 2. **Save Version → Save & Run All (Commit)**. The run first checks the attached code file by file and against
#    `EXPECTED_BUNDLE`, and stops within seconds if it is not the bundle you built.
# 3. When it finishes: **Output** → download `outputs/web_bundle.zip` → unzip it into `dashboard/public/data/`.
# 4. **Resume** after `STOPPED CLEANLY` (time budget or `LST_STOP_AFTER`) or `RUN FAILED` (once the cause is fixed):
#    right sidebar → **Input → + Add Input → Notebooks → Your Work → this notebook → (+)**. That attaches the output
#    of its *newest* version, so save no other version in between. Keep the code dataset attached and the same
#    settings (drop `LST_STOP_AFTER`), then Save Version again: finished stages are reused from the cache. Repeat
#    until the log ends with `ALL SECTIONS OK`.
#
# **After a code change**: run step 1 again, upload the new zip as a **New Version** of the dataset (dataset page →
# **New Version** → replace the file), update the dataset in this notebook's Input panel to that version, and set
# `EXPECTED_BUNDLE` below to the new id that step 1 printed. More details: `README.md` and `docs/` in the repository.

# %%
import os

# Start clean, so a setting deleted below is really unset (also in a live interactive session).
for _k in [k for k in os.environ if k.startswith("LST_")]:
    del os.environ[_k]

# ---------------- run settings (edit) ----------------
os.environ["LST_RUN_MODE"] = "gee"      # "gee": real Earth Engine data (stops with an error if EE is unavailable)
os.environ["LST_PROFILE"] = "pilot"     # "pilot" first (4 frames: errors + cost probe), then "full"
# os.environ["LST_TIME_BUDGET_H"] = "11"   # default on Kaggle: 11 h (stops starting new work, then ends cleanly)
# os.environ["LST_STOP_AFTER"] = "06"      # optional: stop cleanly after this section (e.g. extraction first)
# os.environ["LST_GEE_EXPORT"] = "asset"   # optional: batch exports (needs the "Earth Engine Resource Writer" role)
# os.environ["LST_CACHE_IMPORT"] = "auto"  # resume source; "auto" = the cache in an attached notebook output, or a
#                                          # folder path copied from the Input panel
# os.environ["LST_FAIL_SOFT"] = "1"        # default in commits: a failed run still ends normally and keeps its output
# os.environ["LST_INLINE_DPI"] = "72"      # resolution of the figures shown below (0 = notebook default)

# ---------------- which code runs ----------------
# EXPECTED_BUNDLE: the bundle id printed by make_kaggle_code_bundle.py ("" = accept any attached bundle)
EXPECTED_BUNDLE = ""
CODE_SOURCE = "dataset"    # "dataset": the attached code dataset | "github": GITHUB_REPO @ GITHUB_REF | "auto": either
GITHUB_REPO = "https://github.com/prithwiraj84/Delhi-NCR-Land-Surface-Temperature"
GITHUB_REF = "main"        # branch, tag or (best) full commit id holding the v2 code; used by "github" / "auto" only

# %%
# Bootstrap: load kaggle_runner.py from the newest attached code bundle (folder or zip), let it locate the code and
# check it file by file against its BUNDLE_INFO.json and EXPECTED_BUNDLE.
import importlib.util
import json
import shutil
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

_LST_ADD_HINT = ("right sidebar -> Input -> + Add Input (older editor: Add Data) -> Datasets -> Your Work -> "
                 "ncr-lst-v2-code -> (+)")


def _lst_created(text):
    try:
        return str(json.loads(text).get("created_utc", ""))
    except ValueError:
        return ""


def _lst_find_runner(root=Path("/kaggle/input"), depth=5):
    """kaggle_runner.py of the newest code bundle under /kaggle/input (newest BUNDLE_INFO created_utc, then folders
    before zips, then the shallowest: the choice kaggle_runner.locate_code makes); a zip is extracted to /tmp."""
    found, seen, level = [], set(), [root] if root.is_dir() else []
    for dep in range(depth + 1):
        nxt = []
        for d in level:
            if str(d.resolve()) in seen:
                continue
            seen.add(str(d.resolve()))
            if (d / "kaggle_runner.py").is_file() and (d / "sections" / "00_setup.py").is_file():
                info = d / "BUNDLE_INFO.json"
                found.append((_lst_created(info.read_text(encoding="utf-8")) if info.is_file() else "", 1, -dep, d))
                continue
            try:
                kids = sorted(d.iterdir())
            except OSError:
                continue
            nxt += [k for k in kids if k.is_dir()]
            for z in (k for k in kids if k.suffix.lower() == ".zip" and k.is_file()):
                try:
                    with zipfile.ZipFile(z) as zf:
                        names = {n.replace("\\", "/"): n for n in zf.namelist()}
                        tops = [n[:-16] for n in sorted(names, key=len)
                                if n.endswith("kaggle_runner.py") and n[:-16] + "sections/00_setup.py" in names]
                        if tops:
                            info = names.get(tops[0] + "BUNDLE_INFO.json")
                            found.append((_lst_created(zf.read(info).decode("utf-8")) if info else "", 0, -dep - 1, z))
                except (OSError, zipfile.BadZipFile, UnicodeDecodeError):
                    continue
        level = nxt
    if not found:
        return None
    best = max(found, key=lambda c: c[:3])[3]
    if best.suffix.lower() != ".zip":
        return best
    dest = Path("/tmp/lst_runner_zip")
    shutil.rmtree(dest, ignore_errors=True)
    with zipfile.ZipFile(best) as zf:
        zf.extractall(dest)
    return min(dest.rglob("kaggle_runner.py"), key=lambda p: len(p.parts)).parent


def _lst_runner_from_github(repo, ref):
    raw = repo.rstrip("/").replace("https://github.com/", "https://raw.githubusercontent.com/")
    dest = Path("/tmp/lst_runner_github")
    dest.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(f"{raw}/{ref}/notebook/kaggle_runner.py", timeout=120) as resp:
            (dest / "kaggle_runner.py").write_bytes(resp.read())
    except urllib.error.HTTPError as exc:
        raise FileNotFoundError(
            f"GitHub {repo} @ {ref} has no notebook/kaggle_runner.py (HTTP {exc.code}): the v2 code is not pushed "
            f"there. Attach the code dataset instead ({_LST_ADD_HINT}) and set CODE_SOURCE = \"dataset\", or set "
            "GITHUB_REF to a branch or commit that holds the v2 code.") from None
    except OSError as exc:  # URLError: no Internet / DNS
        raise ConnectionError(f"cannot reach GitHub ({exc}). Turn Internet on (Settings / Session options), or "
                              f"attach the code dataset ({_LST_ADD_HINT}) and set CODE_SOURCE = \"dataset\".") from None
    return dest


def _lst_no_dataset():
    root = Path("/kaggle/input")
    seen = [str(p) for pat in ("*", "*/*", "*/*/*") for p in sorted(root.glob(pat))][:40] if root.is_dir() else []
    return FileNotFoundError(
        f"No code dataset found under /kaggle/input. Attach it: {_LST_ADD_HINT}. A new dataset (or version) can be "
        "attached once Kaggle has finished processing it. Build it on your PC with "
        "`python notebook/make_kaggle_code_bundle.py` and upload outputs/kaggle/ncr-lst-v2-code.zip. Attached now:\n  "
        + ("\n  ".join(seen) or "(nothing)"))


def _lst_load_runner(folder):
    spec = importlib.util.spec_from_file_location("kaggle_runner", Path(folder) / "kaggle_runner.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if CODE_SOURCE not in ("dataset", "github", "auto"):
    raise ValueError(f'CODE_SOURCE must be "dataset", "github" or "auto", not {CODE_SOURCE!r}')
_env_dir = os.environ.get("LST_CODE_DIR", "").strip()
_runner_dir = Path(_env_dir) if _env_dir else (None if CODE_SOURCE == "github" else _lst_find_runner())
if _runner_dir is None:
    if CODE_SOURCE == "dataset":
        raise _lst_no_dataset()
    _runner_dir = _lst_runner_from_github(GITHUB_REPO, GITHUB_REF)
kaggle_runner = _lst_load_runner(_runner_dir)
CODE_DIR = kaggle_runner.locate_code(CODE_SOURCE, GITHUB_REPO, GITHUB_REF)
if (CODE_DIR / "kaggle_runner.py").is_file():
    kaggle_runner = _lst_load_runner(CODE_DIR)          # always the runner that ships with the chosen code
CODE_INFO = kaggle_runner.check_code(CODE_DIR, expected_bundle=EXPECTED_BUNDLE)
print("code folder:", CODE_DIR)
print("code:", kaggle_runner.describe(CODE_INFO))
print("sections:", ", ".join(CODE_INFO["sections"]))

# %%
# Run the whole pipeline (sections 00-12) in this notebook. Logs, tables and figures appear below; the outputs go to
# /kaggle/working/outputs/ (web_bundle.zip for the dashboard). A clean stop - and in a commit also a failure
# (LST_FAIL_SOFT) - ends this cell normally, so the version keeps its output for a resume.
LST_RESULT = kaggle_runner.run_pipeline(CODE_DIR, globals(), expected_bundle=EXPECTED_BUNDLE)
LST_RESULT

# %% [markdown]
# **After the run** — the last lines above say how it ended:
# * `ALL SECTIONS OK` → **Output** → download `outputs/web_bundle.zip` and unzip it into `dashboard/public/data/`.
# * `STOPPED CLEANLY` → resume as in step 4 of *Each run* (first cell).
# * `RUN FAILED` or an error → the message names the failing section and cell. Fix the cause (or send the log), then
#   resume as in step 4: finished stages are reused from the cache.
