"""Atlas-owned recognized-language and localized-interface registry helpers."""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

from atlas_paths import LOCALES_PATH


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def locales_config() -> dict:
    data = load_json(LOCALES_PATH)
    locales = data.get("locales")
    if data.get("schema") != 1 or not isinstance(locales, list) or not locales:
        raise ValueError(f"invalid Atlas locale registry: {LOCALES_PATH}")
    ids = [str(item.get("locale") or "") for item in locales if isinstance(item, dict)]
    if len(ids) != len(locales) or any(not value for value in ids) or len(ids) != len(set(ids)):
        raise ValueError(f"Atlas locale registry has invalid or duplicate locale ids: {LOCALES_PATH}")
    return data


def locale_map() -> dict[str, dict]:
    return {str(item["locale"]): item for item in locales_config()["locales"]}


def locale_enabled(item: dict) -> bool:
    """Return whether a recognized language has a localized Atlas interface."""
    return item.get("enabled", True) is not False


def locale_direction(item: dict) -> str:
    direction = str(item.get("direction") or "ltr").strip().lower()
    if direction not in {"ltr", "rtl"}:
        raise ValueError(f"invalid locale direction: {item['locale']} -> {direction!r}")
    return direction


def public_locale_identity(item: dict) -> str:
    value = str(item.get("public_locale") or item["locale"]).strip().replace("_", "-")
    if not re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*", value):
        raise ValueError(f"invalid public locale identity: {item['locale']} -> {value!r}")
    parts = value.split("-")
    normalized = [parts[0].lower()]
    for part in parts[1:]:
        if len(part) == 4 and part.isalpha():
            normalized.append(part.title())
        elif len(part) in {2, 3} and part.isalpha():
            normalized.append(part.upper())
        else:
            normalized.append(part)
    return "-".join(normalized)


def public_locale_layout(items: list[dict]) -> dict[str, str]:
    identities = {str(item["locale"]): public_locale_identity(item) for item in items}
    by_language: dict[str, list[str]] = {}
    for locale, identity in identities.items():
        by_language.setdefault(identity.split("-", 1)[0].lower(), []).append(locale)
    layout: dict[str, str] = {}
    for base, locales in by_language.items():
        if len(locales) == 1:
            layout[locales[0]] = base
        else:
            layout.update({locale: identities[locale] for locale in locales})
    reverse: dict[str, str] = {}
    for locale, slug in layout.items():
        previous = reverse.get(slug.casefold())
        if previous is not None and previous != locale:
            raise ValueError(f"public locale slug collision: {slug} ({previous}/{locale})")
        reverse[slug.casefold()] = locale
    return layout


def canonical_locale(value: str) -> str:
    raw = str(value).strip()
    registry = locale_map()
    aliases = locales_config().get("aliases") or {}
    for candidate in (raw, raw.replace("-", "_")):
        if candidate in registry:
            return candidate
        if candidate in aliases:
            return str(aliases[candidate])
    normalized = raw.replace("-", "_").casefold()
    registry_lookup = {key.casefold(): key for key in registry}
    alias_lookup = {str(key).casefold(): str(target) for key, target in aliases.items()}
    if normalized in registry_lookup:
        return registry_lookup[normalized]
    if normalized in alias_lookup:
        return alias_lookup[normalized]
    if "_" not in normalized:
        matches = [key for key in registry if key.split("_", 1)[0].casefold() == normalized]
        if len(matches) == 1:
            return matches[0]
    raise ValueError(f"unknown or ambiguous locale in Atlas registry: {value}")


def locale_catalog_identity(item: dict, configured_ids: set[str]) -> str:
    locale = str(item["locale"])
    candidates = [
        str(item.get("html_language") or "").replace("_", "-"),
        public_locale_identity(item).replace("_", "-"),
        locale.replace("_", "-"),
        locale.split("_", 1)[0],
    ]
    return next((candidate for candidate in candidates if candidate in configured_ids), next(
        (candidate for candidate in candidates if candidate), locale
    ))


def locale_fallbacks() -> dict[str, str]:
    raw = locales_config().get("fallback_locales") or {}
    if not isinstance(raw, dict):
        raise ValueError("fallback_locales must be an object")
    result: dict[str, str] = {}
    for source, target in raw.items():
        canonical_source = canonical_locale(source)
        canonical_target = canonical_locale(target)
        if canonical_source == canonical_target:
            raise ValueError(f"locale fallback cannot reference itself: {canonical_source}")
        result[canonical_source] = canonical_target
    for locale in result:
        seen: set[str] = set()
        current = locale
        while current in result:
            if current in seen:
                raise ValueError(f"locale fallback cycle detected from: {locale}")
            seen.add(current)
            current = result[current]
    return result


def locale_fallbacks_for_catalog(configured_ids: set[str]) -> dict[str, str]:
    registry = locale_map()
    projected: dict[str, str] = {}
    for locale, fallback in locale_fallbacks().items():
        source_id = locale_catalog_identity(registry[locale], configured_ids)
        fallback_id = locale_catalog_identity(registry[fallback], configured_ids)
        if source_id in configured_ids and fallback_id in configured_ids:
            projected[source_id] = fallback_id
    return projected
