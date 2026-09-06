#!/usr/bin/env python3
"""Build localized language, family, script, and self-name packs.

Unicode CLDR is the default source for language and script display names.  The
small repository overlay contains only labels that CLDR cannot supply or whose
curated atlas wording intentionally differs.  Language-family labels remain
manual because CLDR does not provide the atlas taxonomy.
"""

from __future__ import annotations

import argparse
from functools import lru_cache
import json
from pathlib import Path
import unicodedata

from atlas_paths import LINGUISTICS_DIR, ensure_import_paths

ensure_import_paths()
import country_names as cldr

CLDR_LOCALE_NAMES = cldr.CLDR_LOCALE_NAMES
CLDR_LIKELY_SUBTAGS = cldr.CLDR_JSON / "cldr-core" / "supplemental" / "likelySubtags.json"
OVERRIDES_PATH = LINGUISTICS_DIR / "language-names.json"
HANI_KANJI_ALIAS_ROOTS = ("sino", "chin", "cin", "txin", "kinvers", "xitoy")


@lru_cache(maxsize=None)
def _json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _locale_table(source_locale: str, filename: str, section: str) -> dict[str, str]:
    parents = (
        ((_json(cldr.CLDR_PARENT_LOCALES).get("supplemental") or {}).get("parentLocales") or {})
        .get("parentLocale")
        or {}
    )
    resolved: dict[str, str] = {}
    # The first locale in the chain is the most specific.  Keep its values and
    # fill only absent entries from linguistic parents.  Do not copy English
    # labels into another locale's pack; a missing localized value is better
    # represented by a sparse manual overlay or the browser's final fallback.
    for locale in cldr._locale_chain(source_locale, parents):
        if locale == "en" and source_locale != "en":
            continue
        path = CLDR_LOCALE_NAMES / locale / filename
        if not path.is_file():
            continue
        payload = _json(path)
        rows = (
            ((((payload.get("main") or {}).get(locale) or {}).get("localeDisplayNames") or {}).get(section))
            or {}
        )
        for code, value in rows.items():
            if value and "-alt-" not in str(code):
                resolved.setdefault(str(code), str(value).strip())
    return resolved


def _language_candidates(code: str) -> list[str]:
    normalized = str(code).replace("_", "-")
    parts = normalized.split("-")
    candidates = [normalized]
    if len(parts) >= 3:
        candidates.append("-".join(parts[:-1]))
    candidates.append(parts[0])
    return list(dict.fromkeys(candidate for candidate in candidates if candidate))


def _resolve_language(table: dict[str, str], code: str) -> str:
    return next((table[candidate] for candidate in _language_candidates(code) if table.get(candidate)), "")


def _resolve_language_match(table: dict[str, str], code: str) -> tuple[str, str]:
    for candidate in _language_candidates(code):
        if table.get(candidate):
            return candidate, table[candidate]
    return "", ""


def _locale_display_pattern(source_locale: str) -> dict[str, str]:
    parents = (
        ((_json(cldr.CLDR_PARENT_LOCALES).get("supplemental") or {}).get("parentLocales") or {})
        .get("parentLocale")
        or {}
    )
    for locale in cldr._locale_chain(source_locale, parents):
        if locale == "en" and source_locale != "en":
            continue
        path = CLDR_LOCALE_NAMES / locale / "localeDisplayNames.json"
        if not path.is_file():
            continue
        payload = _json(path)
        pattern = (
            ((((payload.get("main") or {}).get(locale) or {}).get("localeDisplayNames") or {}).get("localeDisplayPattern"))
            or {}
        )
        if pattern.get("localePattern") and pattern.get("localeSeparator"):
            return {key: str(value) for key, value in pattern.items()}
    return {}


def _maximize_language(code: str, likely: dict[str, str]) -> tuple[str, str, str]:
    normalized = str(code).replace("_", "-")
    parts = normalized.split("-")
    language = parts[0]
    script = next((part for part in parts[1:] if len(part) == 4 and part.isalpha()), "")
    region = next(
        (part for part in parts[1:] if (len(part) == 2 and part.isalpha()) or (len(part) == 3 and part.isdigit())),
        "",
    )
    candidates = [normalized]
    if region:
        candidates.append(f"{language}-{region}")
    if script:
        candidates.append(f"{language}-{script}")
    candidates.append(language)
    maximized = next((str(likely[candidate]) for candidate in candidates if likely.get(candidate)), "")
    max_parts = maximized.split("-")
    if maximized:
        language = max_parts[0]
        script = script or next((part for part in max_parts[1:] if len(part) == 4), "")
        region = region or next(
            (part for part in max_parts[1:] if len(part) in (2, 3) and len(part) != 4),
            "",
        )
    return language, script, region


def _variant_qualifiers(language_codes: list[str]) -> dict[str, tuple[str, str]]:
    likely = (_json(CLDR_LIKELY_SUBTAGS).get("supplemental") or {}).get("likelySubtags") or {}
    grouped: dict[str, list[str]] = {}
    for code in language_codes:
        grouped.setdefault(str(code).replace("_", "-").split("-", 1)[0], []).append(code)
    qualifiers: dict[str, tuple[str, str]] = {}
    for codes in grouped.values():
        if len(codes) < 2:
            continue
        maximized = {code: _maximize_language(code, likely) for code in codes}
        scripts = {value[1] for value in maximized.values() if value[1]}
        regions = {value[2] for value in maximized.values() if value[2]}
        for code in codes:
            normalized = str(code).replace("_", "-")
            if "-" not in normalized:
                continue
            _language, script, region = maximized[code]
            if len(scripts) > 1 and script:
                qualifiers[code] = ("script", script)
            elif len(regions) > 1 and region:
                qualifiers[code] = ("territory", region)
    return qualifiers


def _format_qualified_name(name: str, qualifier: str, pattern: dict[str, str]) -> str:
    template = pattern.get("localePattern") or ""
    if "{0}" not in template or "{1}" not in template:
        return ""
    return template.replace("{0}", name).replace("{1}", qualifier)


def _source_locale_for_file(locale: str, filename: str) -> str:
    aliases = cldr._language_aliases()
    normalized = str(locale).replace("_", "-")
    language = normalized.split("-", 1)[0]
    canonical = aliases.get(normalized) or aliases.get(language) or ""
    return next(
        (
            candidate
            for candidate in (normalized, canonical, language)
            if candidate and (CLDR_LOCALE_NAMES / candidate / filename).is_file()
        ),
        "",
    )


def _base_locale_names(
    locale: str,
    language_codes: list[str],
    script_codes: list[str],
    language_name_aliases: dict[str, str] | None = None,
) -> dict:
    source_locale = _source_locale_for_file(locale, "languages.json")
    if not source_locale:
        return {"source_locale": "", "languages": {}, "scripts": {}}
    languages = _locale_table(source_locale, "languages.json", "languages")
    scripts = _locale_table(source_locale, "scripts.json", "scripts")
    territories = _locale_table(source_locale, "territories.json", "territories")
    pattern = _locale_display_pattern(source_locale)
    qualifiers = _variant_qualifiers(language_codes)
    language_group_sizes: dict[str, int] = {}
    for code in language_codes:
        language = str(code).replace("_", "-").split("-", 1)[0]
        language_group_sizes[language] = language_group_sizes.get(language, 0) + 1
    resolved_languages = {}
    language_name_aliases = language_name_aliases or {}
    for code in language_codes:
        normalized = str(code).replace("_", "-")
        language = normalized.split("-", 1)[0]
        name_alias = language_name_aliases.get(code)
        lookup_code = name_alias or (language if language_group_sizes[language] == 1 else code)
        matched, value = _resolve_language_match(languages, lookup_code)
        if not value:
            continue
        qualifier_kind, qualifier_code = qualifiers.get(code, ("", ""))
        # Exact CLDR compound-language names are preferable to synthesized
        # labels. Qualify only values that otherwise collapse to the base name.
        if not name_alias and matched != normalized and qualifier_kind:
            qualifier_table = scripts if qualifier_kind == "script" else territories
            qualifier = qualifier_table.get(qualifier_code) or ""
            qualified = _format_qualified_name(value, qualifier, pattern) if qualifier else ""
            if qualified:
                value = qualified
        resolved_languages[code] = value
    resolved_scripts = {
        code: scripts[code]
        for code in script_codes
        if scripts.get(code)
    }
    # Ethiopic/Geʽez is a meaningful dual name. Generate it only when CLDR
    # supplies both localized terms and a localized composition pattern.
    if resolved_scripts.get("Ethi") and languages.get("gez"):
        generated = _format_qualified_name(
            resolved_scripts["Ethi"], languages["gez"], pattern
        )
        if generated:
            resolved_scripts["Ethi"] = generated
    # Kanji is a useful search/display alias where a Latin-script CLDR label
    # describes the script through a sino-/chin- “Chinese” root. Han/Hani,
    # Kanji, 汉字, and 漢字 labels already identify it adequately and stay intact.
    # English has its explicit manual label.
    hani_label = resolved_scripts.get("Hani") or ""
    normalized_hani = "".join(
        character
        for character in unicodedata.normalize("NFKD", hani_label).casefold()
        if not unicodedata.combining(character)
    )
    likely = (_json(CLDR_LIKELY_SUBTAGS).get("supplemental") or {}).get("likelySubtags") or {}
    locale_script = _maximize_language(source_locale, likely)[1]
    if (
        locale_script == "Latn"
        and hani_label
        and any(root in normalized_hani for root in HANI_KANJI_ALIAS_ROOTS)
    ):
        generated = _format_qualified_name(
            hani_label, "Kanji", pattern
        )
        if generated:
            resolved_scripts["Hani"] = generated
    return {
        "source_locale": source_locale,
        "languages": resolved_languages,
        "scripts": resolved_scripts,
    }


def _base_native_name(code: str, language_codes: list[str] | None = None) -> str:
    if language_codes:
        return _base_locale_names(code, language_codes, ["Ethi", "Hani"])["languages"].get(code, "")
    source_locale = _source_locale_for_file(code, "languages.json")
    if not source_locale:
        return ""
    table = _locale_table(source_locale, "languages.json", "languages")
    return _resolve_language(table, code)


@lru_cache(maxsize=1)
def _validated_overrides() -> dict:
    if not cldr.CLDR_PACKAGE.is_file():
        raise SystemExit(
            "CLDR JSON is unavailable; populate vendor/cldr-json or set ATLAS_CLDR"
        )
    overrides = _json(OVERRIDES_PATH)
    if (
        overrides.get("schema") != 1
        or not isinstance(overrides.get("version"), int)
        or int(overrides["version"]) <= 0
        or overrides.get("base") != "unicode-cldr-json"
        or not isinstance(overrides.get("language_codes"), list)
        or not isinstance(overrides.get("language_name_aliases"), dict)
        or not isinstance(overrides.get("script_codes"), list)
        or not isinstance(overrides.get("locales"), dict)
        or not isinstance(overrides.get("native_names"), dict)
    ):
        raise ValueError("invalid linguistic-name overrides")
    language_codes = {str(code) for code in overrides["language_codes"]}
    for target, source in overrides["language_name_aliases"].items():
        if target not in language_codes or not isinstance(source, str) or not source.strip():
            raise ValueError("invalid linguistic language-name alias")
    return overrides


@lru_cache(maxsize=None)
def build_locale_pack(locale: str) -> dict | None:
    """Build one display-language pack without traversing every CLDR locale."""
    overrides = _validated_overrides()
    language_codes = [str(code) for code in overrides["language_codes"]]
    script_codes = [str(code) for code in overrides["script_codes"]]
    base = _base_locale_names(
        locale,
        language_codes,
        script_codes,
        {str(key): str(value) for key, value in overrides["language_name_aliases"].items()},
    )
    configured = overrides["locales"].get(locale) or {}
    if not base["source_locale"] and not configured:
        return None
    language_names = dict(base["languages"])
    language_names.update(configured.get("languages") or {})
    language_records = {
        code: {"name": name}
        for code, name in language_names.items()
    }
    for code, name in (configured.get("auxiliary_names") or {}).items():
        language_records.setdefault(str(code), {})["auxiliary_name"] = str(name)
    return {
        "schema": 1,
        "version": int(overrides["version"]),
        "locale": locale,
        "source_locale": base["source_locale"],
        "languages": language_records,
        "taxonomy": {
            "families": {"labels": dict(configured.get("families") or {})},
            "scripts": {
                "labels": {
                    **base["scripts"],
                    **(configured.get("scripts") or {}),
                }
            },
        },
    }


def build_catalog() -> dict:
    overrides = _validated_overrides()
    language_codes = [str(code) for code in overrides["language_codes"]]
    script_codes = [str(code) for code in overrides["script_codes"]]
    locales = {}
    unsupported = []
    for locale in cldr.map_locale_ids():
        pack = build_locale_pack(locale)
        if pack is None:
            unsupported.append(locale)
            continue
        locales[locale] = pack
    native_codes = sorted(set(language_codes) | set(overrides["native_names"]))
    native_names = {}
    for code in native_codes:
        value = overrides["native_names"].get(code) or _base_native_name(code, language_codes)
        if value:
            native_names[code] = value
    package = _json(cldr.CLDR_PACKAGE)
    return {
        "schema": 1,
        "version": int(overrides["version"]),
        "source": {
            "name": "Unicode CLDR JSON",
            "package": str(package.get("name") or "cldr-localenames-full"),
            "version": str(package.get("version") or ""),
            "cldr_version": str(package.get("cldrVersion") or ""),
            "unicode_version": str(package.get("unicodeVersion") or ""),
            "revision": cldr._cldr_revision(),
            "license": str(package.get("license") or "Unicode-3.0"),
        },
        "language_codes": language_codes,
        "script_codes": script_codes,
        "locales": locales,
        "unsupported_locales": unsupported,
        "native_names": native_names,
        "native_name_source": overrides.get("native_name_source") or {},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    payload = build_catalog()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
