/* Shared locale fallback resolution for the Kotonohatlas UI and map. */
(function (root) {
  "use strict";

  function normalizeLocale(value) {
    return String(value || "").trim().replace(/_/g, "-").toLowerCase();
  }

  function fallbackTable(sources) {
    var result = {};
    var rows = Array.isArray(sources) ? sources : [sources];
    rows.forEach(function (source) {
      Object.keys(source || {}).forEach(function (locale) {
        var key = normalizeLocale(locale);
        var fallback = normalizeLocale(source[locale]);
        if (key && fallback) result[key] = fallback;
      });
    });
    return result;
  }

  function localeContext(requested, fallbackSources, defaultLocale, availableLocales) {
    var canonical = {};
    function register(value) {
      var locale = String(value || "").trim().replace(/_/g, "-");
      var key = normalizeLocale(locale);
      if (key && !canonical[key]) canonical[key] = locale;
    }
    (availableLocales || []).forEach(register);
    var sources = Array.isArray(fallbackSources) ? fallbackSources : [fallbackSources];
    sources.forEach(function (source) {
      Object.keys(source || {}).forEach(function (locale) {
        register(locale);
        register(source[locale]);
      });
    });
    register(defaultLocale);
    register(requested);

    var fallbacks = fallbackTable(sources);
    var chain = [];
    var seen = {};
    function appendChain(start) {
      var key = normalizeLocale(start);
      while (key && !seen[key]) {
        seen[key] = true;
        chain.push(canonical[key] || key);
        key = fallbacks[key] || fallbacks[key.split("-")[0]] || "";
      }
    }
    appendChain(requested);
    appendChain(defaultLocale);
    return {
      requested: chain[0] || canonical[normalizeLocale(defaultLocale)] || "en",
      localeChain: chain
    };
  }

  function localeRecord(records, locale) {
    if (!records) return undefined;
    if (Object.prototype.hasOwnProperty.call(records, locale)) return records[locale];
    var key = normalizeLocale(locale);
    var match = Object.keys(records).find(function (candidate) {
      return normalizeLocale(candidate) === key;
    });
    return match == null ? undefined : records[match];
  }

  function mergeLocaleRecords(records, context) {
    return (context && context.localeChain || []).slice().reverse().reduce(function (merged, locale) {
      return Object.assign(merged, localeRecord(records, locale) || {});
    }, {});
  }

  var api = Object.freeze({
    normalizeLocale: normalizeLocale,
    localeContext: localeContext,
    localeRecord: localeRecord,
    mergeLocaleRecords: mergeLocaleRecords
  });
  root.AtlasLocaleResolution = api;
}(typeof globalThis === "undefined" ? this : globalThis));
