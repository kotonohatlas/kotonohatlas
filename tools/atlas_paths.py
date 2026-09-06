"""Kotonohatlas path roots (standalone package).

Kotonohatlas owns map geometry, toponyms, browser runtime, and campaign tools.

An optional embedding project may provide localized introductory copy,
publication links, and deployment policy. Atlas never imports
the embedding project's Python implementation or inspects its document corpus.

The browser-facing host contract consists of empty insertion points. Build adapters
are implementation details and do not assign meanings to those elements. See
deploy/HOST_EXTENSIONS.md.

Environment (all optional unless noted):
  ATLAS_LOCALES         path to an Atlas-localization registry override
  ATLAS_CLDR            path to cldr-json repository root (contains LICENSE + cldr-json/)
  KOTONOHATLAS_ADMIN1   optional Admin-1 toponym package root
  ATLAS_INTRO_COPY      path to optional localized host-introduction JSON
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ATLAS_ROOT = Path(__file__).resolve().parents[1]
TOOLS_DIR = ATLAS_ROOT / "tools"
CONFIG_DIR = ATLAS_ROOT / "config"
GEOGRAPHY_DIR = CONFIG_DIR / "geography"
LINGUISTICS_DIR = CONFIG_DIR / "linguistics"
COPY_DIR = CONFIG_DIR / "copy"
BROWSER_DIR = TOOLS_DIR / "browser"
BUILD_DIR = ATLAS_ROOT / "build"
TOPONYM_RESOLUTION_DIR = ATLAS_ROOT / "toponym-resolution"


def _env_path(name: str) -> Path | None:
    raw = os.environ.get(name)
    if not raw:
        return None
    return Path(raw).expanduser().resolve()


# These defaults make a checkout self-contained. Embedders override individual
# files explicitly instead of exposing an entire sibling source tree.
LOCALES_PATH = (_env_path("ATLAS_LOCALES") or (CONFIG_DIR / "locales.json")).resolve()
COVERAGE_CONFIG = CONFIG_DIR / "language-coverage.json"
HOST_COVERAGE_INTRO = (
    _env_path("ATLAS_INTRO_COPY") or (COPY_DIR / "coverage-intro.json")
).resolve()
ATLAS_COVERAGE_UI = COPY_DIR / "coverage-ui.json"

CLDR_REPOSITORY = (
    _env_path("ATLAS_CLDR")
    or (ATLAS_ROOT / "vendor" / "cldr-json")
).resolve()

ADMIN1_TOPONYM_DIR = _env_path("KOTONOHATLAS_ADMIN1")
ADMIN1_TOPONYM_TOOLS_DIR = (
    ADMIN1_TOPONYM_DIR / "tools" if ADMIN1_TOPONYM_DIR is not None else None
)

ADMIN1_DIR = GEOGRAPHY_DIR / "admin1" / "country"


def ensure_import_paths() -> None:
    paths = [TOOLS_DIR]
    if ADMIN1_TOPONYM_TOOLS_DIR is not None:
        paths.append(ADMIN1_TOPONYM_TOOLS_DIR)
    for candidate in paths:
        path = str(candidate)
        if path not in sys.path:
            sys.path.insert(0, path)
