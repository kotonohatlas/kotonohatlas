<?php

declare(strict_types=1);

/*
 * Built to site root as /locale-context.php.
 * Country from Cloudflare CF-IPCountry. Worker may also own /locale-context*.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: private, no-store');
header('X-Content-Type-Options: nosniff');

$raw = strtoupper((string) ($_SERVER['HTTP_CF_IPCOUNTRY'] ?? ''));
$country = preg_match('/^[A-Z]{2}$/', $raw) ? $raw : null;

echo json_encode([
	'country' => $country,
	'acceptLanguage' => (string) ($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''),
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
