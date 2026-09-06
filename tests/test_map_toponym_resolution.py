import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class MapToponymResolutionTests(unittest.TestCase):
    def test_url_zoom_uses_web_map_absolute_levels(self):
        runtime = (ROOT / "tools" / "browser" / "language-distribution-map.js").as_uri()
        script = f"""
          import {{absoluteZoomForProjectionScale, projectionScaleForAbsoluteZoom}} from {json.dumps(runtime)};
          const zooms = [0, 1, 5.25, -0.5];
          console.log(JSON.stringify({{
            baseScale: projectionScaleForAbsoluteZoom(0),
            doubledScale: projectionScaleForAbsoluteZoom(1),
            roundTrips: zooms.map((zoom) => absoluteZoomForProjectionScale(
              projectionScaleForAbsoluteZoom(zoom)
            ))
          }}));
        """
        completed = subprocess.run(
            ["node", "--input-type=module", "--eval", script],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        result = json.loads(completed.stdout)
        self.assertAlmostEqual(result["baseScale"], 256 / (2 * 3.141592653589793))
        self.assertAlmostEqual(result["doubledScale"], 2 * result["baseScale"])
        self.assertEqual(len(result["roundTrips"]), len([0, 1, 5.25, -0.5]))
        for actual, expected in zip(result["roundTrips"], [0, 1, 5.25, -0.5]):
            self.assertAlmostEqual(actual, expected)

    def test_map_country_click_context_does_not_drive_language_camera(self):
        runtime = (ROOT / "tools" / "browser" / "language-distribution-map.js").as_uri()
        script = f"""
          import {{languageCountryContextDrivesCamera, preserveProjectedNavigation}} from {json.dumps(runtime)};
          const activeProjection = {{family:'current'}};
          console.log(JSON.stringify({{
            mapClick: languageCountryContextDrivesCamera(['JP'], true),
            explicitSelection: languageCountryContextDrivesCamera(['JP'], false),
            languageOnly: languageCountryContextDrivesCamera([], false),
            preservedProjection: preserveProjectedNavigation(true, true, activeProjection),
            refitProjection: preserveProjectedNavigation(true, false, activeProjection),
            planarNavigation: preserveProjectedNavigation(false, true, activeProjection)
          }}));
        """
        completed = subprocess.run(
            ["node", "--input-type=module", "--eval", script],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            json.loads(completed.stdout),
            {
                "mapClick": False,
                "explicitSelection": True,
                "languageOnly": False,
                "preservedProjection": True,
                "refitProjection": False,
                "planarNavigation": False,
            },
        )

        template = (ROOT / "tools" / "browser" / "language-coverage.html").read_text(
            encoding="utf-8"
        )
        self.assertIn("preserveCamera:Boolean(preserveMapViewport)", template)
        self.assertIn(
            "languageMapSelectionOptions(retainedLanguageSource, validCodes, "
            "selectedCountryFeatureId, preserveMapViewport)",
            template,
        )

    def test_concave_admin1_label_points_are_moved_inside_the_region(self):
        runtime = (ROOT / "tools" / "browser" / "language-distribution-map.js").as_uri()
        d3_geo = (ROOT / "tools" / "browser" / "vendor" / "map" / "d3-geo-3.1.1.mjs").as_uri()
        egypt = json.loads(
            (ROOT / "config" / "geography" / "admin1" / "country" / "EG.geojson").read_text(
                encoding="utf-8"
            )
        )
        features = {
            item["properties"]["id"]: item
            for item in egypt["features"]
            if item["properties"]["id"] in {"EG-ASN", "EG-KN"}
        }
        script = f"""
          import {{polygonInteriorLabelPoint}} from {json.dumps(runtime)};
          import {{geoArea, geoCentroid, geoContains}} from {json.dumps(d3_geo)};
          const features = {json.dumps(features)};
          const results = Object.fromEntries(Object.entries(features).map(([id, feature]) => {{
            const polygons = feature.geometry.type === 'Polygon'
              ? [feature.geometry.coordinates]
              : feature.geometry.coordinates;
            const largest = polygons.map((coordinates) => {{
              const geometry = {{type:'Polygon', coordinates}};
              return {{coordinates, geometry, area:geoArea(geometry)}};
            }}).sort((left, right) => right.area - left.area)[0];
            const centroid = geoCentroid(largest.geometry);
            const labelPoint = polygonInteriorLabelPoint(largest.coordinates);
            return [id, {{
              centroidInside: geoContains(largest.geometry, centroid),
              labelPointInside: geoContains(largest.geometry, labelPoint)
            }}];
          }}));
          console.log(JSON.stringify(results));
        """
        completed = subprocess.run(
            ["node", "--input-type=module", "--eval", script],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        result = json.loads(completed.stdout)
        self.assertEqual(set(result), {"EG-ASN", "EG-KN"})
        self.assertTrue(all(not item["centroidInside"] for item in result.values()))
        self.assertTrue(all(item["labelPointInside"] for item in result.values()))

    def test_shared_locale_context_resolves_chains_defaults_and_overlays(self):
        runtime = (ROOT / "tools" / "browser" / "locale-resolution.js").as_uri()
        script = f"""
          await import({json.dumps(runtime)});
          const {{localeContext, mergeLocaleRecords}} = globalThis.AtlasLocaleResolution;
          const chained = localeContext(
            'as',
            {{as:'bn', bn:'hi'}},
            'en',
            ['as', 'bn', 'hi', 'en']
          );
          const result = {{
            chained,
            overlaid: localeContext('hy', [{{hy:'ru'}}, {{hy:'en'}}], '', ['hy','ru','en']),
            cycle: localeContext('a', {{a:'b', b:'a'}}, 'en', ['a','b','en']),
            merged: mergeLocaleRecords(
              {{en:{{shared:'en', onlyEn:true}}, bn:{{shared:'bn'}}, as:{{onlyAs:true}}}},
              chained
            )
          }};
          console.log(JSON.stringify(result));
        """
        completed = subprocess.run(
            ["node", "--input-type=module", "--eval", script],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        result = json.loads(completed.stdout)
        self.assertEqual(result["chained"]["localeChain"], ["as", "bn", "hi", "en"])
        self.assertEqual(result["overlaid"]["localeChain"], ["hy", "en"])
        self.assertEqual(result["cycle"]["localeChain"], ["a", "b", "en"])
        self.assertEqual(
            result["merged"],
            {"shared": "bn", "onlyEn": True, "onlyAs": True},
        )

    def test_script_fallbacks_and_language_exonyms_resolve_in_order(self):
        runtime = (ROOT / "tools" / "browser" / "language-distribution-map.js").as_uri()
        config = json.loads(
            (ROOT / "toponym-resolution" / "policy.json").read_text(
                encoding="utf-8"
            )
        )
        script = f"""
          import {{resolveToponym, toponymLookupKeys}} from {json.dumps(runtime)};
          const policy = {json.dumps(config, ensure_ascii=False)};
          const names = {{
            scripts: {{Latn:'Firenze', Jpan:'フィレンツェ', Cyrl:'Флоренция', Hans:'佛罗伦萨', Hant:'佛羅倫斯'}},
            locales: {{en:'Florence', de:'Florenz', fr:'Florence', es:'Florencia'}}
          }};
          const result = {{
            it: resolveToponym(names, 'it', policy),
            de: resolveToponym(names, 'de', policy),
            fr: resolveToponym(names, 'fr', policy),
            ja: resolveToponym(names, 'ja', policy),
            tt: resolveToponym(names, 'tt', policy, {{tt:'ru'}}),
            ay: resolveToponym(names, 'ay', policy, {{ay:'es'}}),
            hant: resolveToponym(names, 'zh-Hant', policy),
            hantKeys: toponymLookupKeys('zh-Hant', policy)
          }};
          console.log(JSON.stringify(result));
        """
        completed = subprocess.run(
            ["node", "--input-type=module", "--eval", script],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        result = json.loads(completed.stdout)
        self.assertEqual(result["it"], "Firenze")
        self.assertEqual(result["de"], "Florenz")
        self.assertEqual(result["fr"], "Florence")
        self.assertEqual(result["ja"], "フィレンツェ")
        self.assertEqual(result["tt"], "Флоренция")
        self.assertEqual(result["ay"], "Florencia")
        self.assertEqual(result["hant"], "佛羅倫斯")
        self.assertLess(result["hantKeys"].index("zht"), result["hantKeys"].index("zh"))

    def test_place_asset_script_uses_locale_fallback_script_without_double_loading(self):
        runtime = (ROOT / "tools" / "browser" / "language-distribution-map.js").as_uri()
        config = json.loads(
            (ROOT / "toponym-resolution" / "policy.json").read_text(
                encoding="utf-8"
            )
        )
        script = f"""
          import {{placeAssetPlanForLocale, placeScriptForLocale, materializePlaceAssets}} from {json.dumps(runtime)};
          const policy = {json.dumps(config, ensure_ascii=False)};
          const assets = {{packs:{{Latn:'latn', Cyrl:'cyrl'}}}};
          const result = {{
            ethiViaEnglish: placeScriptForLocale(assets, 'am', policy),
            georViaRussian: placeScriptForLocale(assets, 'ka', policy),
            dedicatedEthi: placeScriptForLocale(
              {{packs:{{Latn:'latn', Ethi:'ethi'}}}}, 'am', policy
            ),
            ethiPlan: placeAssetPlanForLocale(
              {{packs:{{Latn:'latn', Cyrl:'cyrl'}}}}, 'am', policy
            ),
            georPlan: placeAssetPlanForLocale(
              {{packs:{{Latn:'latn', Cyrl:'cyrl'}}}}, 'ka', policy
            ),
            materialized: materializePlaceAssets(
              {{countries: {{XX: {{budget:2, representative_place_index:1, places:[[1,2,3,0,10],[4,5,6,1,20]]}}}}}},
              {{names:['base one','base two']}},
              [{{overrides:[[0,'exact one']]}}, {{overrides:[[0,'fallback one'],[1,'fallback two']]}}]
            )
          }};
          console.log(JSON.stringify(result));
        """
        completed = subprocess.run(
            ["node", "--input-type=module", "--eval", script],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        result = json.loads(completed.stdout)
        self.assertEqual(result["ethiViaEnglish"], "Latn")
        self.assertEqual(result["georViaRussian"], "Cyrl")
        self.assertEqual(result["dedicatedEthi"], "Ethi")
        self.assertEqual(result["ethiPlan"], {"script": "Latn", "localeKeys": ["am", "en"]})
        self.assertEqual(result["georPlan"], {"script": "Cyrl", "localeKeys": ["ka", "ru"]})
        self.assertEqual(config["default_locale_fallback"], "en")
        self.assertNotIn("am", config["locale_fallbacks"])
        country = result["materialized"]["countries"]["XX"]
        self.assertEqual(country["places"][0][5], "exact one")
        self.assertEqual(country["places"][1][5], "fallback two")
        self.assertEqual(country["representative_place_index"], 1)

    def test_place_builder_collects_arabic_script_hub_names(self):
        builder = (ROOT / "tools" / "build_language_map_places.py").read_text(encoding="utf-8")
        self.assertIn('"Arab": ("ar", "NAME_AR")', builder)
        self.assertIn('country_override.get("candidate_limit") or 20', builder)
        self.assertIn('country_override.get("selected_label_floor")', builder)
        self.assertIn('country_override.get("prefer_place_labels_when_selected")', builder)
        places = json.loads(
            (ROOT / "config" / "geography" / "places.json").read_text(encoding="utf-8")
        )
        self.assertEqual(places["schema"], 3)
        rows = [row for country in places["countries"].values() for row in country["places"]]
        self.assertTrue(all(
            {
                "Latn", "Jpan", "Kore", "Cyrl", "Arab", "Hans", "Hant",
                "Deva", "Beng", "Grek", "Hebr",
                "Guru", "Gujr", "Orya", "Taml", "Telu", "Knda", "Mlym",
                "Thai", "Laoo", "Mymr", "Khmr", "Armn", "Geor", "Ethi",
            }
            <= set(row[6]["scripts"])
            for row in rows
        ))
        self.assertLess(
            sum("de" in row[6].get("locales", {}) for row in rows),
            len(rows) // 2,
        )
        florence = next(row for row in places["countries"]["IT"]["places"] if row[5] == "Florence")
        self.assertEqual(florence[6]["scripts"]["Latn"], "Firenze")
        self.assertNotIn("it", florence[6].get("locales", {}))
        self.assertEqual(florence[6]["locales"]["de"], "Florenz")
        self.assertEqual(florence[6]["locales"]["en"], "Florence")
        tokyo = next(row for row in places["countries"]["JP"]["places"] if row[5] == "Tokyo")
        self.assertEqual(tokyo[6]["scripts"]["Jpan"], "東京")
        self.assertEqual(tokyo[6]["scripts"]["Kore"], "도쿄")
        self.assertEqual(tokyo[6]["scripts"]["Ethi"], "ቶኪዮ")
        self.assertEqual(tokyo[6]["scripts"]["Thai"], "โตเกียว")
        self.assertEqual(tokyo[6]["scripts"]["Armn"], "Տոկիո")
        addis = next(row for row in places["countries"]["ET"]["places"] if row[5] == "Addis Ababa")
        self.assertEqual(addis[6]["scripts"]["Ethi"], "አዲስ አበባ")
        bangkok = next(row for row in places["countries"]["TH"]["places"] if row[5] == "Bangkok")
        self.assertEqual(bangkok[6]["scripts"]["Thai"], "กรุงเทพฯ")

        busan = next(row for row in places["countries"]["KR"]["places"] if row[5] == "Busan")
        self.assertEqual(busan[6]["scripts"]["Kore"], "부산")
        self.assertEqual(busan[6]["scripts"]["Hant"], "釜山")
        self.assertEqual(busan[6]["scripts"]["Arab"], "بوسان")
        pyongsan = next(row for row in places["countries"]["KP"]["places"] if row[5] == "Pyongsan")
        self.assertEqual(pyongsan[6]["scripts"]["Kore"], "평산")
        self.assertEqual(pyongsan[6]["scripts"]["Latn"], "Pyongsan")
        self.assertNotIn("locales", pyongsan[6])
        maradi = next(row for row in places["countries"]["NE"]["places"] if row[5] == "Maradi")
        self.assertEqual(maradi[6]["scripts"]["Latn"], "Maradi")
        kyiv = next(row for row in places["countries"]["UA"]["places"] if row[5] == "Kyiv")
        self.assertEqual(kyiv[6]["scripts"]["Latn"], "Kyiv")
        self.assertEqual(kyiv[6]["scripts"]["Jpan"], "キーウ")
        warsaw = next(row for row in places["countries"]["PL"]["places"] if row[5] == "Warsaw")
        self.assertEqual(warsaw[6]["scripts"]["Latn"], "Warszawa")
        self.assertEqual(warsaw[6]["locales"]["en"], "Warsaw")
        self.assertNotIn("pl", warsaw[6]["locales"])

if __name__ == "__main__":
    unittest.main()
