"""Run the pipeline sections from a small Kaggle notebook (the workaround for Kaggle's 1 MB notebook limit).

Kaggle refuses notebooks whose source is larger than 1 MB; the full pipeline notebook ``delhi_ncr_lst_pipeline.ipynb``
is ~1.5 MB (1.1 MB of it code). ``kaggle_launcher.ipynb`` is a ~12 KB notebook that finds this code folder - an
attached Kaggle Dataset built with ``notebook/make_kaggle_code_bundle.py``, or a clone of the GitHub repository - and
calls :func:`run_pipeline`, which executes ``sections/00..12`` cell by cell **in the notebook's own namespace**, the
same way the full notebook and ``run_local.py`` do:

* a bundle is checked file by file against the sha1 checksums in its ``BUNDLE_INFO.json``, and the per-section code
  hashes recorded there are injected as ``_CODE_SHA`` (a GitHub checkout gets them computed here; the hash does not
  depend on the Python version), so stage-cache keys are identical to the full notebook's and a resumed run reuses
  exactly the same caches;
* ``expected_bundle`` (the launcher's ``EXPECTED_BUNDLE``) refuses an attached bundle other than the one just built,
  e.g. an older dataset version that Kaggle still mounts;
* the section marker ``_lst_enter_section('NN')`` runs before every section 01-12 (elapsed / remaining time,
  ``LST_STOP_AFTER``, time budget);
* a clean stop (``LSTStop``: time budget or ``LST_STOP_AFTER``; also an error raised after a stop was requested) ends
  the run successfully after ``finalize_stop()`` (``RUN_STOPPED.json`` + packed cache), so the Kaggle version keeps
  its output for a resume;
* any other exception packs the cache and writes ``RUN_FAILED.json``; then, with ``LST_FAIL_SOFT`` (default: Kaggle
  commits only), the run returns ``{"status": "failed"}`` so the version keeps its output for a resume as well;
  otherwise it re-raises with the failing section and cell named.

Cells are compiled with ``dont_inherit=True`` (no ``__future__`` flags leak in from this module), like a Jupyter cell,
and the value of a cell's last expression is displayed, as Jupyter would. The cell source is registered in
``linecache`` so tracebacks show the failing line.
"""
from __future__ import annotations

import ast
import builtins
import hashlib
import json
import linecache
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

N_SECTIONS = 13                       # sections 00..12 (v2)
BUNDLE_INFO = "BUNDLE_INFO.json"      # written by make_kaggle_code_bundle.py
GITHUB_SOURCE = "GITHUB_SOURCE.json"  # written by fetch_github into the checkout (repository, ref, commit)
REQUIRED_FILES = ("build_notebook.py", "kaggle_runner.py", "validate_bundle.py")
ADD_CODE_HINT = ("right sidebar -> Input -> + Add Input (older editor: Add Data) -> Datasets -> Your Work -> "
                 "ncr-lst-v2-code -> (+); a new dataset version can be attached once Kaggle has finished processing it")
_SECTIONS_SUFFIX = "sections/00_setup.py"


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------------------------------------------------
# Locating / fetching the code
# --------------------------------------------------------------------------------------------------------------------
def is_code_dir(path: Path | str) -> bool:
    """True if ``path`` holds the pipeline code: ``sections/00_setup.py`` and ``build_notebook.py``."""
    p = Path(path)
    return (p / "sections" / "00_setup.py").is_file() and (p / "build_notebook.py").is_file()


def _bundle_created(path: Path) -> str:
    try:
        return str(json.loads((path / BUNDLE_INFO).read_text(encoding="utf-8")).get("created_utc", ""))
    except Exception:  # noqa: BLE001 - no / unreadable bundle info
        return ""


def _walk(roots: Iterable[Path | str], max_depth: int) -> Iterator[tuple[Path, int]]:
    """Folders under ``roots`` breadth-first as ``(folder, depth)``, children sorted by name, at most ``max_depth``
    levels deep, never below a code folder. Symlinked folders are followed; a set of resolved paths prevents loops
    and duplicates."""
    seen: set[str] = set()
    for root in roots:
        root = Path(root)
        if not root.is_dir():
            continue
        level = [root]
        for depth in range(max_depth + 1):
            nxt: list[Path] = []
            for d in level:
                try:
                    real = str(d.resolve())
                except OSError:
                    continue
                if real in seen:
                    continue
                seen.add(real)
                yield d, depth
                if depth < max_depth and not is_code_dir(d):
                    try:
                        nxt.extend(sorted((c for c in d.iterdir() if c.is_dir()), key=lambda c: c.name))
                    except OSError:
                        continue
            level = nxt
            if not level:
                break


def _zip_bundle(z: Path) -> tuple[bool, str]:
    """``(is a code zip, BUNDLE_INFO created_utc)`` of a zip file, read without extracting it."""
    try:
        with zipfile.ZipFile(z) as zf:
            names = {n.replace("\\", "/"): n for n in zf.namelist()}
            hits = sorted((n for n in names if n.endswith(_SECTIONS_SUFFIX)), key=len)
            if not hits:
                return False, ""
            member = names.get(hits[0][: -len(_SECTIONS_SUFFIX)] + BUNDLE_INFO)
            if member is None:
                return True, ""
            try:
                return True, str(json.loads(zf.read(member).decode("utf-8")).get("created_utc", ""))
            except (ValueError, UnicodeDecodeError, AttributeError):
                return True, ""
    except (OSError, zipfile.BadZipFile):
        return False, ""


def find_bundles(roots: Iterable[Path | str] = ("/kaggle/input",), max_depth: int = 5) -> list[dict[str, Any]]:
    """Code folders and zipped code bundles under ``roots``, best first: newest ``BUNDLE_INFO`` ``created_utc``, then
    a folder before a zip (Kaggle normally unpacks an uploaded zip), then the shallowest, then by path."""
    out: list[dict[str, Any]] = []
    for d, depth in _walk(roots, max_depth):
        if is_code_dir(d):
            out.append({"path": d, "kind": "folder", "created": _bundle_created(d), "depth": depth})
            continue
        try:
            zips = sorted(c for c in d.iterdir() if c.suffix.lower() == ".zip" and c.is_file())
        except OSError:
            continue
        for z in zips:
            ok, created = _zip_bundle(z)
            if ok:
                out.append({"path": z, "kind": "zip", "created": created, "depth": depth + 1})
    out.sort(key=lambda c: str(c["path"]))
    out.sort(key=lambda c: (c["created"], c["kind"] == "folder", -c["depth"]), reverse=True)  # stable: path order kept
    return out


def find_code_dirs(roots: Iterable[Path | str] = ("/kaggle/input",), max_depth: int = 5) -> list[Path]:
    """All code folders under ``roots`` (best first, see :func:`find_bundles`)."""
    return [c["path"] for c in find_bundles(roots, max_depth) if c["kind"] == "folder"]


def find_code_zips(roots: Iterable[Path | str] = ("/kaggle/input",), max_depth: int = 5) -> list[Path]:
    """Zip archives under ``roots`` that contain ``sections/00_setup.py`` (in case Kaggle kept an upload zipped)."""
    return [c["path"] for c in find_bundles(roots, max_depth) if c["kind"] == "zip"]


def _safe_extract(zf: zipfile.ZipFile, dest: Path) -> None:
    """Extract ``zf`` into ``dest`` refusing absolute paths and ``..`` components (zip-slip)."""
    dest = dest.resolve()
    for member in zf.infolist():
        target = (dest / member.filename).resolve()
        if dest != target and dest not in target.parents:
            raise RuntimeError(f"unsafe path in code zip: {member.filename!r}")
    zf.extractall(dest)


def extract_code_zip(zip_path: Path | str, dest: Path | str = "/tmp/lst_code_zip") -> Path:
    """Extract a code zip (to /tmp, never /kaggle/working, so it is not saved as notebook output) and return the
    code folder inside it."""
    dest = Path(dest)
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    with zipfile.ZipFile(zip_path) as zf:
        _safe_extract(zf, dest)
    dirs = find_code_dirs([dest], max_depth=4)
    if not dirs:
        raise FileNotFoundError(f"{zip_path} contains no sections/00_setup.py + build_notebook.py")
    return dirs[0]


def _git_commit(checkout: Path) -> str | None:
    git = shutil.which("git")
    if not git:
        return None
    try:
        return subprocess.run([git, "rev-parse", "HEAD"], cwd=checkout, check=True, capture_output=True, text=True,
                              timeout=60).stdout.strip() or None
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        return None


def fetch_github(repo_url: str, ref: str = "main", dest: Path | str = "/tmp/lst_code_repo") -> Path:
    """Get the repository at ``ref`` (branch, tag or commit) and return its ``notebook/`` code folder.

    Uses ``git`` (shallow clone / fetch) when available, otherwise the GitHub zip archive. The checkout goes to /tmp,
    not /kaggle/working, so it is never saved as notebook output (a stale copy could otherwise be found again when that
    output is attached for a resume). The resolved commit is written to ``GITHUB_SOURCE.json`` in the code folder.
    """
    dest = Path(dest)
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    repo_url = repo_url.rstrip("/")
    is_sha = 7 <= len(ref) <= 40 and all(c in "0123456789abcdef" for c in ref.lower())
    git = shutil.which("git")
    errors = []
    commit = None
    if git:
        try:
            if is_sha:
                dest.mkdir(parents=True)
                for cmd in (["init", "-q"], ["remote", "add", "origin", repo_url],
                            ["fetch", "-q", "--depth", "1", "origin", ref], ["checkout", "-q", "FETCH_HEAD"]):
                    subprocess.run([git, *cmd], cwd=dest, check=True, capture_output=True, text=True, timeout=600)
            else:
                subprocess.run([git, "clone", "-q", "--depth", "1", "--branch", ref, repo_url, str(dest)],
                               check=True, capture_output=True, text=True, timeout=600)
            commit = _git_commit(dest)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            stderr = getattr(exc, "stderr", "") or ""
            errors.append(f"git: {type(exc).__name__}: {stderr.strip()[:300]}")
            shutil.rmtree(dest, ignore_errors=True)
    if not dest.exists():
        if not repo_url.startswith("https://github.com/"):
            raise RuntimeError(f"could not fetch {repo_url}@{ref}: {'; '.join(errors) or 'git not available'}")
        owner_repo = repo_url[len("https://github.com/"):].removesuffix(".git")
        url = f"https://codeload.github.com/{owner_repo}/zip/{ref}"
        tmp_zip = dest.parent / (dest.name + ".zip")
        try:
            with urllib.request.urlopen(url, timeout=300) as resp, open(tmp_zip, "wb") as fh:  # noqa: S310 - https
                shutil.copyfileobj(resp, fh)
            dest.mkdir(parents=True)
            with zipfile.ZipFile(tmp_zip) as zf:
                _safe_extract(zf, dest)
                comment = zf.comment.decode("ascii", "replace").strip()   # GitHub archives carry the commit id
                commit = comment if re.fullmatch(r"[0-9a-f]{40}", comment) else None
        except Exception as exc:  # noqa: BLE001
            errors.append(f"zip download {url}: {type(exc).__name__}: {exc}")
            raise RuntimeError(f"could not fetch {repo_url}@{ref}: {'; '.join(errors)}") from exc
        finally:
            tmp_zip.unlink(missing_ok=True)
    dirs = find_code_dirs([dest], max_depth=3)
    if not dirs:
        raise FileNotFoundError(f"{repo_url}@{ref} has no notebook/sections/00_setup.py")
    src = {"source": "github", "repo": repo_url, "ref": ref, "git_commit": commit, "fetched_utc": _utc_now()}
    (dirs[0] / GITHUB_SOURCE).write_text(json.dumps(src, indent=1), encoding="utf-8")
    return dirs[0]


def input_listing(roots: Iterable[Path | str] = ("/kaggle/input",), depth: int = 3, limit: int = 40) -> str:
    """The folders under ``roots`` (a few levels), for error messages about what is attached."""
    lines = []
    for d, dep in _walk(roots, depth):
        if dep == 0:
            continue
        if len(lines) >= limit:
            lines.append("  ...")
            break
        lines.append(f"  {d}")
    return "\n".join(lines) or "  (nothing is attached)"


def no_code_dataset_message(roots: Iterable[Path | str] = ("/kaggle/input",)) -> str:
    roots = list(roots)
    return ("No code dataset found under " + ", ".join(str(r) for r in roots) + ". Attach it: " + ADD_CODE_HINT +
            ". (Build it on your PC with `python notebook/make_kaggle_code_bundle.py` and upload "
            "outputs/kaggle/ncr-lst-v2-code.zip as a Kaggle dataset.) Attached now:\n" + input_listing(roots))


def locate_code(source: str = "dataset", github_repo: str | None = None, github_ref: str = "main",
                roots: Iterable[Path | str] = ("/kaggle/input",)) -> Path:
    """Resolve the code folder: ``LST_CODE_DIR`` env, else an attached dataset (the best of :func:`find_bundles`),
    else GitHub.

    ``source``: ``"dataset"`` (attached dataset only), ``"auto"`` (dataset first, then GitHub) or ``"github"``.
    """
    env = os.environ.get("LST_CODE_DIR", "").strip()
    if env:
        if not is_code_dir(env):
            raise FileNotFoundError(f"LST_CODE_DIR={env!r} is not a code folder (needs sections/00_setup.py and "
                                    "build_notebook.py)")
        return Path(env)
    if source not in ("auto", "dataset", "github"):
        raise ValueError(f"CODE_SOURCE must be 'dataset', 'auto' or 'github', not {source!r}")
    roots = list(roots)
    if source in ("auto", "dataset"):
        cands = find_bundles(roots)
        if cands:
            best = cands[0]
            if len(cands) > 1:
                print("several code bundles are attached; using the newest:\n" + "\n".join(
                    f"  {'->' if c is best else '  '} {c['path']}  ({c['kind']}, created {c['created'] or 'unknown'})"
                    for c in cands), flush=True)
            return best["path"] if best["kind"] == "folder" else extract_code_zip(best["path"])
        if source == "dataset":
            raise FileNotFoundError(no_code_dataset_message(roots))
    if not github_repo:
        raise FileNotFoundError(no_code_dataset_message(roots) + "\n(and no GITHUB_REPO is set)")
    print(f"no code dataset attached; fetching {github_repo} @ {github_ref}", flush=True)
    return fetch_github(github_repo, github_ref)


# --------------------------------------------------------------------------------------------------------------------
# Checking the code
# --------------------------------------------------------------------------------------------------------------------
def file_sha1(path: Path | str) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _import_build_notebook(code_dir: Path):
    """Import ``build_notebook`` from ``code_dir`` (fresh, even if another copy was imported before)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("lst_build_notebook", code_dir / "build_notebook.py")
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _read_json(path: Path) -> dict | None:
    """The JSON object in ``path``; None when the file does not exist; raises when it exists but is unreadable."""
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        raise RuntimeError(f"{path} is unreadable ({type(exc).__name__}: {exc}) - an incomplete upload? Rebuild "
                           "with python notebook/make_kaggle_code_bundle.py and upload it as a new dataset "
                           "version") from None
    if not isinstance(data, dict):
        raise RuntimeError(f"{path} is not a JSON object")
    return data


def verify_bundle_files(code_dir: Path | str, bundle: dict) -> None:
    """Compare every file listed in ``BUNDLE_INFO['files']`` (exact-byte sha1) with ``code_dir``; raise on a missing
    or changed file, on a section file the bundle does not list, or when a required file is not listed."""
    code_dir = Path(code_dir)
    files = bundle.get("files")
    if not isinstance(files, dict) or not files:
        raise RuntimeError(f"{code_dir / BUNDLE_INFO} lists no file checksums (an old bundle format) - rebuild with "
                           "python notebook/make_kaggle_code_bundle.py")
    problems = []
    for rel, sha in sorted(files.items()):
        p = code_dir / rel
        if not p.is_file():
            problems.append(f"missing {rel}")
        elif file_sha1(p) != sha:
            problems.append(f"changed {rel}")
    try:
        problems += [f"not in the bundle: sections/{p.name}" for p in sorted((code_dir / "sections").glob("*.py"))
                     if f"sections/{p.name}" not in files]
    except OSError:
        pass
    problems += [f"the bundle does not list {req}" for req in REQUIRED_FILES if req not in files]
    if problems:
        raise RuntimeError(f"{code_dir} does not match its {BUNDLE_INFO} ({'; '.join(problems[:8])}"
                           f"{f'; +{len(problems) - 8} more' if len(problems) > 8 else ''}) - an incomplete or edited "
                           "upload: rebuild with python notebook/make_kaggle_code_bundle.py and upload the zip as a "
                           "new dataset version")


def check_code(code_dir: Path | str, expected_bundle: str | None = None) -> dict[str, Any]:
    """Validate that ``code_dir`` is the complete v2 pipeline and describe it.

    A bundle (``BUNDLE_INFO.json`` present) is verified file by file before any of its code is imported, and its
    recorded code hashes are used; without one (a GitHub checkout or a hand-made folder) the hashes are computed
    here. A non-empty ``expected_bundle`` refuses any other bundle id. Returns ``{"code_dir", "sections",
    "code_hashes", "validator", "bundle", "bundle_id", "source"}``.
    """
    code_dir = Path(code_dir)
    bundle = _read_json(code_dir / BUNDLE_INFO)
    if bundle is not None:
        verify_bundle_files(code_dir, bundle)
    bn = _import_build_notebook(code_dir)
    for attr in ("section_paths", "parse_sections", "section_code_hashes"):
        if not hasattr(bn, attr):
            raise RuntimeError(f"{code_dir}/build_notebook.py has no {attr}(): this is not the v2 code (a v1 checkout "
                               "or an outdated bundle). Rebuild the code dataset / push v2 to GitHub.")
    paths = bn.section_paths(code_dir / "sections")
    ids = [p.name[:2] for p in paths]
    expected = [f"{i:02d}" for i in range(N_SECTIONS)]
    if ids != expected:
        raise RuntimeError(f"{code_dir}/sections has sections {ids}, expected {expected} (v2 has 13 sections 00-12)")
    validator = code_dir / "validate_bundle.py"
    if not validator.is_file():
        raise FileNotFoundError(f"{code_dir} has no validate_bundle.py (an incomplete upload?) - rebuild with "
                                "python notebook/make_kaggle_code_bundle.py")
    if bundle is not None:
        hashes = bundle.get("code_hashes")
        if (not isinstance(hashes, dict) or sorted(hashes) != expected
                or not all(isinstance(v, str) and v for v in hashes.values())):
            raise RuntimeError(f"{code_dir / BUNDLE_INFO} has no valid code_hashes for sections 00-12 - rebuild "
                               "with python notebook/make_kaggle_code_bundle.py")
        source = {"source": "bundle", **{k: bundle.get(k) for k in ("bundle_id", "created_utc", "git_commit",
                                                                     "git_dirty")}}
    else:
        hashes = bn.section_code_hashes(paths)
        try:
            source = _read_json(code_dir / GITHUB_SOURCE) or {"source": "folder"}
        except RuntimeError:
            source = {"source": "github", "git_commit": None}
    info: dict[str, Any] = {"code_dir": str(code_dir), "sections": [p.name for p in paths], "code_hashes": dict(hashes),
                            "validator": str(validator), "bundle": bundle,
                            "bundle_id": (bundle or {}).get("bundle_id"), "source": source}
    check_expected_bundle(info, expected_bundle)
    return info


def check_expected_bundle(info: dict[str, Any], expected: str | None) -> None:
    """Raise unless the code's bundle id equals ``expected`` (no check when ``expected`` is empty). Bundle ids start
    with their UTC build time, so the message can say which side is out of date."""
    expected = (expected or "").strip()
    if not expected:
        return
    found = info.get("bundle_id") or ""
    if found == expected:
        return
    if not found:
        raise RuntimeError(f"EXPECTED_BUNDLE = {expected!r}, but {info['code_dir']} has no bundle id (a GitHub "
                           "checkout or a bundle built before bundle ids existed). Attach the code dataset version "
                           f"{expected}, or set EXPECTED_BUNDLE = \"\" to accept this code.")
    if found < expected:
        raise RuntimeError(f"the attached code bundle {found} is OLDER than EXPECTED_BUNDLE {expected}: Kaggle still "
                           "mounts an earlier version of the code dataset. Right sidebar -> Input -> ncr-lst-v2-code "
                           "-> update it to the latest version (wait until the new version has finished processing), "
                           "then run again.")
    raise RuntimeError(f"the attached code bundle {found} is NEWER than EXPECTED_BUNDLE {expected}. If you uploaded "
                       f"it on purpose, set EXPECTED_BUNDLE = \"{found}\" in the run-settings cell (the id that "
                       "make_kaggle_code_bundle.py printed), then run again.")


def describe(info: dict[str, Any]) -> str:
    """One line saying where the code comes from (bundle id / GitHub commit)."""
    src = info.get("source") or {}
    if src.get("source") == "bundle":
        return (f"bundle {src.get('bundle_id') or '(no id)'} built {src.get('created_utc') or '?'} from commit "
                f"{src.get('git_commit') or '?'}{' + uncommitted changes' if src.get('git_dirty') else ''}")
    if src.get("source") == "github":
        return f"GitHub {src.get('repo')} @ {src.get('ref')} = commit {src.get('git_commit') or 'unknown'}"
    return "a code folder without BUNDLE_INFO.json (code hashes computed here)"


# --------------------------------------------------------------------------------------------------------------------
# Running the sections
# --------------------------------------------------------------------------------------------------------------------
def _display(value: Any) -> None:
    """Show a cell's last expression like Jupyter (IPython display when available)."""
    try:
        from IPython.display import display
        display(value)
    except Exception:  # noqa: BLE001 - plain Python
        print(repr(value), flush=True)


def _ends_with_semicolon(src: str) -> bool:
    """True if the cell's last code token is ``;`` - Jupyter then does not display the last expression."""
    import io
    import tokenize
    skip = {tokenize.NEWLINE, tokenize.NL, tokenize.COMMENT, tokenize.ENDMARKER, tokenize.INDENT, tokenize.DEDENT}
    last = None
    try:
        for tok in tokenize.generate_tokens(io.StringIO(src).readline):
            if tok.type not in skip:
                last = tok
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return False
    return last is not None and last.type == tokenize.OP and last.string == ";"


def _exec_cell(src: str, name: str, ns: dict) -> None:
    """Execute one notebook cell in ``ns`` the way Jupyter does (fresh compiler flags; last expression displayed
    unless the cell ends with ``;``)."""
    linecache.cache[name] = (len(src), None, src.splitlines(True), name)
    tree = ast.parse(src, filename=name)
    last = None
    if tree.body and isinstance(tree.body[-1], ast.Expr) and not _ends_with_semicolon(src):
        last = ast.Expression(tree.body.pop().value)
    exec(compile(tree, name, "exec", dont_inherit=True), ns)  # noqa: S102 - this IS the notebook runner
    if last is not None:
        value = eval(compile(last, name, "eval", dont_inherit=True), ns)  # noqa: S307
        if value is not None:
            _display(value)


def _safe_str(exc: BaseException) -> str:
    """``str(exc)`` that cannot raise (falls back to ``repr``, then the class name)."""
    for fn in (str, repr):
        try:
            return fn(exc)
        except Exception:  # noqa: BLE001, S112 - a broken __str__ must not hide the real error
            continue
    return type(exc).__name__


def _env_flag(name: str, default: bool) -> bool:
    value = os.environ.get(name, "").strip().lower()
    if value in ("1", "true", "yes", "on"):
        return True
    if value in ("0", "false", "no", "off"):
        return False
    return default


def _is_kaggle_commit() -> bool:
    return os.environ.get("KAGGLE_KERNEL_RUN_TYPE", "") == "Batch"


def _set_inline_dpi() -> None:
    """Show inline figures at ``LST_INLINE_DPI`` (default 72; ``0`` keeps the notebook's setting). All figures land in
    the one launcher cell, so this keeps its output small; the PNG files in outputs/figures keep their own dpi."""
    raw = os.environ.get("LST_INLINE_DPI", "72").strip().lower()
    try:
        dpi = int(float(raw))
    except ValueError:
        dpi = 0 if raw in ("off", "none", "") else 72
    if dpi <= 0:
        return
    try:
        from IPython import get_ipython
        shell = get_ipython()
        if shell is None:
            return
        from IPython.core.pylabtools import select_figure_formats
        from matplotlib_inline.config import InlineBackend
        cfg = InlineBackend.instance(parent=shell)
        cfg.print_figure_kwargs = {**cfg.print_figure_kwargs, "dpi": dpi}   # also used if inline activates later
        select_figure_formats(shell, cfg.figure_formats, **cfg.print_figure_kwargs)
    except Exception:  # noqa: BLE001 - display tuning only
        pass


def _remove_cell_guard() -> None:
    """Drop section 00's IPython cell guard. The launcher handles stops itself; left installed, the guard would skip
    every cell run after a clean stop in an interactive session (the settings, the run cell, any inspection)."""
    try:
        from IPython import get_ipython
        shell = get_ipython()
        if shell is not None and hasattr(shell, "ast_transformers"):
            shell.ast_transformers[:] = [t for t in shell.ast_transformers if type(t).__name__ != "_LSTCellGuard"]
    except Exception:  # noqa: BLE001
        pass


def _wait_for_workers(timeout_s: float) -> None:
    """Give abandoned pipeline worker threads (Earth Engine tiles ``ee_N``, GDDP blocks ``gddp_N``, GPU jobs
    ``gpu_N``) up to ``timeout_s`` seconds in total to finish their current item before the cache is packed."""
    end = time.time() + timeout_s
    for t in threading.enumerate():
        if t is threading.current_thread() or not re.fullmatch(r"(ee|gddp|gpu)_\d+", t.name):
            continue
        t.join(max(0.0, end - time.time()))


def _output_dir(ns: dict) -> Path | None:
    cfg = ns.get("CFG")
    out = getattr(cfg, "OUTPUT_DIR", None) if cfg is not None else None
    return Path(out) if out else None


def _write_json(ns: dict, name: str, payload: dict) -> None:
    out = _output_dir(ns)
    if out is None:
        return
    try:
        out.mkdir(parents=True, exist_ok=True)
        (out / name).write_text(json.dumps(payload, indent=1, default=str), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001 - provenance only
        print(f"could not write {out / name}: {type(exc).__name__}: {_safe_str(exc)[:200]}", flush=True)


def _remove_stale(ns: dict, *names: str) -> None:
    """Delete status files a previous run left in this run's output folder (a local resume in place)."""
    out = _output_dir(ns)
    for name in names if out is not None else ():
        try:
            (out / name).unlink(missing_ok=True)
        except OSError:
            pass


def _is_stop(exc: BaseException, ns: dict) -> bool:
    """A clean stop: ``LSTStop`` itself, an exception group holding one, or any error raised after a stop was
    requested (e.g. 'cannot schedule new futures after shutdown' while worker pools wind down)."""
    stop_cls = ns.get("LSTStop")
    if isinstance(stop_cls, type) and issubclass(stop_cls, BaseException):
        if isinstance(exc, stop_cls):
            return True
        group = getattr(builtins, "BaseExceptionGroup", None)
        if group is not None and isinstance(exc, group):
            try:
                if exc.subgroup(stop_cls) is not None:
                    return True
            except Exception:  # noqa: BLE001
                pass
    return bool(ns.get("LST_STOPPED"))


def _stopped(ns: dict, after: str | None, t0: float, run: dict, exc: BaseException | None = None) -> dict[str, Any]:
    stop_cls = ns.get("LSTStop")
    if exc is not None:
        if not (isinstance(stop_cls, type) and isinstance(exc, stop_cls)):
            print(f"(raised after the stop request: {type(exc).__name__}: {_safe_str(exc)[:300]} - treated as part "
                  "of the clean stop)", flush=True)
        if callable(ns.get("request_stop")):
            ns["request_stop"](_safe_str(exc) or "LSTStop")       # no-op when a stop was already requested
    fin = ns.get("finalize_stop")
    if callable(fin):
        try:
            fin()
        except Exception as fin_exc:  # noqa: BLE001 - the stop itself must succeed
            print(f"finalize_stop failed: {type(fin_exc).__name__}: {_safe_str(fin_exc)[:300]}", flush=True)
    reason = ns.get("LST_STOP_REASON")
    result = {**run, "status": "stopped", "after_section": after, "reason": reason, "seconds": round(time.time() - t0, 1)}
    _remove_stale(ns, "RUN_FAILED.json")
    _write_json(ns, "LAUNCHER_RUN.json", result)
    print(f"\nSTOPPED CLEANLY after section {after}: {reason}\n"
          "To resume: let this version finish (it keeps its output). Then, in this notebook: right sidebar -> Input -> "
          "+ Add Input -> Notebooks -> Your Work -> this notebook -> (+) (that attaches its newest version's output, "
          "so save no other version in between); keep the code dataset attached and the same run settings (remove "
          "LST_STOP_AFTER if you used it), then Save Version again. Finished stages are reused from the cache.",
          flush=True)
    return result


def _failed(ns: dict, path: Path, cell: int, exc: BaseException, t0: float, run: dict) -> dict[str, Any]:
    """Pack the cache and write RUN_FAILED.json; then return a 'failed' result (LST_FAIL_SOFT) or raise."""
    msg = _safe_str(exc)
    where = f"{path.name}, code cell {cell}"
    soft = _env_flag("LST_FAIL_SOFT", _is_kaggle_commit())
    tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    pack = ns.get("pack_cache")                 # keeps finished stages for the rerun (LST_PACK_CACHE)
    if callable(pack):
        _wait_for_workers(60.0)
        try:
            pack()
        except Exception as pack_exc:  # noqa: BLE001 - best effort; the original error matters more
            print(f"pack_cache after the failure also failed: {type(pack_exc).__name__}: {_safe_str(pack_exc)[:300]}",
                  flush=True)
    result = {**run, "status": "failed", "section": path.name[:2], "cell": cell,
              "error": f"{type(exc).__name__}: {msg[:500]}", "seconds": round(time.time() - t0, 1)}
    _remove_stale(ns, "RUN_STOPPED.json")
    _write_json(ns, "RUN_FAILED.json", {**result, "traceback": tb[-20000:], "utc": _utc_now()})
    _write_json(ns, "LAUNCHER_RUN.json", result)
    if soft:
        bar = "!" * 100
        print(f"\n{bar}\n!!  RUN FAILED in {where}: {type(exc).__name__}: {msg[:1000]}\n{bar}\n{tb[-12000:]}{bar}\n"
              "!!  LST_FAIL_SOFT: this version still ends normally, so Kaggle keeps its output (packed cache and "
              "outputs/RUN_FAILED.json).\n!!  Fix the cause, attach this version's output (as for a stopped run) and "
              f"run again: finished stages are reused from the cache.\n{bar}", flush=True)
        return result
    raise RuntimeError(f"pipeline FAILED in {where} ({type(exc).__name__}: {msg[:300]}). Fix the cause and run "
                       "again: finished stages are reused from the stage cache.") from exc


def run_pipeline(code_dir: Path | str, ns: dict, until: str | None = None,
                 expected_bundle: str | None = None) -> dict[str, Any]:
    """Execute sections 00..12 (or up to ``until``, e.g. ``"06"``) from ``code_dir`` in the namespace ``ns``.

    Pass ``globals()`` from the launcher notebook so every pipeline variable stays available for inspection.
    Returns ``{"status": "ok" | "stopped" | "failed", ...}``; raises on a real failure unless ``LST_FAIL_SOFT`` is on
    (default: Kaggle commits only).
    """
    code_dir = Path(code_dir).resolve()
    info = check_code(code_dir, expected_bundle)
    bn = _import_build_notebook(code_dir)
    paths = bn.section_paths(code_dir / "sections")
    # Snapshot the cells, then confirm the files are still the checked ones: the code that runs is the code checked.
    snapshot = {p: [src for kind, src in bn.parse_sections([p]) if kind == "code"] for p in paths}
    if info["bundle"] is not None:
        verify_bundle_files(code_dir, info["bundle"])
    elif bn.section_code_hashes(paths) != info["code_hashes"]:
        raise RuntimeError("section files changed while the run started; run again")
    hashes = dict(info["code_hashes"])
    if not os.environ.get("LST_VALIDATOR"):
        os.environ["LST_VALIDATOR"] = info["validator"]         # section 12's standalone bundle check
    runner_file = Path(__file__)
    run = {"code_dir": str(code_dir), "code": describe(info), "bundle_id": info.get("bundle_id"),
           "runner_sha1": file_sha1(runner_file)[:12] if runner_file.is_file() else None,
           "python": sys.version.split()[0], "code_hashes": hashes}
    bar = "=" * 100
    print(f"{bar}\nDelhi NCR LST v2 - launcher run\n  code:   {code_dir}\n  source: {run['code']}\n"
          f"  runner: kaggle_runner.py sha1 {run['runner_sha1']}, python {run['python']}\n"
          f"  section code hashes: {hashes}\n{bar}", flush=True)
    _set_inline_dpi()

    ns.setdefault("__name__", "__main__")
    ns["_CODE_SHA"] = hashes
    ns["_CURRENT_SECTION"] = "00"
    t0 = time.time()
    last_done: str | None = None
    try:
        for path in paths:
            sid = path.name[:2]
            if until is not None and sid > until:
                break
            cells = snapshot[path]
            print(f"\n{bar}\n>>> {path.name}  ({len(cells)} code cells)\n{bar}", flush=True)
            if sid == "00":
                ns["_CURRENT_SECTION"] = "00"
            elif callable(ns.get("_lst_enter_section")):
                ns["_lst_enter_section"](sid)
                if ns.get("LST_STOPPED"):
                    return _stopped(ns, last_done or sid, t0, run)
            else:
                ns["_CURRENT_SECTION"] = sid
            ts = time.time()
            for i, src in enumerate(cells):
                try:
                    _exec_cell(src, f"<{path.name} cell {i}>", ns)
                except KeyboardInterrupt:
                    raise
                except BaseException as exc:  # noqa: BLE001 - classify: clean stop vs failure
                    if _is_stop(exc, ns):
                        return _stopped(ns, sid, t0, run, exc)
                    return _failed(ns, path, i, exc, t0, run)
                if ns.get("LST_STOPPED"):
                    return _stopped(ns, sid, t0, run)
            print(f"<<< {path.name} done in {time.time() - ts:.1f}s", flush=True)
            last_done = sid
    finally:
        _remove_cell_guard()
    secs = time.time() - t0
    result = {**run, "status": "ok", "until": until, "seconds": round(secs, 1)}
    _remove_stale(ns, "RUN_FAILED.json", "RUN_STOPPED.json")
    _write_json(ns, "LAUNCHER_RUN.json", result)
    print(f"\nALL SECTIONS OK in {secs:.1f}s", flush=True)
    out_dir = _output_dir(ns)
    if out_dir is not None and (out_dir / "web_bundle.zip").is_file():
        print(f"web bundle: {out_dir / 'web_bundle.zip'} ({(out_dir / 'web_bundle.zip').stat().st_size / 1e6:.1f} MB) "
              "-> Output tab -> download -> unzip into dashboard/public/data/", flush=True)
    return result
