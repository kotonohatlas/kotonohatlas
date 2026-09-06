# Kotonohatlas configuration

Repository inputs are grouped by concern. These paths are not public URLs;
`tools/language_coverage.py` builds the stable browser-facing asset names.

- `geography/`: map policy, overlays, places, and Admin-1 geometry
- `linguistics/`: language metadata and curated overrides
- `copy/`: map descriptions and interface strings
- `locales.json`: Atlas-localized interface identities and fallback graph
- `language-coverage.json`: language-family grouping and Atlas UI-localization scope

Admin-1 geometry is split into `country/`, `lang/`, and `custom/` so country
and language codes never collide on case-insensitive filesystems.
