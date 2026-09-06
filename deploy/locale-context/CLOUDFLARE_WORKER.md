# Access-country endpoint (Cloudflare Worker)

Route the Worker to **`/locale-context*`** so both `/locale-context` and
`/locale-context.php` hit this script. Atlas’s built site also ships
`locale-context.php` for hosts without a Worker.

Client default: `/locale-context.php`
PHP drop-in: [`PHP.md`](PHP.md) / [`locale-context.php`](locale-context.php)

## Worker body

```js
export default {
  async fetch(request) {
    return Response.json({
      country: request.cf?.country ?? null,
      acceptLanguage: request.headers.get('Accept-Language') ?? '',
    }, {
      headers: {
        'Cache-Control': 'private, no-store',
      },
    });
  },
};
```

Canonical copy: [`examples/cloudflare-worker.js`](examples/cloudflare-worker.js).

### Response

```json
{
  "country": "JP",
  "acceptLanguage": "ja,en-US;q=0.8"
}
```

| Field | Meaning |
|---|---|
| `country` | `request.cf.country`, or `null` when unknown |
| `acceptLanguage` | Echo of `Accept-Language` |

Atlas puts valid `Accept-Language` entries first and follows them with `country`-based suggestions. Client-side,
non-alpha-2 / `XX` / `T1` / `null` / empty country values become unknown.

## Deploy sketch

1. Create a Worker with the script above.
2. Add a route: `example.com/locale-context*` → this Worker
   (or zone route equivalent). That covers `/locale-context.php` too.
3. Keep `Cache-Control: private, no-store`.

No HTML meta tag needed when the default `/locale-context.php` is used.

## Local `make serve`

Static serve does not run PHP or Workers. Lookup fails closed unless you
point `<meta name="atlas-locale-context">` at
[`examples/static-unknown.json`](examples/static-unknown.json).
