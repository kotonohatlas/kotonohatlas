import importlib.util
from functools import lru_cache
import gzip
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
ATLAS_ROOT = ROOT
sys.path.insert(0, str(ATLAS_ROOT / "tools"))
SPEC = importlib.util.spec_from_file_location(
    "language_coverage", ATLAS_ROOT / "tools" / "language_coverage.py"
)
COVERAGE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(COVERAGE)
ADMIN1_SPEC = importlib.util.spec_from_file_location(
    "build_language_map_admin1", ATLAS_ROOT / "tools" / "build_language_map_admin1.py"
)
ADMIN1_BUILDER = importlib.util.module_from_spec(ADMIN1_SPEC)
assert ADMIN1_SPEC.loader is not None
ADMIN1_SPEC.loader.exec_module(ADMIN1_BUILDER)


@lru_cache(maxsize=1)
def map_copy_localizations():
    return COVERAGE._load_map_localizations()


def raw_map_localization(locale):
    return json.loads(json.dumps(map_copy_localizations()[locale], ensure_ascii=False))


@lru_cache(maxsize=1)
def linguistic_catalog():
    return COVERAGE.linguistic_names.build_catalog()


@lru_cache(maxsize=1)
def geography_localizations():
    return COVERAGE._load_geography_localizations(set(map_copy_localizations()))


@lru_cache(maxsize=1)
def description_localizations():
    return COVERAGE._load_description_localizations(set(map_copy_localizations()))[0]


def map_localization(locale):
    copied = raw_map_localization(locale)
    linguistic = linguistic_catalog()["locales"][locale]
    descriptions = description_localizations()[locale]
    taxonomy = copied.setdefault("taxonomy", {})
    for section in ("families", "scripts"):
        taxonomy.setdefault(section, {}).update({
            "labels": dict(
                ((linguistic.get("taxonomy") or {}).get(section) or {}).get("labels") or {}
            ),
            "descriptions": dict(descriptions.get(section) or {}),
        })
    summaries = {
        code: {"summary": summary}
        for code, summary in (descriptions.get("languages") or {}).items()
    }
    copied["languages"] = {
        code: {**summaries.get(code, {}), **record}
        for code, record in (linguistic.get("languages") or {}).items()
    }
    for code, record in summaries.items():
        copied["languages"].setdefault(code, {}).update(record)
    copied["country_names"] = dict(
        geography_localizations()[locale].get("country_names") or {}
    )
    return copied


def localized_language(locale, code):
    table = map_localization(locale).get("languages") or {}
    candidates = (code, code.replace("_", "-"), code.split("_", 1)[0])
    return next((table[candidate] for candidate in candidates if candidate in table), {})


class LanguageCoverageTest(unittest.TestCase):
    def test_access_language_resolution_puts_http_preferences_before_country_suggestions(self):
        runtime = (
            ROOT / "tools" / "browser" / "language-atlas-access.js"
        ).read_text(encoding="utf-8")
        source = runtime.split("if (typeof window", 1)[0].replace(
            "__LANGUAGE_SPEAKER_ORDERS__", "{}"
        )
        probe = source + r"""
global.fetch = async () => ({
  ok: true,
  json: async () => ({country: "JP", acceptLanguage: "ga;q=0.8, ja, en;q=0.6, fr;q=0"}),
});
(async () => {
  const context = await LocaleAccess.getAccessLanguageContext({storage: null});
  console.log(JSON.stringify({
    parsed: LocaleAccess.parseAcceptLanguage("ga;q=0.8, ja, en;q=0.6, fr;q=0"),
    accepted: context.accepted,
    country: context.country,
    suggestionsMatch: JSON.stringify(context.suggested)
      === JSON.stringify(LocaleAccess.getCountryLanguageCodes(context.country)),
    acceptedComesFirst: context.languages.slice(0, context.accepted.length)
      .every((language, index) => language === context.accepted[index]),
    unique: new Set(context.languages).size === context.languages.length,
  }));
})();
"""
        completed = subprocess.run(
            ["node"], input=probe, text=True, capture_output=True, check=True
        )
        result = json.loads(completed.stdout)
        self.assertEqual(result["parsed"], ["ja", "ga", "en"])
        self.assertEqual(result["accepted"], ["ja", "ga", "en"])
        self.assertEqual(result["country"], "JP")
        self.assertTrue(result["suggestionsMatch"])
        self.assertTrue(result["acceptedComesFirst"])
        self.assertTrue(result["unique"])

    def test_admin1_builder_defaults_to_every_iso_country_in_source(self):
        feature = lambda country, suffix: {
            "type": "Feature",
            "properties": {
                "iso_a2": country,
                "iso_3166_2": f"{country}-{suffix}",
                "name_en": f"Region {suffix}",
            },
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[0, 0], [0, 1], [1, 1], [0, 0]]],
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "admin1.geojson"
            output = root / "chunks"
            source.write_text(
                json.dumps(
                    {
                        "type": "FeatureCollection",
                        "features": [
                            feature("AA", "1"),
                            feature("BB", "1"),
                            feature("-1", "ignored"),
                        ],
                    }
                ),
                encoding="utf-8",
            )
            ADMIN1_BUILDER.build(source, output)
            self.assertEqual(
                {path.name for path in (output / "country").glob("*.geojson")},
                {"AA.geojson", "BB.geojson"},
            )

    def test_admin1_manifest_references_namespaced_chunks(self):
        manifest = json.loads(COVERAGE.LANGUAGE_MAP_ADMIN1_PATH.read_text(encoding="utf-8"))
        self.assertEqual(manifest["schema"], 2)
        for country, url in manifest["countries"].items():
            self.assertEqual(Path(url).name, f"{country}.geojson")
            self.assertEqual(Path(url).parent.name, "country")
            self.assertTrue(COVERAGE._admin1_config_path(url).is_file())
        for source, url in manifest["sources"].items():
            self.assertEqual(Path(url).name, f"{source}.geojson")
            self.assertEqual(Path(url).parent.name, "lang")
            self.assertTrue(COVERAGE._admin1_config_path(url).is_file())
        for rules in manifest["languages"].values():
            for rule in rules:
                if rule.get("feature_ids"):
                    for feature_id in rule["feature_ids"]:
                        self.assertRegex(feature_id, r"^[A-Z0-9-]+$")
                    self.assertRegex(rule["country"], r"^[A-Z]{2}$")
                    continue
                source = rule.get("source")
                if source:
                    self.assertIn(source, manifest["sources"])
                else:
                    self.assertIn(rule["country"], manifest["countries"])
                self.assertRegex(rule["country"], r"^[A-Z]{2}$")

    def test_admin1_manifest_region_ids_exist_in_their_geometry_chunks(self):
        manifest = json.loads(COVERAGE.LANGUAGE_MAP_ADMIN1_PATH.read_text(encoding="utf-8"))
        chunk_ids = {}

        def ids_for(url):
            config_path = COVERAGE._admin1_config_path(url)
            if config_path not in chunk_ids:
                payload = json.loads(
                    config_path.read_text(encoding="utf-8")
                )
                chunk_ids[config_path] = {
                    feature["properties"]["id"]
                    for feature in payload["features"]
                }
            return chunk_ids[config_path]

        for language, rules in manifest["languages"].items():
            for rule in rules:
                if rule.get("feature_ids"):
                    continue
                url = (
                    manifest["sources"][rule["source"]]
                    if rule.get("source")
                    else manifest["countries"][rule["country"]]
                )
                unknown = set(rule.get("regions", [])) - ids_for(url)
                self.assertFalse(
                    unknown,
                    f"{language}/{rule['country']} references missing regions: {sorted(unknown)}",
                )

    def test_admin1_runtime_assets_bundle_only_each_languages_regions(self):
        configured = json.loads(COVERAGE.LANGUAGE_MAP_ADMIN1_PATH.read_text(encoding="utf-8"))
        manifest, chunks = COVERAGE._language_admin1_assets(configured)

        self.assertIn("RU", manifest["countries"])
        # Country-mode boundaries need every on-disk country chunk, even when no
        # language regional rule references that country (e.g. Korea).
        self.assertIn("KR", manifest["countries"])
        self.assertIn("KP", manifest["countries"])
        self.assertEqual(
            Path(manifest["countries"]["KR"]).name,
            "KR.geojson",
        )
        self.assertIn("country-KR.geojson.gz", chunks)
        on_disk = {
            path.stem
            for path in (COVERAGE.LANGUAGE_MAP_ADMIN1_DIR / "country").glob("*.geojson")
        }
        self.assertTrue(on_disk <= set(manifest["countries"]))
        self.assertEqual(
            manifest["sources"]["kk"],
            "./language-map-admin1/lang-kk.geojson.gz",
        )

        def chunk_json(filename):
            return json.loads(gzip.decompress(chunks[filename]).decode("utf-8"))

        for language, rules in manifest["languages"].items():
            expected_ids = {
                region
                for rule in rules
                for region in rule.get("regions", [])
            }
            for rule in rules:
                if not rule.get("feature_ids"):
                    self.assertEqual(rule.get("source"), language)
            if not expected_ids:
                continue
            filename = Path(manifest["sources"][language]).name
            payload = chunk_json(filename)
            actual_ids = {
                feature["properties"]["id"]
                for feature in payload["features"]
            }
            self.assertEqual(actual_ids, expected_ids, language)

        kk_payload = chunks["lang-kk.geojson.gz"]
        country_ru_payload = chunks["country-RU.geojson.gz"]
        self.assertLess(len(kk_payload), len(country_ru_payload))
        cn_prefetch = chunk_json("prefetch-CN.geojson.gz")
        self.assertEqual(
            cn_prefetch["prefetch_sources"],
            manifest["prefetch_sources"]["CN"],
        )
        for language in ("kk", "ky"):
            language_ids = {
                feature["properties"]["id"]
                for feature in chunk_json(f"lang-{language}.geojson.gz")["features"]
            }
            packed_ids = {
                feature["properties"]["id"]
                for feature in cn_prefetch["features"]
                if language in feature["properties"].get("prefetch_languages", [])
            }
            self.assertEqual(packed_ids, language_ids)
            self.assertTrue(any(not region.startswith("CN-") for region in packed_ids))

    def test_eu_public_and_regional_relations_keep_reviewed_granularity(self):
        manifest = json.loads(COVERAGE.LANGUAGE_MAP_ADMIN1_PATH.read_text(encoding="utf-8"))
        scoped = {
            "AT": {"bar", "hr", "sl", "hu", "cs", "sk", "rom"},
            "BE": {"nl", "fr", "de", "vls", "wa"},
            "BG": {"tr"},
            "HR": {"it", "vec"},
            "DE": {"nds", "vmf", "frr", "stq", "hsb", "dsb", "da"},
            "DK": {"de"},
            "EE": {"vro"},
            "ES": {"ca", "gl", "eu", "ast", "oc"},
            "FI": {"sms", "se", "smn"},
            "FR": {"oc", "br", "co", "eu", "ca", "gsw"},
            "GR": {"tr"},
            "IT": {"fr", "lmo", "vec", "de", "sl", "sc", "fur", "lld", "ca",
                   "sq", "hr", "frp", "el", "oc"},
            "LV": {"ltg"},
            "NL": {"li", "fy", "gos"},
            "PL": {"de", "csb", "lt"},
            "PT": {"mwl"},
            "RO": {"hu"},
            "SE": {"fit", "se", "sma", "smj"},
            "SI": {"vec", "it", "hu"},
            "SK": {"hu"},
        }
        intentionally_countrywide = {
            "CY": {"el", "tr"},
            "DE": {"rom"},
            "EE": {"ru"},
            "FI": {"sv"},
            "IE": {"ga"},
            "LV": {"ru"},
            "SE": {"fi", "yi", "rom"},
        }

        self.assertEqual(sum(map(len, scoped.values())), 70)
        self.assertEqual(sum(map(len, intentionally_countrywide.values())), 10)
        for country, languages in scoped.items():
            for language in languages:
                rules = [
                    rule for rule in manifest["languages"][language]
                    if rule["country"] == country
                ]
                self.assertTrue(rules, f"missing reviewed scope for {country}/{language}")
                scope_rules = [rule for rule in rules if rule.get("layer") == "scope"]
                self.assertTrue(scope_rules, f"missing scope layer for {country}/{language}")
                self.assertTrue(all("role" not in rule for rule in scope_rules))
                self.assertTrue(any(rule.get("replace_country_role") for rule in scope_rules))

        for country, languages in intentionally_countrywide.items():
            for language in languages:
                rules = [
                    rule for rule in manifest["languages"].get(language, [])
                    if rule["country"] == country
                ]
                self.assertFalse(any(rule.get("layer") == "scope" for rule in rules))
                self.assertFalse(any(rule.get("replace_country_role") for rule in rules))

        runtime = (ROOT / "tools" / "browser" / "language-atlas-access.js").read_text(encoding="utf-8")
        self.assertIn("DK: ['da', 'de']", runtime)
        self.assertIn("GR: ['el', 'tr']", runtime)
        self.assertIn("GR: ['pnt', 'sq', 'bg', 'ro', 'ar', 'ru', 'uk']", runtime)
        self.assertNotIn("SE: ['sv', 'fi', 'se', 'sma', 'smj', 'sms']", runtime)

        registry_languages = {
            item["locale"] for item in COVERAGE.hub.locales_config()["locales"]
        }
        self.assertTrue({"pnt", "fit", "stq", "frp", "rom"} <= registry_languages)

        pontic_rules = [
            rule for rule in manifest["languages"]["pnt"]
            if rule["country"] == "GR"
        ]
        self.assertTrue(pontic_rules)
        self.assertTrue(all(rule["role"] == "distribution" for rule in pontic_rules))
        self.assertTrue(all(not rule.get("replace_country_role") for rule in pontic_rules))

        german_france = next(
            rule for rule in manifest["languages"]["de"]
            if rule["country"] == "FR" and rule.get("layer") == "scope"
        )
        self.assertEqual(german_france["layer"], "scope")
        self.assertTrue(german_france["replace_country_role"])
        self.assertNotIn("role", german_france)

    def test_south_america_relations_keep_regional_and_countrywide_roles_distinct(self):
        manifest = json.loads(COVERAGE.LANGUAGE_MAP_ADMIN1_PATH.read_text(encoding="utf-8"))
        scoped = {
            "AR": {"gn"},
            "BO": {"qu", "ay", "gn"},
            "BR": {"vec"},
            "CL": {"arn"},
            "CO": {"guc", "pbb", "icr"},
            "EC": {"qu", "qug", "jiv"},
            "PE": {"qu", "ay", "cni", "shp"},
            "VE": {"guc", "wba", "aoc"},
        }
        intentionally_countrywide = {
            "AR": {"es"},
            "BO": {"es"},
            "BR": {"pt-BR"},
            "CL": {"es"},
            "CO": {"es"},
            "EC": {"es"},
            "GF": {"fr", "gcr"},
            "GY": {"en"},
            "PE": {"es"},
            "PY": {"gn", "es"},
            "SR": {"nl", "srn"},
            "UY": {"es"},
            "VE": {"es"},
        }

        self.assertEqual(sum(map(len, scoped.values())), 19)
        self.assertEqual(sum(map(len, intentionally_countrywide.values())), 16)
        for country, languages in scoped.items():
            for language in languages:
                rules = [
                    rule for rule in manifest["languages"].get(language, [])
                    if rule["country"] == country
                ]
                scope_rules = [rule for rule in rules if rule.get("layer") == "scope"]
                distribution_rules = [
                    rule for rule in rules if rule.get("role") == "distribution"
                ]
                self.assertTrue(scope_rules, f"missing South America scope: {country}/{language}")
                self.assertTrue(
                    any(rule.get("replace_country_role") for rule in scope_rules),
                    f"whole-country role not replaced: {country}/{language}",
                )
                self.assertTrue(all("role" not in rule for rule in scope_rules))
                self.assertTrue(
                    distribution_rules,
                    f"missing South America distribution overlay: {country}/{language}",
                )

        for country, languages in intentionally_countrywide.items():
            for language in languages:
                rules = [
                    rule for rule in manifest["languages"].get(language, [])
                    if rule["country"] == country
                ]
                self.assertFalse(any(rule.get("layer") == "scope" for rule in rules))
                self.assertFalse(any(rule.get("replace_country_role") for rule in rules))

        registry_languages = {
            item["locale"] for item in COVERAGE.hub.locales_config()["locales"]
        }
        reviewed_candidates = {
            "vec", "qug", "srn", "gcr", "arn", "guc", "pbb",
            "icr", "jiv", "cni", "shp", "wba", "aoc",
        }
        self.assertTrue(reviewed_candidates <= registry_languages)

        runtime = (ROOT / "tools" / "browser" / "language-atlas-access.js").read_text(encoding="utf-8")
        self.assertIn("SR: ['nl', 'srn']", runtime)
        self.assertIn("GF: ['fr', 'gcr']", runtime)
        self.assertIn("AR: ['ay', 'arn']", runtime)

    def test_balkan_relations_keep_national_status_and_regional_distribution_distinct(self):
        manifest = json.loads(COVERAGE.LANGUAGE_MAP_ADMIN1_PATH.read_text(encoding="utf-8"))
        scoped = {
            "BG": {"tr"},
            "HR": {"it", "vec"},
            "GR": {"tr"},
            "RO": {"hu"},
            "RS": {"hu", "ro", "hr", "sk", "uk", "rsk", "bs", "sq", "bg"},
            "SI": {"it", "vec", "hu"},
        }
        national_with_distribution = {
            "ME": {"bs", "sq", "hr"},
            "MK": {"sq"},
            "XK": {"sr"},
        }

        for country, languages in scoped.items():
            for language in languages:
                rules = [
                    rule for rule in manifest["languages"].get(language, [])
                    if rule["country"] == country
                ]
                scope_rules = [rule for rule in rules if rule.get("layer") == "scope"]
                distribution_rules = [
                    rule for rule in rules if rule.get("role") == "distribution"
                ]
                self.assertTrue(scope_rules, f"missing Balkan scope: {country}/{language}")
                self.assertTrue(
                    any(rule.get("replace_country_role") for rule in scope_rules),
                    f"whole-country role not replaced: {country}/{language}",
                )
                self.assertTrue(all("role" not in rule for rule in scope_rules))
                self.assertTrue(
                    distribution_rules,
                    f"missing Balkan distribution overlay: {country}/{language}",
                )
                self.assertTrue(all(
                    "replace_country_role" not in rule for rule in distribution_rules
                ))

        for country, languages in national_with_distribution.items():
            for language in languages:
                rules = [
                    rule for rule in manifest["languages"].get(language, [])
                    if rule["country"] == country
                ]
                self.assertFalse(any(rule.get("layer") == "scope" for rule in rules))
                self.assertFalse(any(rule.get("replace_country_role") for rule in rules))
                self.assertTrue(any(rule.get("role") == "distribution" for rule in rules))

        kurdish_turkey = [
            rule for rule in manifest["languages"]["kmr"]
            if rule["country"] == "TR"
        ]
        self.assertTrue(kurdish_turkey)
        self.assertTrue(all(rule["layer"] == "scope" for rule in kurdish_turkey))
        self.assertTrue(all(rule["replace_country_role"] for rule in kurdish_turkey))
        self.assertTrue(all("role" not in rule for rule in kurdish_turkey))

        hausa_sudan = [
            rule for rule in manifest["languages"]["ha"]
            if rule["country"] == "SD"
        ]
        self.assertTrue(hausa_sudan)
        self.assertTrue(all(rule["role"] == "resident" for rule in hausa_sudan))
        self.assertTrue(all(rule["replace_country_role"] for rule in hausa_sudan))
        self.assertEqual(
            {region for rule in hausa_sudan for region in rule["regions"]},
            {"SD-GZ", "SD-GD", "SD-NB", "SD-SI", "SD-KA", "SD-KH",
             "SD-DN", "SD-DS", "SD-DE", "SD-KN", "SD-KS"},
        )

        registry_languages = {
            item["locale"] for item in COVERAGE.hub.locales_config()["locales"]
        }
        self.assertTrue({"cnr", "rsk"} <= registry_languages)

        runtime = (ROOT / "tools" / "browser" / "language-atlas-access.js").read_text(encoding="utf-8")
        self.assertIn("BA: ['bs', 'hr', 'sr', 'rom', 'yi']", runtime)
        self.assertIn("ME: ['cnr', 'sr', 'bs', 'sq', 'hr', 'rom']", runtime)
        self.assertIn("ME: ['cnr', 'sr']", runtime)
        self.assertIn("RS: ['sr', 'hu', 'ro', 'hr', 'sk', 'uk', 'rsk', 'bs', 'sq', 'bg', 'rom']", runtime)
        self.assertIn("XK: ['sq', 'sr']", runtime)
        self.assertIn("XK: ['sq']", runtime)
        self.assertIn("TR: ['kmr']", runtime)
        self.assertIn("TR: ['tk', 'uk', 'hy', 'pnt']", runtime)
        self.assertNotIn("TR: ['tr', 'kmr']", runtime)

    def test_admin1_manifest_covers_major_regional_language_areas(self):
        manifest = json.loads(COVERAGE.LANGUAGE_MAP_ADMIN1_PATH.read_text(encoding="utf-8"))
        afghanistan = json.loads(
            (ROOT / "config" / "geography" / "admin1" / "country" / "AF.geojson")
            .read_text(encoding="utf-8")
        )
        afghanistan_names = {
            feature["properties"]["id"]: feature["properties"]["name_en"]
            for feature in afghanistan["features"]
        }
        self.assertEqual(len(afghanistan_names), len(afghanistan["features"]))
        self.assertEqual(afghanistan_names["AF-DAY"], "Daykundi")
        self.assertEqual(afghanistan_names["AF-PAN"], "Panjshir")

        def regions(language, country):
            return {
                region
                for rule in manifest["languages"][language]
                if rule["country"] == country
                for region in rule.get("regions", [])
            }

        self.assertEqual(
            regions("ms", "ID"),
            {"ID-RI", "ID-KR", "ID-KB", "ID-JA"},
        )
        self.assertEqual(
            regions("ms", "TH"),
            {"TH-94", "TH-95", "TH-96", "TH-90", "TH-91"},
        )
        self.assertEqual(
            regions("th", "MY"),
            {"MY-09", "MY-02", "MY-03", "MY-07", "MY-08"},
        )
        self.assertEqual(
            regions("km", "TH"),
            {
                "TH-22", "TH-23", "TH-24", "TH-25", "TH-27", "TH-30",
                "TH-31", "TH-32", "TH-33", "TH-34", "TH-44", "TH-45",
            },
        )
        self.assertEqual(
            regions("lo", "TH"),
            {
                "TH-30", "TH-31", "TH-32", "TH-33", "TH-34", "TH-35",
                "TH-36", "TH-37", "TH-38", "TH-39", "TH-40", "TH-41",
                "TH-42", "TH-43", "TH-44", "TH-45", "TH-46", "TH-47",
                "TH-48", "TH-49",
            },
        )
        self.assertEqual(regions("lo", "KH"), {"KH-13", "KH-16", "KH-19"})
        self.assertEqual(regions("mzn", "IR"), {"IR-02", "IR-27"})
        self.assertEqual(regions("glk", "IR"), {"IR-01"})
        self.assertEqual(
            regions("tly", "AZ"),
            {"AZ-AST", "AZ-LER", "AZ-LAN", "AZ-LA", "AZ-MAS"},
        )
        self.assertEqual(regions("xmf", "GE"), {"GE-SZ"})
        self.assertEqual(regions("az", "GE"), {"GE-KK"})
        self.assertEqual(regions("hy", "GE"), {"GE-SJ"})
        self.assertEqual(regions("av", "AZ"), {"AZ-BAL", "AZ-ZAQ"})
        self.assertEqual(
            regions("lez", "AZ"),
            {"AZ-QUS", "AZ-QBA", "AZ-XAC"},
        )
        self.assertEqual(
            regions("haz", "AF"),
            {"AF-BAM", "AF-DAY", "AF-GHO", "AF-GHA", "AF-WAR", "AF-URU"},
        )
        self.assertEqual(regions("ars", "SA"), {"SA-01", "SA-05", "SA-06"})
        self.assertEqual(regions("bal", "OM"), {"OM-MA", "OM-BA", "OM-BJ"})
        self.assertEqual(regions("bal", "IR"), {"IR-11"})
        self.assertEqual(regions("bal", "AF"), {"AF-NIM"})
        self.assertEqual(regions("bal", "PK"), {"PK-BA", "PK-SD"})
        self.assertEqual(regions("os", "RU"), {"RU-SE"})
        self.assertEqual(
            {
                feature_id
                for rule in manifest["languages"]["ab"]
                if rule["country"] == "GE"
                for feature_id in rule.get("feature_ids", [])
            },
            {"D-B35"},
        )
        self.assertEqual(
            {
                feature_id
                for rule in manifest["languages"]["os"]
                if rule["country"] == "GE"
                for feature_id in rule.get("feature_ids", [])
            },
            {"D-B37"},
        )
        for language, country in {
            "mzn": "IR",
            "glk": "IR",
            "tly": "AZ",
            "xmf": "GE",
            "az": "GE",
            "hy": "GE",
            "av": "AZ",
            "lez": "AZ",
            "ab": "GE",
            "os": "GE",
            "haz": "AF",
            "ars": "SA",
            "bal": "OM",
        }.items():
            self.assertTrue(any(
                rule.get("replace_country_role")
                for rule in manifest["languages"][language]
                if rule["country"] == country
            ), f"whole-country role not replaced: {country}/{language}")
        self.assertEqual(
            regions("tt", "RU"),
            {
                "RU-TA", "RU-BA", "RU-ULY", "RU-ORE", "RU-SAM",
                "RU-UD", "RU-CU", "RU-ME", "RU-PER", "RU-SVE",
                "RU-CHE", "RU-TYU",
            },
        )
        tatarstan_scope = [
            rule for rule in manifest["languages"]["tt"]
            if rule["country"] == "RU" and rule.get("layer") == "scope"
        ]
        self.assertEqual(len(tatarstan_scope), 1)
        self.assertEqual(tatarstan_scope[0]["regions"], ["RU-TA"])
        self.assertTrue(tatarstan_scope[0]["replace_country_role"])
        self.assertFalse(
            any(
                rule.get("role") == "distribution" and "RU-TA" in rule.get("regions", [])
                for rule in manifest["languages"]["tt"]
            )
        )
        russian_regional_scopes = {
            "tt": {"RU-TA"},
            "ba": {"RU-BA"},
            "ce": {"RU-CE"},
            "av": {"RU-DA"},
            "udm": {"RU-UD"},
            "sah": {"RU-SA"},
            "kbd": {"RU-KB", "RU-KC"},
            "myv": {"RU-MO"},
            "mdf": {"RU-MO"},
            "kum": {"RU-DA"},
            "kv": {"RU-KO"},
            "lez": {"RU-DA"},
            "krc": {"RU-KC", "RU-KB"},
            "inh": {"RU-IN"},
            "tyv": {"RU-TY"},
            "az-Cyrl": {"RU-DA"},
            "ady": {"RU-AD"},
            "lbe": {"RU-DA"},
            "koi": {"RU-PER"},
        }
        for language, expected in russian_regional_scopes.items():
            rules = [
                rule for rule in manifest["languages"][language]
                if rule.get("country") == "RU" and rule.get("layer") == "scope"
            ]
            self.assertEqual(
                {region for rule in rules for region in rule.get("regions", [])},
                expected,
                language,
            )
            self.assertTrue(all(rule.get("replace_country_role") is True for rule in rules))
        self.assertEqual(
            regions("nn", "NO"),
            {"NO-05", "NO-06", "NO-08", "NO-09", "NO-10", "NO-11", "NO-12", "NO-14", "NO-15"},
        )
        nynorsk_rules = manifest["languages"]["nn"]
        nynorsk_scope_rules = [rule for rule in nynorsk_rules if rule.get("layer") == "scope"]
        nynorsk_distribution_rules = [
            rule for rule in nynorsk_rules if rule.get("role") == "distribution"
        ]
        self.assertEqual(len(nynorsk_scope_rules), 2)
        self.assertEqual(
            sum(bool(rule.get("replace_country_role")) for rule in nynorsk_scope_rules),
            1,
        )
        self.assertTrue(all("replace_country_role" not in rule for rule in nynorsk_distribution_rules))
        self.assertEqual(regions("sdh", "IQ"), {"IQ-DI", "IQ-WA"})
        southern_kurdish_iraq = [
            rule for rule in manifest["languages"]["sdh"]
            if rule["country"] == "IQ"
        ]
        self.assertTrue(all(rule["role"] == "distribution" for rule in southern_kurdish_iraq))
        self.assertEqual(
            sum(bool(rule.get("replace_country_role")) for rule in southern_kurdish_iraq),
            1,
        )
        self.assertEqual(
            regions("si", "LK"),
            {
                "LK-11", "LK-12", "LK-13", "LK-21", "LK-22", "LK-23",
                "LK-31", "LK-32", "LK-33", "LK-52", "LK-53", "LK-61",
                "LK-62", "LK-71", "LK-72", "LK-81", "LK-82", "LK-91",
                "LK-92",
            },
        )
        sinhala_rules = manifest["languages"]["si"]
        self.assertTrue(all(rule["role"] == "distribution" for rule in sinhala_rules))
        self.assertTrue(all("replace_country_role" not in rule for rule in sinhala_rules))
        self.assertEqual(regions("ur", "PK"), {"PK-SD", "PK-IS", "PK-PB"})
        self.assertEqual(
            regions("ur", "IN"),
            {
                "IN-TG", "IN-KA", "IN-BR", "IN-DL", "IN-MH",
                "IN-UP", "IN-JH", "IN-AP", "IN-WB",
            },
        )
        urdu_rules = manifest["languages"]["ur"]
        self.assertTrue(all(rule["role"] == "distribution" for rule in urdu_rules))
        self.assertTrue(all("replace_country_role" not in rule for rule in urdu_rules))
        for language, country in (("ms", "ID"), ("ms", "TH"), ("th", "MY"),
                                  ("km", "TH"), ("lo", "TH"), ("lo", "KH")):
            rules = [
                rule for rule in manifest["languages"][language]
                if rule["country"] == country
            ]
            self.assertTrue(all(rule["layer"] == "scope" for rule in rules))
            self.assertTrue(all("role" not in rule for rule in rules))
            self.assertEqual(sum(bool(rule.get("replace_country_role")) for rule in rules), 1)

        self.assertTrue({"CA-QC", "CA-NB"}.issubset(regions("fr", "CA")))
        self.assertEqual(
            {
                rule["role"]
                for rule in manifest["languages"]["fr"]
                if rule["country"] == "CA"
            },
            {"distribution"},
        )
        self.assertEqual(regions("az-Cyrl", "RU"), {"RU-DA"})
        azerbaijani_russia_rules = manifest["languages"]["az-Cyrl"]
        self.assertTrue(any(
            rule.get("layer") == "scope" and rule.get("replace_country_role")
            for rule in azerbaijani_russia_rules
        ))
        self.assertFalse(any(
            rule.get("role") == "distribution" and "RU-DA" in rule.get("regions", [])
            for rule in azerbaijani_russia_rules
        ))
        self.assertEqual(regions("be", "UA"), {"UA-74", "UA-32", "UA-30"})
        self.assertEqual(regions("be", "PL"), {"PL-PD"})
        self.assertEqual(regions("be", "LT"), {"LT-UT", "LT-VL", "LT-AL"})
        self.assertEqual(
            regions("be", "LV"),
            {
                "LV-001", "LV-014", "LV-015", "LV-023", "LV-024",
                "LV-036", "LV-044", "LV-047", "LV-056", "LV-058",
                "LV-073", "LV-078", "LV-082", "LV-103", "LV-108",
                "LV-109", "LV-110", "LV-DGV", "LV-REZ",
            },
        )
        belarusian_scope_rules = manifest["languages"]["be"]
        self.assertTrue(all(
            rule["layer"] == "scope" and "role" not in rule
            for rule in belarusian_scope_rules
        ))
        self.assertEqual(
            {rule["country"] for rule in belarusian_scope_rules if rule.get("replace_country_role")},
            {"UA", "PL", "LT", "LV"},
        )
        self.assertEqual(
            regions("az-Arab", "IR"),
            {"IR-03", "IR-04", "IR-24", "IR-19"},
        )
        iranian_azerbaijani = next(
            rule
            for rule in manifest["languages"]["az-Arab"]
            if rule["country"] == "IR"
        )
        self.assertEqual(iranian_azerbaijani["role"], "regional")
        self.assertEqual(iranian_azerbaijani["basis"], "protected")
        self.assertIs(iranian_azerbaijani["replace_country_role"], True)
        self.assertTrue({"ID-JT", "ID-JI", "ID-YO", "ID-JK"}.issubset(regions("jv", "ID")))
        self.assertTrue({"ID-JB", "ID-BT"}.issubset(regions("su", "ID")))
        self.assertTrue({"PH-CEB", "PH-BOH", "PH-LEY", "PH-BUK"}.issubset(regions("ceb", "PH")))
        self.assertTrue({"PH-MNL", "PH-CAV", "PH-LAG", "PH-RIZ"}.issubset(regions("tl", "PH")))
        self.assertTrue({"IQ-SU", "IQ-AR", "IR-12"}.issubset(
            regions("ckb", "IQ") | regions("ckb", "IR")
        ))
        self.assertNotIn("IQ-DI", regions("ckb", "IQ"))
        self.assertEqual(regions("ckb", "IR"), {"IR-12"})
        self.assertTrue({"TR-21", "TR-72", "TR-56", "TR-73"}.issubset(regions("kmr", "TR")))
        self.assertEqual(regions("kmr", "IQ"), {"IQ-DA"})
        self.assertEqual(regions("kmr", "IR"), {"IR-04"})
        self.assertEqual(regions("kmr", "SY"), {"SY-HA"})
        self.assertEqual(
            regions("tr", "BG"),
            {"BG-02", "BG-08", "BG-09", "BG-17", "BG-18", "BG-19", "BG-25", "BG-26", "BG-27"},
        )
        self.assertEqual(
            regions("tr", "IQ"),
            {"IQ-AR", "IQ-DI", "IQ-NI", "IQ-SD", "IQ-TS"},
        )
        self.assertEqual(regions("tr", "GR"), {"GR-A"})
        turkish_non_cyprus_rules = [
            rule for rule in manifest["languages"]["tr"]
            if rule["country"] != "CY"
        ]
        self.assertTrue(all(
            (rule.get("layer") == "scope" and "role" not in rule)
            or rule.get("role") == "regional"
            or (rule.get("role") == "distribution" and not rule.get("replace_country_role"))
            for rule in turkish_non_cyprus_rules
        ))
        self.assertEqual(
            {
                rule["country"]
                for rule in turkish_non_cyprus_rules
                if rule.get("replace_country_role")
            },
            {"BG", "GR", "IQ"},
        )
        cypriot_turkish = next(
            rule
            for rule in manifest["languages"]["tr"]
            if rule["country"] == "CY"
        )
        self.assertEqual(cypriot_turkish["role"], "distribution")
        self.assertEqual(cypriot_turkish["feature_ids"], ["CYN"])
        self.assertNotIn("replace_country_role", cypriot_turkish)
        self.assertEqual(
            regions("el", "CY"),
            {"CY-01", "CY-02", "CY-03", "CY-04", "CY-05"},
        )
        self.assertEqual(
            regions("tk", "IR"),
            {"IR-27"},
        )
        self.assertEqual(
            regions("tk", "AF"),
            {
                "AF-JOW", "AF-FYB", "AF-BAL", "AF-KDZ",
            },
        )
        self.assertEqual(
            regions("tk", "UZ"),
            {"UZ-XO", "UZ-QR"},
        )
        self.assertEqual(
            regions("tg", "UZ"),
            {"UZ-SA", "UZ-BU"},
        )
        self.assertEqual(regions("tg", "KG"), {"KG-B"})
        self.assertEqual(regions("tg", "AF"), {"AF-BDS", "AF-TAK", "AF-KDZ"})
        tajik_rules = manifest["languages"]["tg"]
        self.assertTrue(all(rule["layer"] == "scope" for rule in tajik_rules))
        self.assertTrue(all("role" not in rule for rule in tajik_rules))
        self.assertEqual(
            {
                rule["country"]
                for rule in tajik_rules
                if rule.get("replace_country_role")
            },
            {"AF", "KG", "UZ"},
        )
        self.assertEqual(
            regions("uz-Arab", "AF"),
            {
                "AF-BDS", "AF-TAK", "AF-KDZ", "AF-BAL",
                "AF-JOW", "AF-FYB", "AF-SAM", "AF-SAR",
            },
        )
        self.assertEqual(regions("uz", "AF"), set())
        self.assertEqual(regions("uz", "TM"), {"TM-D", "TM-L"})
        self.assertEqual(regions("uz", "KG"), {"KG-O", "KG-J", "KG-B"})
        self.assertEqual(regions("uz", "TJ"), {"TJ-SU", "TJ-KT", "TJ-X01~"})
        self.assertEqual(regions("uz", "KZ"), {"KZ-YUZ"})
        uzbek_afghanistan_rules = manifest["languages"]["uz-Arab"]
        self.assertTrue(all(
            rule["layer"] == "scope" and "role" not in rule
            for rule in uzbek_afghanistan_rules
        ))
        self.assertTrue(uzbek_afghanistan_rules[0]["replace_country_role"])
        uzbek_latin_rules = manifest["languages"]["uz"]
        self.assertEqual(
            {
                rule["country"]
                for rule in uzbek_latin_rules
                if rule.get("replace_country_role")
            },
            {"TM", "KG", "TJ", "KZ"},
        )
        access_runtime = (
            ROOT / "tools" / "browser" / "language-atlas-access.js"
        ).read_text(encoding="utf-8")
        self.assertIn("AF: ['fa-AF', 'ps', 'haz', 'uz-Arab', 'tk']", access_runtime)
        self.assertNotIn("AF: ['fa-AF', 'ps', 'haz', 'uz-Arab', 'tk', 'uz']", access_runtime)
        self.assertIn("IR: ['fa-IR', 'az-Arab', 'mzn', 'glk', 'ckb', 'sdh', 'kmr', 'tk']", access_runtime)
        self.assertIn("UZ: ['uz-Latn', 'uz-Cyrl', 'ru', 'tk']", access_runtime)
        self.assertNotRegex(access_runtime, r"(?<![-A-Za-z])['\"]uz['\"]")
        turkmen_rules = manifest["languages"]["tk"]
        self.assertTrue(all(rule["layer"] == "scope" for rule in turkmen_rules))
        self.assertTrue(all("role" not in rule for rule in turkmen_rules))
        self.assertTrue(all("source" not in rule for rule in turkmen_rules))
        self.assertEqual(
            {
                rule["country"]
                for rule in turkmen_rules
                if rule.get("replace_country_role")
            },
            {"AF", "IR", "UZ"},
        )
        self.assertEqual(regions("kk", "CN"), {"CN-XJ"})
        self.assertEqual(
            regions("kk", "RU"),
            {
                "RU-AST", "RU-VGG", "RU-SAR", "RU-SAM", "RU-ORE", "RU-CHE",
                "RU-KGN", "RU-TYU", "RU-OMS", "RU-NVS", "RU-AL", "RU-ALT",
            },
        )
        self.assertEqual(regions("kk", "TM"), {"TM-B", "TM-D"})
        self.assertEqual(regions("kk", "UZ"), {"UZ-QR", "UZ-TO", "UZ-NW"})
        self.assertEqual(regions("kk", "KG"), {"KG-C", "KG-GB", "KG-Y", "KG-T"})
        self.assertEqual(regions("ky", "CN"), {"CN-XJ"})
        self.assertEqual(regions("ky", "KZ"), {"KZ-ZHA", "KZ-ALA"})
        self.assertEqual(regions("ky", "UZ"), {"UZ-AN", "UZ-NG", "UZ-FA"})
        self.assertEqual(regions("ky", "TJ"), {"TJ-GB"})
        self.assertEqual(
            regions("uk", "RU"),
            {"RU-BRY", "RU-KRS", "RU-BEL", "RU-VOR", "RU-ROS"},
        )
        self.assertEqual(
            regions("zh-Hans", "RU"),
            {"RU-AL", "RU-ZAB", "RU-AMU", "RU-YEV", "RU-KHA", "RU-PRI"},
        )
        self.assertEqual(regions("yi", "RU"), {"RU-YEV"})
        yiddish_russia = next(
            rule
            for rule in manifest["languages"]["yi"]
            if rule["country"] == "RU"
        )
        self.assertEqual(yiddish_russia["basis"], "protected")
        self.assertTrue(yiddish_russia["replace_country_role"])
        self.assertEqual(
            regions("ru", "UA"),
            {
                "UA-09", "UA-12", "UA-14", "UA-23",
                "UA-48", "UA-51", "UA-63", "UA-65",
            },
        )
        ukrainian_russian_rules = [
            rule
            for rule in manifest["languages"]["ru"]
            if rule["country"] == "UA"
        ]
        self.assertTrue(all(
            rule["role"] == "distribution"
            and "layer" not in rule
            and not rule.get("replace_country_role")
            for rule in ukrainian_russian_rules
        ))
        self.assertEqual(regions("ru", "KG"), {"KG-GB", "KG-C"})
        kyrgyzstan_russian_rules = [
            rule
            for rule in manifest["languages"]["ru"]
            if rule["country"] == "KG"
        ]
        self.assertTrue(all(
            rule["role"] == "distribution"
            and not rule.get("replace_country_role")
            for rule in kyrgyzstan_russian_rules
        ))
        self.assertEqual(regions("ru", "EE"), {"EE-44", "EE-37"})
        self.assertEqual(
            regions("ru", "LV"),
            {
                "LV-001", "LV-014", "LV-015", "LV-023", "LV-024",
                "LV-036", "LV-044", "LV-047", "LV-056", "LV-058",
                "LV-073", "LV-078", "LV-082", "LV-103", "LV-108",
                "LV-109", "LV-110", "LV-DGV", "LV-REZ", "LV-RIX",
            },
        )
        self.assertEqual(
            regions("ru", "UZ"),
            {
                "UZ-AN", "UZ-BU", "UZ-FA", "UZ-JI", "UZ-NG", "UZ-NW",
                "UZ-QA", "UZ-QR", "UZ-SA", "UZ-SI", "UZ-SU", "UZ-TK",
                "UZ-TO", "UZ-XO",
            },
        )
        self.assertEqual(regions("ru", "TJ"), {"TJ-DU"})
        for country in ("EE", "LV", "UZ", "TJ"):
            country_russian_rules = [
                rule
                for rule in manifest["languages"]["ru"]
                if rule["country"] == country
            ]
            self.assertTrue(all(
                rule["role"] == "distribution"
                and "layer" not in rule
                and not rule.get("replace_country_role")
                for rule in country_russian_rules
            ))
        self.assertEqual(
            regions("ru", "MD"),
            {
                "MD-BA", "MD-BD", "MD-BR", "MD-CA", "MD-CAM",
                "MD-CU", "MD-ED", "MD-GA", "MD-GRI", "MD-OC",
                "MD-SN", "MD-TA",
            },
        )
        moldova_russian_rules = [
            rule
            for rule in manifest["languages"]["ru"]
            if rule["country"] == "MD"
        ]
        moldova_scope_rules = [
            rule for rule in moldova_russian_rules if rule.get("layer") == "scope"
        ]
        moldova_distribution_rules = [
            rule for rule in moldova_russian_rules if rule.get("role") == "distribution"
        ]
        self.assertEqual(
            {
                region
                for rule in moldova_scope_rules
                for region in rule["regions"]
            },
            {"MD-BD", "MD-CAM", "MD-GA", "MD-GRI", "MD-SN", "MD-TA"},
        )
        self.assertTrue(all("role" not in rule for rule in moldova_scope_rules))
        self.assertEqual(
            sum(bool(rule.get("replace_country_role")) for rule in moldova_scope_rules),
            1,
        )
        self.assertTrue(all(
            not rule.get("replace_country_role")
            for rule in moldova_distribution_rules
        ))
        for language in ("uk", "zh-Hans"):
            russia_rule = next(
                rule
                for rule in manifest["languages"][language]
                if rule["country"] == "RU"
            )
            self.assertEqual(russia_rule["layer"], "scope")
            self.assertNotIn("role", russia_rule)
            self.assertTrue(russia_rule["replace_country_role"])
        kyrgyz_scope_rules = [
            rule
            for rule in manifest["languages"]["ky"]
            if rule["country"] == "UZ"
        ]
        self.assertTrue(all(
            rule["layer"] == "scope" and "role" not in rule
            for rule in kyrgyz_scope_rules
        ))
        self.assertTrue(all(rule.get("replace_country_role") for rule in kyrgyz_scope_rules))
        kyrgyz_kazakhstan_rule = next(
            rule
            for rule in manifest["languages"]["ky"]
            if rule["country"] == "KZ"
        )
        self.assertEqual(kyrgyz_kazakhstan_rule["layer"], "scope")
        self.assertNotIn("role", kyrgyz_kazakhstan_rule)
        self.assertTrue(kyrgyz_kazakhstan_rule["replace_country_role"])
        kyrgyz_tajikistan_rule = next(
            rule
            for rule in manifest["languages"]["ky"]
            if rule["country"] == "TJ"
        )
        self.assertEqual(kyrgyz_tajikistan_rule["layer"], "scope")
        self.assertNotIn("role", kyrgyz_tajikistan_rule)
        self.assertTrue(kyrgyz_tajikistan_rule["replace_country_role"])
        self.assertEqual(
            regions("ps", "AF"),
            {
                "AF-KAN", "AF-HEL", "AF-ZAB", "AF-URU", "AF-PIA",
                "AF-PKA", "AF-KHO", "AF-NAN", "AF-KNR", "AF-LAG",
                "AF-LOG", "AF-WAR", "AF-GHA", "AF-KAB", "AF-HER",
                "AF-FRA", "AF-NIM",
            },
        )
        afghanistan_pashto_rules = [
            rule
            for rule in manifest["languages"]["ps"]
            if rule["country"] == "AF"
        ]
        self.assertTrue(all(rule["role"] == "distribution" for rule in afghanistan_pashto_rules))
        self.assertTrue(all(not rule.get("replace_country_role") for rule in afghanistan_pashto_rules))
        self.assertEqual(regions("sd", "IN"), {"IN-GJ", "IN-MH", "IN-RJ"})
        india_sindhi_rules = [
            rule
            for rule in manifest["languages"]["sd"]
            if rule["country"] == "IN"
        ]
        self.assertTrue(all(rule["role"] == "distribution" for rule in india_sindhi_rules))
        self.assertTrue(all(not rule.get("replace_country_role") for rule in india_sindhi_rules))
        inner_mongolia_rule = next(
            rule
            for rule in manifest["languages"]["mn"]
            if rule["country"] == "CN"
        )
        for language in ("kk", "ky"):
            xinjiang_rule = next(
                rule
                for rule in manifest["languages"][language]
                if rule["country"] == "CN"
            )
            self.assertEqual(xinjiang_rule["layer"], "scope")
            self.assertNotIn("role", xinjiang_rule)
            self.assertEqual(xinjiang_rule["intensity"], inner_mongolia_rule["intensity"])
            self.assertTrue(xinjiang_rule["replace_country_role"])

        kazakh_uzbekistan_rules = [
            rule
            for rule in manifest["languages"]["kk"]
            if rule["country"] == "UZ"
        ]
        self.assertTrue(all(
            rule["layer"] == "scope" and "role" not in rule
            for rule in kazakh_uzbekistan_rules
        ))
        kazakh_kyrgyzstan_rules = [
            rule
            for rule in manifest["languages"]["kk"]
            if rule["country"] == "KG"
        ]
        self.assertTrue(all(
            rule["layer"] == "scope" and "role" not in rule
            for rule in kazakh_kyrgyzstan_rules
        ))
        kazakh_russia_rule = next(
            rule
            for rule in manifest["languages"]["kk"]
            if rule["country"] == "RU"
        )
        self.assertEqual(kazakh_russia_rule["layer"], "scope")
        self.assertNotIn("role", kazakh_russia_rule)
        self.assertEqual(kazakh_russia_rule["intensity"], 0.28)
        self.assertTrue(kazakh_russia_rule["replace_country_role"])
        kazakh_turkmenistan_rule = next(
            rule
            for rule in manifest["languages"]["kk"]
            if rule["country"] == "TM"
        )
        self.assertEqual(kazakh_turkmenistan_rule["layer"], "scope")
        self.assertNotIn("role", kazakh_turkmenistan_rule)
        self.assertEqual(kazakh_turkmenistan_rule["intensity"], 0.18)
        self.assertTrue(kazakh_turkmenistan_rule["replace_country_role"])
        distribution_profile = json.loads(
            COVERAGE.LANGUAGE_MAP_PATH.read_text(encoding="utf-8")
        )["profiles"]["kk"]
        self.assertEqual(len(distribution_profile["regions"]), 2)
        self.assertTrue(all(
            region["center"][0] >= 80
            for region in distribution_profile["regions"]
        ))

        distribution = json.loads(
            COVERAGE.LANGUAGE_MAP_PATH.read_text(encoding="utf-8")
        )
        sindhi_india_regions = [
            region
            for region in distribution["profiles"]["sd"]["regions"]
            if 69 <= region["center"][0] <= 82
            and 18 <= region["center"][1] <= 29
        ]
        self.assertGreaterEqual(len(sindhi_india_regions), 7)
        canada = next(
            entry
            for entry in distribution["profiles"]["fr"]["countrywide"]
            if isinstance(entry, dict) and entry.get("code") == "CA"
        )
        self.assertTrue(canada["status_only"])

    def test_turkmen_distribution_uses_clean_admin1_polygons(self):
        manifest = json.loads(COVERAGE.LANGUAGE_MAP_ADMIN1_PATH.read_text(encoding="utf-8"))
        self.assertNotIn("tk", manifest["sources"])
        self.assertTrue(all(
            "source" not in rule
            for rule in manifest["languages"]["tk"]
        ))

    def test_clear_japanese_resident_concentrations_use_prefecture_polygons(self):
        manifest = json.loads(COVERAGE.LANGUAGE_MAP_ADMIN1_PATH.read_text(encoding="utf-8"))
        expected = {
            "pt-BR": {"JP-23", "JP-22", "JP-10", "JP-21", "JP-24", "JP-08", "JP-11", "JP-14"},
            "ne": {"JP-13", "JP-12", "JP-11", "JP-14", "JP-23", "JP-27", "JP-40",
                   "JP-28", "JP-22", "JP-10", "JP-26"},
        }
        for language, region_ids in expected.items():
            with self.subTest(language=language):
                rules = [
                    rule for rule in manifest["languages"][language]
                    if rule["country"] == "JP"
                ]
                self.assertTrue(rules)
                self.assertTrue(all(rule["role"] == "resident" for rule in rules))
                self.assertTrue(all(rule["replace_country_role"] for rule in rules))
                self.assertEqual(
                    {region for rule in rules for region in rule["regions"]},
                    region_ids,
                )
        self.assertNotIn("vi", manifest["languages"])

    def test_admin1_builder_keeps_disconnected_features_with_the_same_region_id(self):
        def feature(offset):
            return {
                "type": "Feature",
                "properties": {
                    "iso_a2": "PH",
                    "iso_3166_2": "PH-CEB",
                    "name_en": "Cebu",
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[
                        [offset, 0], [offset, 1], [offset + 1, 1], [offset, 0]
                    ]],
                },
            }

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "admin1.geojson"
            output = root / "chunks"
            manifest = root / "manifest.json"
            custom = root / "custom"
            custom.mkdir()
            source.write_text(
                json.dumps({"type": "FeatureCollection", "features": [feature(0), feature(2)]}),
                encoding="utf-8",
            )
            manifest.write_text(
                json.dumps({
                    "sources": {"ceb": "./language-map-admin1/lang-ceb.geojson"},
                    "languages": {
                        "ceb": [{"source": "ceb", "country": "PH", "regions": ["PH-CEB"]}]
                    },
                }),
                encoding="utf-8",
            )
            ADMIN1_BUILDER.build_sources(source, output, manifest, custom)
            payload = json.loads((output / "lang" / "ceb.geojson").read_text(encoding="utf-8"))
            self.assertEqual(len(payload["features"]), 2)

    def test_snapshot_contains_only_localized_registry_rows(self):
        snapshot = COVERAGE.build_snapshot()
        self.assertEqual({item["state"] for item in snapshot["locales"]}, {"localized"})
        self.assertEqual(
            [item["locale"] for item in snapshot["locales"]],
            [
                item["locale"]
                for item in COVERAGE.hub.locales_config()["locales"]
                if COVERAGE.hub.locale_enabled(item)
            ],
        )
        self.assertNotIn("waves", snapshot)
        self.assertNotIn("source_locale", snapshot)
        self.assertNotIn("reference_locale", snapshot)
        self.assertTrue(all("wave" not in item for item in snapshot["locales"]))
        self.assertNotIn("planned", snapshot["summary"])

    def test_publication_manifest_only_contributes_links(self):
        locale = next(
            item["locale"]
            for item in COVERAGE.hub.locales_config()["locales"]
            if COVERAGE.hub.locale_enabled(item)
        )
        snapshot = COVERAGE.build_snapshot({
            "schema": 1,
            "locales": [{"locale": locale, "href": "https://example.invalid/edition/"}],
        })
        published = [item for item in snapshot["locales"] if item["published"]]
        self.assertEqual([item["locale"] for item in published], [locale])
        self.assertEqual(published[0]["href"], "https://example.invalid/edition/")
        self.assertTrue(all(
            "docs" not in item and "review" not in item and "wave" not in item
            for item in snapshot["locales"]
        ))

    def test_host_intro_accepts_arbitrary_synthetic_message_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            intro = Path(tmp) / "intro.json"
            intro.write_text(json.dumps({
                "schema": 1,
                "version": 1,
                "messages": {"en": {"syntheticHostHeading": "Synthetic heading"}},
            }), encoding="utf-8")
            with patch.object(COVERAGE, "UI_INTRO_PATH", intro):
                snapshot = COVERAGE.build_snapshot()
        self.assertEqual(
            snapshot["ui_messages"]["en"]["syntheticHostHeading"],
            "Synthetic heading",
        )

    def test_coverage_ui_counts_enabled_locales_once(self):
        snapshot = COVERAGE.build_snapshot()
        ids = [item["id"] for item in snapshot["ui_locales"]]
        self.assertEqual(len(ids), len(snapshot["locales"]))
        self.assertEqual(len(ids), len(set(ids)))
        configured = set(json.loads(
            COVERAGE.CONFIG_PATH.read_text(encoding="utf-8")
        )["map_ui_localization"]["locales"])
        self.assertEqual(set(snapshot["map_ui_locales"]), configured)
        self.assertTrue(all(
            bool(localization["messages"]) == (locale in configured)
            for locale, localization in snapshot["map_localizations"].items()
        ))

    def test_country_selector_includes_all_iso_3166_alpha2_codes(self):
        snapshot = COVERAGE.build_snapshot()
        map_data = json.loads(COVERAGE.LANGUAGE_MAP_PATH.read_text(encoding="utf-8"))
        self.assertEqual(set(snapshot["country_codes"]), set(map_data["iso2_to_iso3"]))
        self.assertIn("AQ", snapshot["country_codes"])

    def test_deferred_place_labels_balance_population_and_map_prominence(self):
        raw = COVERAGE.LANGUAGE_MAP_PLACES_PATH.read_text(encoding="utf-8")
        self.assertNotIn("\n        [\n", raw)
        payload = json.loads(raw)
        countries = payload["countries"]

        def names(code):
            return [item[5] for item in countries[code]["places"]]

        self.assertEqual(countries["JP"]["budget"], 20)
        self.assertEqual(countries["JP"]["broad_label_floor"], 7)
        self.assertEqual(
            names("JP")[:13],
            [
                "Tokyo", "Ōsaka", "Nagoya", "Sapporo", "Fukuoka", "Sendai",
                "Naha", "Hiroshima", "Niigata", "Akita", "Kagoshima", "Kanazawa",
                "Miyazaki",
            ],
        )
        self.assertEqual(countries["MM"]["representative_place"], "Yangon")
        self.assertEqual(names("MM")[:3], ["Yangon", "Mandalay", "Naypyidaw"])
        self.assertEqual(
            names("RU")[:5],
            ["Moscow", "St.  Petersburg", "Yekaterinburg", "Novosibirsk", "Kazan"],
        )
        self.assertEqual(countries["RU"]["budget"], 18)
        self.assertEqual(countries["RU"]["broad_label_floor"], 7)
        self.assertTrue(
            {"Krasnoyarsk", "Irkutsk", "Vladivostok", "Khabarovsk", "Yakutsk", "Chita"}
            <= set(names("RU"))
        )
        self.assertEqual(countries["US"]["budget"], 32)
        self.assertEqual(countries["US"]["broad_label_floor"], 11)
        self.assertEqual(countries["US"]["selected_label_floor"], 18)
        self.assertTrue(
            {
                "Kansas City", "Omaha", "Wichita", "Oklahoma City", "Tulsa",
                "Des Moines", "Fargo", "Sioux Falls", "Anchorage", "Fairbanks",
                "Juneau", "Nome", "Utqiaġvik",
            }
            <= set(names("US"))
        )
        self.assertEqual(countries["CA"]["budget"], 15)
        self.assertEqual(countries["CA"]["broad_label_floor"], 7)
        self.assertEqual(countries["CA"]["selected_label_floor"], 14)
        self.assertTrue(
            {"Whitehorse", "Yellowknife", "Iqaluit", "Churchill", "Inuvik", "Resolute"}
            <= set(names("CA"))
        )
        for code in ("US", "CA", "RU"):
            self.assertEqual(len(names(code)), len(set(names(code))))
            self.assertTrue(countries[code]["prefer_place_labels_when_selected"])
        self.assertEqual(names("KZ")[0], "Astana")
        self.assertEqual(countries["KZ"]["places"][0][6]["scripts"]["Jpan"], "アスタナ")
        self.assertEqual(names("TN")[0], "Tunis")
        self.assertEqual(countries["AR"]["broad_label_floor"], 2)
        self.assertEqual(names("AR")[:2], ["Buenos Aires", "Ushuaia"])
        self.assertEqual(countries["ZA"]["broad_label_floor"], 3)
        self.assertEqual(names("ZA")[:3], ["Pretoria", "Cape Town", "Bloemfontein"])
        self.assertEqual(countries["AU"]["broad_label_floor"], 3)
        self.assertEqual(names("AU")[:3], ["Canberra", "Sydney", "Darwin"])
        self.assertEqual(names("PL")[:3], ["Warsaw", "Kraków", "Gdańsk"])
        self.assertEqual(
            names("PL")[:7],
            ["Warsaw", "Kraków", "Gdańsk", "Wrocław", "Poznań", "Łódź", "Szczecin"],
        )
        self.assertEqual(
            names("BY")[:6],
            ["Minsk", "Homyel", "Brest", "Hrodna", "Vitsyebsk", "Mahilyow"],
        )
        self.assertEqual(names("CZ")[:3], ["Prague", "Brno", "Ostrava"])
        self.assertEqual(
            names("DE")[:7],
            ["Berlin", "Munich", "Hamburg", "Frankfurt", "Cologne", "Dresden", "Leipzig"],
        )
        self.assertEqual(
            names("FR")[:6],
            ["Paris", "Lyon", "Marseille", "Toulouse", "Bordeaux", "Strasbourg"],
        )
        self.assertEqual(
            names("GB")[:7],
            ["London", "Edinburgh", "Belfast", "Cardiff", "Manchester", "Birmingham", "Glasgow"],
        )
        self.assertEqual(
            names("AT")[:4],
            ["Vienna", "Salzburg", "Innsbruck", "Graz"],
        )
        self.assertEqual(
            names("IT")[:8],
            ["Rome", "Milan", "Naples", "Venice", "Florence", "Turin", "Bologna", "Bari"],
        )
        self.assertEqual(names("CH")[:4], ["Zürich", "Bern", "Geneva", "Basel"])
        self.assertEqual(
            names("SO")[:3],
            ["Mogadishu", "Hargeisa", "Kismaayo"],
        )
        self.assertEqual(
            names("TR")[:10],
            ["Istanbul", "Ankara", "İzmir", "Bursa", "Antalya", "Adana", "Gaziantep", "Diyarbakır", "Trabzon", "Erzurum"],
        )
        self.assertEqual(
            names("UA")[:5],
            ["Kyiv", "Lviv", "Odessa", "Kharkiv", "Dnipro"],
        )
        self.assertEqual(names("SA")[:4], ["Riyadh", "Jeddah", "Medina", "Makkah"])
        self.assertEqual(names("SK")[:2], ["Bratislava", "Košice"])
        self.assertNotIn("MC", countries)
        self.assertNotIn("SM", countries)
        self.assertEqual(names("LI")[0], "Vaduz")
        louangphrabang = next(item for item in countries["LA"]["places"] if item[5] == "Louangphrabang")
        self.assertEqual(louangphrabang[6]["scripts"]["Jpan"], "ルアンパバーン")
        seoul = next(item for item in countries["KR"]["places"] if item[5] == "Seoul")
        busan = next(item for item in countries["KR"]["places"] if item[5] == "Busan")
        self.assertEqual(seoul[6]["scripts"]["Jpan"], "ソウル")
        self.assertEqual(busan[6]["scripts"]["Jpan"], "釜山")

    def test_disabled_registry_rows_are_omitted_instead_of_becoming_plans(self):
        registry = json.loads(json.dumps(COVERAGE.hub.locales_config()))
        disabled_locale = registry["locales"][-1]["locale"]
        registry["locales"][-1]["enabled"] = False
        with (
            patch.object(COVERAGE.hub, "locales_config", return_value=registry),
        ):
            snapshot = COVERAGE.build_snapshot()
        self.assertNotIn(disabled_locale, {item["locale"] for item in snapshot["locales"]})
        self.assertNotIn(disabled_locale, {item["id"] for item in snapshot["ui_locales"]})
        self.assertNotIn("planned", snapshot["summary"])

    def test_ui_messages_json_uses_canonical_utf8_formatting(self):
        for path in (COVERAGE.UI_MESSAGES_PATH,):
            with self.subTest(path=path.name):
                raw = path.read_text(encoding="utf-8")
                parsed = json.loads(raw)
                self.assertEqual(
                    raw,
                    json.dumps(parsed, ensure_ascii=False, indent=2) + "\n",
                )
                self.assertNotIn("\\u2019", raw)

    def test_atlas_localizations_are_versioned_per_locale_and_descriptions_are_bundled(self):
        ui = json.loads(COVERAGE.UI_MESSAGES_PATH.read_text(encoding="utf-8"))
        locale_ids = {item["id"] for item in ui["locales"]}
        source_paths = COVERAGE.MAP_LOCALIZATION_SOURCE_PATHS
        self.assertEqual(set(source_paths), {"atlas_ui", "map_controls"})
        self.assertEqual(ui["schema"], 3)
        self.assertGreater(ui["version"], 0)
        self.assertEqual(set(ui["messages"]), locale_ids)
        self.assertNotIn("heroCopy", ui["messages"]["ja"])
        self.assertNotIn("whyCopy", ui["messages"]["ja"])
        self.assertNotIn("taxonomy", ui)
        source_keys = set()
        for kind, path in source_paths.items():
            raw = path.read_text(encoding="utf-8")
            source = json.loads(raw)
            with self.subTest(source=kind):
                self.assertEqual(source["schema"], 2)
                self.assertGreater(source["version"], 0)
                self.assertEqual(source["kind"], kind)
                self.assertEqual(set(source["locales"]), locale_ids)
                self.assertEqual(
                    raw,
                    json.dumps(source, ensure_ascii=False, indent=2) + "\n",
                )
                self.assertFalse(source_keys & set(source["messages"]))
                source_keys.update(source["messages"])
                for key, record in source["messages"].items():
                    self.assertTrue(record["context"].strip(), key)
                    self.assertIn("en", record["translations"], key)
                    self.assertLessEqual(set(record["translations"]), locale_ids)
                    self.assertTrue(all(record["translations"].values()))
                    for placeholder in re.findall(
                        r"\{[^{}]+\}", record["translations"]["en"]
                    ):
                        self.assertIn(placeholder, record["context"], key)

        self.assertEqual(len(source_keys), 123)
        self.assertEqual(
            len(json.loads(source_paths["atlas_ui"].read_text())["messages"]),
            45,
        )
        self.assertEqual(
            len(json.loads(source_paths["map_controls"].read_text())["messages"]),
            78,
        )
        self.assertNotIn("countrywideLegend", source_keys)
        self.assertNotIn("regionalLegend", source_keys)
        runtime_sources = (
            COVERAGE.TEMPLATE_PATH.read_text(encoding="utf-8")
            + COVERAGE.LANGUAGE_MAP_RUNTIME_PATH.read_text(encoding="utf-8")
        )
        self.assertEqual(
            {key for key in source_keys if key not in runtime_sources},
            set(),
        )

        localizations = map_copy_localizations()
        self.assertEqual(set(localizations), locale_ids)
        for locale, localized in localizations.items():
            with self.subTest(locale=locale):
                self.assertEqual(localized["schema"], 1)
                self.assertGreater(localized["version"], 0)
                self.assertEqual(localized["locale"], locale)
                self.assertIn("messages", localized)
                self.assertEqual(
                    set(localized),
                    {"schema", "version", "locale", "messages"},
                )
                self.assertNotIn("heroCopy", localized["messages"])
                self.assertNotIn("whyCopy", localized["messages"])
                self.assertNotIn("country_names", localized)

        description_packs, description_sources = COVERAGE._load_description_localizations(
            locale_ids
        )
        self.assertEqual(set(description_packs), locale_ids)
        self.assertEqual(
            set(description_sources),
            {"languages", "families", "scripts"},
        )
        self.assertEqual(
            description_packs["ja"]["languages"]["fkv"],
            localized_language("ja", "fkv")["summary"],
        )
        self.assertTrue(description_packs["en"]["families"]["Indo-European"])
        self.assertTrue(description_packs["ja"]["scripts"]["Hani"])
        self.assertEqual(description_packs["xh"]["languages"], {})
        self.assertEqual(
            {
                kind: sum(
                    len(translations)
                    for translations in source["descriptions"].values()
                )
                for kind, source in description_sources.items()
            },
            {"languages": 4860, "families": 1474, "scripts": 858},
        )

        atlas_metadata = json.loads(
            COVERAGE.LANGUAGE_ATLAS_METADATA_PATH.read_text(encoding="utf-8")
        )
        self.assertNotIn("native_names", atlas_metadata)
        self.assertNotIn("native_name_source", atlas_metadata)

        japanese = map_localization("ja")["taxonomy"]
        english = map_localization("en")["taxonomy"]
        self.assertEqual(
            set(japanese["scripts"]["labels"]),
            set(english["scripts"]["labels"]),
        )
        self.assertEqual(
            set(japanese["families"]["descriptions"]),
            set(english["families"]["descriptions"]),
        )

    def test_viewpoint_build_configuration_has_one_value_and_one_override_flag(self):
        def fixture():
            return {
                "iso2_to_iso3": {"AA": "AAA"},
                "viewpoint_resolution_model": {"levels": {}},
            }

        neutral = fixture()
        COVERAGE._apply_viewpoint_configuration(neutral)
        self.assertNotIn("viewpoint", neutral["viewpoint_resolution_model"])
        self.assertNotIn("viewpoint_override", neutral["viewpoint_resolution_model"])

        default = fixture()
        COVERAGE._apply_viewpoint_configuration(default, "aa")
        self.assertEqual(default["viewpoint_resolution_model"]["viewpoint"], "AA")
        self.assertNotIn("viewpoint_override", default["viewpoint_resolution_model"])

        override = fixture()
        COVERAGE._apply_viewpoint_configuration(override, "AA", True)
        self.assertEqual(override["viewpoint_resolution_model"]["viewpoint"], "AA")
        self.assertIs(override["viewpoint_resolution_model"]["viewpoint_override"], True)

        with self.assertRaises(ValueError):
            COVERAGE._apply_viewpoint_configuration(fixture(), "", True)
        with self.assertRaises(ValueError):
            COVERAGE._apply_viewpoint_configuration(fixture(), "AAA")

    def test_language_map_data_is_separate_and_well_formed(self):
        raw = COVERAGE.LANGUAGE_MAP_PATH.read_text(encoding="utf-8")
        data = json.loads(raw)
        self.assertNotIn('"coordinates": [\n', raw)
        self.assertNotRegex(raw, r'"[A-Za-z_]*countries": \[\n')
        self.assertEqual(data["schema"], 1)
        self.assertNotIn("messages", data)
        self.assertEqual(data["geometry"]["overview_resolution"], "110m")
        self.assertEqual(data["geometry"]["resolution"], "10m")
        self.assertIn("countries-10m", data["geometry"]["detail_module"])
        self.assertEqual(
            data["geometry"]["detail_module"],
            "./vendor/map/atlas-countries-10m-1.0.0.mjs",
        )
        self.assertEqual(data["profiles"]["vi"]["scope"], "east_southeast_asia")
        self.assertEqual(data["profiles"]["th"]["scope"], "southeast_asia")
        israel_nonrecognizing_states = {
            "AF", "BD", "BN", "CU", "DJ", "DZ", "ID", "IQ", "IR", "KM",
            "KP", "KW", "LB", "LY", "ML", "MR", "MV", "MY", "NE", "OM",
            "PK", "QA", "SA", "SD", "SO", "SY", "TN", "VE", "YE",
        }
        self.assertEqual(
            set(data["viewpoint_groups"]["israel_nonrecognizing_states"]["countries"]),
            israel_nonrecognizing_states,
        )
        self.assertEqual(
            data["viewpoint_groups"]["israel_nonrecognizing_states"]["as_of"],
            "2026-02",
        )
        self.assertNotIn(
            "default_viewpoint_country",
            data["viewpoint_resolution_model"],
        )
        self.assertNotIn(
            "viewpoint",
            data["viewpoint_resolution_model"],
        )
        self.assertNotIn(
            "viewpoint_override",
            data["viewpoint_resolution_model"],
        )
        messages_ja = map_localization("ja")["messages"]
        messages_en = map_localization("en")["messages"]
        self.assertEqual(messages_ja["projectionAzimuthal"], "正積方位図法")
        self.assertEqual(messages_ja["projectionAzimuthalEquidistant"], "正距方位図法")
        self.assertEqual(messages_ja["projectionGnomonic"], "心射図法")
        self.assertEqual(messages_ja["projectionStereographic"], "平射図法")
        self.assertEqual(messages_ja["projectionEquirectangular"], "正距円筒図法")
        self.assertEqual(messages_ja["projectionConicEqualArea"], "正積円錐図法")
        self.assertEqual(messages_ja["projectionNaturalEarth1"], "Natural Earth 1")
        self.assertEqual(messages_ja["projectionTransverseMercator"], "横メルカトル図法")
        self.assertEqual(messages_ja["projectionAutoSelected"], "自動選択: {mode}。{description}")
        self.assertEqual(messages_ja["projectionGroupAzimuthal"], "方位図法")
        self.assertEqual(messages_ja["projectionGroupCylindrical"], "円筒図法")
        self.assertEqual(messages_ja["projectionGroupConic"], "円錐図法")
        self.assertEqual(messages_ja["projectionGroupPseudocylindrical"], "擬円筒図法")
        self.assertEqual(messages_ja["movementMercatorAxis"], "投影軸")
        self.assertEqual(messages_ja["orientationNorthShort"], "北")
        self.assertEqual(messages_ja["orientationEastShort"], "東")
        self.assertEqual(messages_ja["orientationSouthShort"], "南")
        self.assertEqual(messages_ja["orientationWestShort"], "西")
        self.assertEqual(messages_en["orientationNorthShort"], "N")
        self.assertEqual(messages_en["orientationEastShort"], "E")
        self.assertEqual(messages_en["orientationSouthShort"], "S")
        self.assertEqual(messages_en["orientationWestShort"], "W")
        messages_ar = map_localization("ar")["messages"]
        self.assertEqual(messages_ar["orientationNorthShort"], "ش")
        self.assertEqual(messages_ar["orientationEastShort"], "ق")
        self.assertEqual(messages_ar["orientationSouthShort"], "ج")
        self.assertEqual(messages_ar["orientationWestShort"], "غ")
        wave_one_ui_locales = {
            "zh-Hans", "zh-Hant", "de", "fr", "es", "ko",
            "pt-BR", "pt-PT", "it", "ru",
        }
        self.assertTrue(wave_one_ui_locales <= set(map_copy_localizations()))
        english_message_keys = set(messages_en)
        for locale in wave_one_ui_locales:
            with self.subTest(map_locale=locale):
                self.assertTrue(set(map_localization(locale)["messages"]) <= english_message_keys)
        canonicalization = {item["label"]: item for item in data["feature_canonicalization"]}
        exclusions = {item["label"]: item for item in data["geometry_exclusions"]}
        self.assertEqual(
            exclusions["Superseded Hans Island geometry"]["bounds"],
            [[-66.4, 80.8], [-66.28, 80.85]],
        )
        self.assertEqual(exclusions["Takeshima base geometry"]["from"], "KOR")
        self.assertEqual(
            exclusions["Takeshima base geometry"]["bounds"],
            [[131.83, 37.22], [131.89, 37.27]],
        )
        self.assertNotIn("Northern Territories (Habomai, Shikotan, Kunashiri and Etorofu)", canonicalization)
        self.assertNotIn("Takeshima", canonicalization)
        self.assertNotIn("Somaliland", canonicalization)
        self.assertEqual(canonicalization["Baikonur"]["to"], "KAZ")
        self.assertTrue(canonicalization["Baikonur"]["seamless"])
        self.assertEqual(data["feature_code_aliases"]["SOL"], "SO")
        extracts = {item["id"]: item for item in data["territory_extracts"]}
        self.assertEqual(extracts["XCR"]["from"], ["RUS", "UKR"])
        self.assertEqual(extracts["EAX"]["from"], "ESP")
        self.assertEqual(len(extracts["EAX"]["bounds"]), 2)
        for feature_id in ("GLP", "MTQ", "GUF", "MYT", "REU"):
            self.assertEqual(extracts[feature_id]["from"], "FRA")
        self.assertEqual(extracts["BVT"]["from"], "NOR")
        self.assertEqual(extracts["SJM"]["from"], "NOR")
        self.assertEqual(len(extracts["SJM"]["bounds"]), 2)
        self.assertEqual(extracts["CCK"]["from"], "IOA")
        self.assertEqual(extracts["CXR"]["from"], "IOA")
        self.assertNotIn("IOA", data["feature_code_aliases"])
        regions = {item["id"]: item for item in data["feature_regions"]}
        self.assertEqual(regions["HIC"]["selection_rule"]["countries"], ["CA"])
        self.assertEqual(regions["HIG"]["selection_rule"]["countries"], ["GL"])
        self.assertTrue(regions["HIC"]["settled_boundary"])
        self.assertTrue(regions["HIG"]["settled_boundary"])
        hans_boundary = {
            (-66.450667, 80.821444),
            (-66.464528, 80.825861),
            (-66.456667, 80.831833),
        }
        for feature_id in ("HIC", "HIG"):
            ring = regions[feature_id]["geometry"]["coordinates"][0]
            self.assertTrue(hans_boundary <= {tuple(point) for point in ring})
        self.assertEqual(regions["XHL"]["geometry"]["type"], "MultiPolygon")
        self.assertIn("natural-earth-vector", regions["XHL"]["source_url"])
        halaib_ring = regions["XHL"]["geometry"]["coordinates"][0][0]
        signed_area = sum(
            first[0] * second[1] - second[0] * first[1]
            for first, second in zip(halaib_ring, halaib_ring[1:])
        )
        self.assertLess(signed_area, 0, "D3 spherical exterior rings must be clockwise")
        self.assertEqual(regions["BRT"]["source_feature_id"], "BRT")
        self.assertIn("natural-earth-vector", regions["BRT"]["source_url"])
        self.assertEqual(regions["XWA"]["geometry"]["type"], "Polygon")
        self.assertIn("natural-earth-vector", regions["XWA"]["source_url"])
        western_sahara_administered_ring = regions["XWA"]["geometry"]["coordinates"][0]
        administered_signed_area = sum(
            first[0] * second[1] - second[0] * first[1]
            for first, second in zip(
                western_sahara_administered_ring,
                western_sahara_administered_ring[1:],
            )
        )
        self.assertLess(administered_signed_area, 0, "D3 spherical exterior rings must be clockwise")
        self.assertEqual(regions["VAT"]["geometry"]["type"], "Polygon")
        self.assertEqual(regions["TKL"]["geometry"]["type"], "MultiPolygon")
        self.assertEqual(regions["BES"]["geometry"]["type"], "MultiPolygon")
        self.assertEqual(data["feature_selections"]["VAT"]["countries"], ["VA"])
        self.assertEqual(data["feature_selections"]["TKL"]["countries"], ["TK"])
        self.assertEqual(data["feature_selections"]["KOS"]["countries"], ["XK"])
        self.assertEqual(data["feature_selections"]["KOS"]["party_countries"], ["XK", "RS"])
        self.assertEqual(data["feature_selections"]["KOS"]["admin_countries"], ["XK"])
        self.assertTrue(
            {"CA", "GB", "JP", "US"}
            <= set(data["feature_selections"]["KOS"]["viewpoint_selections"]["XK"])
        )
        self.assertEqual(
            set(data["feature_selections"]["KOS"]["viewpoint_selections"]["RS"]),
            {"BA", "CN", "CY", "ES", "GE", "GR", "MD", "RO", "RU", "SK", "UA"},
        )
        self.assertEqual(data["feature_selections"]["XCR"]["countries"], ["UA", "RU"])
        self.assertTrue(data["feature_selections"]["XCR"]["highlight_with_related"])
        self.assertTrue(data["feature_selections"]["XCR"]["click_priority"])
        self.assertTrue(data["feature_selections"]["XCR"]["focus_feature"])
        eu_viewpoints = {
            "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES",
            "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU",
            "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
        }
        self.assertEqual(
            set(data["feature_selections"]["XCR"]["viewpoint_selections"]["UA"]),
            eu_viewpoints | {"CA", "GB", "JP", "US"},
        )
        crimea_ru_viewpoints = {
            "AF", "AM", "AO", "BI", "BO", "BY", "CN", "CU",
            "ER", "IN", "IR", "KH", "KM", "KP", "KZ", "NI",
            "RS", "SA", "SD", "SY", "UZ", "VE", "ZA", "ZW",
        }
        self.assertEqual(
            set(data["feature_selections"]["XCR"]["viewpoint_selections"]["RU"]),
            crimea_ru_viewpoints,
        )
        crimea_ru_evidence = data["feature_selections"]["XCR"][
            "viewpoint_selection_evidence"
        ]["RU"]
        self.assertEqual(crimea_ru_evidence["as_of"], "2022-07-03")
        self.assertEqual(
            set(crimea_ru_evidence["official"]) | set(crimea_ru_evidence["de_facto"]),
            crimea_ru_viewpoints,
        )
        self.assertEqual(data["feature_selections"]["CYN"]["countries"], ["CY", "TR"])
        self.assertEqual(
            data["feature_selections"]["CYN"]["default_viewpoint_selection"],
            ["CY"],
        )
        self.assertTrue(data["feature_selections"]["CYN"]["self_administered"])
        self.assertEqual(data["feature_selections"]["CYN"]["claim_only_countries"], ["CY"])
        self.assertEqual(data["feature_selections"]["SOL"]["countries"], ["SO"])
        self.assertEqual(data["feature_selections"]["SOL"]["admin_countries"], [])
        self.assertEqual(data["feature_selections"]["SOL"]["party_countries"], ["SO"])
        self.assertTrue(data["feature_selections"]["SOL"]["self_administered"])
        self.assertTrue(data["feature_selections"]["SOL"]["region_overlay"])
        self.assertTrue(data["feature_selections"]["KAS"]["highlight_with_related"])
        self.assertEqual(data["feature_selections"]["XHL"]["countries"], ["EG", "SD"])
        self.assertTrue(data["feature_selections"]["XHL"]["highlight_with_related"])
        self.assertEqual(data["feature_selections"]["PSX"]["countries"], ["PS"])
        self.assertEqual(data["feature_selections"]["PSX"]["party_countries"], ["PS", "IL"])
        self.assertEqual(
            data["feature_selections"]["PSX"]["viewpoint_resolutions"],
            [
                {
                    "viewpoint_group": "israel_nonrecognizing_states",
                    "selection_countries": ["PS"],
                    "level": "recognized",
                }
            ],
        )
        self.assertEqual(data["iso2_to_iso3"]["TW"], "TWN")
        self.assertEqual(data["iso2_to_iso3"]["EA"], "EAX")
        self.assertNotIn("TWN", data["feature_selections"])
        self.assertEqual(data["feature_selections"]["SAH"]["countries"], ["EH"])
        for feature_id in ("PSX", "SAH"):
            self.assertTrue(data["feature_selections"][feature_id]["click_priority"])
            self.assertTrue(data["feature_selections"][feature_id]["focus_feature"])
        self.assertEqual(data["feature_selections"]["XWA"]["countries"], ["EH", "MA"])
        self.assertTrue(data["feature_selections"]["XWA"]["click_priority"])
        self.assertTrue(data["feature_selections"]["XWA"]["region_overlay"])
        bir_tawil = regions["BRT"]["selection_rule"]
        self.assertEqual(bir_tawil["party_countries"], ["EG", "SD"])
        self.assertEqual(
            bir_tawil["viewpoint_resolutions"],
            [
                {
                    "viewpoints": ["EG"],
                    "selection_countries": ["SD"],
                    "level": "administered",
                },
                {
                    "viewpoints": ["SD"],
                    "selection_countries": ["EG"],
                    "level": "administered",
                },
                {
                    "default": True,
                    "selection_countries": [],
                    "level": "unclaimed",
                },
            ],
        )
        self.assertNotIn("BRT", data["feature_selections"])
        self.assertNotIn("KAB", data["feature_selections"])
        selections = list(data["feature_selections"].items()) + [
            (region["id"], region["selection_rule"])
            for region in data["feature_regions"]
            if "selection_rule" in region
        ]
        for feature_id, selection in selections:
            with self.subTest(feature_id=feature_id):
                self.assertTrue(selection["countries"])
                self.assertTrue(set(selection["countries"]) <= set(data["iso2_to_iso3"]))
                for field in (
                    "viewpoint_selections",
                    "party_equivalent_viewpoint_selections",
                ):
                    for target, viewpoints in selection.get(field, {}).items():
                        self.assertIn(target, selection.get("party_countries", selection["countries"]))
                        self.assertTrue(viewpoints)
                        self.assertTrue(set(viewpoints) <= set(data["iso2_to_iso3"]))
                resolutions = selection.get("viewpoint_resolutions", [])
                self.assertLessEqual(
                    sum(resolution.get("default") is True for resolution in resolutions),
                    1,
                )
                for resolution in resolutions:
                    self.assertIn(
                        resolution["level"],
                        {"administered", "recognized", "claimed", "observed", "unclaimed", "hidden"},
                    )
                    self.assertTrue(
                        set(resolution.get("selection_countries", resolution.get("countries", [])))
                        <= set(selection.get("party_countries", selection["countries"]))
                    )
                    self.assertTrue(
                        set(resolution.get("viewpoints", []))
                        <= set(data["iso2_to_iso3"])
                    )
                    group_names = set(resolution.get("viewpoint_groups", []))
                    if resolution.get("viewpoint_group"):
                        group_names.add(resolution["viewpoint_group"])
                    self.assertTrue(group_names <= set(data.get("viewpoint_groups", {})))
                default_viewpoint_selection = selection.get("default_viewpoint_selection", [])
                self.assertTrue(
                    set(default_viewpoint_selection)
                    <= set(selection.get("party_countries", selection["countries"]))
                )
        self.assertEqual(data["iso2_to_iso3"]["JP"], "JPN")
        self.assertEqual(data["iso2_to_iso3"]["XK"], "XKK")
        self.assertIn("kmr", data["profiles"])
        self.assertIn("ca", data["profiles"])
        catalan = data["profiles"]["ca"]
        catalan_countrywide = {
            item if isinstance(item, str) else item["code"]
            for item in catalan["countrywide"]
        }
        self.assertEqual(catalan_countrywide, {"AD", "ES"})
        self.assertIs(catalan["roles_from_access"], False)
        self.assertIn(
            {"center": [2.9, 42.7], "radius_km": 70, "intensity": 0.58},
            catalan["regions"],
        )
        self.assertIn(
            {"center": [8.31, 40.56], "radius_km": 55, "intensity": 0.48},
            catalan["regions"],
        )
        self.assertIn("eu", data["profiles"])
        self.assertEqual(["IR"], data["profiles"]["fa-ir"]["countrywide"])
        self.assertEqual(["UZ"], data["profiles"]["uz-uz"]["countrywide"])
        self.assertEqual(["TJ"], data["profiles"]["tg"]["countrywide"])
        self.assertEqual(["TM"], data["profiles"]["tk"]["countrywide"])
        self.assertIn("KZ", data["profiles"]["kk"]["countrywide"])
        self.assertIn("KG", data["profiles"]["ky"]["countrywide"])
        self.assertIn("MN", data["profiles"]["mn"]["countrywide"])
        for locale in ("fa-af", "ps"):
            afghanistan = next(
                item for item in data["profiles"][locale]["countrywide"]
                if isinstance(item, dict) and item.get("code") == "AF"
            )
            self.assertIs(afghanistan["status_only"], True)
            self.assertTrue(data["profiles"][locale]["regions"])
        self.assertTrue(data["profiles"]["uz-uz"]["regions"])
        for locale in ("bo", "kk", "ky", "mn", "ug"):
            china = next(
                item for item in data["profiles"][locale]["countrywide"]
                if isinstance(item, dict) and item.get("code") == "CN"
            )
            self.assertIs(china["status_only"], True)
            self.assertTrue(data["profiles"][locale]["regions"])
        self.assertNotIn(
            "CN",
            {
                item if isinstance(item, str) else item["code"]
                for item in data["profiles"]["tg"]["countrywide"]
            },
        )
        self.assertTrue(any(
            79 <= region["center"][0] <= 87 and 42 <= region["center"][1] <= 48
            for region in data["profiles"]["kk"]["regions"]
        ))
        self.assertEqual([], data["profiles"]["tg"]["regions"])
        self.assertGreaterEqual(len(data["profiles"]["kk"]["regions"]), 2)
        for locale in ("ky", "uz-uz"):
            self.assertGreaterEqual(len(data["profiles"][locale]["regions"]), 3)
        dari = next(
            item for item in data["profiles"]["fa-af"]["countrywide"]
            if isinstance(item, dict) and item.get("code") == "AF"
        )
        pashto = next(
            item for item in data["profiles"]["ps"]["countrywide"]
            if isinstance(item, dict) and item.get("code") == "AF"
        )
        self.assertGreater(dari["intensity"], pashto["intensity"])
        self.assertEqual(
            data["profiles"]["tk"]["regions"],
            [],
        )
        for locale, profile in data["profiles"].items():
            with self.subTest(locale=locale):
                role_codes = {}
                for role in ("countrywide", "official", "resident"):
                    role_items = profile.get(role, [])
                    role_codes[role] = {
                        item if isinstance(item, str) else item["code"]
                        for item in role_items
                    }
                    for item in role_items:
                        if isinstance(item, dict):
                            if "intensity" in item:
                                self.assertGreater(item["intensity"], 0)
                                self.assertLessEqual(item["intensity"], 1)
                            if "status_only" in item:
                                self.assertIs(item["status_only"], True)
                self.assertFalse(role_codes["countrywide"] & role_codes["official"])
                if "scope" in profile:
                    self.assertIn(profile["scope"], data["scopes"])
                for region in profile.get("regions", []):
                    self.assertEqual(len(region["center"]), 2)
                    self.assertGreater(region["radius_km"], 0)
                    self.assertGreater(region["intensity"], 0)
                    self.assertLessEqual(region["intensity"], 1)

        south_african_written_official_locales = {
            "af", "en", "nr", "nso", "ss", "st", "tn", "ts", "ve", "xh", "zu",
        }
        for locale in south_african_written_official_locales:
            with self.subTest(south_african_locale=locale):
                profile = data["profiles"][locale]
                south_africa = next(
                    item for item in profile["countrywide"]
                    if isinstance(item, dict) and item.get("code") == "ZA"
                )
                self.assertIs(south_africa.get("status_only"), True)
                self.assertLess(south_africa["intensity"], 0.2)
                self.assertTrue(profile["regions"])

        afrikaans_regions = data["profiles"]["af"]["regions"]
        self.assertTrue(any(
            16 <= region["center"][0] <= 21 and -29 <= region["center"][1] <= -27
            for region in afrikaans_regions
        ))
        self.assertTrue(any(
            16 <= region["center"][0] <= 20 and -27 <= region["center"][1] <= -24
            for region in afrikaans_regions
        ))
        self.assertTrue(any(
            16 <= region["center"][0] <= 20 and -24 <= region["center"][1] <= -21
            for region in afrikaans_regions
        ))

        self.assertIn("BW", data["profiles"]["tn"]["countrywide"])
        self.assertFalse(any(
            (item if isinstance(item, str) else item.get("code")) == "NA"
            for item in data["profiles"]["tn"]["countrywide"]
        ))

        zimbabwe_territorial_locales = {"st", "tn", "ts", "ve", "xh"}
        for locale in zimbabwe_territorial_locales:
            with self.subTest(zimbabwe_territorial_locale=locale):
                self.assertFalse(any(
                    (item if isinstance(item, str) else item.get("code")) == "ZW"
                    for item in data["profiles"][locale]["countrywide"]
                ))

        sub_saharan_distribution_profiles = {
            "am", "ti", "om", "so", "sw", "rw", "rn", "lg", "ha",
            "yo", "ig", "ln", "sg", "mg", "sn", "wo", "bm", "ff",
        }
        for locale in sub_saharan_distribution_profiles:
            with self.subTest(sub_saharan_distribution_locale=locale):
                profile = data["profiles"][locale]
                self.assertIn(profile["scope"], data["scopes"])
                self.assertTrue(profile["regions"])

        balkan_distribution_profiles = {
            "sq", "hu", "bs", "hr", "sr", "mk", "bg", "el", "ro", "sl", "tr",
        }
        for locale in balkan_distribution_profiles:
            with self.subTest(balkan_distribution_locale=locale):
                profile = data["profiles"][locale]
                self.assertEqual(profile["scope"], "europe")
                self.assertTrue(profile["regions"])
        for locale in ("sq", "hu", "bs", "hr", "sr", "el", "ro", "sl", "tr"):
            with self.subTest(cross_border_balkan_locale=locale):
                self.assertGreaterEqual(len(data["profiles"][locale]["regions"]), 2)
        turkish_regions = data["profiles"]["tr"]["regions"]
        self.assertTrue(any(
            36.5 <= region["center"][0] <= 37.5
            and 36.2 <= region["center"][1] <= 37.2
            for region in turkish_regions
        ))
        self.assertTrue(any(
            35.5 <= region["center"][0] <= 36.3
            and 35.4 <= region["center"][1] <= 36.2
            for region in turkish_regions
        ))
        self.assertGreaterEqual(sum(
            25 <= region["center"][0] <= 28
            and 41.5 <= region["center"][1] <= 44.5
            for region in turkish_regions
        ), 5)
        self.assertGreaterEqual(sum(
            24.5 <= region["center"][0] <= 26.5
            and 40.5 <= region["center"][1] <= 41.5
            for region in turkish_regions
        ), 3)
        self.assertGreaterEqual(sum(
            42 <= region["center"][0] <= 46
            and 34 <= region["center"][1] <= 37
            for region in turkish_regions
        ), 5)

        caucasus_and_west_asia_profiles = {
            "hy": "AM",
            "az": "AZ",
            "ka-ge": "GE",
            "fa-ir": "IR",
            "he-il": "IL",
        }
        for locale, country in caucasus_and_west_asia_profiles.items():
            with self.subTest(caucasus_west_asia_locale=locale):
                profile = data["profiles"][locale]
                country_codes = {
                    item if isinstance(item, str) else item["code"]
                    for item in profile["countrywide"]
                }
                self.assertIn(country, country_codes)
                self.assertEqual(profile["scope"], "west_asia")
                self.assertTrue(profile["regions"])
        arabic_profile = data["profiles"]["ar"]
        self.assertEqual(arabic_profile["scope"], "west_asia")
        self.assertNotIn("countrywide", arabic_profile)
        self.assertNotIn("official", arabic_profile)
        self.assertTrue(any(
            35 <= region["center"][0] <= 41
            and 35 <= region["center"][1] <= 39
            for region in arabic_profile["regions"]
        ))
        self.assertTrue(any(
            47 <= region["center"][0] <= 54
            and 25 <= region["center"][1] <= 33
            for region in arabic_profile["regions"]
        ))
        ckb_regions = data["profiles"]["ckb"]["regions"]
        self.assertLessEqual(max(region["radius_km"] for region in ckb_regions), 115)
        self.assertTrue(any(
            45 <= region["center"][0] <= 46.5
            and 36 <= region["center"][1] <= 38
            for region in ckb_regions
        ))
        self.assertLessEqual(
            max(region["radius_km"] for region in data["profiles"]["kmr"]["regions"]),
            390,
        )
        self.assertFalse(any(
            46 <= region["center"][0] <= 48
            and 39 <= region["center"][1] <= 41
            and region["intensity"] >= 0.5
            for region in data["profiles"]["hy"]["regions"]
        ))

        south_american_distribution_profiles = {"gn", "ay", "qu"}
        for locale in south_american_distribution_profiles:
            with self.subTest(south_american_distribution_locale=locale):
                profile = data["profiles"][locale]
                self.assertEqual(profile["scope"], "south_america")
                self.assertTrue(profile["regions"])
        self.assertTrue(any(
            -64 <= region["center"][0] <= -53
            and -28 <= region["center"][1] <= -19
            for region in data["profiles"]["gn"]["regions"]
        ))
        self.assertTrue(any(
            -71 <= region["center"][0] <= -66
            and -21 <= region["center"][1] <= -14
            for region in data["profiles"]["ay"]["regions"]
        ))
        self.assertTrue(any(
            -76 <= region["center"][0] <= -70
            and -16 <= region["center"][1] <= -8
            for region in data["profiles"]["qu"]["regions"]
        ))
        self.assertFalse(any(
            -84 <= region["center"][0] <= -32
            and -58 <= region["center"][1] <= 14
            for region in data["profiles"]["es"]["regions"]
        ))

        hausa = data["profiles"]["ha"]
        self.assertEqual(hausa["scope"], "hausa_belt")
        self.assertNotIn("official", hausa)
        self.assertTrue(any(region["center"][0] >= 30 for region in hausa["regions"]))
        igbo = data["profiles"]["ig"]
        self.assertEqual(igbo["scope"], "igbo_region")
        self.assertEqual(igbo["official"], [])

        nationwide_primary_languages = {
            "so": {"SO"},
            "sw": {"KE", "TZ"},
            "rw": {"RW"},
            "rn": {"BI"},
            "sn": {"ZW"},
            "sg": {"CF"},
            "mg": {"MG"},
            "wo": {"SN"},
            "bm": {"ML"},
        }
        for locale, expected_countries in nationwide_primary_languages.items():
            with self.subTest(nationwide_primary_locale=locale):
                countrywide = {
                    item for item in data["profiles"][locale]["countrywide"]
                    if isinstance(item, str)
                }
                self.assertTrue(expected_countries <= countrywide)

    def test_disputed_region_rules_use_supported_country_codes(self):
        path = COVERAGE.LANGUAGE_DISPUTED_REGIONS_PATH
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
        self.assertTrue(raw.endswith("\n"))
        self.assertNotIn('"coordinates": [\n', raw)
        self.assertNotRegex(raw, r'"[A-Za-z_]*countries": \[\n')
        self.assertEqual(data["type"], "FeatureCollection")
        features = data["features"]
        self.assertGreaterEqual(len(features), 70)
        wave_one_label_locales = {
            "en", "ja", "zh-hans", "zh-hant", "de", "fr", "es", "ko", "pt", "it", "ru",
        }
        for feature in features:
            with self.subTest(feature_name_schema=feature["properties"]["id"]):
                properties = feature["properties"]
                rule = properties["selection_rule"]
                self.assertIn("name", properties)
                self.assertEqual(set(properties["name"]), wave_one_label_locales)
                self.assertTrue(all(properties["name"].values()))
                self.assertNotIn("name_en", properties)
                self.assertNotIn("name_ja", properties)
                self.assertNotIn("name_long", properties)
                self.assertNotIn("label_en", rule)
                self.assertNotIn("label_ja", rule)
        rules = [feature["properties"]["selection_rule"] for feature in features]
        self.assertNotIn("B21", {rule["source_id"] for rule in rules})
        alhucemas = next(
            feature for feature in features
            if feature["properties"]["id"] == "D-B64"
        )
        self.assertEqual(alhucemas["properties"]["name"]["en"], "Alhucemas Islands")
        self.assertEqual(alhucemas["properties"]["name"]["ja"], "アルセマス諸島")
        map_data = json.loads(COVERAGE.LANGUAGE_MAP_PATH.read_text(encoding="utf-8"))
        viewpoint_groups = set(map_data.get("viewpoint_groups", {}))
        self.assertTrue(all(feature["geometry"]["type"] in {"Polygon", "MultiPolygon"} for feature in features))
        ilemi_rules = {
            rule["source_id"]: rule
            for rule in rules
            if rule["source_id"] in {"B17", "B74"}
        }
        self.assertEqual(set(ilemi_rules), {"B17", "B74"})
        for source_id, rule in ilemi_rules.items():
            with self.subTest(source_id=source_id):
                self.assertEqual(set(rule["countries"]), {"KE", "SS"})
                self.assertEqual(set(rule["party_countries"]), {"KE", "SS"})
                self.assertNotIn("SD", rule["countries"])
                self.assertNotIn("ET", rule["party_countries"])
                self.assertEqual(
                    rule["viewpoint_resolutions"],
                    [
                        {
                            "viewpoints": ["KE"],
                            "selection_countries": ["KE"],
                            "level": "administered",
                        },
                        {
                            "viewpoints": ["SS"],
                            "selection_countries": ["SS"],
                            "level": "administered",
                        },
                        {
                            "default": True,
                            "selection_countries": ["KE", "SS"],
                            "level": "observed",
                        },
                    ],
                )
        lawa_rule = next(rule for rule in rules if rule["source_id"] == "B14")
        self.assertEqual(lawa_rule["countries"], ["GF", "SR"])
        self.assertEqual(lawa_rule["admin_countries"], ["GF"])
        self.assertEqual(lawa_rule["party_countries"], ["GF", "SR"])
        japan_rules = {
            rule["source_id"]: rule
            for rule in rules
            if rule["source_id"] in {"B18", "B29", "B39"}
        }
        self.assertEqual(set(japan_rules), {"B18", "B29", "B39"})
        self.assertTrue(all(rule["countries"] == ["JP"] for rule in japan_rules.values()))
        self.assertEqual(japan_rules["B18"]["party_countries"], ["JP", "TW", "CN"])
        self.assertEqual(japan_rules["B18"]["admin_countries"], ["JP"])
        self.assertEqual(japan_rules["B29"]["party_countries"], ["JP", "RU"])
        self.assertEqual(japan_rules["B29"]["admin_countries"], ["RU"])
        self.assertEqual(japan_rules["B39"]["party_countries"], ["JP", "KR"])
        self.assertEqual(japan_rules["B39"]["admin_countries"], ["KR"])
        self.assertTrue(all("japan_preferred" not in rule for rule in rules))
        self_administered = {
            rule["source_id"]
            for rule in rules
            if rule.get("self_administered")
        }
        self.assertEqual(self_administered, {"B35", "B36", "B37", "C02", "C03"})
        israel_rule = next(rule for rule in rules if rule["source_id"] == "B91")
        self.assertEqual(israel_rule["countries"], ["IL"])
        self.assertEqual(israel_rule["party_countries"], ["IL"])
        palestinian_regions = {
            rule["source_id"]: rule
            for rule in rules
            if rule["source_id"] in {"B53", "B54"}
        }
        self.assertEqual(set(palestinian_regions), {"B53", "B54"})
        for rule in palestinian_regions.values():
            self.assertEqual(rule["countries"], ["PS"])
            self.assertEqual(rule["party_countries"], ["PS", "IL"])
            self.assertEqual(rule["admin_countries"], ["PS"])
        israel_claim_regions = {
            rule["source_id"]: rule
            for rule in rules
            if rule["source_id"] in {"B16", "B53", "B54", "B58", "B78", "B79", "B98", "B99"}
        }
        self.assertEqual(
            set(israel_claim_regions),
            {"B16", "B53", "B54", "B58", "B78", "B79", "B98", "B99"},
        )
        recognized_by_source = {
            "B16": "SY",
            "B53": "PS",
            "B54": "PS",
            "B58": "LB",
            "B78": "PS",
            "B79": "PS",
            "B98": "PS",
            "B99": "PS",
        }
        for source_id, rule in israel_claim_regions.items():
            with self.subTest(source_id=source_id):
                recognized_country = recognized_by_source[source_id]
                self.assertEqual(
                    rule["viewpoint_resolutions"],
                    [
                        {
                            "viewpoint_group": "israel_nonrecognizing_states",
                            "selection_countries": [recognized_country],
                            "level": "recognized",
                        }
                    ],
                )
                self.assertIn(
                    rule["viewpoint_resolutions"][0]["viewpoint_group"],
                    viewpoint_groups,
                )
        standalone_disputed = {
            rule["source_id"]: rule
            for rule in rules
            if rule["source_id"] in {"B12", "B22", "B32", "B33", "B55", "B69"}
        }
        self.assertEqual(standalone_disputed["B12"]["countries"], ["FK"])
        self.assertEqual(standalone_disputed["B55"]["countries"], ["GI"])
        self.assertEqual(standalone_disputed["B22"]["countries"], ["YT"])
        self.assertEqual(standalone_disputed["B69"]["countries"], ["IO"])
        for source_id in ("B32", "B33"):
            self.assertEqual(standalone_disputed[source_id]["countries"], ["GS"])
        ceuta_melilla = {
            rule["source_id"]: rule
            for rule in rules
            if rule["source_id"] in {"B60", "B61"}
        }
        self.assertEqual(set(ceuta_melilla), {"B60", "B61"})
        for rule in ceuta_melilla.values():
            self.assertEqual(rule["countries"], ["EA"])
            self.assertEqual(rule["admin_countries"], ["EA", "ES"])
            self.assertEqual(rule["party_countries"], ["EA", "ES", "MA"])
        north_borneo = next(
            feature for feature in features
            if feature["properties"]["selection_rule"]["source_id"] == "C04"
        )
        self.assertEqual(north_borneo["properties"]["name"]["en"], "Sabah (North Borneo)")
        self.assertEqual(north_borneo["properties"]["name"]["ja"], "サバ州（北ボルネオ）")
        configured_codes = set(json.loads(COVERAGE.LANGUAGE_MAP_PATH.read_text(encoding="utf-8"))["iso2_to_iso3"])
        for rule in rules:
            for target, viewpoints in rule.get(
                "party_equivalent_viewpoint_selections", {}
            ).items():
                self.assertIn(target, rule.get("party_countries", rule["countries"]))
                self.assertTrue(viewpoints)
                self.assertTrue(set(viewpoints) <= configured_codes)
        referenced_codes = {
            code
            for rule in rules
            for key in (
                "countries",
                "party_countries",
                "admin_countries",
                "claim_only_countries",
            )
            for code in rule.get(key, [])
        }
        self.assertFalse(referenced_codes - configured_codes)

    def test_registered_locales_have_complete_localized_descriptions(self):
        config = json.loads(COVERAGE.CONFIG_PATH.read_text(encoding="utf-8"))
        locales = {item["locale"] for item in COVERAGE.hub.locales_config()["locales"]}
        expected_directional_names = {
            "kmr": "北部クルド語（クルマンジー）",
            "nr": "南ンデベレ語",
            "nso": "北部ソト語（セペディ）",
            "sdh": "南部クルド語",
            "st": "南部ソト語",
        }
        for locale, expected_name in expected_directional_names.items():
            self.assertEqual(
                localized_language("ja", locale)["name"],
                expected_name,
            )
        self.assertEqual(localized_language("ja", "tet")["name"], "テトゥン語")
        summarized = []
        generic_restatements = (
            "全国主要言語として使われます",
            "公用語または地域言語として使われます",
            "定住話者コミュニティで使われます",
            "語族に属する言語です",
            "語派に属する言語です",
        )
        for locale in locales:
            summary_ja = localized_language("ja", locale).get("summary")
            summary_en = localized_language("en", locale).get("summary")
            with self.subTest(locale=locale):
                self.assertTrue(summary_ja)
                self.assertTrue(summary_en)
                self.assertGreaterEqual(len(summary_ja), 50)
                self.assertGreaterEqual(len(summary_en), 120)
                self.assertNotRegex(summary_ja, r"[A-Za-z]{2,}")
                for text in generic_restatements:
                    self.assertNotIn(text, summary_ja)
                self.assertNotRegex(
                    summary_ja,
                    r"^(?:主に|[^。]+を中心に)[^。]*(?:使われます|使われています)。$",
                )
                summarized.append(locale)
        self.assertEqual(set(summarized), locales)
        pt_summary = localized_language("ja", "pt_PT")["summary"]
        nl_summary = localized_language("ja", "nl_NL")["summary"]
        self.assertIn("植民地支配", pt_summary)
        self.assertIn("広がり", pt_summary)
        self.assertNotIn("全国主要言語として使われます", pt_summary)
        self.assertIn("スリナム", nl_summary)
        self.assertIn("植民地統治", nl_summary)
        self.assertIn("アフリカーンス語", nl_summary)

    def test_language_families_cover_every_registered_locale_once(self):
        config = json.loads(COVERAGE.CONFIG_PATH.read_text(encoding="utf-8"))
        locales = {
            item["locale"]
            for item in COVERAGE.hub.locales_config()["locales"]
            if COVERAGE.hub.locale_enabled(item)
        }
        family_members = []
        canonical_terms = set(map_localization("en")["taxonomy"]["families"]["labels"])
        for family in config["language_families"]:
            with self.subTest(family=family["id"]):
                self.assertTrue(family["id"])
                self.assertTrue(family["taxonomy"])
                self.assertLessEqual(
                    {term.strip() for term in family["taxonomy"].split("›")},
                    canonical_terms,
                )
                self.assertTrue(family["members"])
                family_members.extend(family["members"])
        self.assertEqual(len(family_members), len(set(family_members)))
        self.assertEqual(set(family_members), locales)

    def test_family_notes_explain_structure_instead_of_repeating_the_map_or_members(self):
        config = json.loads(COVERAGE.CONFIG_PATH.read_text(encoding="utf-8"))
        japanese = map_localization("ja")["taxonomy"]
        english = map_localization("en")["taxonomy"]
        taxonomy_paths = [item["taxonomy"] for item in config["language_families"]]
        selectable_terms = {
            term.strip()
            for path in taxonomy_paths
            for term in path.split("›")
            if term.strip()
        }
        japanese_notes = japanese["families"]["descriptions"]
        english_notes = english["families"]["descriptions"]
        self.assertLessEqual(selectable_terms, set(japanese_notes))
        self.assertEqual(set(japanese_notes), set(english_notes))
        self.assertEqual(set(japanese_notes), set(japanese["families"]["labels"]))
        self.assertEqual(set(english_notes), set(english["families"]["labels"]))
        self.assertTrue(all(len(note) >= 45 for note in japanese_notes.values()))
        for note in japanese_notes.values():
            self.assertNotIn("を含みます", note)
            self.assertNotIn("に分布", note)
            self.assertNotIn("この一覧", note)
        for note in english_notes.values():
            self.assertNotIn(" includes ", note)
            self.assertNotIn(" distributed ", note)
            self.assertNotIn("this catalog", note.casefold())

    def test_script_notes_explain_history_and_structure_without_repeating_the_ui(self):
        japanese_taxonomy = map_localization("ja")["taxonomy"]
        english_taxonomy = map_localization("en")["taxonomy"]
        japanese_notes = japanese_taxonomy["scripts"]["descriptions"]
        english_notes = english_taxonomy["scripts"]["descriptions"]
        expected_scripts = {
            "Arab", "Armn", "Beng", "Cyrl", "Deva", "Ethi", "Geor",
            "Cans", "Grek", "Gujr", "Guru", "Hang", "Hani", "Hans", "Hant",
            "Hebr", "Hira", "Hrkt", "Jpan", "Kana", "Khmr", "Knda", "Kore",
            "Laoo", "Latn", "Mlym", "Mymr", "Olck", "Orya", "Sinh", "Taml",
            "Telu", "Tfng", "Thaa", "Thai", "Tibt", "Zinh", "Zyyy", "Zzzz",
        }
        self.assertEqual(set(japanese_taxonomy["scripts"]["labels"]), expected_scripts)
        self.assertEqual(set(english_taxonomy["scripts"]["labels"]), expected_scripts)
        self.assertEqual(set(japanese_notes), expected_scripts)
        self.assertEqual(set(english_notes), expected_scripts)
        descriptive_scripts = expected_scripts - {"Zinh", "Zyyy", "Zzzz"}
        self.assertTrue(all(len(japanese_notes[script]) >= 90 for script in descriptive_scripts))
        self.assertTrue(all(len(english_notes[script]) >= 220 for script in descriptive_scripts))
        self.assertIn("アブギダ", japanese_notes["Mymr"])
        self.assertIn("アブギダ", japanese_notes["Telu"])
        self.assertIn("万葉仮名の草書体", japanese_notes["Hira"])
        self.assertIn("比較的珍しい", japanese_notes["Hrkt"])
        self.assertIn("ローマ帝国", japanese_notes["Latn"])
        self.assertIn("最大規模", japanese_notes["Latn"])
        self.assertIn("イスラム教", japanese_notes["Arab"])
        self.assertIn("アラビア語以外の大規模言語", japanese_notes["Arab"])
        self.assertIn("3番目の規模", japanese_notes["Arab"])
        self.assertIn("4番目の規模", japanese_notes["Deva"])
        self.assertIn("5番目", japanese_notes["Beng"])
        self.assertIn("世界でも特に利用人口の多い", japanese_notes["Beng"])
        self.assertNotIn("日本での知名度", japanese_notes["Beng"])
        self.assertIn("アラビア・インド数字", japanese_notes["Thaa"])
        self.assertIn("アブジャドではなく", japanese_notes["Thaa"])
        self.assertIn("ジェームズ・エヴァンズ", japanese_notes["Cans"])
        self.assertIn("基本字形を回転", japanese_notes["Cans"])
        self.assertIn("帝国アラム文字", japanese_notes["Hebr"])
        self.assertIn("マソラ学者", japanese_notes["Hebr"])
        self.assertIn("母音専用の字母", japanese_notes["Grek"])
        self.assertIn("メスロプ・マシュトツ", japanese_notes["Armn"])
        self.assertIn("アソムタヴルリ", japanese_notes["Geor"])
        self.assertIn("南セム系の子音文字", japanese_notes["Ethi"])
        self.assertIn("グル・アンガド", japanese_notes["Guru"])
        self.assertIn("1970〜80年代", japanese_notes["Mlym"])
        self.assertIn("前鼻音化閉鎖音", japanese_notes["Sinh"])
        self.assertIn("二系列", japanese_notes["Khmr"])
        self.assertIn("1960年ごろ", japanese_notes["Laoo"])
        self.assertIn("形態音韻", japanese_notes["Olck"])
        self.assertIn("ソンツェン・ガンポ", japanese_notes["Tibt"])
        self.assertIn("IRCAM", japanese_notes["Tfng"])
        self.assertIn("正教会", japanese_notes["Cyrl"])
        self.assertIn("ロシア帝国・ソ連期", japanese_notes["Cyrl"])
        self.assertIn("6番目の規模", japanese_notes["Cyrl"])
        self.assertIn("7位前後の規模", japanese_notes["Hira"])
        self.assertIn("7位前後の規模", japanese_notes["Kana"])
        self.assertIn("8位前後の規模", japanese_notes["Telu"])
        self.assertIn("9位前後の規模", japanese_notes["Taml"])
        self.assertIn("10位前後の規模", japanese_notes["Hang"])
        self.assertIn("10位前後の規模", japanese_notes["Kore"])
        self.assertIn("朝鮮王朝の世宗", japanese_notes["Hang"])
        self.assertIn("1446年", japanese_notes["Hang"])
        self.assertIn("『訓民正音』", japanese_notes["Hang"])
        self.assertIn("世界でも珍しい仕組み", japanese_notes["Hang"])
        self.assertNotIn("位", japanese_notes["Jpan"])
        self.assertIn("表語文字（いわゆる表意文字）", japanese_notes["Hani"])
        self.assertIn("2番目の規模", japanese_notes["Hani"])
        self.assertIn("中国語では原則として一字が一音節", japanese_notes["Hani"])
        self.assertIn("日本語では音読み・訓読み", japanese_notes["Hani"])
        self.assertNotIn("形態素と音節に対応", japanese_notes["Hani"])
        self.assertIn("European expansion", english_notes["Latn"])
        self.assertIn("spread with Islam", english_notes["Arab"])
        self.assertIn("major languages beyond Arabic", english_notes["Arab"])
        self.assertIn("Orthodox Christianity", english_notes["Cyrl"])
        self.assertIn("Soviet administration", english_notes["Cyrl"])
        self.assertIn("In Chinese", english_notes["Hani"])
        self.assertIn("in Japanese", english_notes["Hani"])
        for note in japanese_notes.values():
            self.assertNotIn("当プロジェクト調べ", note)
            self.assertNotIn("この一覧の言語で使われる", note)
            self.assertNotIn("ISO 15924", note)
        for note in english_notes.values():
            self.assertNotIn("used by languages in this catalog", note.casefold())
            self.assertNotIn("ISO 15924", note)

    def test_speaker_estimates_cover_every_catalog_locale(self):
        data = COVERAGE.speaker_estimates.build_catalog()
        locales = {item["locale"] for item in COVERAGE.hub.locales_config()["locales"]}
        metadata = json.loads(
            COVERAGE.LANGUAGE_ATLAS_METADATA_PATH.read_text(encoding="utf-8")
        )
        profile_codes = set(metadata["profiles"])
        self.assertEqual(locales | profile_codes, set(data["estimates"]))
        atlas_estimates = {
            "ba": 1830673,
            "rif": 2045261,
            "rif-Tfng": 1831992,
            "shi": 3252721,
            "shi-Latn": 3252721,
        }
        self.assertEqual(
            {code: data["estimates"][code] for code in atlas_estimates},
            atlas_estimates,
        )
        self.assertEqual(data["schema"], 2)
        self.assertEqual(data["source"]["version"], "48.2.0")
        self.assertEqual(data["source"]["cldr_version"], "48")
        self.assertTrue(data["source"]["url"].startswith("https://unicode.org/cldr/"))
        self.assertEqual(data["resolution"]["fa_AF"], "territory:AF/fa")
        self.assertEqual(data["resolution"]["pa_PK"], "global:pa_Arab")
        self.assertEqual(data["resolution"]["kmr"], "manual")
        self.assertEqual(data["unsupported_codes"], ["eo", "fkv", "la"])
        self.assertNotIn("speaker_estimate", metadata["profiles"]["ba"])
        for locale, estimate in data["estimates"].items():
            with self.subTest(locale=locale):
                self.assertTrue(estimate is None or (isinstance(estimate, int) and estimate > 0))

    def test_every_atlas_only_language_has_an_explicit_native_name(self):
        runtime = (ROOT / "tools" / "browser" / "language-atlas-access.js").read_text(
            encoding="utf-8"
        )

        def table_codes(constant_name):
            match = re.search(
                rf"const {constant_name} = Object\.freeze\(\{{(.*?)\n\s*\}}\);",
                runtime,
                re.DOTALL,
            )
            self.assertIsNotNone(match)
            return set(re.findall(r"'([^']+)'", match.group(1)))

        atlas_codes = (
            table_codes("BASE_ESTABLISHED_LANGUAGES_BY_COUNTRY")
            | table_codes("CURATED_REGIONAL_LANGUAGES_BY_COUNTRY")
            | table_codes("ECRML_LANGUAGES_BY_COUNTRY")
            | table_codes("RESIDENT_LANGUAGES_BY_COUNTRY")
            | {"en"}
        )
        catalog_forms = set()
        catalog_bases = set()
        for item in COVERAGE.hub.locales_config()["locales"]:
            forms = {
                item["locale"].replace("_", "-").casefold(),
                COVERAGE.hub.public_locale_identity(item).replace("_", "-").casefold(),
            }
            catalog_forms.update(forms)
            catalog_bases.update(form.split("-", 1)[0] for form in forms)
        atlas_only = {
            code for code in atlas_codes
            if (
                code.replace("_", "-").casefold() not in catalog_forms
                and (
                    "-" in code.replace("_", "-")
                    or code.replace("_", "-").casefold() not in catalog_bases
                )
            )
        }
        native_names = linguistic_catalog()["native_names"]
        self.assertLessEqual(atlas_only, set(native_names))
        self.assertEqual(native_names["yap"], "Thin nu Waqaab")
        self.assertEqual(native_names["zdj"], "Shingazidja")
        self.assertEqual(native_names["yue-Hans"], "粤语 (简体)")

    def test_language_name_aliases_reuse_the_source_name_without_changing_identity(self):
        overrides = COVERAGE.linguistic_names._validated_overrides()
        aliases = overrides["language_name_aliases"]
        self.assertEqual(aliases["pt_PT"], "pt")
        for locale in ("ja", "en", "pt-PT"):
            pack = COVERAGE.linguistic_names.build_locale_pack(locale)
            source_locale = pack["source_locale"]
            source_names = COVERAGE.linguistic_names._locale_table(
                source_locale, "languages.json", "languages"
            )
            self.assertEqual(
                pack["languages"]["pt_PT"]["name"],
                source_names["pt"],
            )

    def test_effective_countrywide_map_languages_are_recoverable_from_the_catalog(self):
        locales_config = COVERAGE.hub.locales_config()
        catalog_languages = {
            item["locale"].replace("_", "-").split("-")[0]
            for item in locales_config["locales"]
        }
        alias_languages = {
            locale.replace("_", "-").split("-")[0]
            for locale in locales_config.get("aliases", {})
        }
        map_only_languages = {
            locale.replace("_", "-").split("-")[0]
            for locale, localized in (map_localization("ja").get("languages") or {}).items()
            if localized.get("summary")
        }
        runtime = (ROOT / "tools" / "browser" / "language-atlas-access.js").read_text(
            encoding="utf-8"
        )
        def parse_country_languages(constant_name):
            match = re.search(
                rf"const {constant_name} = Object\.freeze\(\{{(.*?)\n\s*\}}\);",
                runtime,
                re.DOTALL,
            )
            self.assertIsNotNone(match)
            return {
                country: re.findall(r"'([^']+)'", values)
                for country, values in re.findall(
                    r"\b([A-Z]{2}):\s*\[([^\]]*)\]",
                    match.group(1),
                )
            }

        established = parse_country_languages("BASE_ESTABLISHED_LANGUAGES_BY_COUNTRY")
        overrides = parse_country_languages("COUNTRYWIDE_LANGUAGE_OVERRIDES_BY_COUNTRY")
        countrywide_languages = {
            locale.replace("_", "-").split("-")[0]
            for country, languages in established.items()
            for locale in overrides.get(country, languages[:1])
        }
        self.assertLessEqual(
            countrywide_languages,
            catalog_languages | alias_languages | map_only_languages,
        )

    def test_representative_core_regions_are_country_codes(self):
        config = json.loads(COVERAGE.CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertEqual(
            config["representative_core_regions"]["en"],
            ["US", "GB", "CA", "AU", "NZ"],
        )
        self.assertEqual(
            config["representative_core_regions"]["fr"],
            ["FR", "CD", "CA", "BE", "CH"],
        )
        self.assertEqual(
            config["representative_core_regions"]["es"],
            ["ES", "MX", "AR", "CO", "PE"],
        )
        self.assertEqual(
            config["representative_core_regions"]["tr"],
            ["TR", "CY", "BG", "IQ", "GR"],
        )
        for language, countries in config["representative_core_regions"].items():
            self.assertTrue(language)
            self.assertTrue(countries)
            self.assertEqual(len(countries), len(set(countries)))
            self.assertTrue(all(len(country) == 2 and country.isupper() for country in countries))

    def test_ui_catalog_matches_enabled_locales_and_schema(self):
        ui = json.loads(COVERAGE.UI_MESSAGES_PATH.read_text(encoding="utf-8"))
        self.assertEqual(ui["schema"], 3)
        self.assertGreater(ui["version"], 0)
        self.assertNotIn("notice_policy", ui)

        locale_ids = [item["id"] for item in ui["locales"]]
        configured_ids = set(locale_ids)
        self.assertEqual(len(locale_ids), len(configured_ids))
        for item in ui["locales"]:
            with self.subTest(locale_metadata=item.get("id")):
                self.assertIsInstance(item.get("id"), str)
                self.assertTrue(item["id"].strip())
                self.assertIsInstance(item.get("label"), str)
                self.assertTrue(item["label"].strip())
                self.assertIn(item.get("direction", "ltr"), {"ltr", "rtl"})

        registry = [
            item
            for item in COVERAGE.hub.locales_config()["locales"]
            if COVERAGE.hub.locale_enabled(item)
        ]
        expected_ids = {
            COVERAGE._coverage_ui_locale_id(item, configured_ids)
            for item in registry
        }
        self.assertLessEqual(configured_ids, expected_ids)
        self.assertEqual(set(ui["messages"]), configured_ids)

        directions = {item["id"]: item.get("direction", "ltr") for item in ui["locales"]}
        expected_directions = {
            COVERAGE._coverage_ui_locale_id(item, configured_ids): COVERAGE.hub.locale_direction(item)
            for item in registry
            if COVERAGE._coverage_ui_locale_id(item, configured_ids) in configured_ids
        }
        self.assertEqual(directions, expected_directions)

        self.assertNotIn("fallback_locales", ui)
        global_fallbacks = COVERAGE.hub.locales_config().get("fallback_locales") or {}
        self.assertEqual(global_fallbacks["as_IN"], "bn_BD")
        self.assertEqual(global_fallbacks["pa_IN"], "hi_IN")
        self.assertEqual(global_fallbacks["uz_UZ"], "ru_RU")
        fallback_locales = COVERAGE.hub.locale_fallbacks_for_catalog(configured_ids)
        self.assertEqual(
            {
                locale: fallback_locales[locale]
                for locale in ("ay", "qu", "ln", "rn", "tet", "jv", "lo", "kk", "pa-Arab")
            },
            {
                "ay": "es",
                "qu": "es",
                "ln": "fr",
                "rn": "fr",
                "tet": "pt-PT",
                "jv": "id",
                "lo": "th",
                "kk": "ru",
                "pa-Arab": "ur",
            },
        )
        for locale, fallback in fallback_locales.items():
            with self.subTest(fallback_locale=locale):
                self.assertIn(locale, configured_ids)
                self.assertIn(fallback, configured_ids)
                self.assertNotEqual(locale, fallback)
                seen = set()
                current = locale
                while current in fallback_locales:
                    self.assertNotIn(current, seen)
                    seen.add(current)
                    current = fallback_locales[current]

        required_ui = {"allTitle", "sortName"}
        for locale in locale_ids:
            with self.subTest(locale=locale):
                messages = ui["messages"][locale]
                self.assertLessEqual(required_ui, set(messages))
                self.assertNotIn("core", messages)
                self.assertNotIn("coreLegend", messages)
                self.assertNotIn("countrywide", messages)
                self.assertNotIn("projectionAuto", messages)
                self.assertNotIn("allCopy", messages)
                for key, value in messages.items():
                    self.assertIsInstance(key, str)
                    self.assertTrue(key)
                    self.assertIsInstance(value, str)
                    self.assertTrue(value.strip())

        map_ja = map_localization("ja")["messages"]
        map_en = map_localization("en")["messages"]
        retired_map_messages = {
            "countryPlaceholder",
            "neighborCountrywide",
            "neighborOfficial",
            "loading",
            "unavailable",
            "scripts",
            "families",
            "nonLatin",
            "locales",
        }
        for locale in locale_ids:
            with self.subTest(retired_map_messages=locale):
                self.assertTrue(
                    retired_map_messages.isdisjoint(
                        map_localization(locale)["messages"]
                    )
                )
        self.assertEqual(map_ja["official"], "公用")
        self.assertEqual(map_ja["regional"], "地域")
        self.assertEqual(map_ja["protected"], "少数")
        self.assertEqual(map_ja["neighbor"], "隣接")
        self.assertEqual(map_en["official"], "Official")
        self.assertEqual(map_en["regional"], "Regional")
        self.assertEqual(map_en["protected"], "Protected")
        self.assertEqual(map_en["neighbor"], "Neighboring")
        self.assertEqual(map_ja["countryTitle"], "世界の言語地図")
        self.assertEqual(map_en["countryTitle"], "World language map")
        self.assertNotIn("言語選択欄", map_ja["countryCopy"])
        self.assertNotIn("language selector", map_en["countryCopy"])
        self.assertNotIn("翻訳対応", map_ja["countryCopy"])
        self.assertNotIn("translation", map_en["countryCopy"].casefold())

        map_policy = json.loads(COVERAGE.CONFIG_PATH.read_text(encoding="utf-8"))[
            "map_ui_localization"
        ]
        map_ui_locales = set(map_policy["locales"])
        self.assertTrue(map_ui_locales)
        self.assertLessEqual(map_ui_locales, configured_ids)
        required_map_keys = set(map_en)
        placeholder_pattern = re.compile(r"\{([A-Za-z][A-Za-z0-9_]*)\}")
        self.assertEqual(set(map_ja), required_map_keys)
        for locale in configured_ids:
            messages = map_localization(locale)["messages"]
            if locale not in map_ui_locales:
                with self.subTest(fallback_map_messages=locale):
                    self.assertEqual(messages, {})
                continue
            with self.subTest(complete_map_messages=locale):
                self.assertEqual(set(messages), required_map_keys)
                for key in required_map_keys:
                    self.assertTrue(
                        isinstance(messages[key], str) and messages[key].strip(),
                        f"{locale}:{key} must be a non-empty string",
                    )
                    self.assertNotIn(
                        "\n", messages[key], f"{locale}:{key} must stay on one line"
                    )
                    self.assertIsNone(
                        re.search(r";(?=\S)|\.(?=[^\W\d_])|\.(?=\{)", messages[key]),
                        f"{locale}:{key} has joined clauses or sentences",
                    )
                    if re.search(r"\d", map_en[key]) is None:
                        self.assertIsNone(
                            re.search(r"\d", messages[key]),
                            f"{locale}:{key} introduced an unrelated number",
                        )
                    self.assertEqual(
                        sorted(placeholder_pattern.findall(messages[key])),
                        sorted(placeholder_pattern.findall(map_en[key])),
                        key,
                    )
                self.assertNotEqual(messages["zoomOut"], messages["zoomIn"])
                self.assertNotEqual(
                    messages["movementPlanar"], messages["movementGlobe"]
                )
                orientation_labels = {
                    messages[key]
                    for key in (
                        "orientationNorthUp",
                        "orientationNortheastUp",
                        "orientationEastUp",
                        "orientationSoutheastUp",
                        "orientationSouthUp",
                        "orientationSouthwestUp",
                        "orientationWestUp",
                        "orientationNorthwestUp",
                    )
                }
                self.assertEqual(len(orientation_labels), 8)
                projection_labels = {
                    messages[key]
                    for key in (
                        "projectionAuto",
                        "projectionAzimuthal",
                        "projectionAzimuthalEquidistant",
                        "projectionStereographic",
                        "projectionGnomonic",
                        "projectionConicEqualArea",
                        "projectionConicConformal",
                        "projectionConicEquidistant",
                        "projectionEquirectangular",
                        "projectionOrthographic",
                        "projectionEqualEarth",
                        "projectionNaturalEarth1",
                        "projectionMercator",
                        "projectionTransverseMercator",
                    )
                }
                self.assertEqual(len(projection_labels), 14)
                self.assertNotIn("countrywideLegend", messages)
                self.assertNotIn("regionalLegend", messages)
                if locale != "en":
                    self.assertIn("Shift", messages["shiftGestureHint"])
                    self.assertIn("Ctrl/⌘", messages["rollGestureHint"])

        self.assertEqual(map_ja["searchPlaceholder"], "言語名・コード")
        self.assertEqual(map_en["searchPlaceholder"], "Language name or code")
        self.assertEqual(map_ja["noMatchingLocales"], "該当する言語はありません")
        self.assertEqual(map_en["noMatchingLocales"], "No matching languages")
        self.assertEqual(map_ja["goToViewpointCountry"], "検出された国へ移動: {country}")
        for key in {
            "clearCountrySelection", "clearLanguageSelection", "clearFamilySelection",
            "clearScriptSelection", "backTo", "preparingSuggestions", "showMoreLanguages",
            "mapLoading", "mapUnavailable", "variants", "representativeCountries",
            "languagesUsingScript", "languagesInGroup", "moreLanguages",
            "groupCountriesByRole", "taxonomyDescriptionPending", "usageSummary",
        }:
            self.assertIn(key, required_map_keys)

    def test_selectable_ui_taxonomy_uses_sparse_non_english_fallbacks(self):
        ui = json.loads(COVERAGE.UI_MESSAGES_PATH.read_text(encoding="utf-8"))
        english_terms = set(map_localization("en")["taxonomy"]["families"]["labels"])
        expected_locales = {item["id"] for item in ui["locales"]}
        self.assertEqual(
            set(map_copy_localizations()),
            expected_locales,
        )
        for locale in expected_locales:
            terms = map_localization(locale)["taxonomy"]["families"]["labels"]
            with self.subTest(locale=locale):
                self.assertLessEqual(set(terms), english_terms)
                self.assertTrue(all(terms.values()))
                self.assertEqual(
                    len(terms),
                    len({translation.casefold() for translation in terms.values()}),
                    f"{locale} must not collapse distinct language families",
                )
                self.assertTrue(
                    all("\n" not in translation for translation in terms.values())
                )
                if locale in {"ja", "en"}:
                    self.assertEqual(set(terms), english_terms)
                if locale != "en":
                    self.assertFalse({
                        term
                        for term, translation in terms.items()
                        if term.casefold() == translation.casefold()
                    })

    def test_kven_has_curated_identity_family_and_explanation(self):
        metadata = json.loads(
            COVERAGE.LANGUAGE_ATLAS_METADATA_PATH.read_text(encoding="utf-8")
        )
        profile = metadata["profiles"]["fkv"]
        localized = localized_language("ja", "fkv")
        self.assertEqual(profile["english_name"], "Kven")
        self.assertEqual(localized["name"], "クヴェン語")
        self.assertEqual(profile["native_name"], "kvääni")
        self.assertEqual(profile["family_en"], "Uralic › Finnic")
        self.assertGreaterEqual(localized["summary"].count("。"), 2)
        self.assertIn("トロムス・フィンマルク", localized["summary"])
        self.assertIn("メアンキエリ", localized["summary"])
        self.assertIn("少数言語", localized["summary"])
        self.assertNotEqual(
            localized["summary"],
            "ノルウェーで公用語または地域言語として使われます。",
        )
        grouped_codes = [
            code
            for codes in metadata["family_groups"].values()
            for code in codes
        ]
        self.assertEqual(len(grouped_codes), len(set(grouped_codes)))
        self.assertGreaterEqual(len(grouped_codes), 200)
        facts_ja = {
            code: localized_language("ja", code).get("summary") for code in grouped_codes
        }
        self.assertTrue(all(facts_ja.values()))
        self.assertTrue(all(fact.endswith("。") for fact in facts_ja.values()))
        self.assertTrue(all("語族" not in fact for fact in facts_ja.values()))
        self.assertGreaterEqual(facts_ja["se"].count("。"), 2)
        self.assertEqual(metadata["profiles"]["se"]["native_name"], "davvisámegiella")
        self.assertEqual(metadata["profiles"]["smn"]["native_name"], "anarâškielâ")
        self.assertEqual(metadata["profiles"]["sms"]["native_name"], "sääʹmǩiõll")

    def test_language_family_metadata_exposes_verified_iso_639_5_codes(self):
        metadata = json.loads(
            COVERAGE.LANGUAGE_ATLAS_METADATA_PATH.read_text(encoding="utf-8")
        )
        self.assertEqual(metadata["family_code_source"]["title"], "ISO 639-5")
        self.assertEqual(metadata["family_code_source"]["authority"], "Library of Congress")
        codes = metadata["family_iso_639_5"]
        self.assertEqual(codes["Indo-European"], "ine")
        self.assertEqual(codes["Germanic"], "gem")
        self.assertEqual(codes["Romance"], "roa")
        self.assertEqual(codes["Niger-Congo"], "nic")
        self.assertTrue(all(re.fullmatch(r"[a-z]{3}", code) for code in codes.values()))
        self.assertEqual(len(codes), len(set(codes.values())))

    def test_traditional_mongolian_variant_has_native_display_name(self):
        metadata = json.loads(
            COVERAGE.LANGUAGE_ATLAS_METADATA_PATH.read_text(encoding="utf-8")
        )
        self.assertEqual(metadata["profiles"]["mn-Mong"]["native_name"], "ᠮᠣᠩᠭᠣᠯ")

    def test_access_only_intl_fallbacks_have_curated_identity_data(self):
        metadata = COVERAGE.build_snapshot()["atlas_language_metadata"]
        expected = {
            "ba": ("Bashkir", "башҡорт", "Turkic", 1830673),
            "rif-Tfng": ("Riffian (Tifinagh)", "ⵜⴰⵔⵉⴼⵉⵜ", "Afro-Asiatic › Berber", 1831992),
            "shi-Latn": ("Tachelhit (Latin)", "Tashelḥiyt", "Afro-Asiatic › Berber", 3252721),
        }
        for code, values in expected.items():
            with self.subTest(code=code):
                profile = metadata["profiles"][code]
                self.assertEqual(
                    (profile["english_name"], profile["native_name"], profile["family_en"], profile["speaker_estimate"]),
                    values,
                )
                self.assertTrue(profile["source_urls"])

    def test_taxonomy_selection_includes_access_only_language_members(self):
        metadata = json.loads(
            COVERAGE.LANGUAGE_ATLAS_METADATA_PATH.read_text(encoding="utf-8")
        )
        access_runtime = (
            ROOT / "tools" / "browser" / "language-atlas-access.js"
        ).read_text(encoding="utf-8")
        self.assertIn("za", metadata["family_groups"]["Kra-Dai"])
        self.assertIn("nod", metadata["family_groups"]["Kra-Dai"])
        self.assertIn("TH: ['th', 'tts', 'nod', 'sou', 'mfa']", access_runtime)
        self.assertIn("TH: ['tts', 'nod', 'sou', 'mfa', 'ms', 'km', 'lo']", access_runtime)

    def test_template_version_markers_appear_once(self):
        template = COVERAGE.TEMPLATE_PATH.read_text(encoding="utf-8")
        for marker in (
            "__COVERAGE_VERSION__",
            "__ATLAS_UI_VERSION__",
            "__LANGUAGE_MAP_VERSION__",
            "__LANGUAGE_MAP_RUNTIME_VERSION__",
            "__LOCALE_RESOLUTION_VERSION__",
            "__LANGUAGE_ATLAS_ACCESS_VERSION__",
        ):
            self.assertEqual(template.count(marker), 1)
        self.assertNotIn(
            "toponym-resolution/runtime.js",
            COVERAGE.LANGUAGE_MAP_RUNTIME_PATH.read_text(encoding="utf-8"),
        )
        self.assertEqual(
            COVERAGE.LANGUAGE_MAP_RUNTIME_PATH.read_text(encoding="utf-8").count(
                "__LOCALE_RESOLUTION_VERSION__"
            ),
            1,
        )

    def test_render_writes_standalone_page_and_json(self):
        snapshot = {
            "generated_at": "2026-08-26T00:00:00+00:00",
            "revision": "test",
            "summary": {},
            "locales": [{
                "locale": "xh",
                "slug": "xh",
                "state": "localized",
                "review": {"unused_history": [1, 2, 3]},
                "docs": {"fresh": 99},
            }],
            "ui_locales": [{"id": "xh", "label": "isiXhosa"}],
            "ui_fallback_locales": {"xh": "en"},
            "ui_messages": {"xh": {"show": "Bonisa"}},
            "atlas_ui_version": 1,
            "map_localizations": {
                "xh": {
                    "schema": 1,
                    "version": 1,
                    "locale": "xh",
                    "messages": {"countrywide": "Ilizwe lonke"},
                    "country_names": {"CN": "test-cn-policy-override"},
                    "taxonomy": {
                        "families": {
                            "labels": {"Indo-European": "Indo-Yurophu"},
                            "descriptions": {},
                        },
                        "scripts": {"labels": {}, "descriptions": {}},
                    },
                },
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            for legacy in (
                output / "map-i18n",
                output / "map-descriptions",
                output / "map-geography" / "locales",
                output / "map-linguistics" / "locales",
            ):
                legacy.mkdir(parents=True, exist_ok=True)
                (legacy / "stale.json").write_text("{}\n", encoding="utf-8")
            COVERAGE.render(snapshot, output)
            html = (output / "index.html").read_text(encoding="utf-8")
            payload = json.loads((output / "coverage.json").read_text(encoding="utf-8"))
            map_payload = json.loads((output / "language-map.json").read_text(encoding="utf-8"))
            map_runtime = (
                output / "assets" / "javascripts" / "language-distribution-map.js"
            ).read_text(encoding="utf-8")
            toponym_runtime = (
                output / "assets" / "javascripts" / "toponym-resolution" / "runtime.js"
            )
            locale_chunk = (output / "map-locales" / "xh.json.gz").read_bytes()
            localization = json.loads(gzip.decompress(locale_chunk).decode("utf-8"))
            self.assertEqual(
                locale_chunk,
                gzip.compress(gzip.decompress(locale_chunk), compresslevel=9, mtime=0),
            )
            self.assertFalse((output / "map-i18n").exists())
            self.assertFalse((output / "map-descriptions").exists())
            self.assertFalse((output / "map-geography" / "locales").exists())
            self.assertFalse((output / "map-linguistics" / "locales").exists())
            map_vendor_files = {
                path.name
                for path in (output / "assets" / "javascripts" / "vendor" / "map").iterdir()
            }

        for marker in (
            "__COVERAGE_VERSION__",
            "__ATLAS_UI_VERSION__",
            "__LANGUAGE_MAP_VERSION__",
            "__LANGUAGE_MAP_RUNTIME_VERSION__",
            "__LOCALE_RESOLUTION_VERSION__",
            "__LANGUAGE_ATLAS_ACCESS_VERSION__",
        ):
            self.assertNotIn(marker, html)
        self.assertNotIn("__LOCALE_RESOLUTION_VERSION__", map_runtime)
        self.assertNotIn("__TOPONYM_RESOLUTION_VERSION__", map_runtime)
        self.assertFalse(toponym_runtime.exists())
        self.assertNotIn("toponym-resolution/runtime.js", map_runtime)
        self.assertNotIn("ATLAS_COVERAGE", html)
        self.assertEqual(html.count('id="atlas-host-after-catalog"'), 1)
        self.assertIn("data-atlas-host-language-labels", html)
        self.assertRegex(html, r'fetch\("\./coverage\.json\?v=[0-9a-f]{12}"')
        self.assertEqual(map_payload["schema"], 1)
        self.assertEqual(
            payload,
            {
                "generated_at": snapshot["generated_at"],
                "revision": snapshot["revision"],
                "locales": [{"locale": "xh", "slug": "xh", "state": "localized"}],
                "ui_locales": [{"id": "xh", "label": "isiXhosa"}],
                "ui_fallback_locales": {"xh": "en"},
                "ui_messages": {"xh": {"show": "Bonisa"}},
                "atlas_ui_version": 1,
                "map_locale_bundle_version": payload["map_locale_bundle_version"],
                "map_localization_locales": ["xh"],
                "map_linguistics_core_version": payload["map_linguistics_core_version"],
                "map_ui_locales": ["xh"],
                "map_place_assets": payload["map_place_assets"],
                "map_toponym_resolution": payload["map_toponym_resolution"],
                "speaker_estimate_source": {"title": ""},
            },
        )
        self.assertRegex(payload["map_locale_bundle_version"], r"^[0-9a-f]{12}$")
        self.assertEqual(
            localization["i18n"],
            {
                "schema": 1,
                "version": 1,
                "locale": "xh",
                "messages": {"countrywide": "Ilizwe lonke"},
            },
        )
        self.assertEqual(localization["locale"], "xh")
        self.assertEqual(localization["geography"]["country_names"]["CN"], "test-cn-policy-override")
        self.assertIn("descriptions", localization)
        self.assertIn("linguistics", localization)
        self.assertTrue(
            {
                "atlas-countries-10m-1.0.0.mjs",
                "atlas-countries-110m-1.0.0.mjs",
                "topojson-client-3.1.0.mjs",
                "d3-geo-3.1.1.mjs",
                "d3-selection-3.0.0.mjs",
                "d3-zoom-3.0.0.mjs",
                "earcut-3.0.2.mjs",
                "LICENSE-atlas.txt",
            }.issubset(map_vendor_files)
        )
        self.assertNotIn("https://esm.sh", map_runtime)
        self.assertIn("const COUNTRY_ADMIN1_REFERENCE_LAYER = false;", map_runtime)
        self.assertNotIn(".location-map__admin1-boundary", html)


    def test_country_mode_admin1_reference_layer_stays_disabled(self):
        runtime = COVERAGE.LANGUAGE_MAP_RUNTIME_PATH.read_text(encoding="utf-8")
        html = COVERAGE.TEMPLATE_PATH.read_text(encoding="utf-8")
        self.assertIn("const COUNTRY_ADMIN1_REFERENCE_LAYER = false;", runtime)
        self.assertIn("function countryAdmin1BoundariesShouldShow(projection, width, height)", runtime)
        should_show = runtime.split(
            "function countryAdmin1BoundariesShouldShow(projection, width, height)", 1
        )[1].split("\n  }", 1)[0]
        self.assertIn("!COUNTRY_ADMIN1_REFERENCE_LAYER", should_show)
        self.assertNotIn("function drawAdmin1Labels(", runtime)
        self.assertNotIn(".location-map__admin1-boundary", html)
        self.assertNotIn(".location-map__admin1-label", html)
        # Language-specific regional fills remain available.
        self.assertIn(".location-map__admin1[data-role=\"regional\"]", html)

    def test_admin1_boundary_regions_cover_every_country_and_stay_gzip_bounded(self):
        import gzip

        regions = COVERAGE._admin1_boundary_regions()
        self.assertIn("east-asia", regions)
        self.assertIn("north-eurasia-west", regions)
        self.assertIn("north-eurasia-east", regions)
        self.assertEqual(regions["east-asia"]["countries"], ["CN", "HK", "JP", "KP", "KR", "MN", "MO", "TW"])
        self.assertEqual(regions["north-eurasia-west"]["feature_filter"], {"lon_max": 60})
        self.assertEqual(regions["north-eurasia-east"]["feature_filter"], {"lon_min": 60})

        configured = json.loads(COVERAGE.LANGUAGE_MAP_ADMIN1_PATH.read_text(encoding="utf-8"))
        manifest, chunks = COVERAGE._language_admin1_assets(configured)
        on_disk = {
            path.stem
            for path in (COVERAGE.LANGUAGE_MAP_ADMIN1_DIR / "country").glob("*.geojson")
        }
        assigned = {
            code
            for entry in manifest["regions"].values()
            for code in entry["countries"]
        }
        self.assertEqual(assigned, on_disk)
        self.assertIn("KR", manifest["regions"]["east-asia"]["countries"])
        self.assertRegex(
            manifest["regions"]["east-asia"]["url"],
            r"^./language-map-admin1/region-east-asia\.geojson\.gz$",
        )
        for region_id, entry in manifest["regions"].items():
            filename = Path(entry["url"]).name
            self.assertTrue(filename.endswith(".geojson.gz"), filename)
            self.assertIn(filename, chunks)
            compressed = chunks[filename]
            self.assertIsInstance(compressed, (bytes, bytearray))
            self.assertLessEqual(
                len(compressed),
                1_000_000,
                f"{region_id} gzip size {len(compressed)} exceeds 1MB",
            )
            payload = json.loads(gzip.decompress(compressed).decode("utf-8"))
            self.assertEqual(payload.get("region"), region_id)
            self.assertEqual(payload.get("type"), "FeatureCollection")

        self.assertTrue(chunks)
        for filename, compressed in chunks.items():
            self.assertTrue(filename.endswith(".gz"), filename)
            self.assertIsInstance(compressed, (bytes, bytearray), filename)
            self.assertEqual(
                compressed,
                gzip.compress(gzip.decompress(compressed), compresslevel=9, mtime=0),
                filename,
            )

    def test_builder_has_no_implicit_frontistr_dependency(self):
        operational_sources = [ROOT / "Makefile", *sorted((ROOT / "tools").glob("*.py"))]
        source = "\n".join(path.read_text(encoding="utf-8") for path in operational_sources)
        for forbidden in (
            "ATLAS_SIBLING",
            "ATLAS_PAGE_COPY_ROOT",
            "FRONTISTR_DOC_ROOT",
            "HOST_I18N",
            "frontistr-ui.js",
            "frontistr_i18n",
            "load_host_i18n",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, source)

    def test_selector_and_map_view_updates_share_canonical_url_order(self):
        html = COVERAGE.TEMPLATE_PATH.read_text(encoding="utf-8")
        order_match = re.search(
            r"var canonicalUrlParameterOrder = \[(.*?)\];",
            html,
            re.DOTALL,
        )
        self.assertIsNotNone(order_match)
        self.assertEqual(
            re.findall(r'"([^"]+)"', order_match.group(1)),
            [
                "lang",
                "c",
                "fid",
                "l",
                "f",
                "s",
                "p",
                "m",
                "o",
                "r",
                "lon",
                "lat",
                "z",
            ],
        )
        self.assertIn("var canonical = canonicalizeUrlParameters(url);", html)
        self.assertIn("if (next === current) return;", html)
        self.assertEqual(html.count('history.replaceState(null, "",'), 1)
        self.assertIn("url.searchParams.set(\"lang\", code);\n        replaceUrl(url);", html)
        obsolete_match = re.search(
            r"var obsoleteUrlParameterKeys = \[(.*?)\];",
            html,
            re.DOTALL,
        )
        self.assertIsNotNone(obsolete_match)
        self.assertEqual(
            re.findall(r'"([^"]+)"', obsolete_match.group(1)),
            [
                "country",
                "feature",
                "language",
                "family",
                "script",
                "projection",
                "movement",
                "orientation",
                "roll",
                "zoom",
                "center",
            ],
        )


if __name__ == "__main__":
    unittest.main()
