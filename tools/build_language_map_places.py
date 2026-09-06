#!/usr/bin/env python3
"""Build the compact, deferred place-label data used by the coverage map."""

from __future__ import annotations

import argparse
import json
import math
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path


from atlas_paths import ATLAS_ROOT, GEOGRAPHY_DIR
ROOT = ATLAS_ROOT
MAP_CONFIG = GEOGRAPHY_DIR / "map.json"
OVERRIDES = GEOGRAPHY_DIR / "place-overrides.json"
OUTPUT = GEOGRAPHY_DIR / "places.json"

LATIN_LOCALE_FIELDS = {
    "en": "NAME_EN",
    "de": "NAME_DE",
    "fr": "NAME_FR",
    "es": "NAME_ES",
    "pt": "NAME_PT",
    "it": "NAME_IT",
    "hu": "NAME_HU",
    "id": "NAME_ID",
    "nl": "NAME_NL",
    "pl": "NAME_PL",
    "sv": "NAME_SV",
    "tr": "NAME_TR",
    "vi": "NAME_VI",
}

# These are display fallbacks, not claims that a script has one
# language-neutral spelling. Exact locale forms always override them.
SCRIPT_NAME_FIELDS = {
    "Jpan": ("ja", "NAME_JA"),
    "Hans": ("zh", "NAME_ZH"),
    "Hant": ("zht", "NAME_ZHT"),
    "Kore": ("ko", "NAME_KO"),
    "Cyrl": ("ru", "NAME_RU"),
    "Arab": ("ar", "NAME_AR"),
    "Deva": ("hi", "NAME_HI"),
    "Beng": ("bn", "NAME_BN"),
    "Grek": ("el", "NAME_EL"),
    "Hebr": ("he", "NAME_HE"),
}

LOCALE_NAME_FIELDS = {
    **LATIN_LOCALE_FIELDS,
    "fa": "NAME_FA",
    "uk": "NAME_UK",
    "ur": "NAME_UR",
}

# Natural Earth remains the coordinate/rank source, but a small number of its
# translated labels contain administrative suffixes, superseded names or values
# copied from a different feature.  Keep these reviewable corrections beside the
# builder instead of silently rewriting every source label.
PLACE_NAME_CORRECTIONS = {
    "Nur-Sultan": {
        "name": "Astana",
        "localized_names": {
            "en": "Astana",
            "ja": "アスタナ",
            "de": "Astana",
            "fr": "Astana",
            "es": "Astaná",
            "ko": "아스타나",
            "pt": "Astana",
            "it": "Astana",
            "ru": "Астана",
            "ar": "أستانا",
            "bn": "আস্তানা",
            "el": "Αστάνα",
            "fa": "آستانه",
            "he": "אסטנה",
            "hi": "अस्ताना",
            "hu": "Asztana",
            "id": "Astana",
            "nl": "Astana",
            "pl": "Astana",
            "sv": "Astana",
            "tr": "Astana",
            "uk": "Астана",
            "ur": "آستانہ",
            "vi": "Astana",
            "zh": "阿斯塔纳",
            "zht": "阿斯塔納",
        },
    },
    "Tokyo": {
        "localized_names": {
            "ja": "東京",
            "ko": "도쿄",
            "sv": "Tokyo",
        },
    },
    "Brussels": {
        "localized_names": {
            "ar": "بروكسل",
            "fa": "بروکسل",
            "ja": "ブリュッセル",
            "ko": "브뤼셀",
            "ur": "برسلز",
            "zht": "布魯塞爾",
        },
    },
    "Seoul": {
        "localized_names": {
            "ja": "ソウル",
            "ko": "서울",
        },
    },
    "Busan": {
        "localized_names": {
            "ar": "بوسان",
        },
    },
    "Arak": {
        "localized_names": {
            "ar": "آراك",
        },
    },
    "Pyongsan": {
        "replace_source_names": True,
        "script_names": {
            "Latn": "Pyongsan",
            "Jpan": "平山",
            "Hans": "平山",
            "Hant": "平山",
            "Kore": "평산",
            "Cyrl": "Пхёнсан",
            "Arab": "بيونغسان",
            "Deva": "प्योंगसान",
            "Beng": "পিয়ংসান",
            "Grek": "Πιονγκσάν",
            "Hebr": "פיונגסאן",
        },
    },
    "Buzmeyin": {
        "name": "Büzmeýin",
        "replace_source_names": True,
        "script_names": {
            "Latn": "Büzmeýin",
            "Jpan": "ビュズメイン",
            "Hans": "别兹梅因",
            "Hant": "別茲梅因",
            "Kore": "뷔즈메인",
            "Cyrl": "Бюзмейин",
            "Arab": "بوزمين",
            "Deva": "ब्युज़मेइन",
            "Beng": "বুজমেইন",
            "Grek": "Μπουζμεΐν",
            "Hebr": "בוזמיין",
        },
    },
    "Kissidougou": {
        "localized_names": {
            "zh": "基西杜古",
            "zht": "基西杜古",
        },
    },
    "Macenta": {
        "localized_names": {
            "zh": "马森塔",
            "zht": "馬森塔",
        },
    },
    "Kyiv": {
        "script_names": {
            "Latn": "Kyiv",
            "Jpan": "キーウ",
            "Kore": "키이우",
        },
    },
    "Bengaluru": {
        "script_names": {
            "Latn": "Bengaluru",
        },
    },
    "Mbombela": {
        "script_names": {
            "Latn": "Mbombela",
        },
    },
    "Port Elizabeth": {
        "name": "Gqeberha",
        "localized_names": {
            "en": "Gqeberha",
        },
        "script_names": {
            "Latn": "Gqeberha",
        },
    },
    "Nazret": {
        "name": "Adama",
        "script_names": {
            "Latn": "Adama",
        },
    },
    "Nueva San Salvador": {
        "name": "Santa Tecla",
        "script_names": {
            "Latn": "Santa Tecla",
        },
    },
    "Uroteppa": {
        "name": "Istaravshan",
        "script_names": {
            "Latn": "Istaravshan",
        },
    },
    "Icel": {
        "name": "Mersin",
        "script_names": {
            "Latn": "Mersin",
        },
    },
    "Shenyeng": {"name": "Shenyang"},
    "Xian": {"name": "Xi'an"},
    "Hyeson": {"name": "Hyesan"},
    "Songnam": {"name": "Seongnam"},
}

# Some source NAME values collide inside one country, so these corrections use
# Natural Earth's stable feature id rather than an ambiguous place name.
PLACE_NAME_CORRECTIONS_BY_NE_ID = {
    1159149391: {
        "name": "Maradi",
        "localized_names": {"en": "Maradi"},
        "script_names": {"Latn": "Maradi"},
    },
}


def _localized_name(
    code: str,
    locale: str,
    value: object,
    properties: dict | None = None,
) -> str:
    name = str(value or "").strip()
    # Japanese city labels omit administrative suffixes regardless of country.
    # These are Japanese suffixes, so foreign proper names such as
    # メキシコシティ remain untouched.  Treat 東京都 specially so 京都 is never
    # reduced to 京 when a source already omits 京都市's 市.
    if locale == "ja":
        if name == "東京都":
            return "東京"
        name = re.sub(r"(?:特別行政区|特別市|広域市|市|郡)$", "", name)
    elif locale == "ko":
        name = re.sub(r"(?:특별자치시|특별시|광역시|직할시)$", "", name)
        if code in {"CN", "JP", "KP", "KR", "TW"} and name.endswith("시"):
            # The source consistently stores East Asian municipalities with a
            # Korean administrative suffix.  Removing one final 시 also handles
            # names such as 우시시 -> 우시 without damaging the place name.
            name = name[:-1]
    elif locale == "zht":
        name = re.sub(r"(?:特別行政區|特別市|直轄市|廣域市|特級市)$", "", name)
        if code in {"CN", "JP", "KP", "KR", "TW"} and name.endswith("市"):
            name = name[:-1]
    elif locale == "zh":
        name = re.sub(r"(?:特别行政区|特别市|直辖市|广域市|特级市)$", "", name)
        if code in {"CN", "JP", "KP", "KR", "TW"} and name.endswith("市"):
            name = name[:-1]
    return name


def _number(value: object, default: float = 0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _fold_name(value: str) -> str:
    return "".join(
        character
        for character in unicodedata.normalize("NFKD", value).casefold()
        if not unicodedata.combining(character)
    )


def _latin_script_fallback(
    code: str,
    properties: dict,
    corrections: dict[str, str],
    default_name: str,
    use_source_names: bool = True,
) -> str:
    """Return the Latin spelling shared by the most source locales.

    NAMEPAR breaks ties when it matches a candidate after accent folding. This
    avoids privileging English without turning every Latin locale into an
    override of a mandatory endonym.
    """

    values = []
    for locale, field in LATIN_LOCALE_FIELDS.items():
        value = _localized_name(
            code,
            locale,
            corrections.get(locale, properties.get(field) if use_source_names else ""),
            properties,
        )
        if value:
            values.append(value)
    if not values:
        return default_name
    counts = Counter(values)
    maximum = max(counts.values())
    candidates = [value for value, count in counts.items() if count == maximum]
    parent_name = str(properties.get("NAMEPAR") or "").strip()
    if parent_name:
        folded_parent = _fold_name(parent_name)
        matching_parent = next(
            (value for value in candidates if _fold_name(value) == folded_parent),
            "",
        )
        if matching_parent:
            return matching_parent
    if default_name in candidates:
        return default_name
    return candidates[0]


def _country_code(
    properties: dict,
    iso3_to_iso2: dict[str, str],
    feature_code_aliases: dict[str, str],
) -> str:
    code = str(properties.get("ISO_A2") or "")
    if len(code) == 2 and code != "-99":
        return code
    adm0_code = str(properties.get("ADM0_A3") or "")
    return iso3_to_iso2.get(adm0_code, "") or feature_code_aliases.get(adm0_code, "")


def _place_sort_key(feature: dict) -> tuple:
    properties = feature["properties"]
    population = max(0, _number(properties.get("POP_MAX")))
    minimum_zoom = _number(properties.get("MIN_ZOOM"), 9)
    importance = (
        (100 if properties.get("ADM0CAP") else 0)
        + 2.5 * math.log1p(population)
        + 0.75 * (6.1 - minimum_zoom)
        + 0.05 * _number(properties.get("RANK_MAX"))
    )
    return (
        -importance,
        str(properties.get("NAME") or ""),
    )


def _label_budget(features: list[dict]) -> int:
    population = sum(_number(item["properties"].get("POP_MAX")) for item in features[:20])
    population_budget = 2 + math.floor(population / 6_500_000)
    # This is only an upper bound.  The browser applies a projected-land-area
    # capacity, so a generous candidate budget does not crowd small countries.
    # It does stop large, less populous countries from being capped at a capital
    # and one city merely because population was the only generation signal.
    coverage_budget = 2 + math.ceil(math.sqrt(len(features)))
    return min(len(features), max(2, min(20, population_budget), coverage_budget))


def build(source: Path) -> dict:
    raw = json.loads(source.read_text(encoding="utf-8"))
    map_config = json.loads(MAP_CONFIG.read_text(encoding="utf-8"))
    overrides = json.loads(OVERRIDES.read_text(encoding="utf-8"))
    iso3_to_iso2 = {value: key for key, value in map_config["iso2_to_iso3"].items()}
    feature_code_aliases = map_config.get("feature_code_aliases") or {}
    grouped: dict[str, list[dict]] = defaultdict(list)
    for feature in raw.get("features") or []:
        properties = feature.get("properties") or {}
        coordinates = (feature.get("geometry") or {}).get("coordinates") or []
        code = _country_code(properties, iso3_to_iso2, feature_code_aliases)
        if len(code) != 2 or len(coordinates) < 2:
            continue
        grouped[code].append(feature)

    countries = {}
    for code, features in sorted(grouped.items()):
        country_override = (overrides.get("countries") or {}).get(code) or {}
        priority = {
            name: index
            for index, name in enumerate(country_override.get("priority") or [])
        }
        minimum_zoom = country_override.get("minimum_zoom") or {}
        candidate_limit = max(1, int(country_override.get("candidate_limit") or 20))
        sorted_features = sorted(features, key=lambda feature: (
            priority.get(str(feature["properties"].get("NAME") or ""), len(priority)),
            _place_sort_key(feature),
        ))
        if candidate_limit <= 20:
            ranked = sorted_features[:candidate_limit]
        else:
            ranked = []
            seen_names = set()
            for feature in sorted_features:
                source_name = str(feature["properties"].get("NAME") or "").strip()
                normalized_name = source_name.casefold()
                if not normalized_name or normalized_name in seen_names:
                    continue
                seen_names.add(normalized_name)
                ranked.append(feature)
                if len(ranked) >= candidate_limit:
                    break
        places = []
        for feature in ranked:
            properties = feature["properties"]
            source_name = str(properties.get("NAME") or properties.get("NAME_EN") or "").strip()
            name_correction = (
                PLACE_NAME_CORRECTIONS_BY_NE_ID.get(properties.get("NE_ID"))
                or PLACE_NAME_CORRECTIONS.get(source_name)
                or {}
            )
            default_name = str(name_correction.get("name") or source_name).strip()
            corrected_names = name_correction.get("localized_names") or {}
            script_name_overrides = name_correction.get("script_names") or {}
            use_source_names = not name_correction.get("replace_source_names")
            country_name = str(properties.get("ADM0NAME") or "").strip()
            # Monaco / San Marino style duplicates add no information to the map.
            if default_name.casefold() == country_name.casefold():
                continue
            script_fallbacks = {
                "Latn": _latin_script_fallback(
                    code,
                    properties,
                    corrected_names,
                    default_name,
                    use_source_names,
                )
            }
            for script, (locale, field) in SCRIPT_NAME_FIELDS.items():
                localized_name = _localized_name(
                    code,
                    locale,
                    corrected_names.get(
                        locale,
                        properties.get(field) if use_source_names else "",
                    ),
                    properties,
                )
                if localized_name:
                    script_fallbacks[script] = localized_name
            script_fallbacks.update({
                script: str(value).strip()
                for script, value in script_name_overrides.items()
                if str(value).strip()
            })
            locale_overrides = {}
            for locale, field in LOCALE_NAME_FIELDS.items():
                localized_name = _localized_name(
                    code,
                    locale,
                    corrected_names.get(
                        locale,
                        properties.get(field) if use_source_names else "",
                    ),
                    properties,
                )
                script = "Latn"
                if locale in {"fa", "ur"}:
                    script = "Arab"
                elif locale == "uk":
                    script = "Cyrl"
                if localized_name and localized_name != script_fallbacks.get(script):
                    locale_overrides[locale] = localized_name
            names = {"scripts": script_fallbacks}
            if locale_overrides:
                names["locales"] = locale_overrides
            longitude, latitude = feature["geometry"]["coordinates"][:2]
            places.append([
                round(float(longitude), 6),
                round(float(latitude), 6),
                _number(minimum_zoom.get(default_name, properties.get("MIN_ZOOM")), 9),
                int(bool(properties.get("ADM0CAP"))),
                int(_number(properties.get("POP_MAX"))),
                default_name,
                names,
            ])
        if places:
            budget = country_override.get("budget")
            country_payload = {
                "budget": min(len(places), int(budget)) if budget is not None else min(len(places), _label_budget(ranked)),
                "places": places,
            }
            broad_label_floor = country_override.get("broad_label_floor")
            if broad_label_floor is not None:
                country_payload["broad_label_floor"] = min(len(places), max(1, int(broad_label_floor)))
            selected_label_floor = country_override.get("selected_label_floor")
            if selected_label_floor is not None:
                country_payload["selected_label_floor"] = min(len(places), max(1, int(selected_label_floor)))
            if country_override.get("prefer_place_labels_when_selected"):
                country_payload["prefer_place_labels_when_selected"] = True
            representative_place = str(country_override.get("representative_place") or "").strip()
            if representative_place and any(row[5] == representative_place for row in places):
                country_payload["representative_place"] = representative_place
            countries[code] = country_payload

    return {
        "schema": 3,
        "description": "Deferred capital and major-city labels. Each place has reusable script fallbacks plus sparse locale-specific overrides; English is an ordinary override.",
        "source": {
            "title": "Natural Earth 1:10m Populated Places",
            "url": "https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-populated-places/",
            "version": "5.1.2",
        },
        "fields": ["longitude", "latitude", "minimum_zoom", "capital", "population", "name", "localized_names"],
        "countries": countries,
    }


def format_payload(payload: dict) -> str:
    """Keep the generated file reviewable without exploding every place row."""

    def compact(value: object) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(", ", ": "))

    lines = ["{"]
    top_level = list(payload.items())
    for top_index, (key, value) in enumerate(top_level):
        top_comma = "," if top_index + 1 < len(top_level) else ""
        if key != "countries":
            lines.append(f"  {compact(key)}: {compact(value)}{top_comma}")
            continue

        lines.append(f"  {compact(key)}: {{")
        countries = list(value.items())
        for country_index, (code, country) in enumerate(countries):
            country_comma = "," if country_index + 1 < len(countries) else ""
            lines.append(f"    {compact(code)}: {{")
            members = list(country.items())
            for member_index, (member_key, member_value) in enumerate(members):
                member_comma = "," if member_index + 1 < len(members) else ""
                if member_key != "places":
                    lines.append(f"      {compact(member_key)}: {compact(member_value)}{member_comma}")
                    continue
                lines.append(f"      {compact(member_key)}: [")
                for place_index, place in enumerate(member_value):
                    place_comma = "," if place_index + 1 < len(member_value) else ""
                    lines.append(f"        {compact(place)}{place_comma}")
                lines.append(f"      ]{member_comma}")
            lines.append(f"    }}{country_comma}")
        lines.append(f"  }}{top_comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Natural Earth ne_10m_populated_places.geojson")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    payload = build(args.source)
    args.output.write_text(format_payload(payload), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
