#!/usr/bin/env python3
"""Pack deterministic country and territory labels from pinned Unicode CLDR JSON."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

from atlas_paths import COPY_DIR, GEOGRAPHY_DIR, CLDR_REPOSITORY, ensure_import_paths

ensure_import_paths()

CLDR_JSON = CLDR_REPOSITORY / "cldr-json"
CLDR_LOCALE_NAMES = CLDR_JSON / "cldr-localenames-full" / "main"
CLDR_PACKAGE = CLDR_JSON / "cldr-localenames-full" / "package.json"
CLDR_ALIASES = CLDR_JSON / "cldr-core" / "supplemental" / "aliases.json"
CLDR_PARENT_LOCALES = CLDR_JSON / "cldr-core" / "supplemental" / "parentLocales.json"
LANGUAGE_MAP = GEOGRAPHY_DIR / "map.json"
MAP_LOCALIZATION_DIR = COPY_DIR / "i18n"
MAP_LOCALIZATION_SOURCE_PATHS = (
    MAP_LOCALIZATION_DIR / "atlas-ui.json",
    MAP_LOCALIZATION_DIR / "map-controls.json",
)
GLOBAL_ALTERNATES = {
    "CD": "variant",
    "CG": "variant",
    "HK": "short",
    "MO": "short",
    "PS": "short",
}
LOCALE_ALTERNATES = {}


def _json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def map_locale_ids() -> list[str]:
    locale_lists = []
    for path in MAP_LOCALIZATION_SOURCE_PATHS:
        payload = _json(path)
        locales = payload.get("locales")
        if (
            payload.get("schema") != 2
            or not isinstance(payload.get("version"), int)
            or int(payload["version"]) <= 0
            or payload.get("kind") != path.stem.replace("-", "_")
            or not isinstance(locales, list)
            or not locales
            or any(not isinstance(locale, str) or not locale for locale in locales)
            or locales != sorted(set(locales))
        ):
            raise ValueError(f"invalid language-map localization source: {path}")
        locale_lists.append(locales)
    if any(locales != locale_lists[0] for locales in locale_lists[1:]):
        raise ValueError("language-map localization sources must use the same locales")
    return list(locale_lists[0])


def _git_dir(repository: Path) -> Path:
    git_path = repository / ".git"
    if git_path.is_file():
        content = git_path.read_text(encoding="utf-8").strip()
        if not content.startswith("gitdir:"):
            raise ValueError(f"unsupported gitdir pointer: {git_path}")
        return (repository / content.split(":", 1)[1].strip()).resolve()
    if git_path.is_dir():
        return git_path
    raise FileNotFoundError(f"git metadata missing: {repository}")


def _read_git_head(repository: Path) -> str:
    git_dir = _git_dir(repository)
    head = (git_dir / "HEAD").read_text(encoding="utf-8").strip()
    if not head.startswith("ref:"):
        return head
    ref = head.split(":", 1)[1].strip()
    ref_path = git_dir / ref
    if ref_path.is_file():
        return ref_path.read_text(encoding="utf-8").strip()
    packed = git_dir / "packed-refs"
    if packed.is_file():
        for line in packed.read_text(encoding="utf-8").splitlines():
            if line.startswith("#") or " " not in line:
                continue
            sha, name = line.split(" ", 1)
            if name.strip() == ref:
                return sha.strip()
    raise FileNotFoundError(f"git ref missing: {ref_path}")


def _cldr_revision() -> str:
    # Prefer git when available, but CI slim images may omit the binary even
    # though the submodule checkout is present on disk.
    try:
        result = subprocess.run(
            ["git", "-C", str(CLDR_REPOSITORY), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return _read_git_head(CLDR_REPOSITORY)
    return result.stdout.strip()


def _language_aliases() -> dict[str, str]:
    rows = (
        (((_json(CLDR_ALIASES).get("supplemental") or {}).get("metadata") or {}).get("alias") or {})
        .get("languageAlias")
        or {}
    )
    return {
        str(locale).replace("_", "-"): str(entry.get("_replacement") or "").replace("_", "-")
        for locale, entry in rows.items()
        if isinstance(entry, dict) and entry.get("_replacement")
    }


def _source_locale(locale: str, aliases: dict[str, str]) -> str:
    normalized = locale.replace("_", "-")
    language = normalized.split("-", 1)[0]
    canonical = aliases.get(normalized) or aliases.get(language) or ""
    candidates = (normalized, canonical, language)
    return next(
        (
            candidate
            for candidate in candidates
            if candidate and (CLDR_LOCALE_NAMES / candidate / "territories.json").is_file()
        ),
        "",
    )


def _locale_chain(source_locale: str, parents: dict[str, str]) -> list[str]:
    chain = []
    current = source_locale
    while current and current != "und" and current not in chain:
        path = CLDR_LOCALE_NAMES / current / "territories.json"
        if path.is_file():
            chain.append(current)
        explicit = parents.get(current)
        current = explicit if explicit else current.rsplit("-", 1)[0] if "-" in current else ""
    if "en" not in chain:
        chain.append("en")
    return chain


def _territories(source_locale: str, country_codes: list[str]) -> dict[str, str]:
    parents = (
        ((_json(CLDR_PARENT_LOCALES).get("supplemental") or {}).get("parentLocales") or {})
        .get("parentLocale")
        or {}
    )
    tables = []
    for locale in _locale_chain(source_locale, parents):
        payload = _json(CLDR_LOCALE_NAMES / locale / "territories.json")
        names = (
            ((((payload.get("main") or {}).get(locale) or {}).get("localeDisplayNames") or {}).get("territories"))
            or {}
        )
        tables.append(names)
    resolved = {}
    for code in country_codes:
        alternate = (LOCALE_ALTERNATES.get(source_locale) or {}).get(code) or GLOBAL_ALTERNATES.get(code)
        key = (
            f"{code}-alt-{alternate}"
            if alternate
            else code
        )
        value = next((str(names.get(key) or "").strip() for names in tables if names.get(key)), "")
        if not value:
            value = next((str(names.get(code) or "").strip() for names in tables if names.get(code)), "")
        if not value:
            raise ValueError(f"CLDR {source_locale} is missing territory {code}")
        resolved[code] = value
    return resolved


def build_catalog() -> dict:
    if not CLDR_PACKAGE.is_file():
        raise SystemExit(
            "CLDR JSON is unavailable; populate vendor/cldr-json or set ATLAS_CLDR"
        )
    package = _json(CLDR_PACKAGE)
    country_codes = sorted((_json(LANGUAGE_MAP).get("iso2_to_iso3") or {}).keys())
    aliases = _language_aliases()
    locales = {}
    unsupported = []
    for locale in map_locale_ids():
        source_locale = _source_locale(locale, aliases)
        if not source_locale:
            unsupported.append(locale)
            continue
        locales[locale] = {
            "source_locale": source_locale,
            "names": _territories(source_locale, country_codes),
        }
    return {
        "schema": 3,
        "version": 1,
        "source": {
            "name": "Unicode CLDR JSON",
            "package": str(package.get("name") or "cldr-localenames-full"),
            "version": str(package.get("version") or ""),
            "cldr_version": str(package.get("cldrVersion") or ""),
            "unicode_version": str(package.get("unicodeVersion") or ""),
            "revision": _cldr_revision(),
            "license": str(package.get("license") or "Unicode-3.0"),
        },
        "style": "long",
        "alternates": GLOBAL_ALTERNATES,
        "locale_alternates": LOCALE_ALTERNATES,
        "country_codes": country_codes,
        "locales": locales,
        "unsupported_locales": unsupported,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    rendered = json.dumps(build_catalog(), ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if not args.output.is_file() or args.output.read_text(encoding="utf-8") != rendered:
            raise SystemExit(f"country-name catalog is stale: {args.output}")
        return 0
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
