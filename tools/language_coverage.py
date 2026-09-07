"""Generate the Kotonohatlas browser shell.

Kotonohatlas owns the map and browser runtime. The generated page exposes an
empty ``#atlas-host-intro`` insertion point whose contents, if any, belong to
the embedding site. See ``deploy/HOST_EXTENSIONS.md``.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from atlas_paths import (
    ATLAS_COVERAGE_UI,
    ATLAS_ROOT,
    BROWSER_DIR,
    CLDR_REPOSITORY,
    COVERAGE_CONFIG,
    COPY_DIR,
    GEOGRAPHY_DIR,
    HOST_COVERAGE_INTRO,
    LINGUISTICS_DIR,
    TOPONYM_RESOLUTION_DIR,
    ensure_import_paths,
)

ensure_import_paths()

import atlas_access  # noqa: E402
import atlas_i18n as hub  # noqa: E402
os.environ.setdefault("KOTONOHATLAS_ROOT", str(ATLAS_ROOT))
try:
    import admin1_names  # noqa: E402
except ModuleNotFoundError as exc:  # Optional external name-catalog package.
    if exc.name != "admin1_names":
        raise
    admin1_names = None
import country_names  # noqa: E402
import linguistic_names  # noqa: E402
import speaker_estimates  # noqa: E402


ROOT = ATLAS_ROOT
CONFIG_PATH = COVERAGE_CONFIG
UI_INTRO_PATH = HOST_COVERAGE_INTRO
UI_MESSAGES_PATH = ATLAS_COVERAGE_UI
# Kotonohatlas-owned map localization / geography / linguistics.
MAP_LOCALIZATION_DIR = COPY_DIR / "i18n"
MAP_LOCALIZATION_SOURCE_PATHS = {
    "atlas_ui": MAP_LOCALIZATION_DIR / "atlas-ui.json",
    "map_controls": MAP_LOCALIZATION_DIR / "map-controls.json",
}
MAP_DESCRIPTION_DIR = COPY_DIR / "descriptions"
MAP_DESCRIPTION_PATHS = {
    "languages": MAP_DESCRIPTION_DIR / "languages.json",
    "families": MAP_DESCRIPTION_DIR / "families.json",
    "scripts": MAP_DESCRIPTION_DIR / "scripts.json",
}
COUNTRY_NAME_OVERRIDES_PATH = LINGUISTICS_DIR / "country-names.json"
CLDR_LICENSE_PATH = CLDR_REPOSITORY / "LICENSE"
LANGUAGE_MAP_PATH = GEOGRAPHY_DIR / "map.json"
LANGUAGE_DISPUTED_REGIONS_PATH = GEOGRAPHY_DIR / "overlays.json"
LANGUAGE_MAP_PLACES_PATH = GEOGRAPHY_DIR / "places.json"
PLACE_NAME_USAGE_OVERRIDES_PATH = GEOGRAPHY_DIR / "place-name-usage-overrides.json"
LANGUAGE_MAP_ADMIN1_PATH = GEOGRAPHY_DIR / "admin1" / "index.json"
LANGUAGE_MAP_ADMIN1_REGIONS_PATH = GEOGRAPHY_DIR / "admin1" / "regions.json"
LANGUAGE_MAP_ADMIN1_DIR = GEOGRAPHY_DIR / "admin1"
LANGUAGE_ATLAS_METADATA_PATH = LINGUISTICS_DIR / "metadata.json"
TEMPLATE_PATH = BROWSER_DIR / "language-coverage.html"
ATLAS_UI_CSS_PATH = BROWSER_DIR / "atlas-ui.css"
LOCALE_CONTEXT_PHP_PATH = ATLAS_ROOT / "deploy" / "locale-context" / "locale-context.php"
LANGUAGE_MAP_RUNTIME_PATH = BROWSER_DIR / "language-distribution-map.js"
LOCALE_RESOLUTION_RUNTIME_PATH = BROWSER_DIR / "locale-resolution.js"
TOPONYM_RESOLUTION_POLICY_PATH = TOPONYM_RESOLUTION_DIR / "policy.json"
LANGUAGE_MAP_VENDOR_DIR = BROWSER_DIR / "vendor" / "map"
PUBLIC_COVERAGE_FIELDS = (
    "generated_at",
    "revision",
    "locales",
    "country_codes",
    "representative_core_regions",
    "ui_locales",
    "ui_fallback_locales",
    "speaker_estimate_source",
    "atlas_language_metadata",
)
PUBLIC_LOCALE_FIELDS = (
    "locale",
    "slug",
    "public_identity",
    "hreflang",
    "native_name",
    "auxiliary_name",
    "family_en",
    "speaker_estimate",
    "direction",
    "published",
    "href",
    "state",
)


def _admin1_output_filename(configured_url: str) -> str:
    configured_path = Path(str(configured_url).split("?", 1)[0].removeprefix("./"))
    if configured_path.parent.name == "country":
        filename = f"country-{configured_path.name}"
    elif configured_path.parent.name == "lang":
        filename = f"lang-{configured_path.name}"
    else:
        filename = configured_path.name
    return filename if filename.endswith(".gz") else f"{filename}.gz"


def _admin1_config_path(configured_url: str) -> Path:
    configured_path = Path(str(configured_url).split("?", 1)[0].removeprefix("./"))
    return LANGUAGE_MAP_ADMIN1_PATH.parent / configured_path


def _gzip_payload(payload: str) -> bytes:
    return gzip.compress(payload.encode("utf-8"), compresslevel=9, mtime=0)


def _enrich_admin1_properties(properties: dict) -> dict:
    if admin1_names is None:
        return dict(properties)
    return admin1_names.enrich_admin1_properties(properties)


def _admin1_chunk_payload(configured_url: str) -> tuple[str, bytes, dict]:
    chunk_path = _admin1_config_path(configured_url)
    filename = _admin1_output_filename(configured_url)
    collection = json.loads(chunk_path.read_text(encoding="utf-8"))
    enriched_features = []
    for feature in collection.get("features") or []:
        packed = json.loads(json.dumps(feature, ensure_ascii=False))
        packed["properties"] = _enrich_admin1_properties(packed.get("properties") or {})
        enriched_features.append(packed)
    collection = {**collection, "features": enriched_features}
    payload = json.dumps(
        collection,
        ensure_ascii=False,
        separators=(",", ":"),
    ) + "\n"
    return filename, _gzip_payload(payload), collection


def _admin1_country_chunk_urls() -> dict[str, str]:
    """Map every on-disk country Admin-1 chunk for country-mode boundary drawing.

    Language regional rules only list countries they paint. Country-mode
    subdivision outlines need the full Natural Earth country set, including
    places like KR/KP that have no language-region rules yet.
    """
    urls: dict[str, str] = {}
    for path in sorted((LANGUAGE_MAP_ADMIN1_DIR / "country").glob("*.geojson")):
        code = path.stem
        if not re.fullmatch(r"[A-Z]{2}", code):
            continue
        urls[code] = f"./country/{path.name}"
    return urls


def _admin1_feature_mean_lon(feature: dict) -> float:
    coordinates: list[list[float]] = []

    def walk(node) -> None:
        if isinstance(node, (list, tuple)) and node and isinstance(node[0], (int, float)):
            coordinates.append(list(node))
            return
        for child in node or []:
            walk(child)

    walk((feature.get("geometry") or {}).get("coordinates"))
    if not coordinates:
        return 0.0
    return sum(point[0] for point in coordinates) / len(coordinates)


def _admin1_feature_matches_filter(feature: dict, feature_filter: dict | None) -> bool:
    if not feature_filter:
        return True
    longitude = _admin1_feature_mean_lon(feature)
    if "lon_max" in feature_filter and not (longitude < float(feature_filter["lon_max"])):
        return False
    if "lon_min" in feature_filter and not (longitude >= float(feature_filter["lon_min"])):
        return False
    return True


def _admin1_boundary_regions() -> dict[str, dict]:
    """Load the country-mode Admin-1 world region partition.

    Tiny territories are intentionally absorbed into neighboring regional packs so
    a Vatican or Pacific atoll never becomes its own network request.
    """
    configured = hub.load_json(LANGUAGE_MAP_ADMIN1_REGIONS_PATH)
    regions = configured.get("regions") or {}
    if not isinstance(regions, dict) or not regions:
        raise ValueError("Admin-1 boundary regions are not configured")
    normalized: dict[str, dict] = {}
    country_owners: dict[str, list[str]] = {}
    for region_id, entry in regions.items():
        if not re.fullmatch(r"[a-z][a-z0-9-]*", str(region_id)):
            raise ValueError(f"invalid Admin-1 boundary region id: {region_id}")
        countries = [
            str(code).strip().upper()
            for code in (entry.get("countries") or [])
        ]
        if not countries or any(not re.fullmatch(r"[A-Z]{2}", code) for code in countries):
            raise ValueError(f"Admin-1 boundary region {region_id} has invalid countries")
        feature_filter = entry.get("feature_filter") or None
        if feature_filter is not None and not isinstance(feature_filter, dict):
            raise ValueError(f"Admin-1 boundary region {region_id} has invalid feature_filter")
        neighbors = [
            str(neighbor).strip()
            for neighbor in (entry.get("neighbors") or [])
        ]
        unknown_neighbors = [neighbor for neighbor in neighbors if neighbor not in regions]
        if unknown_neighbors:
            raise ValueError(
                f"Admin-1 boundary region {region_id} references unknown neighbors: "
                f"{', '.join(unknown_neighbors)}"
            )
        for code in countries:
            country_owners.setdefault(code, []).append(str(region_id))
        normalized[str(region_id)] = {
            "countries": countries,
            "neighbors": neighbors,
            "feature_filter": feature_filter,
        }
    for code, owners in sorted(country_owners.items()):
        if len(owners) <= 1:
            continue
        filters = [normalized[region_id].get("feature_filter") for region_id in owners]
        if not all(filters):
            raise ValueError(
                f"Admin-1 country {code} is reused across regions without feature filters: "
                f"{', '.join(owners)}"
            )
    return normalized


def _language_admin1_assets(manifest: dict) -> tuple[dict, dict[str, bytes]]:
    """Build derived language bundles and compact optional prefetch bundles."""
    # Publish every country chunk, not only those referenced by language rules.
    countries = dict(manifest.get("countries") or {})
    countries.update(_admin1_country_chunk_urls())
    boundary_regions = _admin1_boundary_regions()
    for region_id, entry in boundary_regions.items():
        unknown = [code for code in entry["countries"] if code not in countries]
        if unknown:
            raise ValueError(
                f"Admin-1 boundary region {region_id} references missing country chunks: "
                f"{', '.join(unknown)}"
            )
    assigned = {
        code
        for entry in boundary_regions.values()
        for code in entry["countries"]
    }
    orphan_countries = sorted(set(countries) - assigned)
    if orphan_countries:
        raise ValueError(
            "Admin-1 boundary regions must absorb every country chunk so tiny "
            f"territories are never fetched alone: {', '.join(orphan_countries)}"
        )
    manifest = {
        **manifest,
        "countries": dict(sorted(countries.items())),
    }
    source_urls = manifest.get("sources") or {}
    country_urls = manifest.get("countries") or {}
    chunk_cache: dict[str, tuple[str, bytes, dict]] = {}

    def source_chunk(source: str) -> tuple[str, bytes, dict]:
        configured_url = source_urls.get(source) or country_urls.get(source)
        if not configured_url:
            raise ValueError(f"Admin-1 geometry source is not configured: {source}")
        cache_key = str(configured_url).split("?", 1)[0]
        if cache_key not in chunk_cache:
            chunk_cache[cache_key] = _admin1_chunk_payload(configured_url)
        return chunk_cache[cache_key]

    # Keep country and custom-source chunks available as public/debugging
    # artifacts. Runtime rules below point at the smaller language bundles.
    chunks: dict[str, bytes] = {}
    runtime_sources: dict[str, str] = {}
    for source, configured_url in sorted(source_urls.items()):
        filename, payload, _collection = source_chunk(source)
        chunks[filename] = payload
        runtime_sources[source] = configured_url

    runtime_languages: dict[str, list[dict]] = {}
    country_prefetch_languages: dict[str, set[str]] = {}
    language_features: dict[str, list[dict]] = {}
    for language, configured_rules in (manifest.get("languages") or {}).items():
        if not language.replace("-", "").isalnum():
            raise ValueError(f"invalid Admin-1 language id: {language}")
        selected_features: list[dict] = []
        selected_feature_keys: set[str] = set()
        runtime_rules: list[dict] = []
        for configured_rule in configured_rules:
            rule = dict(configured_rule)
            if rule.get("feature_ids"):
                runtime_rules.append(rule)
                continue
            source = str(rule.get("source") or rule.get("country") or "")
            country = str(rule.get("country") or "")
            _filename, _payload, collection = source_chunk(source)
            region_ids = set(rule.get("regions") or [])
            matched_ids: set[str] = set()
            for feature in collection.get("features") or []:
                feature_id = str((feature.get("properties") or {}).get("id") or "")
                if feature_id not in region_ids:
                    continue
                matched_ids.add(feature_id)
                feature_key = json.dumps(
                    feature,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                if feature_key in selected_feature_keys:
                    pass
                else:
                    selected_feature_keys.add(feature_key)
                    selected_features.append(feature)
            unknown = sorted(region_ids - matched_ids)
            if unknown:
                raise ValueError(
                    f"{language}/{rule.get('country')} references missing Admin-1 regions: "
                    f"{', '.join(unknown)}"
                )
            if country and matched_ids:
                country_prefetch_languages.setdefault(country, set()).add(language)
            # Every regional rule for a selected language reads the same exact
            # bundle. This avoids fetching an entire country for a small
            # cross-border distribution while retaining rule-level filtering.
            rule["source"] = language
            runtime_rules.append(rule)
        runtime_languages[language] = runtime_rules
        if not selected_features:
            continue
        language_features[language] = selected_features
        filename = f"lang-{language}.geojson.gz"
        payload = json.dumps(
            {"type": "FeatureCollection", "features": selected_features},
            ensure_ascii=False,
            separators=(",", ":"),
        ) + "\n"
        chunks[filename] = _gzip_payload(payload)
        runtime_sources[language] = f"./language-map-admin1/{filename}"

    # Country search is an intent signal for several possible languages. Bundle
    # the complete language chunks for every language related to that country,
    # not only the features located inside the country. Once prefetch-CN has
    # arrived, for example, selecting Kazakh or Kyrgyz must not require a second
    # request for lang-kk or lang-ky. Identical features remain stored once and
    # carry their language memberships as an index.
    country_prefetch_features: dict[str, list[dict]] = {}
    for country, languages in sorted(country_prefetch_languages.items()):
        country_features: list[dict] = []
        country_indexes: dict[str, int] = {}
        for language in sorted(languages):
            for feature in language_features.get(language, []):
                feature_key = json.dumps(
                    feature,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                if feature_key not in country_indexes:
                    packed_feature = json.loads(feature_key)
                    packed_feature.setdefault("properties", {})["prefetch_languages"] = [language]
                    country_indexes[feature_key] = len(country_features)
                    country_features.append(packed_feature)
                    continue
                packed_feature = country_features[country_indexes[feature_key]]
                packed_languages = packed_feature["properties"]["prefetch_languages"]
                if language not in packed_languages:
                    packed_languages.append(language)
        country_prefetch_features[country] = country_features

    runtime_prefetch: dict[str, str] = {}
    runtime_prefetch_sources: dict[str, list[str]] = {}
    for country, features in sorted(country_prefetch_features.items()):
        languages = country_prefetch_languages.get(country) or set()
        if len(languages) < 2:
            continue
        filename = f"prefetch-{country}.geojson.gz"
        payload = json.dumps(
            {
                "type": "FeatureCollection",
                "prefetch_sources": sorted(languages),
                "features": features,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ) + "\n"
        compressed = _gzip_payload(payload)
        individual_size = sum(
            len(chunks.get(f"lang-{language}.geojson.gz", b""))
            for language in languages
        )
        if not individual_size or len(compressed) >= individual_size:
            continue
        chunks[filename] = compressed
        runtime_prefetch[country] = f"./language-map-admin1/{filename}"
        runtime_prefetch_sources[country] = sorted(languages)

    # Also provide one opt-in world bundle for clients that have a strong
    # reason to prefetch every referenced Admin-1 geometry. This is another
    # generated cache product, not a second source of truth: identical features
    # are stored once and retain their language membership as an index.
    world_features: list[dict] = []
    world_feature_indexes: dict[str, int] = {}
    for features in country_prefetch_features.values():
        for feature in features:
            packed_feature = json.loads(json.dumps(feature, ensure_ascii=False))
            properties = packed_feature.setdefault("properties", {})
            languages = set(properties.pop("prefetch_languages", []) or [])
            feature_key = json.dumps(
                packed_feature,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            if feature_key not in world_feature_indexes:
                properties["prefetch_languages"] = sorted(languages)
                world_feature_indexes[feature_key] = len(world_features)
                world_features.append(packed_feature)
                continue
            stored_languages = world_features[
                world_feature_indexes[feature_key]
            ]["properties"]["prefetch_languages"]
            stored_languages[:] = sorted(set(stored_languages) | languages)

    runtime_prefetch_world = ""
    if world_features:
        filename = "prefetch-world.geojson.gz"
        payload = json.dumps(
            {
                "type": "FeatureCollection",
                "prefetch_sources": sorted({
                    language
                    for feature in world_features
                    for language in feature.get("properties", {}).get("prefetch_languages", [])
                }),
                "features": world_features,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ) + "\n"
        compressed = _gzip_payload(payload)
        individual_size = sum(
            len(chunk_payload)
            for chunk_name, chunk_payload in chunks.items()
            if chunk_name.startswith("lang-")
        )
        if individual_size and len(compressed) < individual_size:
            chunks[filename] = compressed
            runtime_prefetch_world = f"./language-map-admin1/{filename}"

    runtime_manifest = {
        **manifest,
        "sources": runtime_sources,
        "languages": runtime_languages,
        "prefetch": runtime_prefetch,
        "prefetch_sources": runtime_prefetch_sources,
        "prefetch_world": runtime_prefetch_world,
    }
    for configured_url in country_urls.values():
        filename = _admin1_output_filename(configured_url)
        if filename in chunks:
            continue
        _filename, payload, _collection = _admin1_chunk_payload(configured_url)
        chunks[filename] = payload

    # Country-mode Admin-1 outlines load by focus-sized world region packs so a
    # Korea view pulls east-asia once, and microstates ride along with neighbors.
    runtime_regions: dict[str, dict] = {}
    for region_id, entry in sorted(boundary_regions.items()):
        features: list[dict] = []
        feature_filter = entry.get("feature_filter")
        for country in entry["countries"]:
            _filename, _payload, collection = source_chunk(country)
            for feature in collection.get("features") or []:
                if not _admin1_feature_matches_filter(feature, feature_filter):
                    continue
                packed = json.loads(json.dumps(feature, ensure_ascii=False))
                properties = packed.setdefault("properties", {})
                properties["country"] = country
                packed["properties"] = _enrich_admin1_properties(properties)
                features.append(packed)
        filename = f"region-{region_id}.geojson.gz"
        raw = (
            json.dumps(
                {
                    "type": "FeatureCollection",
                    "region": region_id,
                    "countries": entry["countries"],
                    "features": features,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
            + "\n"
        ).encode("utf-8")
        # Same stable gzip recipe as place packs: hash the bytes we publish.
        chunks[filename] = gzip.compress(raw, compresslevel=9, mtime=0)
        region_meta = {
            "countries": entry["countries"],
            "neighbors": entry["neighbors"],
            "url": f"./language-map-admin1/{filename}",
        }
        if feature_filter:
            region_meta["feature_filter"] = feature_filter
        runtime_regions[region_id] = region_meta
    runtime_manifest["regions"] = runtime_regions
    return runtime_manifest, chunks


def _language_place_assets(
    places: dict,
    toponym_resolution: dict,
    usage_overrides: dict | None = None,
) -> tuple[dict, dict[str, bytes]]:
    """Split map labels into one core and writing-system name packs.

    The numeric core is shared by every UI language. Each script pack contains
    city and place names plus sparse locale-specific overrides. Country and
    territory names live alongside these packs in the separate geography-name
    asset family.
    """

    rows: list[list] = []
    core_countries: dict[str, dict] = {}
    available_scripts: set[str] = set()
    locale_overrides: dict[str, dict[int, str]] = {}
    place_indices: dict[tuple[str, str], list[int]] = {}
    for country, configured_country in (places.get("countries") or {}).items():
        country_places = configured_country.get("places") or []
        core_country = {
            key: configured_country[key]
            for key in (
                "budget",
                "broad_label_floor",
                "selected_label_floor",
                "prefer_place_labels_when_selected",
            )
            if key in configured_country
        }
        core_country["places"] = []
        representative_name = str(configured_country.get("representative_place") or "")
        for country_index, row in enumerate(country_places):
            if len(row) < 7 or not isinstance(row[6], dict):
                raise ValueError(f"invalid multilingual place row: {country}/{country_index}")
            global_index = len(rows)
            rows.append(row)
            place_indices.setdefault((str(country), str(row[5])), []).append(global_index)
            core_country["places"].append(row[:5])
            if representative_name and str(row[5]) == representative_name:
                core_country["representative_place_index"] = country_index
            names = row[6]
            available_scripts.update(str(key) for key in (names.get("scripts") or {}))
            for locale, value in (names.get("locales") or {}).items():
                normalized_locale = str(locale).replace("_", "-").lower()
                if not normalized_locale.replace("-", "").isalnum():
                    raise ValueError(f"invalid place-name locale id: {locale}")
                if value:
                    locale_overrides.setdefault(normalized_locale, {})[global_index] = str(value)
        core_countries[str(country)] = core_country

    if usage_overrides is None:
        usage_overrides = {"schema": 1, "places": []}
    if not isinstance(usage_overrides, dict) or usage_overrides.get("schema") != 1:
        raise ValueError("unsupported place-name usage override schema")
    configured_usage_places = usage_overrides.get("places")
    if not isinstance(configured_usage_places, list):
        raise ValueError("place-name usage overrides must contain a places list")
    seen_usage_overrides: set[tuple[int, str]] = set()
    for override_index, override in enumerate(configured_usage_places):
        if not isinstance(override, dict):
            raise ValueError(f"invalid place-name usage override: {override_index}")
        country = str(override.get("country") or "")
        place = str(override.get("place") or "").strip()
        if len(country) != 2 or country != country.upper() or not place:
            raise ValueError(f"invalid place-name usage override identity: {override_index}")
        matching_indices = place_indices.get((country, place), [])
        if len(matching_indices) != 1:
            raise ValueError(
                f"place-name usage override must match exactly one place: {country}/{place}"
            )
        evidence = override.get("evidence") or {}
        if not isinstance(evidence, dict):
            raise ValueError(
                f"place-name usage override has invalid evidence: {country}/{place}"
            )
        sources = evidence.get("sources") or []
        if evidence.get("basis") != "attested-usage" or not isinstance(sources, list):
            raise ValueError(
                f"place-name usage override lacks attested evidence: {country}/{place}"
            )
        if not sources or any(
            not isinstance(source, dict)
            or not str(source.get("url") or "").startswith(("https://", "http://"))
            for source in sources
        ):
            raise ValueError(
                f"place-name usage override lacks a source URL: {country}/{place}"
            )
        locale_names = override.get("locale_names")
        if not isinstance(locale_names, dict) or not locale_names:
            raise ValueError(
                f"place-name usage override lacks locale names: {country}/{place}"
            )
        global_index = matching_indices[0]
        for locale, value in locale_names.items():
            normalized_locale = str(locale).replace("_", "-").lower()
            normalized_value = str(value).strip()
            if not normalized_locale.replace("-", "").isalnum() or not normalized_value:
                raise ValueError(
                    f"invalid attested place-name override: {country}/{place}/{locale}"
                )
            usage_key = (global_index, normalized_locale)
            if usage_key in seen_usage_overrides:
                raise ValueError(
                    f"duplicate attested place-name override: {country}/{place}/{locale}"
                )
            seen_usage_overrides.add(usage_key)
            locale_overrides.setdefault(normalized_locale, {})[global_index] = normalized_value

    script_fallbacks = {
        str(script): [str(item) for item in fallbacks]
        for script, fallbacks in (toponym_resolution.get("script_fallbacks") or {}).items()
    }
    final_scripts = [
        str(script) for script in (toponym_resolution.get("final_scripts") or ["Latn"])
    ]
    locale_scripts = {
        str(locale).replace("_", "-").lower(): str(script)
        for locale, script in (toponym_resolution.get("locale_scripts") or {}).items()
    }
    unassigned_locales = sorted(set(locale_overrides) - set(locale_scripts))
    if unassigned_locales:
        raise ValueError(
            "place-name locale override has no script assignment: "
            + ", ".join(unassigned_locales)
        )

    def script_order(script: str) -> list[str]:
        ordered: list[str] = []
        seen: set[str] = set()

        def append(candidate: str) -> None:
            if not candidate or candidate in seen:
                return
            seen.add(candidate)
            ordered.append(candidate)
            for fallback in script_fallbacks.get(candidate, []):
                append(fallback)

        append(script)
        for final_script in final_scripts:
            append(final_script)
        return ordered

    chunks: dict[str, bytes] = {}

    def write_chunk(filename: str, payload: dict) -> str:
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        compressed = gzip.compress(raw, compresslevel=9, mtime=0)
        chunks[filename] = compressed
        version = hashlib.sha256(compressed).hexdigest()[:12]
        return f"./map-geography/places/{filename}?v={version}"

    core_payload = {
        "schema": 2,
        "fields": ["longitude", "latitude", "minimum_zoom", "capital", "population"],
        "countries": core_countries,
    }
    core_url = write_chunk("core.json.gz", core_payload)
    pack_urls: dict[str, str] = {}
    pack_payloads: dict[str, dict] = {}
    bundled_scripts = available_scripts | set(locale_scripts.values())
    for script in sorted(bundled_scripts):
        if not script.replace("-", "").isalnum():
            raise ValueError(f"invalid place-name script id: {script}")
        names = []
        candidates = script_order(script)
        for row in rows:
            row_script_names = row[6].get("scripts") or {}
            resolved = next(
                (str(row_script_names[candidate]) for candidate in candidates if row_script_names.get(candidate)),
                str(row[5]),
            )
            names.append(resolved)
        packed_locales: dict[str, dict[str, list[list]]] = {}
        for locale, overrides in sorted(locale_overrides.items()):
            if locale_scripts[locale] == script:
                packed_locales.setdefault(locale, {})["places"] = [
                    [place_index, value]
                    for place_index, value in sorted(overrides.items())
                ]
        pack_payload = {
            "schema": 2,
            "script": script,
            "names": names,
            "locales": packed_locales,
        }
        pack_payloads[script] = pack_payload
        pack_urls[script] = write_chunk(f"pack-{script}.json.gz", pack_payload)
    unavailable_scripts = sorted(set(locale_scripts.values()) - bundled_scripts)
    if unavailable_scripts:
        raise ValueError(
            "place-name locale override targets an unavailable script: "
            + ", ".join(unavailable_scripts)
        )
    all_url = write_chunk(
        "all.json.gz",
        {"schema": 2, "core": core_payload, "packs": pack_payloads},
    )
    return (
        {
            "schema": 2,
            "encoding": "gzip",
            "place_count": len(rows),
            "core": core_url,
            "packs": pack_urls,
            "all": all_url,
        },
        chunks,
    )


def _publication_links(source: Path | dict | None) -> dict[str, str]:
    """Read the small, product-neutral publication contract supplied by a host."""
    if source is None:
        return {}
    raw = hub.load_json(source) if isinstance(source, Path) else source
    if not isinstance(raw, dict) or raw.get("schema") != 1:
        raise ValueError("Atlas publication manifest must have schema 1")
    entries = raw.get("locales") or []
    if not isinstance(entries, list):
        raise ValueError("Atlas publication manifest locales must be a list")
    links: dict[str, str] = {}
    for entry in entries:
        if isinstance(entry, str):
            locale, href = entry, ""
        elif isinstance(entry, dict):
            locale = str(entry.get("locale") or "").strip()
            href = str(entry.get("href") or "").strip()
        else:
            raise ValueError("Atlas publication entries must be locale strings or objects")
        if not locale:
            raise ValueError("Atlas publication entry is missing locale")
        if locale in links:
            raise ValueError(f"duplicate Atlas publication locale: {locale}")
        links[locale] = href
    return links


def _project_revision() -> str:
    configured = str(os.environ.get("ATLAS_REVISION") or "").strip()
    if configured:
        return configured
    completed = subprocess.run(
        ["git", "-C", str(ATLAS_ROOT), "rev-parse", "--short=12", "HEAD"],
        check=False,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip() if completed.returncode == 0 else ""


def _coverage_ui_locale_id(item: dict, configured_ids: set[str]) -> str:
    """Match one registry locale to its configured coverage-interface identity.

    Coverage UI translations commonly use a neutral language ID (``de``), while
    rendered HTML may use a regional hreflang (``de-DE``). Prefer any identity
    already present in the UI catalog before inventing a fallback for a newly
    enabled candidate.
    """
    return hub.locale_catalog_identity(item, configured_ids)


def _load_map_localizations() -> dict:
    locale_ids = None
    version = 1
    message_sources = {}
    for kind, path in MAP_LOCALIZATION_SOURCE_PATHS.items():
        payload = hub.load_json(path)
        locales = payload.get("locales")
        messages = payload.get("messages")
        if (
            payload.get("schema") != 2
            or not isinstance(payload.get("version"), int)
            or int(payload["version"]) <= 0
            or payload.get("kind") != kind
            or not isinstance(locales, list)
            or any(not isinstance(locale, str) or not locale for locale in locales)
            or locales != sorted(set(locales))
            or not isinstance(messages, dict)
            or not messages
        ):
            raise ValueError(f"invalid language-map localization source: {path}")
        if locale_ids is None:
            locale_ids = locales
        elif locales != locale_ids:
            raise ValueError("language-map localization sources must use the same locales")
        version = max(version, int(payload["version"]))
        for key, record in messages.items():
            if key in message_sources:
                raise ValueError(f"duplicate language-map message key: {key}")
            if (
                not isinstance(key, str)
                or not key
                or not isinstance(record, dict)
                or not isinstance(record.get("context"), str)
                or not record["context"].strip()
                or not isinstance(record.get("translations"), dict)
                or "en" not in record["translations"]
            ):
                raise ValueError(f"invalid language-map message: {kind}/{key}")
            expected_placeholders = sorted(set(re.findall(
                r"\{[A-Za-z][A-Za-z0-9_]*\}",
                record["translations"]["en"],
            )))
            if any(
                placeholder not in record["context"]
                for placeholder in expected_placeholders
            ):
                raise ValueError(f"language-map context omits a placeholder: {kind}/{key}")
            for locale, translation in record["translations"].items():
                if locale not in locales:
                    raise ValueError(f"unknown language-map message locale: {key}/{locale}")
                if not isinstance(translation, str) or not translation.strip():
                    raise ValueError(f"invalid language-map translation: {key}/{locale}")
                if sorted(set(re.findall(
                    r"\{[A-Za-z][A-Za-z0-9_]*\}", translation
                ))) != expected_placeholders:
                    raise ValueError(
                        f"language-map placeholders differ from English: {key}/{locale}"
                    )
            message_sources[key] = record
    if not locale_ids or not {"ja", "en"} <= set(locale_ids):
        raise ValueError("language map localizations require ja and en payloads")
    localizations = {
        locale: {
            "schema": 1,
            "version": version,
            "locale": locale,
            "messages": {},
        }
        for locale in locale_ids
    }
    for key, record in message_sources.items():
        for locale, translation in record["translations"].items():
            localizations[locale]["messages"][key] = translation
    return localizations


def _load_description_localizations(
    localization_ids: set[str] | None = None,
) -> tuple[dict, dict]:
    """Transpose entity-oriented description sources into display-locale packs."""
    localization_ids = localization_ids or set(_load_map_localizations())
    localizations = {
        locale: {
            "schema": 1,
            "version": 1,
            "locale": locale,
            "languages": {},
            "families": {},
            "scripts": {},
        }
        for locale in sorted(localization_ids)
    }
    sources = {}
    for kind, path in MAP_DESCRIPTION_PATHS.items():
        payload = hub.load_json(path)
        descriptions = payload.get("descriptions")
        if (
            payload.get("schema") != 1
            or not isinstance(payload.get("version"), int)
            or int(payload["version"]) <= 0
            or payload.get("kind") != kind
            or not isinstance(descriptions, dict)
        ):
            raise ValueError(f"invalid language-map {kind} descriptions: {path}")
        sources[kind] = payload
        for entity, translations in descriptions.items():
            if (
                not isinstance(entity, str)
                or not entity.strip()
                or not isinstance(translations, dict)
            ):
                raise ValueError(f"invalid {kind} description entity: {entity!r}")
            for locale, description in translations.items():
                locale_id = locale.replace("_", "-")
                if locale_id not in localizations:
                    raise ValueError(f"unknown {kind} description locale: {locale}")
                if not isinstance(description, str) or not description.strip():
                    raise ValueError(f"invalid {kind} description: {entity}/{locale}")
                localizations[locale_id][kind][entity] = description
    return localizations, sources


def _load_geography_localizations(localization_ids: set[str] | None = None) -> dict:
    localization_ids = localization_ids or set(_load_map_localizations())
    localizations = {
        locale: {"schema": 1, "version": 1, "locale": locale}
        for locale in sorted(localization_ids)
    }
    country_catalog = country_names.build_catalog()
    override_catalog = hub.load_json(COUNTRY_NAME_OVERRIDES_PATH)
    country_codes = sorted(
        (hub.load_json(LANGUAGE_MAP_PATH).get("iso2_to_iso3") or {}).keys()
    )
    if (
        country_catalog.get("schema") != 3
        or country_catalog.get("style") != "long"
        or country_catalog.get("alternates") != {
            "CD": "variant", "CG": "variant", "HK": "short", "MO": "short", "PS": "short"
        }
        or country_catalog.get("country_codes") != country_codes
        or not isinstance(country_catalog.get("locales"), dict)
        or not isinstance(country_catalog.get("unsupported_locales"), list)
        or not isinstance(country_catalog.get("source"), dict)
        or country_catalog["source"].get("license") != "Unicode-3.0"
    ):
        raise ValueError("invalid CLDR country-name catalog")
    if (
        override_catalog.get("schema") != 1
        or not isinstance(override_catalog.get("version"), int)
        or int(override_catalog["version"]) <= 0
        or override_catalog.get("base") != "unicode-cldr-json"
        or not isinstance(override_catalog.get("review_sources"), list)
        or override_catalog.get("territory") != "CN"
        or not isinstance(override_catalog.get("locales"), dict)
    ):
        raise ValueError("invalid language country-name overrides")
    overrides = override_catalog["locales"]
    if not set(overrides) <= set(localizations):
        raise ValueError(
            "country-name overlays target unknown Atlas localizations: "
            + ", ".join(sorted(set(overrides) - set(localizations)))
        )
    catalog_locales = country_catalog["locales"]
    if set(catalog_locales) | set(country_catalog["unsupported_locales"]) != set(localizations):
        raise ValueError("CLDR country-name locale coverage is stale")
    for locale, entry in catalog_locales.items():
        names = entry.get("names") if isinstance(entry, dict) else None
        if not isinstance(names, dict) or set(names) != set(country_codes):
            raise ValueError(f"invalid CLDR country names for map UI locale: {locale}")

    for locale, payload in localizations.items():
        configured = overrides.get(locale) or {}
        if configured and (
            any(len(code) != 2 or not code.isalpha() or code.upper() != code for code in configured)
            or any(not isinstance(name, str) or not name.strip() for name in configured.values())
        ):
            raise ValueError(f"invalid country-name overrides for map UI locale: {locale}")
        payload["country_names"] = {
            **((catalog_locales.get(locale) or {}).get("names") or {}),
            **(payload.get("country_names") or {}),
            **configured,
        }
        by_name = {}
        for code, name in payload["country_names"].items():
            normalized = " ".join(unicodedata.normalize("NFKC", name).casefold().split())
            by_name.setdefault(normalized, []).append(code)
        collisions = [codes for codes in by_name.values() if len(codes) > 1]
        if collisions:
            rendered = ", ".join("/".join(codes) for codes in collisions)
            raise ValueError(f"country-name collisions for {locale}: {rendered}")
    return localizations


def _load_linguistic_localizations(localization_ids: set[str] | None = None) -> tuple[dict, dict]:
    localization_ids = localization_ids or set(_load_map_localizations())
    catalog = linguistic_names.build_catalog()
    if (
        catalog.get("schema") != 1
        or catalog.get("source", {}).get("license") != "Unicode-3.0"
        or not isinstance(catalog.get("locales"), dict)
        or not isinstance(catalog.get("native_names"), dict)
        or set(catalog.get("locales") or {}) | set(catalog.get("unsupported_locales") or [])
        != set(localization_ids)
    ):
        raise ValueError("invalid CLDR linguistic-name catalog")
    return catalog["locales"], catalog


def _taxonomy_label(path: str, locale: str, localizations: dict) -> str:
    terms = [term.strip() for term in str(path or "").split("›") if term.strip()]
    localized = (
        ((((localizations.get(locale) or {}).get("taxonomy") or {}).get("families") or {}).get("labels"))
        or {}
    )
    return " › ".join(str(localized.get(term) or term) for term in terms)


def _linguistic_language_name(code: str, locale: str, localizations: dict) -> str:
    record = (
        (((localizations.get(locale) or {}).get("languages") or {}).get(code))
        or {}
    )
    return str(record.get("name") or "")


def _optional_page_copy_bundle(path: Path, *, kind: str) -> dict:
    """Host-owned page strings. Absent → empty (Kotonohatlas alone has no messages)."""
    if not path.is_file():
        return {"schema": 0, "version": 0, "messages": {}}
    data = hub.load_json(path)
    messages = data.get("messages") or {}
    if not isinstance(messages, dict):
        raise ValueError(f"invalid {kind} localization bundle: messages")
    return data


def build_snapshot(
    publications: Path | dict | None = None,
    *,
    revision: str = "",
) -> dict:
    registry_all = hub.locales_config()["locales"]
    registry = [item for item in registry_all if hub.locale_enabled(item)]
    layout = hub.public_locale_layout(registry)
    coverage_config = hub.load_json(CONFIG_PATH)
    speaker_data = speaker_estimates.build_catalog()
    ui_data = _optional_page_copy_bundle(UI_MESSAGES_PATH, kind="coverage UI")
    intro_data = _optional_page_copy_bundle(UI_INTRO_PATH, kind="coverage intro")
    ui_messages = ui_data.get("messages") or {}
    intro_messages = intro_data.get("messages") or {}
    if ui_messages and (
        ui_data.get("schema") != 3
        or not isinstance(ui_data.get("version"), int)
        or int(ui_data["version"]) <= 0
    ):
        raise ValueError("invalid Kotonohatlas coverage UI localization bundle")
    if intro_messages and (
        intro_data.get("schema") != 1
        or not isinstance(intro_data.get("version"), int)
        or int(intro_data["version"]) <= 0
    ):
        raise ValueError("invalid host-introduction localization bundle")
    merged_ui_messages = {}
    locales = set(ui_messages) | set(intro_messages)
    for locale in locales:
        ui_locale = ui_messages.get(locale) or {}
        intro_locale = intro_messages.get(locale) or {}
        if not isinstance(ui_locale, dict) or not isinstance(intro_locale, dict):
            raise ValueError(f"invalid page copy locale payload: {locale}")
        duplicate_keys = set(ui_locale) & set(intro_locale)
        if duplicate_keys:
            raise ValueError(
                f"coverage UI and intro localization bundles overlap for {locale}: "
                + ", ".join(sorted(duplicate_keys))
            )
        merged_ui_messages[locale] = {**intro_locale, **ui_locale}
    map_localizations = _load_map_localizations()
    description_localizations, description_sources = _load_description_localizations(
        set(map_localizations)
    )
    geography_localizations = _load_geography_localizations(set(map_localizations))
    linguistic_localizations, linguistic_catalog = _load_linguistic_localizations(
        set(map_localizations)
    )
    atlas_language_metadata = hub.load_json(LANGUAGE_ATLAS_METADATA_PATH)
    speaker_estimate_values = speaker_data.get("estimates") or {}
    for code, profile in (atlas_language_metadata.get("profiles") or {}).items():
        estimate = speaker_estimate_values.get(code)
        if isinstance(estimate, int) and estimate > 0:
            profile["speaker_estimate"] = estimate
        else:
            profile.pop("speaker_estimate", None)
    publication_links = _publication_links(publications)
    localized_locale_ids = {str(item["locale"]) for item in registry}
    if not set(publication_links) <= localized_locale_ids:
        raise ValueError(
            "Atlas publication manifest contains locales not localized by Atlas: "
            + ", ".join(sorted(set(publication_links) - supported_locale_ids))
        )

    family_by_locale: dict[str, dict[str, str]] = {}
    for family in coverage_config.get("language_families") or []:
        family_data = {
            "id": str(family["id"]),
            "en": _taxonomy_label(family["taxonomy"], "en", linguistic_localizations),
        }
        for locale in family.get("members") or []:
            locale = str(locale)
            if locale in family_by_locale:
                raise ValueError(f"locale belongs to multiple language families: {locale}")
            family_by_locale[locale] = family_data

    locale_rows = []
    for item in registry:
        locale = str(item["locale"])
        public_identity = hub.public_locale_identity(item)
        family = family_by_locale.get(locale) or {}
        speaker_estimate = speaker_estimate_values.get(locale)
        auxiliary_name = _linguistic_language_name(locale, "en", linguistic_localizations)
        if not auxiliary_name:
            raise ValueError(f"missing generated auxiliary language name: {locale}")
        locale_row = {
            "locale": locale,
            "slug": layout[locale],
            "public_identity": public_identity,
            "hreflang": str(item.get("html_language") or public_identity),
            "native_name": str(item["name"]),
            "auxiliary_name": auxiliary_name,
            "family_en": str(family.get("en") or ""),
            "speaker_estimate": speaker_estimate,
            "direction": hub.locale_direction(item),
            "published": locale in publication_links,
            "href": publication_links.get(locale) or (
                f"./{layout[locale]}/" if locale in publication_links else ""
            ),
            "state": "localized",
        }
        locale_rows.append(locale_row)

    configured_ui_rows = {
        str(item.get("id") or ""): item
        for item in (ui_data.get("locales") or [])
        if isinstance(item, dict) and item.get("id")
    }
    configured_ui_ids = set(configured_ui_rows) or set(map_localizations)
    ui_locales = []
    ui_locale_ids: set[str] = set()
    for item in registry:
        ui_id = _coverage_ui_locale_id(item, configured_ui_ids)
        if ui_id in ui_locale_ids:
            continue
        configured_ui_row = configured_ui_rows.get(ui_id) or {}
        ui_locales.append({
            "id": ui_id,
            "label": str(configured_ui_row.get("label") or item.get("name") or item["locale"]),
            "direction": str(configured_ui_row.get("direction") or hub.locale_direction(item)),
        })
        ui_locale_ids.add(ui_id)
        # Empty payloads intentionally inherit the configured fallback atlas
        # localization (English by default) until this locale is translated.
        map_localizations.setdefault(
            ui_id, {"schema": 1, "version": 1, "locale": ui_id, "messages": {}, "taxonomy": {}}
        )

    ui_fallback_locales = hub.locale_fallbacks_for_catalog(ui_locale_ids)
    map_ui_policy = coverage_config.get("map_ui_localization") or {}
    configured_map_ui_locales = map_ui_policy.get("locales") or []
    if (
        not isinstance(configured_map_ui_locales, list)
        or not configured_map_ui_locales
        or any(not isinstance(locale, str) or not locale for locale in configured_map_ui_locales)
        or len(configured_map_ui_locales) != len(set(configured_map_ui_locales))
    ):
        raise ValueError("map_ui_localization.locales must be a non-empty unique locale list")
    if not set(configured_map_ui_locales) <= set(map_localizations):
        raise ValueError("map_ui_localization.locales contains an unknown localization")
    map_ui_locales = sorted(configured_map_ui_locales)
    for locale, localization in map_localizations.items():
        if locale not in map_ui_locales:
            localization["messages"] = {}

    return {
        "schema": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "revision": revision or _project_revision(),
        "summary": {
            "localized": len(locale_rows),
            "published": len(publication_links),
        },
        "locales": locale_rows,
        "country_codes": sorted(
            (hub.load_json(LANGUAGE_MAP_PATH).get("iso2_to_iso3") or {}).keys()
        ),
        "representative_core_regions": coverage_config.get("representative_core_regions") or {},
        "ui_locales": ui_locales,
        "ui_fallback_locales": ui_fallback_locales,
        "map_ui_locales": map_ui_locales,
        "ui_messages": merged_ui_messages,
        "atlas_ui_version": int(ui_data.get("version") or 0),
        "map_localizations": map_localizations,
        "description_localizations": description_localizations,
        "description_sources": description_sources,
        "geography_localizations": geography_localizations,
        "linguistic_localizations": linguistic_localizations,
        "linguistic_name_catalog": linguistic_catalog,
        "speaker_estimate_source": {
            "title": (
                "Unicode CLDR "
                f"{str((speaker_data.get('source') or {}).get('cldr_version') or '')} "
                "Language-Territory Information"
            ),
            "url": str((speaker_data.get("source") or {}).get("url") or ""),
            "metric": str(speaker_data.get("metric") or ""),
            "notes": str(speaker_data.get("notes") or ""),
        },
        "atlas_language_metadata": atlas_language_metadata,
    }


def _apply_viewpoint_configuration(
    map_data: dict,
    viewpoint: str = "",
    viewpoint_override: bool = False,
) -> None:
    code = str(viewpoint or "").strip().upper()
    if code and not re.fullmatch(r"[A-Z]{2}", code):
        raise ValueError("viewpoint must be an ISO 3166-1 alpha-2 country code")
    if code and code not in (map_data.get("iso2_to_iso3") or {}):
        raise ValueError(f"viewpoint country is not configured by the map: {code}")
    if viewpoint_override and not code:
        raise ValueError("viewpoint_override requires viewpoint")
    model = map_data.setdefault("viewpoint_resolution_model", {})
    model.pop("viewpoint", None)
    model.pop("viewpoint_override", None)
    if not code:
        return
    model["viewpoint"] = code
    if viewpoint_override:
        model["viewpoint_override"] = True


def _environment_boolean(name: str) -> bool:
    value = str(os.environ.get(name, "")).strip().lower()
    if not value:
        return False
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise SystemExit(
        f"{name} must be one of: true, false, 1, 0, yes, no, on, off"
    )


def render(
    snapshot: dict,
    output: Path,
    viewpoint: str = "",
    viewpoint_override: bool = False,
) -> None:
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    marker = "__COVERAGE_VERSION__"
    ui_marker = "__ATLAS_UI_VERSION__"
    ui_css_marker = "__ATLAS_UI_CSS_VERSION__"
    map_marker = "__LANGUAGE_MAP_VERSION__"
    map_runtime_marker = "__LANGUAGE_MAP_RUNTIME_VERSION__"
    locale_resolution_marker = "__LOCALE_RESOLUTION_VERSION__"
    atlas_access_marker = "__LANGUAGE_ATLAS_ACCESS_VERSION__"
    if template.count(marker) != 1:
        raise SystemExit(f"coverage template must contain exactly one {marker} marker")
    if template.count(ui_marker) != 1:
        raise SystemExit(f"coverage template must contain exactly one {ui_marker} marker")
    if template.count(ui_css_marker) != 1:
        raise SystemExit(f"coverage template must contain exactly one {ui_css_marker} marker")
    if template.count(map_marker) != 1:
        raise SystemExit(f"coverage template must contain exactly one {map_marker} marker")
    if template.count(map_runtime_marker) != 1:
        raise SystemExit(f"coverage template must contain exactly one {map_runtime_marker} marker")
    if template.count(locale_resolution_marker) != 1:
        raise SystemExit(
            f"coverage template must contain exactly one {locale_resolution_marker} marker"
        )
    if template.count(atlas_access_marker) != 1:
        raise SystemExit(f"coverage template must contain exactly one {atlas_access_marker} marker")
    map_localizations = snapshot.get("map_localizations") or {}

    def map_copy(data: dict) -> dict:
        return {
            "schema": 1,
            "version": int(data.get("version") or 1),
            "locale": str(data.get("locale") or "en"),
            "messages": json.loads(json.dumps(data.get("messages") or {}, ensure_ascii=False)),
        }

    map_localizations = {
        locale: map_copy(data) for locale, data in map_localizations.items()
    }
    description_localizations = snapshot.get("description_localizations") or {
        locale: {
            "schema": 1,
            "version": 1,
            "locale": locale,
            "languages": {},
            "families": {},
            "scripts": {},
        }
        for locale in map_localizations
    }
    geography_localizations = snapshot.get("geography_localizations") or {
        locale: {
            "schema": 1,
            "version": int(data.get("version") or 1),
            "locale": locale,
            "country_names": dict(data.get("country_names") or {}),
        }
        for locale, data in (snapshot.get("map_localizations") or {}).items()
    }
    linguistic_localizations = snapshot.get("linguistic_localizations") or {
        locale: {
            "schema": 1,
            "version": int(data.get("version") or 1),
            "locale": locale,
            "languages": {
                code: {"name": record["name"]}
                for code, record in (data.get("languages") or {}).items()
                if record.get("name")
            },
            "taxonomy": {
                section: {
                    "labels": dict(
                        ((((data.get("taxonomy") or {}).get(section) or {}).get("labels")) or {})
                    )
                }
                for section in ("families", "scripts")
            },
        }
        for locale, data in (snapshot.get("map_localizations") or {}).items()
    }
    locale_bundle_chunks = {}
    for locale, localization in sorted(map_localizations.items()):
        bundle = {
            "schema": 1,
            "locale": locale,
            "i18n": localization,
            "descriptions": description_localizations.get(locale) or {},
            "geography": geography_localizations.get(locale) or {},
            "linguistics": linguistic_localizations.get(locale) or {},
        }
        serialized = json.dumps(
            bundle,
            ensure_ascii=False,
            separators=(",", ":"),
        ) + "\n"
        locale_bundle_chunks[f"{locale}.json.gz"] = _gzip_payload(serialized)
    locale_bundle_version = hashlib.sha256(b"".join(
        locale.encode("utf-8") + b"\0" + locale_bundle_chunks[f"{locale}.json.gz"]
        for locale in sorted(map_localizations)
    )).hexdigest()[:12]
    linguistic_core = {
        "schema": 1,
        "version": int((snapshot.get("linguistic_name_catalog") or {}).get("version") or 1),
        "native_names": dict(
            (snapshot.get("linguistic_name_catalog") or {}).get("native_names") or {}
        ),
        "source": dict((snapshot.get("linguistic_name_catalog") or {}).get("source") or {}),
        "native_name_source": dict(
            (snapshot.get("linguistic_name_catalog") or {}).get("native_name_source") or {}
        ),
    }
    linguistic_core_payload = json.dumps(
        linguistic_core, ensure_ascii=False, separators=(",", ":")
    ) + "\n"
    linguistic_core_version = hashlib.sha256(
        linguistic_core_payload.encode("utf-8")
    ).hexdigest()[:12]
    public_snapshot = {
        key: snapshot[key]
        for key in PUBLIC_COVERAGE_FIELDS
        if key in snapshot
    }
    public_snapshot["locales"] = [
        {key: row[key] for key in PUBLIC_LOCALE_FIELDS if key in row}
        for row in snapshot.get("locales") or []
    ]
    public_snapshot["ui_messages"] = snapshot.get("ui_messages") or {}
    public_snapshot["atlas_ui_version"] = int(
        snapshot.get("atlas_ui_version") or 1
    )
    public_snapshot["map_locale_bundle_version"] = locale_bundle_version
    public_snapshot["map_localization_locales"] = sorted(map_localizations)
    public_snapshot["map_linguistics_core_version"] = linguistic_core_version
    public_snapshot["map_ui_locales"] = sorted(
        snapshot.get("map_ui_locales") or map_localizations
    )
    source = public_snapshot.get("speaker_estimate_source") or {}
    public_snapshot["speaker_estimate_source"] = {"title": str(source.get("title") or "")}
    map_data = hub.load_json(LANGUAGE_MAP_PATH)
    _apply_viewpoint_configuration(map_data, viewpoint, viewpoint_override)
    map_data["toponym_resolution"] = hub.load_json(TOPONYM_RESOLUTION_POLICY_PATH)
    disputed_regions = hub.load_json(LANGUAGE_DISPUTED_REGIONS_PATH)
    disputed_payload = json.dumps(
        disputed_regions,
        ensure_ascii=False,
        separators=(",", ":"),
    ) + "\n"
    disputed_version = hashlib.sha256(disputed_payload.encode("utf-8")).hexdigest()[:12]
    map_data["geometry"]["disputed_url"] = (
        f"./language-map-overlays.json?v={disputed_version}"
    )
    places_manifest, places_chunks = _language_place_assets(
        hub.load_json(LANGUAGE_MAP_PLACES_PATH),
        map_data.get("toponym_resolution") or {},
        hub.load_json(PLACE_NAME_USAGE_OVERRIDES_PATH),
    )
    map_data.pop("places_url", None)
    map_data["places"] = places_manifest
    public_snapshot["map_place_assets"] = places_manifest
    public_snapshot["map_toponym_resolution"] = map_data.get("toponym_resolution") or {}
    payload = json.dumps(public_snapshot, ensure_ascii=False, separators=(",", ":")) + "\n"
    version = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]
    admin1_manifest, admin1_chunks = _language_admin1_assets(
        hub.load_json(LANGUAGE_MAP_ADMIN1_PATH)
    )
    def admin1_chunk_version(payload: str | bytes) -> str:
        raw = payload if isinstance(payload, (bytes, bytearray)) else payload.encode("utf-8")
        return hashlib.sha256(raw).hexdigest()[:12]

    for section in ("countries", "sources", "prefetch"):
        versioned_urls: dict[str, str] = {}
        for key, configured_url in sorted((admin1_manifest.get(section) or {}).items()):
            filename = _admin1_output_filename(configured_url)
            if filename not in admin1_chunks:
                _filename, chunk_payload, _collection = _admin1_chunk_payload(configured_url)
                admin1_chunks[filename] = chunk_payload
            chunk_payload = admin1_chunks[filename]
            chunk_version = admin1_chunk_version(chunk_payload)
            versioned_urls[key] = f"./language-map-admin1/{filename}?v={chunk_version}"
        if section in admin1_manifest:
            admin1_manifest[section] = versioned_urls
    versioned_regions: dict[str, dict] = {}
    for region_id, entry in sorted((admin1_manifest.get("regions") or {}).items()):
        configured_url = entry.get("url") or ""
        filename = Path(str(configured_url).split("?", 1)[0]).name
        if filename not in admin1_chunks:
            raise ValueError(f"Admin-1 boundary region chunk missing: {filename}")
        chunk_payload = admin1_chunks[filename]
        chunk_version = admin1_chunk_version(chunk_payload)
        versioned_regions[region_id] = {
            "countries": list(entry.get("countries") or []),
            "neighbors": list(entry.get("neighbors") or []),
            "url": f"./language-map-admin1/{filename}?v={chunk_version}",
        }
        if entry.get("feature_filter"):
            versioned_regions[region_id]["feature_filter"] = entry["feature_filter"]
    if versioned_regions:
        admin1_manifest["regions"] = versioned_regions
    configured_world_url = admin1_manifest.get("prefetch_world")
    if configured_world_url:
        world_filename = Path(str(configured_world_url).split("?", 1)[0]).name
        world_payload = admin1_chunks[world_filename]
        world_version = admin1_chunk_version(world_payload)
        admin1_manifest["prefetch_world"] = (
            f"./language-map-admin1/{world_filename}?v={world_version}"
        )
    admin1_payload = json.dumps(
        admin1_manifest,
        ensure_ascii=False,
        separators=(",", ":"),
    ) + "\n"
    admin1_version = hashlib.sha256(admin1_payload.encode("utf-8")).hexdigest()[:12]
    map_data["admin1_url"] = f"./language-map-admin1.json?v={admin1_version}"
    map_data["admin1_languages"] = sorted(admin1_manifest.get("languages") or {})
    map_payload = json.dumps(
        map_data,
        ensure_ascii=False,
        separators=(",", ":"),
    ) + "\n"
    map_version = hashlib.sha256(map_payload.encode("utf-8")).hexdigest()[:12]
    locale_resolution_runtime = LOCALE_RESOLUTION_RUNTIME_PATH.read_text(encoding="utf-8")
    locale_resolution_version = hashlib.sha256(
        locale_resolution_runtime.encode("utf-8")
    ).hexdigest()[:12]
    map_runtime = LANGUAGE_MAP_RUNTIME_PATH.read_text(encoding="utf-8")
    if map_runtime.count(locale_resolution_marker) != 1:
        raise SystemExit(
            f"language map runtime must contain exactly one {locale_resolution_marker} marker"
        )
    map_runtime = map_runtime.replace(locale_resolution_marker, locale_resolution_version)
    map_runtime_version = hashlib.sha256(map_runtime.encode("utf-8")).hexdigest()[:12]
    atlas_access_runtime = atlas_access.build_javascript(
        speaker_estimates.build_catalog().get("estimates") or {}
    )
    atlas_access_version = hashlib.sha256(
        atlas_access_runtime.encode("utf-8")
    ).hexdigest()[:12]
    ui_candidates = (
        output / "assets" / "javascripts" / "atlas-ui.js",
        BROWSER_DIR / "atlas-ui.js",
    )
    ui_runtime = next((path for path in ui_candidates if path.is_file()), None)
    ui_version_source = (
        ui_runtime.read_bytes()
        if ui_runtime is not None
        else b"/* atlas-ui optional */\n"
    )
    ui_version = hashlib.sha256(ui_version_source).hexdigest()[:12]
    if not ATLAS_UI_CSS_PATH.is_file():
        raise SystemExit(f"atlas UI stylesheet missing: {ATLAS_UI_CSS_PATH}")
    ui_css_source = ATLAS_UI_CSS_PATH.read_bytes()
    ui_css_version = hashlib.sha256(ui_css_source).hexdigest()[:12]
    output.mkdir(parents=True, exist_ok=True)
    for legacy_locale_output in (
        output / "map-i18n",
        output / "map-descriptions",
        output / "map-geography" / "locales",
        output / "map-linguistics" / "locales",
    ):
        if legacy_locale_output.exists():
            shutil.rmtree(legacy_locale_output)
    map_runtime_output = output / "assets" / "javascripts"
    map_runtime_output.mkdir(parents=True, exist_ok=True)
    site_ui_runtime = output / "assets" / "javascripts" / "atlas-ui.js"
    if not site_ui_runtime.is_file():
        site_ui_runtime.parent.mkdir(parents=True, exist_ok=True)
        site_ui_runtime.write_bytes(ui_version_source)
    site_ui_css = output / "assets" / "stylesheets" / "atlas-ui.css"
    site_ui_css.parent.mkdir(parents=True, exist_ok=True)
    site_ui_css.write_bytes(ui_css_source)
    if not LOCALE_CONTEXT_PHP_PATH.is_file():
        raise SystemExit(f"locale-context.php missing: {LOCALE_CONTEXT_PHP_PATH}")
    shutil.copyfile(LOCALE_CONTEXT_PHP_PATH, output / "locale-context.php")
    license_output = output / "assets" / "licenses"
    license_output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(CLDR_LICENSE_PATH, license_output / "Unicode-3.0.txt")
    shutil.copytree(
        LANGUAGE_MAP_VENDOR_DIR,
        map_runtime_output / "vendor" / "map",
        dirs_exist_ok=True,
    )
    map_locale_output = output / "map-locales"
    if map_locale_output.exists():
        shutil.rmtree(map_locale_output)
    map_locale_output.mkdir(parents=True, exist_ok=True)
    for filename, chunk_payload in locale_bundle_chunks.items():
        locale = filename.removesuffix(".json.gz")
        if not locale.replace("-", "").isalnum():
            raise ValueError(f"invalid map locale id: {locale}")
        (map_locale_output / filename).write_bytes(chunk_payload)
    (output / "coverage.json").write_text(
        payload,
        encoding="utf-8",
    )
    (output / "language-map.json").write_text(map_payload, encoding="utf-8")
    (output / "language-map-overlays.json").write_text(
        disputed_payload,
        encoding="utf-8",
    )
    geography_output = output / "map-geography"
    linguistic_output = output / "map-linguistics"
    linguistic_output.mkdir(parents=True, exist_ok=True)
    (linguistic_output / "core.json").write_text(
        linguistic_core_payload,
        encoding="utf-8",
    )
    places_output = geography_output / "places"
    places_output.mkdir(parents=True, exist_ok=True)
    for filename, chunk_payload in places_chunks.items():
        (places_output / filename).write_bytes(chunk_payload)
    (output / "language-map-admin1.json").write_text(
        admin1_payload,
        encoding="utf-8",
    )
    admin1_output = output / "language-map-admin1"
    if admin1_output.exists():
        shutil.rmtree(admin1_output)
    admin1_output.mkdir(parents=True, exist_ok=True)
    for filename, chunk_payload in admin1_chunks.items():
        path = admin1_output / filename
        if isinstance(chunk_payload, (bytes, bytearray)):
            path.write_bytes(chunk_payload)
        else:
            path.write_text(chunk_payload, encoding="utf-8")
    (map_runtime_output / "language-distribution-map.js").write_text(
        map_runtime,
        encoding="utf-8",
    )
    (map_runtime_output / "locale-resolution.js").write_text(
        locale_resolution_runtime,
        encoding="utf-8",
    )
    (map_runtime_output / "language-atlas-access.js").write_text(
        atlas_access_runtime,
        encoding="utf-8",
    )
    (output / "index.html").write_text(
        template.replace(marker, version)
        .replace(ui_marker, ui_version)
        .replace(ui_css_marker, ui_css_version)
        .replace(map_marker, map_version)
        .replace(map_runtime_marker, map_runtime_version)
        .replace(locale_resolution_marker, locale_resolution_version)
        .replace(atlas_access_marker, atlas_access_version),
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="build/site")
    parser.add_argument(
        "--publication-manifest",
        help="optional schema-1 JSON listing host-published locale links",
    )
    parser.add_argument(
        "--revision",
        default=os.environ.get("ATLAS_REVISION", ""),
        help="revision label shown by the generated Atlas (defaults to the Atlas git revision)",
    )
    parser.add_argument(
        "--viewpoint",
        default=os.environ.get("ATLAS_VIEWPOINT", ""),
        help="fallback territorial viewpoint country (or overriding viewpoint with --viewpoint-override)",
    )
    parser.add_argument(
        "--viewpoint-override",
        action=argparse.BooleanOptionalAction,
        default=_environment_boolean("ATLAS_VIEWPOINT_OVERRIDE"),
        help="apply --viewpoint even when an access-country viewpoint is available",
    )
    args = parser.parse_args()

    normalized_viewpoint = str(args.viewpoint or "").strip().upper()
    if normalized_viewpoint and not re.fullmatch(r"[A-Z]{2}", normalized_viewpoint):
        parser.error("--viewpoint must be an ISO 3166-1 alpha-2 country code")
    if args.viewpoint_override and not normalized_viewpoint:
        parser.error("--viewpoint-override requires --viewpoint or ATLAS_VIEWPOINT")

    publication_manifest = (
        Path(args.publication_manifest).resolve() if args.publication_manifest else None
    )
    if publication_manifest is not None and not publication_manifest.is_file():
        raise SystemExit(f"publication manifest missing: {publication_manifest}")
    snapshot = build_snapshot(publication_manifest, revision=str(args.revision or ""))
    output = Path(args.output).resolve()
    render(snapshot, output, normalized_viewpoint, args.viewpoint_override)
    print(
        f"language_coverage={output / 'index.html'} "
        f"locales={snapshot['summary']['localized']} "
        f"published={snapshot['summary']['published']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
