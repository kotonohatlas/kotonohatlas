function normalize(value) {
  return String(value || "").trim().replace(/_/g, "-").toLowerCase();
}

function base(value) {
  return normalize(value).split("-")[0];
}

export function localeScript(value) {
  const locale = normalize(value);
  if (!locale || typeof Intl === "undefined" || typeof Intl.Locale !== "function") return "";
  try {
    return new Intl.Locale(locale).maximize().script || "";
  } catch (error) {
    return "";
  }
}

export function normalizedRecord(value) {
  return Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [normalize(key), item]));
}

export function toponymLookupKeys(locale, resolution = {}, localeFallbacks = {}) {
  const localeContext = globalThis.AtlasLocaleResolution?.localeContext;
  if (typeof localeContext !== "function") {
    throw new Error("AtlasLocaleResolution must be loaded before resolving toponyms");
  }
  const requested = normalize(locale);
  const localeKeys = normalizedRecord(resolution.locale_keys);
  const keys = [];
  const seen = new Set();
  const append = (value) => {
    const key = normalize(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };
  const appendLocale = (value) => {
    const key = normalize(value);
    if (!key) return;
    append(key);
    (localeKeys[key] || []).forEach(append);
    append(base(key));
  };
  localeContext(
    requested,
    [resolution.locale_fallbacks || {}, localeFallbacks || {}],
    ""
  ).localeChain.forEach(appendLocale);

  return keys;
}

export function resolveToponym(names, locale, resolution = {}, localeFallbacks = {}, fallback = "") {
  if (!names || typeof names !== "object" || Array.isArray(names)) return String(fallback || names || "");
  const localeKeys = toponymLookupKeys(locale, resolution, localeFallbacks);
  const localeNames = normalizedRecord(names.locales);
  const scriptNames = normalizedRecord(names.scripts);
  if (Object.keys(localeNames).length || Object.keys(scriptNames).length) {
    for (const key of localeKeys) {
      if (localeNames[key]) return localeNames[key];
    }
    const scriptFallbacks = normalizedRecord(resolution.script_fallbacks);
    const seenScripts = new Set();
    const scriptNameForKeys = (keys) => {
      const scripts = [];
      const appendScript = (value) => {
        const script = normalize(value);
        if (!script || seenScripts.has(script)) return;
        seenScripts.add(script);
        scripts.push(script);
        (scriptFallbacks[script] || []).forEach(appendScript);
      };
      keys.map(localeScript).forEach(appendScript);
      return scripts.map((script) => scriptNames[script]).find(Boolean) || "";
    };
    const directScriptName = scriptNameForKeys(localeKeys);
    if (directScriptName) return directScriptName;

    const defaultLocale = normalize(resolution.default_locale_fallback || "en");
    const defaultKeys = defaultLocale
      ? toponymLookupKeys(defaultLocale, resolution, localeFallbacks)
          .filter((key) => !localeKeys.includes(key))
      : [];
    for (const key of defaultKeys) {
      if (localeNames[key]) return localeNames[key];
    }
    const defaultScriptName = scriptNameForKeys(defaultKeys);
    if (defaultScriptName) return defaultScriptName;

    const scripts = [];
    const appendFinalScript = (value) => {
      const script = normalize(value);
      if (!script || seenScripts.has(script)) return;
      seenScripts.add(script);
      scripts.push(script);
      (scriptFallbacks[script] || []).forEach(appendFinalScript);
    };
    (resolution.final_scripts || ["Latn"]).forEach(appendFinalScript);
    for (const script of scripts) {
      if (scriptNames[script]) return scriptNames[script];
    }
    for (const key of resolution.final_fallbacks || ["native", "local", "en"]) {
      const normalizedKey = normalize(key);
      if (localeNames[normalizedKey]) return localeNames[normalizedKey];
      if (names[normalizedKey] && typeof names[normalizedKey] === "string") return names[normalizedKey];
    }
    return String(fallback || Object.values(scriptNames).find(Boolean) || Object.values(localeNames).find(Boolean) || "");
  }

  const normalizedNames = normalizedRecord(names);
  for (const key of localeKeys) {
    if (normalizedNames[key]) return normalizedNames[key];
  }
  const legacyScriptProfiles = resolution.legacy_script_profiles || resolution.script_profiles || {};
  for (const key of legacyScriptProfiles[localeScript(locale)] || []) {
    if (normalizedNames[normalize(key)]) return normalizedNames[normalize(key)];
  }
  for (const key of resolution.final_fallbacks || ["en", "native", "local"]) {
    if (normalizedNames[normalize(key)]) return normalizedNames[normalize(key)];
  }
  return String(fallback || Object.values(names).find(Boolean) || "");
}
