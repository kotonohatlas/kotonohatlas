# Access-country endpoint (PHP)

`make build` copies [`locale-context.php`](locale-context.php) to
**`build/site/locale-context.php`**. Client default URL is that path.

Reads Cloudflare’s `CF-IPCountry` header. Same JSON as the Worker on
`/locale-context*`.

```php
<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: private, no-store');
header('X-Content-Type-Options: nosniff');

$raw = strtoupper((string) ($_SERVER['HTTP_CF_IPCOUNTRY'] ?? ''));
$country = preg_match('/^[A-Z]{2}$/', $raw) ? $raw : null;

echo json_encode([
	'country' => $country,
	'acceptLanguage' => (string) ($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''),
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
```

```json
{"country":"JP","acceptLanguage":"ja,en-US;q=0.8"}
```

No meta tag needed when the file is at `/locale-context.php`.
