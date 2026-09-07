#!/usr/bin/env python3
"""Build reviewable source-language and IPA hints for place-name enrichment.

This file is deliberately separate from places.json: pronunciation provenance is
needed while generating script fallbacks, but is not needed by the browser.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import unicodedata
from pathlib import Path

from atlas_paths import ATLAS_ROOT, GEOGRAPHY_DIR


PLACES_PATH = GEOGRAPHY_DIR / "places.json"
OUTPUT_PATH = GEOGRAPHY_DIR / "place-pronunciations.json"
OVERRIDES_PATH = GEOGRAPHY_DIR / "place-pronunciation-overrides.json"
TERRITORY_INFO_PATH = (
    ATLAS_ROOT
    / "vendor/cldr-json/cldr-json/cldr-core/supplemental/territoryInfo.json"
)

LANGUAGES = {
    "ar": {"epitran": "ara-Arab", "espeak": "ar"},
    "bn": {"epitran": "ben-Beng", "espeak": "bn"},
    "de": {"epitran": "deu-Latn", "espeak": "de"},
    "el": {"epitran": "", "espeak": "el"},
    "en": {"epitran": "", "espeak": "en-us"},
    "es": {"epitran": "spa-Latn", "espeak": "es"},
    "fa": {"epitran": "fas-Arab", "espeak": "fa"},
    "fr": {"epitran": "fra-Latn", "espeak": "fr-fr"},
    "he": {"epitran": "", "espeak": "he"},
    "hi": {"epitran": "hin-Deva", "espeak": "hi"},
    "hu": {"epitran": "hun-Latn", "espeak": "hu"},
    "id": {"epitran": "ind-Latn", "espeak": "id"},
    "it": {"epitran": "ita-Latn", "espeak": "it"},
    "ja": {"epitran": "", "espeak": "ja"},
    "ko": {"epitran": "kor-Hang", "espeak": "ko"},
    "nl": {"epitran": "nld-Latn", "espeak": "nl"},
    "pl": {"epitran": "pol-Latn", "espeak": "pl"},
    "pt": {"epitran": "por-Latn", "espeak": "pt"},
    "ru": {"epitran": "rus-Cyrl", "espeak": "ru"},
    "sv": {"epitran": "swe-Latn", "espeak": "sv"},
    "tr": {"epitran": "tur-Latn", "espeak": "tr"},
    "uk": {"epitran": "ukr-Cyrl", "espeak": "uk"},
    "ur": {"epitran": "urd-Arab", "espeak": "ur"},
    "vi": {"epitran": "vie-Latn", "espeak": "vi"},
    "zh": {"epitran": "", "espeak": "cmn"},
}

# CLDR gives country-level language populations, not the language of each city.
# These exceptions select the suitable regional voice without changing the
# inferred source language.
ESPEAK_VOICE_BY_COUNTRY = {
    "AU": {"en": "en-gb"},
    "BE": {"fr": "fr-be"},
    "BR": {"pt": "pt-br"},
    "CH": {"fr": "fr-ch"},
    "GB": {"en": "en-gb"},
    "IE": {"en": "en-gb"},
    "NZ": {"en": "en-gb"},
}

# English is an official language in many multilingual countries whose place
# names come from other local languages. Limit automatic English pronunciation
# to the countries where it is a reasonable default for this coarse catalog.
INFERRED_COUNTRY_ALLOWLIST = {
    "en": {"GB", "US"},
}

# Resolve a few clear cases rejected by the generic 2:1 dominance guard. This
# is a pronunciation-source choice, not a geopolitical viewpoint rule.
COUNTRY_LANGUAGE_OVERRIDES = {
    "PK": "ur",
    "TW": "zh",
    "UA": "uk",
}

SOURCE_SCRIPT_BY_LANGUAGE = {
    "ar": "Arab",
    "bn": "Beng",
    "el": "Grek",
    "fa": "Arab",
    "he": "Hebr",
    "hi": "Deva",
    "ja": "Jpan",
    "ko": "Kore",
    "ru": "Cyrl",
    "uk": "Cyrl",
    "ur": "Arab",
    "zh": "Hans",
}

# Use a locale-specific spelling as the source only where that locale is the
# ordinary local written form. Elsewhere, a locale field can be an exonym (for
# example a French colonial-era name), so the neutral Latn field is safer.
LOCALIZED_SOURCE_COUNTRIES = {
    "de": {"AT", "DE"},
    "es": {
        "AR", "BO", "CL", "CO", "CR", "CU", "DO", "EC", "ES", "GQ",
        "GT", "HN", "MX", "NI", "PA", "PE", "PR", "PY", "SV", "UY", "VE",
    },
    "fr": {"FR", "GF", "GP", "MC", "MQ", "RE"},
    "hu": {"HU"},
    "id": {"ID"},
    "it": {"IT", "SM", "VA"},
    "nl": {"NL"},
    "pl": {"PL"},
    "pt": {"BR", "PT"},
    "sv": {"SE"},
    "tr": {"TR"},
    "vi": {"VN"},
}


def _fold_ipa(value: str) -> str:
    """Normalize harmless engine notation differences for comparison only."""

    value = unicodedata.normalize("NFD", value.casefold())
    value = re.sub(r"[\u0300-\u036fˈˌː͡._\- ]", "", value)
    replacements = {
        "ʀ": "r", "ʁ": "r", "ɾ": "r", "ɹ": "r",
        "ɡ": "g", "ɐ": "a", "ɑ": "a", "ɒ": "a",
        "ɛ": "e", "ə": "e", "ɪ": "i", "ɔ": "o", "ʊ": "u",
        "ʃ": "sh", "ʂ": "sh", "ʒ": "zh", "ʐ": "zh",
    }
    return "".join(replacements.get(character, character) for character in value)


_UNCONVERTED_SCRIPT_RE = re.compile(
    "["
    "\u0590-\u05ff"  # Hebrew
    "\u0600-\u06ff"  # Arabic
    "\u0750-\u077f"  # Arabic Supplement
    "\u08a0-\u08ff"  # Arabic Extended-A
    "\u0900-\u0dff"  # Indic scripts used by the configured engines
    "\u0400-\u052f"  # Cyrillic
    "\u1100-\u11ff\u3130-\u318f\uac00-\ud7af"  # Hangul
    "\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff"  # Kana and Han
    "]"
)


def _valid_ipa(value: str) -> bool:
    """Reject explicit language switches and visibly unconverted source text."""

    if not value or re.search(r"\([a-z][a-z0-9-]*\)", value.casefold()):
        return False
    return not _UNCONVERTED_SCRIPT_RE.search(value)


def _load_engines():
    try:
        import epitran
        import espeakng_loader
        from phonemizer import phonemize
        from phonemizer.backend.espeak.wrapper import EspeakWrapper
    except ImportError as error:
        raise RuntimeError(
            "pronunciation build dependencies are missing; install the "
            "'place-generation' optional dependency"
        ) from error

    EspeakWrapper.set_library(espeakng_loader.get_library_path())
    EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
    # Language-switch flags are captured in the generated row, where they are
    # actionable; repeating a warning for each place only obscures the summary.
    logging.getLogger("phonemizer").setLevel(logging.ERROR)
    return epitran, phonemize


def _territory_languages(path: Path) -> dict[str, str]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    territories = raw["supplemental"]["territoryInfo"]
    inferred = {}
    for country, territory in territories.items():
        candidates = []
        for locale, details in (territory.get("languagePopulation") or {}).items():
            language = locale.split("_")[0]
            status = details.get("_officialStatus")
            if status not in {"official", "de_facto_official"}:
                continue
            candidates.append((float(details.get("_populationPercent") or 0), language))
        candidates.sort(reverse=True)
        if not candidates:
            continue
        # In multilingual countries, only infer when one supported language is
        # clearly predominant. Per-place exceptions can be added later.
        if len(candidates) > 1 and candidates[0][0] < candidates[1][0] * 2:
            continue
        language = candidates[0][1]
        allowlist = INFERRED_COUNTRY_ALLOWLIST.get(language)
        if language in LANGUAGES and (allowlist is None or country in allowlist):
            inferred[country] = language
    # CLDR records Polish correctly, but this explicit line documents the
    # intended regression case and survives reduced CLDR distributions.
    inferred.setdefault("PL", "pl")
    inferred.update({
        country: language
        for country, language in COUNTRY_LANGUAGE_OVERRIDES.items()
        if language in LANGUAGES
    })
    return inferred


def _source_name(country: str, row: list, language: str) -> str:
    names = row[6]
    locales = names.get("locales") or {}
    localized = str(locales.get(language) or "").strip()
    if language in LOCALIZED_SOURCE_COUNTRIES:
        if country not in LOCALIZED_SOURCE_COUNTRIES[language]:
            localized = ""
    script = SOURCE_SCRIPT_BY_LANGUAGE.get(language, "Latn")
    if language == "zh" and country == "TW":
        script = "Hant"
    return localized or str(names["scripts"].get(script) or names["scripts"]["Latn"]).strip()


def _format_payload(payload: dict) -> str:
    def compact(value: object) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(", ", ": "))

    lines = ["{"]
    keys = list(payload)
    for index, key in enumerate(keys):
        comma = "," if index + 1 < len(keys) else ""
        if key != "countries":
            lines.append(f"  {compact(key)}: {compact(payload[key])}{comma}")
            continue
        lines.append(f'  "countries": {{')
        countries = list(payload[key].items())
        for country_index, (country, entries) in enumerate(countries):
            country_comma = "," if country_index + 1 < len(countries) else ""
            lines.append(f"    {compact(country)}: {{")
            rows = list(entries.items())
            for row_index, (name, details) in enumerate(rows):
                row_comma = "," if row_index + 1 < len(rows) else ""
                lines.append(f"      {compact(name)}: {compact(details)}{row_comma}")
            lines.append(f"    }}{country_comma}")
        lines.append(f"  }}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def build(places_path: Path, territory_info_path: Path, overrides_path: Path) -> dict:
    epitran_module, phonemize = _load_engines()
    places = json.loads(places_path.read_text(encoding="utf-8"))
    country_languages = _territory_languages(territory_info_path)
    overrides = json.loads(overrides_path.read_text(encoding="utf-8"))
    ipa_overrides = overrides.get("countries") or {}
    unused_overrides = {
        (country, name)
        for country, entries in ipa_overrides.items()
        for name in entries
    }
    epitran_engines = {
        language: epitran_module.Epitran(settings["epitran"])
        for language, settings in LANGUAGES.items()
        if settings.get("epitran")
    }
    countries = {}
    status_counts = {
        "reviewed": 0,
        "reading-reviewed": 0,
        "engine-consensus": 0,
        "single-engine": 0,
        "candidate": 0,
        "invalid": 0,
    }
    for country, country_payload in places["countries"].items():
        language = country_languages.get(country)
        if not language:
            continue
        voice = (ESPEAK_VOICE_BY_COUNTRY.get(country) or {}).get(language)
        if not voice and language == "es" and country != "ES":
            voice = "es-419"
        voice = voice or LANGUAGES[language]["espeak"]
        entries = {}
        for row in country_payload.get("places") or []:
            name = str(row[5])
            # Some source datasets contain two coordinates with the same label.
            # Pronunciation is keyed by label and is intentionally shared.
            if name in entries:
                continue
            source = _source_name(country, row, language)
            override = (ipa_overrides.get(country) or {}).get(name)
            if override:
                unused_overrides.discard((country, name))
            if isinstance(override, str):
                ipa_override = override
                engine_input = source
            else:
                override = override or {}
                ipa_override = str(override.get("ipa") or "").strip()
                engine_input = str(override.get("input") or source).strip()
            epitran_engine = epitran_engines.get(language)
            epitran_ipa = (
                epitran_engine.transliterate(engine_input).strip()
                if epitran_engine
                else ""
            )
            espeak_ipa = phonemize(
                engine_input,
                language=voice,
                backend="espeak",
                strip=True,
                preserve_punctuation=True,
                njobs=1,
            ).strip()
            alternate_key = ""
            alternate_ipa = ""
            espeak_valid = _valid_ipa(espeak_ipa)
            epitran_valid = _valid_ipa(epitran_ipa)
            if ipa_override:
                ipa = ipa_override
                status = "reviewed"
            elif espeak_valid and not epitran_ipa:
                ipa = espeak_ipa
                status = "reading-reviewed" if engine_input != source else "single-engine"
            elif espeak_valid and epitran_valid and _fold_ipa(epitran_ipa) == _fold_ipa(espeak_ipa):
                ipa = espeak_ipa
                status = "reading-reviewed" if engine_input != source else "engine-consensus"
            elif epitran_valid and not espeak_valid:
                ipa = epitran_ipa
                status = "reading-reviewed" if engine_input != source else "candidate"
                alternate_key = "espeak_ipa"
                alternate_ipa = espeak_ipa
            elif espeak_valid:
                # eSpeak NG handles lexical exceptions and silent letters that
                # a grapheme-only engine cannot. Preserve Epitran's result so
                # this choice remains reviewable.
                ipa = espeak_ipa
                status = "reading-reviewed" if engine_input != source else "candidate"
                alternate_key = "epitran_ipa"
                alternate_ipa = epitran_ipa
            else:
                ipa = ""
                status = "invalid"
                alternate_key = "espeak_ipa"
                alternate_ipa = espeak_ipa
            status_counts[status] += 1
            entry = {
                "language": language,
                "source": source,
                "ipa": ipa,
                "status": status,
            }
            if engine_input != source:
                entry["engine_input"] = engine_input
            if alternate_key:
                entry[alternate_key] = alternate_ipa
            if (
                ipa_override
                and epitran_ipa
                and _fold_ipa(epitran_ipa) != _fold_ipa(ipa)
            ):
                entry["epitran_ipa"] = epitran_ipa
            entries[name] = entry
        if entries:
            countries[country] = entries
    if unused_overrides:
        formatted = ", ".join(f"{country}/{name}" for country, name in sorted(unused_overrides))
        raise ValueError(f"pronunciation overrides do not match generated places: {formatted}")
    return {
        "schema": 1,
        "description": (
            "Build-time pronunciation hints for script fallback generation. "
            "Source languages are inferred from CLDR territory data; IPA is "
            "never shipped to the browser. reviewed rows have an explicit IPA; "
            "reading-reviewed rows use an explicit engine input; engine-consensus "
            "means only that two engines agree; candidate rows retain the "
            "disagreeing engine result; invalid rows are not used."
        ),
        "engines": {
            "primary": "eSpeak NG",
            "comparison": "Epitran where a language module is available",
        },
        "status_counts": status_counts,
        "countries": countries,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--places", type=Path, default=PLACES_PATH)
    parser.add_argument("--territory-info", type=Path, default=TERRITORY_INFO_PATH)
    parser.add_argument("--overrides", type=Path, default=OVERRIDES_PATH)
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    args = parser.parse_args()
    try:
        payload = build(args.places, args.territory_info, args.overrides)
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1
    args.output.write_text(_format_payload(payload), encoding="utf-8")
    counts = payload["status_counts"]
    print(
        f"countries={len(payload['countries'])} places={sum(counts.values())} "
        + " ".join(f"{key}={value}" for key, value in counts.items())
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
