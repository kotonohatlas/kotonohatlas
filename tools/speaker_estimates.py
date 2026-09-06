#!/usr/bin/env python3
"""Build language speaker estimates from pinned Unicode CLDR territory data."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

from atlas_paths import LINGUISTICS_DIR, LOCALES_PATH, ensure_import_paths

ensure_import_paths()
import country_names as cldr

CLDR_TERRITORY_INFO = cldr.CLDR_JSON / "cldr-core" / "supplemental" / "territoryInfo.json"
CLDR_LIKELY_SUBTAGS = cldr.CLDR_JSON / "cldr-core" / "supplemental" / "likelySubtags.json"
CLDR_PACKAGE = cldr.CLDR_JSON / "cldr-core" / "package.json"
ATLAS_METADATA_PATH = LINGUISTICS_DIR / "metadata.json"
OVERRIDES_PATH = LINGUISTICS_DIR / "speaker-estimates.json"


def _json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _target_codes() -> list[str]:
    locale_codes = {
        str(item["locale"])
        for item in (_json(LOCALES_PATH).get("locales") or [])
        if isinstance(item, dict) and item.get("locale")
    }
    profile_codes = set((_json(ATLAS_METADATA_PATH).get("profiles") or {}))
    return sorted(locale_codes | profile_codes)


def _maximize(code: str, likely: dict[str, str]) -> tuple[str, str, str]:
    normalized = str(code).replace("_", "-")
    parts = normalized.split("-")
    language = parts[0]
    script = next(
        (part.title() for part in parts[1:] if len(part) == 4 and part.isalpha()),
        "",
    )
    region = next(
        (
            part.upper()
            for part in parts[1:]
            if (len(part) == 2 and part.isalpha())
            or (len(part) == 3 and part.isdigit())
        ),
        "",
    )
    candidates = [normalized]
    if region:
        candidates.append(f"{language}-{region}")
    if script:
        candidates.append(f"{language}-{script}")
    candidates.append(language)
    maximized = next(
        (str(likely[candidate]) for candidate in candidates if likely.get(candidate)),
        "",
    )
    if maximized:
        max_parts = maximized.split("-")
        language = max_parts[0]
        script = script or next(
            (part.title() for part in max_parts[1:] if len(part) == 4),
            "",
        )
        region = region or next(
            (part.upper() for part in max_parts[1:] if len(part) in (2, 3)),
            "",
        )
    return language, script, region


def _candidate_population_codes(
    code: str,
    likely: dict[str, str],
    aliases: dict[str, str],
) -> list[str]:
    normalized = str(code).replace("_", "-")
    language = normalized.split("-", 1)[0]
    canonical = aliases.get(normalized) or aliases.get(language) or ""
    variants = [normalized]
    if canonical:
        variants.extend(canonical.split())
    candidates = []
    for variant in variants:
        resolved_language, script, _region = _maximize(variant, likely)
        explicit_parts = variant.split("-")
        explicit_script = next(
            (
                part.title()
                for part in explicit_parts[1:]
                if len(part) == 4 and part.isalpha()
            ),
            "",
        )
        if explicit_script:
            candidates.append(f"{resolved_language}_{explicit_script}")
        if script:
            candidates.append(f"{resolved_language}_{script}")
        candidates.append(resolved_language)
    return list(dict.fromkeys(candidate for candidate in candidates if candidate))


def _population_tables() -> tuple[dict[str, float], dict[str, dict[str, float]]]:
    territories = (
        (_json(CLDR_TERRITORY_INFO).get("supplemental") or {}).get("territoryInfo")
        or {}
    )
    totals: dict[str, float] = defaultdict(float)
    by_territory = {}
    for territory, record in territories.items():
        population = float(record.get("_population") or 0)
        territory_values = {}
        for language, data in (record.get("languagePopulation") or {}).items():
            estimate = population * float(data.get("_populationPercent") or 0) / 100
            totals[str(language)] += estimate
            territory_values[str(language)] = estimate
        by_territory[str(territory)] = territory_values
    return dict(totals), by_territory


def build_catalog() -> dict:
    package = _json(CLDR_PACKAGE)
    likely = (
        (_json(CLDR_LIKELY_SUBTAGS).get("supplemental") or {}).get("likelySubtags")
        or {}
    )
    aliases = cldr._language_aliases()
    totals, by_territory = _population_tables()
    overrides = _json(OVERRIDES_PATH)
    if (
        overrides.get("schema") != 1
        or not isinstance(overrides.get("version"), int)
        or int(overrides["version"]) <= 0
        or overrides.get("base") != "unicode-cldr-json"
        or not isinstance(overrides.get("territory_scopes"), dict)
        or not isinstance(overrides.get("estimates"), dict)
    ):
        raise ValueError("invalid language speaker-estimate overrides")

    targets = _target_codes()
    if not set(overrides["territory_scopes"]) <= set(targets):
        raise ValueError("unknown territory-scoped speaker-estimate override")
    if not set(overrides["estimates"]) <= set(targets):
        raise ValueError("unknown manual speaker-estimate override")

    estimates = {}
    resolution = {}
    unsupported = []
    for code in targets:
        if code in overrides["estimates"]:
            value = overrides["estimates"][code]
            if value is not None and (not isinstance(value, int) or value <= 0):
                raise ValueError(f"invalid manual speaker estimate: {code}")
            estimates[code] = value
            resolution[code] = "manual" if value is not None else "excluded"
            if value is None:
                unsupported.append(code)
            continue

        scoped = overrides["territory_scopes"].get(code)
        if scoped:
            territory = str(scoped.get("territory") or "")
            language = str(scoped.get("language") or "")
            value = (by_territory.get(territory) or {}).get(language)
            if not value or value <= 0:
                raise ValueError(f"unresolved territory-scoped speaker estimate: {code}")
            estimates[code] = int(round(value))
            resolution[code] = f"territory:{territory}/{language}"
            continue

        candidates = _candidate_population_codes(code, likely, aliases)
        population_code = next(
            (candidate for candidate in candidates if totals.get(candidate, 0) > 0),
            "",
        )
        if not population_code:
            estimates[code] = None
            resolution[code] = "unsupported"
            unsupported.append(code)
            continue
        estimates[code] = int(round(totals[population_code]))
        resolution[code] = f"global:{population_code}"

    cldr_version = str(package.get("cldrVersion") or package.get("version") or "")
    return {
        "schema": 2,
        "version": int(overrides["version"]),
        "source": {
            "name": "Unicode CLDR JSON",
            "package": str(package.get("name") or "cldr-core"),
            "version": str(package.get("version") or ""),
            "cldr_version": cldr_version,
            "unicode_version": str(package.get("unicodeVersion") or ""),
            "revision": cldr._cldr_revision(),
            "license": str(package.get("license") or "Unicode-3.0"),
            "url": (
                "https://unicode.org/cldr/charts/"
                f"{cldr_version}/supplemental/language_territory_information.html"
            ),
        },
        "metric": (
            "Sum of CLDR language population across territories, generally including "
            "conversational or technology-capable L1 and L2+ users."
        ),
        "notes": (
            "Figures are approximate and not fully comparable. Small populations may be "
            "omitted. Latin and Esperanto are excluded because territory-based totals are "
            "not meaningful estimates of their user populations."
        ),
        "estimates": estimates,
        "resolution": resolution,
        "unsupported_codes": sorted(unsupported),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output")
    args = parser.parse_args()
    payload = json.dumps(build_catalog(), ensure_ascii=False, indent=2) + "\n"
    if args.output:
        Path(args.output).write_text(payload, encoding="utf-8")
    else:
        print(payload, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
