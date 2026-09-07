# Third-party licenses

The Kotonohatlas license covers the project's own code, project-authored configuration, and transformation logic. It
does not claim ownership of source datasets. Bundled third-party software and data remain under their respective
licenses, terms, and copyright notices.

## Unicode CLDR

Unicode CLDR JSON is included as the `vendor/cldr-json` submodule and is licensed under the Unicode License v3.
The complete notice is available at [`vendor/cldr-json/LICENSE`](vendor/cldr-json/LICENSE).

## Browser map components

Browser-ready copies of the following components are included under `tools/browser/vendor/map`:

- `@d3-maps/atlas` — MIT License;
- `d3-geo`, `d3-selection`, `d3-zoom`, and `topojson-client` — ISC-style licenses; and
- `earcut` — ISC License.

The complete notices are stored alongside those components. See
[`tools/browser/vendor/map/README.md`](tools/browser/vendor/map/README.md) for the package versions and file index.

Source attribution recorded in Kotonohatlas configuration, including attribution for map geometry derived from
Natural Earth, remains applicable to the corresponding data.

## Optional place-name generation tools

The optional `place-generation` dependency group uses Aksharamukha (AGPL-3.0), Epitran (MIT Modern Variant),
Phonemizer (GPL-3.0-or-later), and eSpeak NG data and libraries distributed by `espeakng-loader` (GPL-3.0-or-later).
These tools generate the reviewable pronunciation catalog and script fallbacks; they are not loaded by the browser.
