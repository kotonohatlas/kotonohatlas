# Kotonohatlas

**Kotonohatlas** (コトノハトラス) combines Japanese *kotonoha*—言の葉,
“words” or “leaves of language”—with *atlas*. Its formal subtitle is
***Atlas Linguarum Mundi***: “Atlas of the Languages of the World.”
The Japanese name is pronounced /ko.to.no.ha.to.ɾa.sɯ/.

It is a practical language map designed to sit between visitors and the language editions of a multilingual website.
Kotonohatlas supplies the explorable map, shows which languages have a localized Atlas interface, and can suggest an
entry language from HTTP `Accept-Language` preferences followed by access-country relevance. An embedding
site may add links to its own language editions and site-specific content. Kotonohatlas can also run as a standalone
map and coverage browser.

## Scope and map disclaimer

Kotonohatlas offers an approximate overview at the level useful for multilingual websites. It is not an academically
exhaustive linguistic atlas, nor does it adjudicate borders, sovereignty, or language identity. Names and identifiers
come primarily from Unicode CLDR and ISO 3166-1, and configurable viewpoint rules adapt the presentation to its context.
See [`DISCLAIMER.md`](DISCLAIMER.md) for the full scope, limitations, sources, and customization guidance.

## Run locally

```text
python3 -m pip install -e .
make build
make serve
```

The editable install supplies the small JavaScript minifier used by the source-tree builder. The map data and CLDR
checkout stay in this repository rather than being copied into a Python wheel. The generated site is written to
`build/site` and served at `http://127.0.0.1:8000/` by default.

## Embedding boundary

Kotonohatlas owns the map, its data model, its interface, and the empty host extension elements documented below. The
embedding site owns the complete subtree inserted into those elements. Kotonohatlas neither interprets that subtree nor
assigns it a particular purpose; it may contain an introduction, navigation, status information, or nothing at all.

See [`deploy/HOST_EXTENSIONS.md`](deploy/HOST_EXTENSIONS.md) for the insertion-point contract and
[`deploy/locale-context/`](deploy/locale-context/) for the access-country endpoint contract.

The browser API keeps access resolution deliberately small:

```js
const languages = await LocaleAccess.getAccessLanguageSuggestions();
```

The returned list is already ordered as HTTP `Accept-Language`, then country-based suggestions, with duplicates
removed. Use `getAccessLanguageContext()` when the two groups or the resolved country must be displayed separately.
The ready-to-serve browser file is [`dist/language-atlas-access.js`](dist/language-atlas-access.js); regenerate only
that file with `make access-runtime`.

## License

Kotonohatlas's own software, project-authored configuration, and transformation logic—the recipe used to turn its
inputs into the language atlas—are available under the [GNU General Public License v3.0 or later](LICENSE). Commercial
use is welcome under the terms of the GPL.

Organizations for which source-disclosure requirements, license compatibility, or internal compliance policies make
GPL use impractical may arrange a non-GPL licensing option. Separately, deployment assistance and multilingual
publishing support, including AI-assisted language expansion, are available. See
[`ALTERNATIVE-LICENSING.md`](ALTERNATIVE-LICENSING.md) or contact <kh@callirrhoe.net>.

Source datasets are not relicensed by Kotonohatlas. Bundled third-party software and data remain under their respective
licenses or terms. See
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

## Layout

| Path | Role |
|---|---|
| `config/geography/` | Map policy, geometry, places, and overlays |
| `config/linguistics/` | Language metadata, names, and speaker estimates |
| `config/copy/` | Map descriptions and interface strings |
| `tools/` | Site builder and map helpers |
| `tools/browser/` | Browser runtime and coverage page |
| `dist/` | Ready-to-serve embeddable access-language runtime |
| `deploy/` | Host integration contracts and examples |
| `vendor/cldr-json/` | Local Unicode CLDR data dependency |
| `build/` | Generated local output |

## Language layers and build inputs

Kotonohatlas keeps three independent sets:

1. **Recognized languages** have enough geographic or linguistic metadata to appear in map search and context cards.
2. **Localized Atlas locales** can run the Atlas interface, using sparse translations and configured fallbacks where
   necessary. `config/locales.json` defines this set.
3. **Published host editions** have an external destination supplied by the embedding site. They are links, not Atlas
   localization capability.

The first two sets, generic interface translations, map data, and browser runtimes live in this repository, so
`make build` needs no host project beside it. An embedding project can supply the small pieces that belong to its
deployment:

| Input | Purpose |
|---|---|
| `ATLAS_LOCALES=/path/locales.json` | Optional override of Atlas-localized interface locales |
| `ATLAS_INTRO_COPY=/path/intro.json` | Optional localized host introduction |
| `--publication-manifest /path/file.json` | Which language editions link out of Atlas |
| `ATLAS_VIEWPOINT` | Optional territorial viewpoint policy |

No host Python module is imported, and Atlas does not scan documentation, translation status, review history, or host
wave configuration. The localization-registry and publication-manifest contracts are documented in
[`deploy/HOST_EXTENSIONS.md`](deploy/HOST_EXTENSIONS.md#choosing-the-atlas-localization-set).

## Tests

```text
make test
```

Tests protect behavior and stable data invariants. They must not freeze mutable translations, labels, toponyms,
catalog ordering, coverage totals, or other reviewed data. See [`AGENTS.md`](AGENTS.md).
