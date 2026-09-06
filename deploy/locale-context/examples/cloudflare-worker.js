/**
 * Cloudflare Worker for Atlas access-country.
 * Route: /locale-context*  (covers /locale-context and /locale-context.php)
 * See ../CLOUDFLARE_WORKER.md
 */
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
