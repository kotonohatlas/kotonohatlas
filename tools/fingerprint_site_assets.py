"""Stamp final Pages asset references with hashes of the published files."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path


VERSION_LENGTH = 12
INDEX_REFERENCES = {
    "./assets/stylesheets/atlas-ui.css": "assets/stylesheets/atlas-ui.css",
    "./assets/javascripts/language-distribution-map.js": (
        "assets/javascripts/language-distribution-map.js"
    ),
    "./language-map.json": "language-map.json",
    "./assets/javascripts/locale-resolution.js": (
        "assets/javascripts/locale-resolution.js"
    ),
    "./assets/javascripts/language-atlas-access.js": (
        "assets/javascripts/language-atlas-access.js"
    ),
    "./assets/javascripts/atlas-ui.js": "assets/javascripts/atlas-ui.js",
    "./coverage.json": "coverage.json",
}
LOCALE_DATA_DIRECTORY = "map-locales"
LOCAL_CACHEABLE_URL = re.compile(
    r"^\./(?P<path>[^?#]+(?:\.json|\.geojson|\.gz|\.js))"
    r"(?:\?v=[A-Za-z0-9._~-]+)?$"
)


def content_version(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:VERSION_LENGTH]


def _replace_query_version(text: str, reference: str, version: str) -> str:
    pattern = re.compile(re.escape(f"{reference}?v=") + r"[A-Za-z0-9._~-]+")
    updated, count = pattern.subn(f"{reference}?v={version}", text)
    if count != 1:
        raise ValueError(f"expected exactly one versioned reference to {reference}, found {count}")
    return updated


def _record_version(site: Path, relative_path: str, versions: dict[str, str]) -> str:
    target = (site / relative_path).resolve()
    if not target.is_relative_to(site):
        raise ValueError(f"asset reference escapes site root: {relative_path}")
    if not target.is_file():
        raise FileNotFoundError(f"referenced asset is not published: {relative_path}")
    version = content_version(target)
    versions[relative_path] = version
    return version


def _rewrite_versioned_urls(value, site: Path, versions: dict[str, str]):
    if isinstance(value, dict):
        return {
            key: _rewrite_versioned_urls(item, site, versions)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_rewrite_versioned_urls(item, site, versions) for item in value]
    if not isinstance(value, str):
        return value
    match = LOCAL_CACHEABLE_URL.fullmatch(value)
    if not match:
        return value
    relative_path = match.group("path")
    version = _record_version(site, relative_path, versions)
    return f"./{relative_path}?v={version}"


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, payload) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


def _locale_data_versions(site: Path, versions: dict[str, str]) -> dict[str, dict[str, str]]:
    directory = site / LOCALE_DATA_DIRECTORY
    if not directory.is_dir():
        raise FileNotFoundError(
            f"published asset directory missing: {LOCALE_DATA_DIRECTORY}"
        )
    groups: dict[str, dict[str, str]] = {
        "locales": {
            path.name.removesuffix(".json.gz"): _record_version(
                site, path.relative_to(site).as_posix(), versions
            )
            for path in sorted(directory.glob("*.json.gz"))
            if path.is_file()
        }
    }
    core_path = "map-linguistics/core.json"
    groups["linguistics_core"] = {
        "core": _record_version(site, core_path, versions),
    }
    return groups


def fingerprint_site(site: Path) -> dict[str, str]:
    """Fingerprint final leaf assets first, then their manifests and consumers."""
    site = site.resolve()
    index_path = site / "index.html"
    runtime_path = site / "assets" / "javascripts" / "language-distribution-map.js"
    locale_runtime_path = site / "assets" / "javascripts" / "locale-resolution.js"
    versions: dict[str, str] = {}

    locale_runtime_relative = "assets/javascripts/locale-resolution.js"
    locale_version = _record_version(site, locale_runtime_relative, versions)
    runtime = runtime_path.read_text(encoding="utf-8")
    runtime = _replace_query_version(runtime, "./locale-resolution.js", locale_version)
    runtime_path.write_text(runtime, encoding="utf-8")

    admin1_manifest_path = site / "language-map-admin1.json"
    admin1_manifest = _rewrite_versioned_urls(
        _read_json(admin1_manifest_path), site, versions
    )
    _write_json(admin1_manifest_path, admin1_manifest)

    coverage_path = site / "coverage.json"
    coverage = _rewrite_versioned_urls(_read_json(coverage_path), site, versions)
    coverage["map_asset_versions"] = _locale_data_versions(site, versions)
    _write_json(coverage_path, coverage)

    map_path = site / "language-map.json"
    map_payload = _rewrite_versioned_urls(_read_json(map_path), site, versions)
    _write_json(map_path, map_payload)

    for relative_path in INDEX_REFERENCES.values():
        _record_version(site, relative_path, versions)
    index = index_path.read_text(encoding="utf-8")
    for reference, relative_path in INDEX_REFERENCES.items():
        index = _replace_query_version(index, reference, versions[relative_path])
    index_path.write_text(index, encoding="utf-8")
    return versions


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", default="build/site")
    args = parser.parse_args()
    site = Path(args.site).resolve()
    versions = fingerprint_site(site)
    print(f"fingerprinted_assets={len(versions)} site={site}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
