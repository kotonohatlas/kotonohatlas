#!/usr/bin/env python3
"""Build compact Natural Earth Admin-1 map chunks used by language layers."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


ISO_ALPHA2_RE = re.compile(r"^[A-Z]{2}$")


def feature_country_code(feature: dict) -> str:
    """Return the Natural Earth ISO alpha-2 owner for an Admin-1 feature."""
    code = str((feature.get("properties") or {}).get("iso_a2") or "").strip().upper()
    return code if ISO_ALPHA2_RE.fullmatch(code) else ""

def ring_signed_area(ring: list[list[float]]) -> float:
    """Return the planar signed area used to determine GeoJSON ring winding."""
    if len(ring) < 3:
        return 0.0
    return sum(
        start[0] * end[1] - end[0] * start[1]
        for start, end in zip(ring, ring[1:])
    ) / 2.0


def normalize_polygon_winding(polygon: list[list[list[float]]]) -> list[list[list[float]]]:
    """Use clockwise exteriors and counter-clockwise holes for D3 spherical paths."""
    normalized = []
    for index, ring in enumerate(polygon):
        clockwise = ring_signed_area(ring) < 0
        expected_clockwise = index == 0
        normalized.append(ring if clockwise == expected_clockwise else list(reversed(ring)))
    return normalized


def normalize_geometry_winding(geometry: dict) -> dict:
    """Normalize Polygon/MultiPolygon winding while preserving other geometry fields."""
    geometry_type = geometry.get("type")
    if geometry_type == "Polygon":
        return {
            **geometry,
            "coordinates": normalize_polygon_winding(geometry.get("coordinates") or []),
        }
    if geometry_type == "MultiPolygon":
        return {
            **geometry,
            "coordinates": [
                normalize_polygon_winding(polygon)
                for polygon in (geometry.get("coordinates") or [])
            ],
        }
    return geometry


def compact_feature(feature: dict, country: str) -> dict:
    properties = feature.get("properties") or {}
    region_id = str(properties.get("iso_3166_2") or "").strip()
    if not region_id:
        raise ValueError(f"Admin-1 feature for {country} has no ISO 3166-2 id")
    return {
        "type": "Feature",
        "properties": {
            "id": region_id,
            "country": country,
            "name_en": str(properties.get("name_en") or properties.get("name") or region_id),
        },
        "geometry": normalize_geometry_winding(feature["geometry"]),
    }


def build(source: Path, output: Path, countries: list[str] | None = None) -> None:
    raw = json.loads(source.read_text(encoding="utf-8"))
    features = raw.get("features") or []
    country_output = output / "country"
    country_output.mkdir(parents=True, exist_ok=True)
    available = sorted({feature_country_code(feature) for feature in features} - {""})
    selected_countries = available if countries is None else list(dict.fromkeys(countries))
    unknown = sorted(set(selected_countries) - set(available))
    if unknown:
        raise ValueError(f"no Admin-1 features found for: {', '.join(unknown)}")
    for country in selected_countries:
        selected = [
            compact_feature(feature, country)
            for feature in features
            if feature_country_code(feature) == country
        ]
        payload = {"type": "FeatureCollection", "features": selected}
        (country_output / f"{country}.geojson").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )


def build_sources(source: Path, output: Path, manifest_path: Path, custom_dir: Path) -> None:
    raw = json.loads(source.read_text(encoding="utf-8"))
    features = raw.get("features") or []
    by_id: dict[str, list[dict]] = {}
    for feature in features:
        region_id = str(
            (feature.get("properties") or {}).get("iso_3166_2") or ""
        ).strip()
        if region_id:
            by_id.setdefault(region_id, []).append(feature)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    source_urls = manifest.get("sources") or {}
    language_output = output / "lang"
    language_output.mkdir(parents=True, exist_ok=True)
    for source_id in source_urls:
        region_ids = []
        for rules in (manifest.get("languages") or {}).values():
            for rule in rules:
                if rule.get("source") == source_id:
                    region_ids.extend(rule.get("regions") or [])
        selected = []
        for region_id in dict.fromkeys(region_ids):
            matched = by_id.get(region_id) or []
            if matched:
                country = region_id.split("-", 1)[0]
                selected.extend(compact_feature(feature, country) for feature in matched)
                continue
            custom_path = custom_dir / f"{region_id}.geojson"
            if not custom_path.is_file():
                raise ValueError(f"no Admin-1 or custom geometry found for {region_id}")
            custom_feature = json.loads(custom_path.read_text(encoding="utf-8"))
            custom_feature["geometry"] = normalize_geometry_winding(custom_feature["geometry"])
            selected.append(custom_feature)
        filename = f"{source_id}.geojson"
        payload = {"type": "FeatureCollection", "features": selected}
        (language_output / filename).write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--countries",
        nargs="+",
        type=lambda value: value.strip().upper(),
        default=None,
        help="optional ISO alpha-2 subset; defaults to every country in the source",
    )
    parser.add_argument("--manifest", type=Path)
    parser.add_argument(
        "--custom-dir",
        type=Path,
        default=Path("config/geography/admin1/custom"),
    )
    args = parser.parse_args()
    build(args.source, args.output, args.countries)
    if args.manifest:
        build_sources(args.source, args.output, args.manifest, args.custom_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
