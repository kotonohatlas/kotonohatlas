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
    "Eindhoven": {
        # Natural Earth's Hindi field names Amsterdam here. Use the attested
        # Eindhoven form as both the Hindi label and the Devanagari fallback.
        "localized_names": {
            "hi": "आइंडहोवन",
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
    # Natural Earth retains Loubomo, the 1975-1991 name, in a few fields.
    1159143017: {
        "name": "Dolisie",
        "localized_names": {
            "hu": "Dolisie",
            "he": "דוליזי",
            "fa": "دولیسی",
            "ru": "Долизи",
        },
        "script_names": {"Latn": "Dolisie"},
    },
    # Puerto San José and nearby Puerto Quetzal are distinct places.
    1159141559: {
        "name": "Puerto San José",
        "localized_names": {"es": "Puerto San José"},
        "script_names": {"Latn": "Puerto San José"},
    },
    # NAME_ES contains an unrelated locality in the same province.
    1159118621: {
        "localized_names": {"es": "Puerto Plata"},
    },
    # NAME_AR/NAME_EN contain the governorate rather than the city.
    1159140381: {
        "name": "Mansoura",
        "localized_names": {"ar": "المنصورة", "en": "Mansoura"},
        "script_names": {"Latn": "Mansoura"},
    },
    # NAME_AR contains the generic word "city"; the shared script label should
    # stay at the same scope as Giza in the other writing systems.
    1159146947: {"localized_names": {"ar": "الجيزة"}},
    # The city reverted from Barrow to its Iñupiaq name in 2016. Localized
    # exonyms may retain Barrow where it remains established usage.
    1159150549: {
        "script_names": {"Latn": "Utqiaġvik"},
    },
    # The Japanese source still carries the former colonial-era city name.
    1159144719: {
        "localized_names": {"ja": "ソヨ"},
    },
    # The following Indic source labels name another place (or are corrupt).
    # Correcting the Deva/Beng parents also prevents that error propagating to
    # the additional scripts generated from them when no IPA row is available.
    1159116339: {
        "script_names": {"Deva": "इलाम", "Beng": "ইলাম"},
    },
    1159144521: {
        "script_names": {"Deva": "न्गाउंडेरे"},
    },
    # Natural Earth localizes the surrounding district rather than the city in
    # several scripts (for example Japanese 県 and Bengali জেলা). This point is
    # the city of Jamalpur, so keep every shared fallback at city-name scope.
    1159144679: {
        "name": "Jamalpur",
        "replace_source_names": True,
        "script_names": {
            "Latn": "Jamalpur",
            "Jpan": "ジャマルプル",
            "Hans": "杰马勒布尔",
            "Hant": "傑馬勒布爾",
            "Kore": "자말푸르",
            "Cyrl": "Джамалпур",
            "Arab": "جمالبور",
            "Deva": "जमालपुर",
            "Beng": "জামালপুর",
            "Grek": "Τζαμαλπούρ",
            "Hebr": "ג'מאלפור",
        },
    },
    1159145061: {
        "name": "Veliko Tarnovo",
        "script_names": {"Latn": "Veliko Tarnovo", "Deva": "वेलिको तर्नोवो"},
    },
    # Natural Earth mixes the island/old city names into rows whose point and
    # administrative role are the present-day cities below.
    1159118935: {
        "name": "Janjanbureh",
        "localized_names": {
            "es": "Janjanbureh",
            "id": "Janjanbureh",
            "sv": "Janjanbureh",
            "vi": "Janjanbureh",
            "uk": "Джанджанбуре",
        },
        "script_names": {
            "Latn": "Janjanbureh",
            "Arab": "جانجانبوره",
            "Deva": "जंजनबुरे",
            "Beng": "জানজানবুরে",
            "Grek": "Τζαντζανμπουρέ",
            "Hebr": "ג'נג'נבורה",
        },
    },
    1159146035: {
        "name": "Cockburn Town",
        "script_names": {
            "Latn": "Cockburn Town",
            "Deva": "कॉकबर्न टाउन",
            "Beng": "ককবার্ন টাউন",
        },
    },
    # Mbombela is the current official name. Retain established Nelspruit
    # locale exonyms, but do not manufacture new-script forms from that old
    # Hindi/Bengali source label.
    1159136731: {
        "script_names": {"Deva": "म्बोम्बेला", "Beng": "ম্বোম্বেলা"},
    },
    # A few Natural Earth/Wikidata localized fields contain a neighboring city,
    # a country name, or unrelated text rather than a translation of the row.
    1159113331: {"localized_names": {"fr": "Port-de-Paix"}},
    1159118801: {"localized_names": {"tr": "Higüey"}},
    1159122929: {"localized_names": {"en": "Tacuarembó"}},
    1159136215: {"localized_names": {"en": "Ha'il"}},
    1159146487: {"localized_names": {"en": "Colón"}},
    1159149507: {"localized_names": {"en": "Oujda"}},
    1159150757: {"localized_names": {"en": "Tampico"}},
    # Natural Earth has the surrounding Kufra district in NAME_AR, while this
    # point and the other language fields identify the district capital Al Jawf.
    1159150075: {"localized_names": {"ar": "الجوف"}},
    # These Natural Earth Arabic labels identify the enclosing wilayat. The
    # point features are towns, so omit ولاية just as the other scripts do.
    1159137881: {"localized_names": {"ar": "مرباط"}},
    1159146591: {"localized_names": {"ar": "صحار"}},
    1159146593: {"localized_names": {"ar": "السيب"}},
    1159148149: {"localized_names": {"ar": "نزوى"}},
    1159148153: {"localized_names": {"ar": "صور"}},
    # These points represent the cities, not the identically named Saudi
    # governorates carried in Natural Earth's Arabic fields.
    1159128287: {"localized_names": {"ar": "القطيف"}},
    1159136385: {"localized_names": {"ar": "الخرج"}},
    # Natural Earth has merged the wilayat prefix with the town name and then
    # attached an unrelated Arabic personal name. Omani government sources use
    # simply Samail / سمائل for this place.
    1159128941: {
        "name": "Samail",
        "replace_source_names": True,
        "script_names": {
            "Latn": "Samail",
            "Jpan": "サマイル",
            "Hans": "萨迈勒",
            "Hant": "薩邁勒",
            "Kore": "사마일",
            "Cyrl": "Самаиль",
            "Arab": "سمائل",
            "Deva": "समाइल",
            "Beng": "সামাইল",
            "Grek": "Σαμάιλ",
            "Hebr": "סמאיל",
        },
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

    locale_name_fields = dict(LOCALE_NAME_FIELDS)
    locale_name_fields.update({
        locale: field for locale, field in SCRIPT_NAME_FIELDS.values()
    })
    for code, country_override in (overrides.get("countries") or {}).items():
        for place in country_override.get("additional_places") or []:
            name = str(place.get("name") or "").strip()
            if len(code) != 2 or not name:
                continue
            properties = {
                "ISO_A2": code,
                "ADM0_A3": map_config["iso2_to_iso3"].get(code, ""),
                "NAME": name,
                "MIN_ZOOM": place.get("minimum_zoom", 9),
                "POP_MAX": place.get("population", 0),
                "ADM0CAP": 0,
            }
            for locale, localized_name in (place.get("names") or {}).items():
                field = locale_name_fields.get(locale)
                if field and str(localized_name).strip():
                    properties[field] = str(localized_name).strip()
            grouped[code].append({
                "properties": properties,
                "geometry": {
                    "type": "Point",
                    "coordinates": [place.get("longitude"), place.get("latitude")],
                },
            })

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
            # ISO 3166-1 and CLDR region codes cover countries and territories,
            # not only sovereign states. For atlas display, an explicitly named
            # administrative center is treated as the capital. Otherwise, a
            # coded region without a Natural Earth ADM0 capital uses its
            # highest-ranked place as a display fallback.
            administrative_center = str(
                country_override.get("administrative_center") or ""
            ).strip()
            if administrative_center:
                for row in places:
                    row[3] = int(row[5] == administrative_center)
            elif not any(row[3] for row in places):
                places[0][3] = 1
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
        "description": "Deferred capital and major-city labels by ISO 3166-1 and CLDR region code. A coded region's administrative center is treated as its capital. Each place has reusable script fallbacks plus sparse locale-specific overrides; English is an ordinary override.",
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
