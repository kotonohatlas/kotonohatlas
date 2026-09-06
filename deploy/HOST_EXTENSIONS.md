# Host insertion points

Kotonohatlas provides a generic insertion point near the start of the page:

```html
<div id="atlas-host-intro"></div>
```

The element is empty in Kotonohatlas output. An embedding site may place any suitable HTML inside it during its own
build or deployment process. Kotonohatlas assigns no product-specific meaning, schema, or workflow to that content.

## Boundary

Kotonohatlas guarantees the element ID and its position in the page. The embedding site owns everything inserted into
the element, including its wording, localization, markup, links, styling, data sources, and update policy.

Content inside the element must not be required for the map to initialize or operate. If nothing is inserted, the empty
element remains inert and the page continues to work normally.

For example, a host may change the browser title and add its own introductory copy without changing Kotonohatlas:

```js
document.title = "Language guide — Example site";

const intro = document.getElementById("atlas-host-intro");
const heading = document.createElement("h2");
heading.textContent = "About this language guide";
const copy = document.createElement("p");
copy.textContent = "This copy, its translation, and its presentation belong to the host site.";
intro.replaceChildren(heading, copy);
```

## Integration guidance

- Insert host content after Kotonohatlas generates the page.
- Keep the outer element and its `id` unchanged.
- Namespace host-specific classes and data attributes.
- Treat the inserted subtree as host-owned; Kotonohatlas must not interpret its internal structure.
- Preserve the empty element when producing a reusable or standalone build.

If the inserted markup uses Atlas's `data-i18n` lookup, the host may also provide a locale-keyed message bundle with
`ATLAS_INTRO_COPY=/absolute/path/intro.json`. Atlas only merges these strings into the page message catalog; it does not
assign meaning to their keys or require a particular introduction layout:

```json
{
  "schema": 1,
  "version": 1,
  "messages": {
    "en": {"hostHeading": "About this site"},
    "fr": {"hostHeading": "À propos de ce site"}
  }
}
```

Keys in this host bundle must not collide with Atlas-owned interface keys. The host remains responsible for checking
that every key required by its inserted markup is present.

The access-country endpoint under [`locale-context/`](locale-context/) is a separate optional interface. It is not part
of the insertion-point contract.

## Choosing the Atlas localization set

Kotonohatlas distinguishes languages it recognizes in map data from locales in which the Atlas interface can run.
It ships its own registry for the latter set. A deployment may replace that Atlas-localization registry at build time
by setting `ATLAS_LOCALES` to an absolute path:

```sh
ATLAS_LOCALES=/srv/example/config/locales.json \
make build
```

A typical entry identifies Atlas's stable internal locale, its native display name, and any public BCP 47 identity
that differs from the internal identifier:

```json
{
  "schema": 1,
  "locales": [
    {"locale": "en", "name": "English", "public_locale": "en-US"},
    {"locale": "fr_FR", "name": "Français", "html_language": "fr-FR"},
    {"locale": "ar", "name": "العربية", "direction": "rtl"}
  ]
}
```

`enabled` defaults to true. A row with `enabled: false` is omitted from the generated Atlas localization catalog; it is
not rendered as a plan or candidate. Planning metadata belongs to the project doing that planning.

This registry controls Atlas's localized UI-language catalog. It does not reduce the map's recognized linguistic
universe: Kotonohatlas may still know about other languages for mapping and lookup, displaying them as recognized but
not localized. Sparse localization is valid; configured fallback relationships supply missing Atlas copy.

The registry may also contain `aliases`, `fallback_locales`, `public_aliases`, `public_alias_preferences`, and
`public_fallback_locale`. These general locale relationships drive Atlas fallback and identity resolution. Host build
flags, review states, translation waves, corpus totals, and catalog ordering do not belong in this contract.

## Linking published editions

Host publication is a separate input. Pass a schema-1 manifest whose entries use localized Atlas locale IDs and
optional links:

```json
{
  "schema": 1,
  "locales": [
    {"locale": "en", "href": "https://example.org/en/"},
    {"locale": "fr_FR", "href": "./fr/"},
    "ar"
  ]
}
```

```sh
python3 tools/language_coverage.py \
  --publication-manifest /srv/example/atlas-publications.json \
  --output build/site
```

A string entry uses Atlas's default `./<public-locale-slug>/` link. An object may supply any relative or absolute host
URL. Omitting the manifest produces a standalone atlas with no edition links. The published host set is normally a
subset of the Atlas-localized set, but the two sets are not assumed to be equal. Atlas does not infer publication by
scanning a host build tree.

FrontISTR is one integration example: its adapter reads FrontISTR's own build manifest, converts only the published
locale IDs into this contract, and then injects FrontISTR-specific introductory copy. Kotonohatlas never imports
FrontISTR code or reads its translation/review workflow.

## Catalog extension points

The generated page also preserves one empty container after the language catalog:

```html
<div id="atlas-host-after-catalog"></div>
```

An embedding project may use this container for any catalog-adjacent content: a corpus-review summary, learning-resource
links, dataset notes, project navigation, or something else. Kotonohatlas does not fetch, interpret, rank, translate, or
style that content. The host owns the complete subtree and may leave the container empty.

Language cards and the selected-language summary also contain an empty
`[data-atlas-host-language-labels][data-locale]` container. Kotonohatlas never fills or styles it. The host may use that
slot for a label when appropriate, leave it empty, or replace its contents as application state changes.

For example, an integration may show project-specific progress, available material, editorial status, a local
classification, any combination of those, or nothing. None of these uses is preferred by Kotonohatlas. The data shape,
wording, thresholds, and styling below are illustrative and are not Kotonohatlas contracts:

```js
const hostLabelsByLocale = {
  fr_FR: ["Translation 81%"],
  ja: ["Learning materials available"],
  ar: ["Editorially reviewed"],
};

function renderHostLanguageLabels(root = document) {
  root.querySelectorAll("[data-atlas-host-language-labels][data-locale]").forEach((slot) => {
    const values = hostLabelsByLocale[slot.dataset.locale] || [];
    const signature = JSON.stringify(values);
    if (slot.dataset.hostLabelSignature === signature) return;

    const labels = values.map((value) => {
      const label = document.createElement("span");
      label.className = "example-host-language-label";
      label.textContent = value;
      return label;
    });
    slot.replaceChildren(...labels);
    slot.dataset.hostLabelSignature = signature;
  });
}

renderHostLanguageLabels();
new MutationObserver(() => renderHostLanguageLabels())
  .observe(document.body, {childList: true, subtree: true});
```

The observer in this example reapplies host labels when Kotonohatlas redraws a catalog card. A host with its own render
lifecycle may call `renderHostLanguageLabels()` there instead. Likewise, the host may populate
`#atlas-host-after-catalog` for any project-specific feature, or leave it empty.

## Optional territorial viewpoints

Kotonohatlas does not choose a country as its default territorial viewpoint. When no current access-country viewpoint
matches a territorial rule, the rule's neutral default is used.

An embedding site may inject one configured viewpoint. By default it acts as a presentation floor after the current
access-country viewpoint. The value is an ISO 3166-1 alpha-2 country code:

```html
<meta name="atlas-viewpoint" content="NZ">
```

The equivalent document-level attribute is also supported:

```html
<html data-atlas-viewpoint="NZ">
```

Direct map integrations may instead pass `viewpoint: "NZ"` to `mount()` or `update()`. The configured country is
resolved through every territorial rule just like an access-country viewpoint: it may therefore supply a party-equivalent
position, a third-country position, or no position for that dispute. A neutral access country inherits that result. A
known position on the same side is promoted only when the configured viewpoint has a stronger party-equivalent position;
a known position on the opposing side still takes priority. For example, a configured Japanese viewpoint does not
override the Russian resolution for a visitor whose current viewpoint is Russia.

To apply the configured viewpoint regardless of the current access country, enable its override flag:

```html
<meta name="atlas-viewpoint" content="BR" data-override="true">
```

The direct map equivalent is `{viewpoint: "BR", viewpointOverride: true}`. Resolution uses the configured country
before the current `viewpointCountry` when override is enabled, or after it otherwise, then falls back to the territorial
rule's neutral default.

A reusable map-data package may set the same values as `viewpoint_resolution_model.viewpoint` and
`viewpoint_resolution_model.viewpoint_override`. Runtime options supplied by the embedding site take precedence over
those data fields.

Leaving `viewpoint` unset is the package-neutral state. The boolean only changes how that one value is applied, so there
are no competing default and override country values to misconfigure.

### CI injection

The site generator accepts the same policy directly:

```sh
python3 tools/language_coverage.py --viewpoint AU
python3 tools/language_coverage.py --viewpoint DE --viewpoint-override
```

CI may set `ATLAS_VIEWPOINT=SE` and optionally `ATLAS_VIEWPOINT_OVERRIDE=true` instead of changing the command line.
The generated `language-map.json` receives the resolved setting and its content fingerprint changes with it. With
neither variable nor option, no viewpoint setting is written.

This policy only affects territorial-resolution rules; it does not change the camera, the selected country, or the
visitor's access-country context. Omitting `viewpoint` keeps the package-neutral behavior.
