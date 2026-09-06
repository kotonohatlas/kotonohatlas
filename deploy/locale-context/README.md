# Access-country endpoint

| Guide | Role |
|---|---|
| [`PHP.md`](PHP.md) | `build/site/locale-context.php` — Cloudflare `CF-IPCountry` |
| [`CLOUDFLARE_WORKER.md`](CLOUDFLARE_WORKER.md) | Route `/locale-context*` |

Client default: **`/locale-context.php`**

```json
{"country":"JP","acceptLanguage":"ja,en-US;q=0.8"}
```

`LocaleAccess.getAccessLanguageSuggestions()` parses the HTTP language preferences, appends the country suggestions,
and returns one ordered, de-duplicated language list. An embedding host with a different route can set
`<meta name="atlas-locale-context" content="/its-route">` or pass `{endpoint: "/its-route"}`.
