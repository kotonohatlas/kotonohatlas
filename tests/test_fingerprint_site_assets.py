import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ATLAS_ROOT = Path(__file__).resolve().parents[1]
HOST_ROOT = ATLAS_ROOT.parent.parent if ATLAS_ROOT.parent.name == "vendor" else ATLAS_ROOT.parent
SPEC = importlib.util.spec_from_file_location(
    "fingerprint_site_assets",
    ATLAS_ROOT / "tools" / "fingerprint_site_assets.py",
)
FINGERPRINT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(FINGERPRINT)


class FingerprintSiteAssetsTest(unittest.TestCase):
    def test_final_file_content_controls_each_query_version(self):
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            files = {
                "assets/stylesheets/atlas-ui.css": "body {}\n",
                "assets/javascripts/language-distribution-map.js": (
                    'import "./locale-resolution.js?v=stale";\nexport {};\n'
                ),
                "language-map.json": (
                    '{"geometry":{"disputed_url":"./language-map-overlays.json?v=stale"},'
                    '"admin1_url":"./language-map-admin1.json?v=stale"}\n'
                ),
                "assets/javascripts/locale-resolution.js": "globalThis.Locale = {};\n",
                "assets/javascripts/language-atlas-access.js": "globalThis.Access = {};\n",
                "assets/javascripts/atlas-ui.js": "globalThis.Ui = {};\n",
                "coverage.json": (
                    '{"map_place_assets":{"core":'
                    '"./map-geography/places/core.json.gz"}}\n'
                ),
                "language-map-overlays.json": "{}\n",
                "language-map-admin1.json": (
                    '{"countries":{"AA":'
                    '"./language-map-admin1/AA.json.gz?v=stale"}}\n'
                ),
                "language-map-admin1/AA.json.gz": "admin-one\n",
                "map-geography/places/core.json.gz": "places\n",
                "map-locales/ja.json.gz": "compressed locale bundle\n",
                "map-linguistics/core.json": "{}\n",
            }
            for relative_path, content in files.items():
                path = site / relative_path
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
            references = "\n".join(
                f'{reference}?v=stale'
                for reference in FINGERPRINT.INDEX_REFERENCES
            )
            (site / "index.html").write_text(references + "\n", encoding="utf-8")

            first = FINGERPRINT.fingerprint_site(site)
            first_index = (site / "index.html").read_text(encoding="utf-8")
            first_runtime = (
                site / "assets/javascripts/language-distribution-map.js"
            ).read_text(encoding="utf-8")

            for reference, relative_path in FINGERPRINT.INDEX_REFERENCES.items():
                expected = hashlib.sha256((site / relative_path).read_bytes()).hexdigest()[:12]
                self.assertEqual(first[relative_path], expected)
                self.assertIn(f"{reference}?v={expected}", first_index)
            locale_version = hashlib.sha256(
                (site / "assets/javascripts/locale-resolution.js").read_bytes()
            ).hexdigest()[:12]
            self.assertIn(f"./locale-resolution.js?v={locale_version}", first_runtime)
            coverage = json.loads((site / "coverage.json").read_text(encoding="utf-8"))
            expected_groups = {"locales": "map-locales/ja.json.gz"}
            for group, relative_path in expected_groups.items():
                self.assertEqual(
                    coverage["map_asset_versions"][group]["ja"],
                    hashlib.sha256((site / relative_path).read_bytes()).hexdigest()[:12],
                )
            self.assertEqual(
                coverage["map_asset_versions"]["linguistics_core"]["core"],
                hashlib.sha256((site / "map-linguistics/core.json").read_bytes()).hexdigest()[:12],
            )
            place_version = hashlib.sha256(
                (site / "map-geography/places/core.json.gz").read_bytes()
            ).hexdigest()[:12]
            self.assertEqual(
                coverage["map_place_assets"]["core"],
                f"./map-geography/places/core.json.gz?v={place_version}",
            )

            admin1_manifest = json.loads(
                (site / "language-map-admin1.json").read_text(encoding="utf-8")
            )
            admin1_chunk_version = hashlib.sha256(
                (site / "language-map-admin1/AA.json.gz").read_bytes()
            ).hexdigest()[:12]
            self.assertEqual(
                admin1_manifest["countries"]["AA"],
                f"./language-map-admin1/AA.json.gz?v={admin1_chunk_version}",
            )

            second = FINGERPRINT.fingerprint_site(site)
            self.assertEqual(first, second)
            self.assertEqual(first_index, (site / "index.html").read_text(encoding="utf-8"))

            locale_path = site / "map-locales/ja.json.gz"
            locale_path.write_text("changed locale bundle\n", encoding="utf-8")
            third = FINGERPRINT.fingerprint_site(site)
            admin1_chunk_path = site / "language-map-admin1/AA.json.gz"
            admin1_chunk_path.write_text("changed-admin-one\n", encoding="utf-8")
            fourth = FINGERPRINT.fingerprint_site(site)

        self.assertNotEqual(first["map-locales/ja.json.gz"], third["map-locales/ja.json.gz"])
        self.assertNotEqual(first["coverage.json"], third["coverage.json"])
        for relative_path in set(first) - {"map-locales/ja.json.gz", "coverage.json"}:
            self.assertEqual(first[relative_path], third[relative_path])
        self.assertNotEqual(
            third["language-map-admin1/AA.json.gz"],
            fourth["language-map-admin1/AA.json.gz"],
        )
        self.assertNotEqual(
            third["language-map-admin1.json"],
            fourth["language-map-admin1.json"],
        )
        self.assertNotEqual(third["language-map.json"], fourth["language-map.json"])
        for relative_path in set(third) - {
            "language-map-admin1/AA.json.gz",
            "language-map-admin1.json",
            "language-map.json",
        }:
            self.assertEqual(third[relative_path], fourth[relative_path])

    def test_gitlab_fingerprints_the_completed_site(self):
        pipeline = (HOST_ROOT / ".gitlab-ci.yml").read_text(encoding="utf-8")
        assemble_job, merge_job = pipeline.split("merge-pages:", 1)
        atlas_ui_asset = "build/language-coverage/assets/javascripts/atlas-ui.js"
        self.assertIn(atlas_ui_asset, assemble_job)
        self.assertIn("build/language-coverage/map-locales/", assemble_job)
        self.assertIn(
            f"cp {atlas_ui_asset} build/site/assets/javascripts/atlas-ui.js",
            merge_job,
        )
        self.assertIn(
            "cp -R build/language-coverage/map-locales build/site/map-locales",
            merge_job,
        )
        self.assertIn(
            "python3 vendor/kotonohatlas/tools/fingerprint_site_assets.py --site build/site",
            merge_job,
        )


if __name__ == "__main__":
    unittest.main()
