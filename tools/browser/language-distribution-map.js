import "./locale-resolution.js?v=__LOCALE_RESOLUTION_VERSION__";
import overviewWorld from "./vendor/map/atlas-countries-110m-1.0.0.mjs";
import {feature, mesh} from "./vendor/map/topojson-client-3.1.0.mjs";
import {geoArea, geoAzimuthalEqualArea, geoAzimuthalEquidistant, geoBounds, geoCentroid, geoConicConformal, geoConicEqualArea, geoConicEquidistant, geoContains, geoDistance, geoEqualEarth, geoEquirectangular, geoGnomonic, geoMercator, geoNaturalEarth1, geoOrthographic, geoPath, geoStereographic, geoTransverseMercator} from "./vendor/map/d3-geo-3.1.1.mjs";
import {pointer, select} from "./vendor/map/d3-selection-3.0.0.mjs";
import {zoom, zoomIdentity} from "./vendor/map/d3-zoom-3.0.0.mjs";
import earcut, {flatten as flattenEarcut} from "./vendor/map/earcut-3.0.2.mjs";

// Pages fingerprints this finalized module after the complete site is assembled.
const {localeContext} = globalThis.AtlasLocaleResolution;

const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_WORLD_CENTER_LONGITUDE = 150;
const ATLANTIC_WORLD_CENTER_LONGITUDE = 10;
const AMERICAS_WORLD_CENTER_LONGITUDE = -90;
// Evaluate small detached parts against the complete set being fitted. The
// largest polygon of every focused country or standalone Admin-1 region
// remains required, so a small but intentional anchor such as Fiji is never
// discarded. Only camera fitting ignores the removable fragments; the map
// still renders them.
const REMOTE_FOCUS_AREA_RATIO = 0.01;
const COUNTRY_FOCUS_VIEWPORT_INSET = 18;
const LANGUAGE_FOCUS_PADDING_RATIO = 0.04;
const PRUNED_LANGUAGE_FOCUS_PADDING_RATIO = 0.065;
const MAXIMUM_NAVIGATION_ZOOM = 64;
// Web-map zoom convention: at z=0 a cylindrical projection's 2π-radian
// world width is 256 CSS pixels, and each additional level doubles the scale.
const ABSOLUTE_ZOOM_BASE_SCALE = 256 / (2 * Math.PI);
// Natural Earth Admin-1 is not maintained closely enough to present its
// subdivisions as current administrative geography. Keep the regional
// language geometry available, but never draw the generic reference layer.
const COUNTRY_ADMIN1_REFERENCE_LAYER = false;
const COUNTRY_ADMIN1_BOUNDARY_ZOOM = 3.5;
const COUNTRY_ADMIN1_BOUNDARY_MAX_COUNTRIES = 16;
const COUNTRY_ADMIN1_BOUNDARY_MAX_REGIONS = 2;
const DETAIL_RESTORE_DELAY = 16;
const POLAR_CENTER_ENTER_RATIO = 0.16;
const POLAR_CENTER_RECOVERY_RATIO = 0.4;
const GRATICULE_STEPS = [90, 60, 45, 30, 20, 15, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05];
const MAJOR_GRATICULE_STEPS = [90, 60, 45, 30, 15, 10, 5, 2, 1, 0.5, 0.2, 0.1];
let topology = overviewWorld;
let features = feature(topology, topology.objects.features).features;
let borders = mesh(topology, topology.objects.features, (a, b) => a !== b);
let coastlines = mesh(topology, topology.objects.features, (a, b) => a === b);
// Reprojecting the detailed 10m linework dominated every drag frame. Country
// Retain the exact 10m geometry in a static GPU buffer for fills, while motion previews use this compact
// linework until the detailed settled SVG returns at gesture end.
const motionOverviewBorders = mesh(overviewWorld, overviewWorld.objects.features, (a, b) => a !== b);
const motionOverviewCoastlines = mesh(overviewWorld, overviewWorld.objects.features, (a, b) => a === b);
let detailedTopologyPromise = null;
let disputedFeaturesPromise = null;
let mapInstanceSequence = 0;

function runBackgroundTask(callback) {
  if (window.scheduler && typeof window.scheduler.postTask === "function") {
    return window.scheduler.postTask(callback, {priority: "background"});
  }
  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      try { resolve(callback()); }
      catch (error) { reject(error); }
    }, 0);
  });
}

function geometryPolygons(item) {
  if (!item || !item.geometry) return [];
  if (item.geometry.type === "Polygon") return [item.geometry.coordinates];
  if (item.geometry.type === "MultiPolygon") return item.geometry.coordinates;
  return [];
}

function ringSignedArea(ring) {
  let area = 0;
  for (let index = 1; index < ring.length; index += 1) {
    const start = ring[index - 1];
    const end = ring[index];
    area += start[0] * end[1] - end[0] * start[1];
  }
  return area / 2;
}

function normalizePolygonWinding(polygon) {
  return polygon.map((ring, index) => {
    const clockwise = ringSignedArea(ring) < 0;
    const expectedClockwise = index === 0;
    return clockwise === expectedClockwise ? ring : [...ring].reverse();
  });
}

function normalizeGeometryWinding(geometry) {
  if (!geometry) return geometry;
  if (geometry.type === "Polygon") {
    return {...geometry, coordinates: normalizePolygonWinding(geometry.coordinates || [])};
  }
  if (geometry.type === "MultiPolygon") {
    return {
      ...geometry,
      coordinates: (geometry.coordinates || []).map(normalizePolygonWinding)
    };
  }
  return geometry;
}

function normalizeFeatureWinding(item) {
  return item?.geometry
    ? {...item, geometry: normalizeGeometryWinding(item.geometry)}
    : item;
}

function polygonCenter(polygon) {
  const ring = polygon && polygon[0] || [];
  if (!ring.length) return null;
  const bounds = ring.reduce((value, point) => [
    Math.min(value[0], point[0]),
    Math.min(value[1], point[1]),
    Math.max(value[2], point[0]),
    Math.max(value[3], point[1])
  ], [Infinity, Infinity, -Infinity, -Infinity]);
  return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
}

function polygonArea(polygon) {
  const ring = polygon && polygon[0] || [];
  if (ring.length < 3) return 0;
  const center = polygonCenter(polygon);
  const latitudeWeight = Math.max(0.08, Math.cos((center && center[1] || 0) * Math.PI / 180));
  const signedArea = ring.reduce((value, point, index) => {
    const next = ring[(index + 1) % ring.length];
    return value + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
  return Math.abs(signedArea) * latitudeWeight;
}

function labelPointSegmentDistanceSquared(x, y, start, end) {
  let segmentX = start[0];
  let segmentY = start[1];
  const dx = end[0] - segmentX;
  const dy = end[1] - segmentY;
  if (dx !== 0 || dy !== 0) {
    const ratio = ((x - segmentX) * dx + (y - segmentY) * dy) / (dx * dx + dy * dy);
    if (ratio > 1) {
      segmentX = end[0];
      segmentY = end[1];
    } else if (ratio > 0) {
      segmentX += dx * ratio;
      segmentY += dy * ratio;
    }
  }
  const distanceX = x - segmentX;
  const distanceY = y - segmentY;
  return distanceX * distanceX + distanceY * distanceY;
}

function labelPointPolygonDistance(x, y, rings) {
  let inside = false;
  let minimumDistanceSquared = Infinity;
  rings.forEach((ring) => {
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
      const start = ring[index];
      const end = ring[previous];
      if ((start[1] > y) !== (end[1] > y)
        && x < (end[0] - start[0]) * (y - start[1]) / (end[1] - start[1]) + start[0]) {
        inside = !inside;
      }
      minimumDistanceSquared = Math.min(
        minimumDistanceSquared,
        labelPointSegmentDistanceSquared(x, y, start, end)
      );
    }
  });
  const distance = Math.sqrt(minimumDistanceSquared);
  return (inside ? 1 : -1) * distance;
}

function labelPointCell(x, y, halfSize, rings) {
  const distance = labelPointPolygonDistance(x, y, rings);
  return {x, y, halfSize, distance, maximum: distance + halfSize * Math.SQRT2};
}

function pushLabelPointCell(heap, cell) {
  heap.push(cell);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent].maximum >= cell.maximum) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = cell;
}

function popLabelPointCell(heap) {
  if (!heap.length) return null;
  const first = heap[0];
  const last = heap.pop();
  if (!heap.length) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) break;
    const child = right < heap.length && heap[right].maximum > heap[left].maximum ? right : left;
    if (heap[child].maximum <= last.maximum) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = last;
  return first;
}

function labelPointCentroidCell(rings) {
  const ring = rings[0] || [];
  let area = 0;
  let x = 0;
  let y = 0;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const start = ring[index];
    const end = ring[previous];
    const factor = start[0] * end[1] - end[0] * start[1];
    x += (start[0] + end[0]) * factor;
    y += (start[1] + end[1]) * factor;
    area += factor * 3;
  }
  if (area === 0) return labelPointCell(ring[0][0], ring[0][1], 0, rings);
  return labelPointCell(x / area, y / area, 0, rings);
}

// A spherical centroid can sit outside a concave subdivision. Find a stable
// interior label point only for that exceptional case. The local longitude
// scaling keeps the pole-of-inaccessibility search useful at high latitudes,
// while longitude unwrapping keeps polygons around the antimeridian contiguous.
export function polygonInteriorLabelPoint(polygon) {
  const outer = (polygon?.[0] || []).filter((point) => (
    Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(Number.isFinite)
  ));
  if (outer.length < 3) return null;
  const referenceLongitude = Number(outer[0][0]);
  const meanLatitude = outer.reduce((total, point) => total + Number(point[1]), 0) / outer.length;
  const longitudeScale = Math.max(0.05, Math.abs(Math.cos(meanLatitude * Math.PI / 180)));
  const project = (point) => [
    (referenceLongitude + normalizeRotationLongitude(Number(point[0]) - referenceLongitude)) * longitudeScale,
    Number(point[1])
  ];
  const rings = (polygon || []).map((ring) => (
    (ring || []).filter((point) => (
      Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(Number.isFinite)
    )).map(project)
  )).filter((ring) => ring.length >= 3);
  if (!rings.length) return null;
  const bounds = rings[0].reduce((value, point) => [
    Math.min(value[0], point[0]),
    Math.min(value[1], point[1]),
    Math.max(value[2], point[0]),
    Math.max(value[3], point[1])
  ], [Infinity, Infinity, -Infinity, -Infinity]);
  const width = bounds[2] - bounds[0];
  const height = bounds[3] - bounds[1];
  const cellSize = Math.min(width, height);
  if (!(cellSize > 0)) {
    return [normalizeRotationLongitude(outer[0][0]), outer[0][1]];
  }
  const heap = [];
  let halfSize = cellSize / 2;
  for (let x = bounds[0]; x < bounds[2]; x += cellSize) {
    for (let y = bounds[1]; y < bounds[3]; y += cellSize) {
      pushLabelPointCell(heap, labelPointCell(x + halfSize, y + halfSize, halfSize, rings));
    }
  }
  let best = labelPointCentroidCell(rings);
  const boundsCenter = labelPointCell(
    (bounds[0] + bounds[2]) / 2,
    (bounds[1] + bounds[3]) / 2,
    0,
    rings
  );
  if (boundsCenter.distance > best.distance) best = boundsCenter;
  const precision = Math.max(cellSize / 128, 1e-6);
  let iterations = 0;
  while (heap.length && iterations < 20000) {
    const cell = popLabelPointCell(heap);
    iterations += 1;
    if (cell.distance > best.distance) best = cell;
    if (cell.maximum - best.distance <= precision) continue;
    halfSize = cell.halfSize / 2;
    pushLabelPointCell(heap, labelPointCell(cell.x - halfSize, cell.y - halfSize, halfSize, rings));
    pushLabelPointCell(heap, labelPointCell(cell.x + halfSize, cell.y - halfSize, halfSize, rings));
    pushLabelPointCell(heap, labelPointCell(cell.x - halfSize, cell.y + halfSize, halfSize, rings));
    pushLabelPointCell(heap, labelPointCell(cell.x + halfSize, cell.y + halfSize, halfSize, rings));
  }
  return [normalizeRotationLongitude(best.x / longitudeScale), best.y];
}

export function focusFeature(item) {
  const polygons = geometryPolygons(item);
  if (polygons.length < 2) return item;
  const parts = polygons.map((polygon) => ({
    polygon,
    area: polygonArea(polygon)
  }));
  const anchor = parts.reduce((largest, part) => part.area > largest.area ? part : largest, parts[0]);
  const retained = parts.filter((part) => (
    part === anchor || part.area >= anchor.area * REMOTE_FOCUS_AREA_RATIO
  ));
  const retainedPolygons = retained.map((part) => part.polygon);
  if (retainedPolygons.length === polygons.length) return item;
  return {
    ...item,
    geometry: retainedPolygons.length === 1
      ? {type: "Polygon", coordinates: retainedPolygons[0]}
      : {type: "MultiPolygon", coordinates: retainedPolygons}
  };
}

function focusFeatureGroup(items, data = {}) {
  const iso2ByIso3 = countryCodeIndex(data);
  const groups = new Map();
  const parts = (items || []).flatMap((item, itemIndex) => {
    const polygons = geometryPolygons(item);
    if (!polygons.length) return [];
    const featureId = item?.properties?.id;
    const group = iso2ByIso3.get(featureId) || featureId || `region-${itemIndex}`;
    const measured = polygons.map((polygon) => ({
      polygon,
      area: polygonArea(polygon),
      group,
      required: false
    }));
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(...measured);
    return measured;
  });
  groups.forEach((groupParts) => {
    const anchor = groupParts.reduce((largest, part) => part.area > largest.area ? part : largest, groupParts[0]);
    anchor.required = true;
  });
  if (parts.length < 2) {
    return {type: "FeatureCollection", features: items || []};
  }
  const totalArea = parts.reduce((sum, part) => sum + part.area, 0);
  const removable = parts.filter((part) => (
    !part.required && part.area < totalArea * REMOTE_FOCUS_AREA_RATIO
  ));
  if (!removable.length) {
    return {type: "FeatureCollection", features: items || []};
  }
  const removableSet = new Set(removable);
  const retained = parts.filter((part) => !removableSet.has(part));
  return {
    type: "FeatureCollection",
    __atlasPrunedRemoteParts: true,
    features: retained.map((part) => ({
      type: "Feature",
      properties: {},
      geometry: {type: "Polygon", coordinates: part.polygon}
    }))
  };
}

function applyFeatureCanonicalization(data) {
  let movedCount = 0;
  (data.feature_canonicalization || []).forEach((rule) => {
    const source = features.find((item) => item.properties.id === rule.from);
    const target = features.find((item) => item.properties.id === rule.to);
    if (!source || !target) return;
    if (rule.seamless) {
      const sourcePolygons = geometryPolygons(source);
      const sourceFeature = {
        type: "Feature",
        properties: {},
        geometry: {type: "MultiPolygon", coordinates: sourcePolygons}
      };
      // Some atlases encode an enclave-like administrative exception twice:
      // once as a hole in the surrounding country and once as a standalone
      // feature.  Merely assigning both features the same colour still leaves
      // the hole boundary visible.  Fill matching holes in the canonical
      // country, absorb any detached source polygons, and remove the source
      // feature from the drawable collection altogether.
      const filledTargetPolygons = geometryPolygons(target).map((polygon) => [
        polygon[0],
        ...polygon.slice(1).filter((hole) => {
          const center = polygonCenter([hole]);
          return !(center && geoContains(sourceFeature, center));
        })
      ]);
      const filledTargetFeature = {
        type: "Feature",
        properties: {},
        geometry: {type: "MultiPolygon", coordinates: filledTargetPolygons}
      };
      const detachedSourcePolygons = sourcePolygons.filter((polygon) => {
        const center = polygonCenter(polygon);
        return !center || !geoContains(filledTargetFeature, center);
      });
      target.geometry = {
        type: "MultiPolygon",
        coordinates: filledTargetPolygons.concat(detachedSourcePolygons)
      };
      source.geometry = {type: "MultiPolygon", coordinates: []};
      movedCount += sourcePolygons.length;
      return;
    }
    const hasBounds = Array.isArray(rule.bounds) && rule.bounds.length === 2;
    const [southWest, northEast] = hasBounds ? rule.bounds : [[-180, -90], [180, 90]];
    const moved = [];
    const retained = geometryPolygons(source).filter((polygon) => {
      const center = polygonCenter(polygon);
      const matches = center && center[0] >= southWest[0] && center[0] <= northEast[0]
        && center[1] >= southWest[1] && center[1] <= northEast[1];
      if (matches) moved.push(polygon);
      return !matches;
    });
    if (!moved.length) return;
    source.geometry = {type: "MultiPolygon", coordinates: retained};
    target.geometry = {type: "MultiPolygon", coordinates: geometryPolygons(target).concat(moved)};
    movedCount += moved.length;
  });
  return movedCount;
}

function applyGeometryExclusions(data) {
  let excludedCount = 0;
  (data.geometry_exclusions || []).forEach((rule) => {
    if (!Array.isArray(rule.bounds) || rule.bounds.length !== 2) return;
    const [southWest, northEast] = rule.bounds;
    const sourceIds = new Set(Array.isArray(rule.from) ? rule.from : (rule.from ? [rule.from] : []));
    features.forEach((item) => {
      if (sourceIds.size && !sourceIds.has(item.properties.id)) return;
      const retained = geometryPolygons(item).filter((polygon) => {
        const center = polygonCenter(polygon);
        const excluded = center && center[0] >= southWest[0] && center[0] <= northEast[0]
          && center[1] >= southWest[1] && center[1] <= northEast[1];
        if (excluded) excludedCount += 1;
        return !excluded;
      });
      item.geometry = {type: "MultiPolygon", coordinates: retained};
    });
  });
  return excludedCount;
}

function excludeLineGeometry(item, rules) {
  if (!item || item.type !== "MultiLineString") return item;
  const exclusions = (rules || []).filter((rule) => (
    Array.isArray(rule.bounds) && rule.bounds.length === 2
  ));
  if (!exclusions.length) return item;
  const excluded = (point) => exclusions.some((rule) => {
    const [southWest, northEast] = rule.bounds;
    return point[0] >= southWest[0] && point[0] <= northEast[0]
      && point[1] >= southWest[1] && point[1] <= northEast[1];
  });
  const coordinates = [];
  item.coordinates.forEach((line) => {
    let retained = [];
    for (let index = 1; index < line.length; index += 1) {
      const start = line[index - 1];
      const end = line[index];
      const midpoint = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
      if (excluded(midpoint)) {
        if (retained.length > 1) coordinates.push(retained);
        retained = [];
        continue;
      }
      if (!retained.length) retained.push(start);
      retained.push(end);
    }
    if (retained.length > 1) coordinates.push(retained);
  });
  return {...item, coordinates};
}

function applyFeatureRegions(data) {
  let regionCount = 0;
  (data.feature_regions || []).forEach((region) => {
    if (!region.id) return;
    const existing = region.source_feature_id
      ? features.find((item) => item.properties.id === region.source_feature_id)
      : null;
    if (existing) {
      if (region.selection_rule) existing.properties.selection_rule = region.selection_rule;
      regionCount += 1;
      return;
    }
    if (!region.geometry) return;
    features.push({
      type: "Feature",
      properties: {
        id: region.id,
        name: region.name_en || region.id,
        name_long: region.name_en || region.id,
        selection_rule: region.selection_rule || null,
        settled_boundary: Boolean(region.settled_boundary)
      },
      geometry: region.geometry
    });
    regionCount += 1;
  });
  return regionCount;
}

function canonicalFeatureId(data, featureId) {
  const rule = (data.feature_canonicalization || []).find((item) => item.from === featureId && !item.bounds);
  if (rule) return rule.to;
  const alias = (data.feature_code_aliases || {})[featureId];
  return alias ? (data.iso2_to_iso3 || {})[alias] || alias : featureId;
}

function updateBorders(data) {
  const canonicalSourceIds = new Set(
    (data.feature_canonicalization || []).map((rule) => rule.from).filter(Boolean)
  );
  borders = mesh(topology, topology.objects.features, (a, b) => {
    const aId = canonicalFeatureId(data, a && a.properties && a.properties.id);
    const bId = canonicalFeatureId(data, b && b.properties && b.properties.id);
    return aId !== bId;
  });
  coastlines = excludeLineGeometry(
    mesh(topology, topology.objects.features, (a, b) => (
      a === b && !canonicalSourceIds.has(a && a.properties && a.properties.id)
    )),
    data.geometry_exclusions
  );
}

function applyTerritoryExtracts(data) {
  let movedCount = 0;
  (data.territory_extracts || []).forEach((rule) => {
    const moved = [];
    (Array.isArray(rule.from) ? rule.from : [rule.from]).forEach((sourceId) => {
      const source = features.find((item) => item.properties.id === sourceId);
      if (!source || !Array.isArray(rule.bounds) || rule.bounds.length < 1) return;
      const boundsList = Array.isArray(rule.bounds[0][0]) ? rule.bounds : [rule.bounds];
      const retained = geometryPolygons(source).filter((polygon) => {
        const center = polygonCenter(polygon);
        const matches = center && boundsList.some(([southWest, northEast]) => {
          return center[0] >= southWest[0] && center[0] <= northEast[0]
            && center[1] >= southWest[1] && center[1] <= northEast[1];
        });
        if (matches) moved.push(polygon);
        return !matches;
      });
      source.geometry = {type: "MultiPolygon", coordinates: retained};
    });
    if (!moved.length) return;
    const existing = features.find((item) => item.properties.id === rule.id);
    if (existing) {
      existing.geometry = {type: "MultiPolygon", coordinates: geometryPolygons(existing).concat(moved)};
    } else {
      features.push({
        type: "Feature",
        properties: {id: rule.id, name: rule.name_en || rule.id, name_long: rule.name_en || rule.id},
        geometry: {type: "MultiPolygon", coordinates: moved}
      });
    }
    movedCount += moved.length;
  });
  return movedCount;
}

function prepareFeatures(data) {
  const changes = {
    exclusions: applyGeometryExclusions(data),
    canonicalized: applyFeatureCanonicalization(data),
    extracts: applyTerritoryExtracts(data),
    regions: applyFeatureRegions(data)
  };
  features = features.filter((item) => geometryPolygons(item).length > 0);
  updateBorders(data);
  return changes;
}

function installTopology(nextTopology, data) {
  topology = nextTopology;
  features = feature(topology, topology.objects.features).features;
  borders = mesh(topology, topology.objects.features, (a, b) => a !== b);
  return prepareFeatures(data);
}

function loadDetailedTopology(data) {
  if (!detailedTopologyPromise) {
    const url = data.geometry && data.geometry.detail_module
      ? data.geometry.detail_module
      : "./vendor/map/atlas-countries-10m-1.0.0.mjs";
    detailedTopologyPromise = import(url).then((module) => module.default);
  }
  return detailedTopologyPromise;
}

function loadDisputedFeatures(data) {
  if (!disputedFeaturesPromise) {
    const url = data.geometry && data.geometry.disputed_url;
    disputedFeaturesPromise = url
      ? fetch(url, {credentials: "same-origin"}).then((response) => {
        if (!response.ok) throw new Error(`Unable to load disputed regions (${response.status})`);
        return response.json();
      }).then((collection) => {
        const additions = (collection.features || []).filter((item) => (
          item && item.type === "Feature" && item.geometry && item.properties
        ));
        return {features: additions, count: additions.length};
      })
      : Promise.resolve({features: [], count: 0});
  }
  return disputedFeaturesPromise;
}

function svgElement(name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
}

function mapLabelBoxesOverlap(left, right, padding = 4) {
  return left.x < right.x + right.width + padding
    && left.x + left.width + padding > right.x
    && left.y < right.y + right.height + padding
    && left.y + left.height + padding > right.y;
}

class LabelCollisionIndex {
  constructor(cellSize = 56) {
    this.cellSize = cellSize;
    this.boxes = [];
    this.cells = new Map();
  }

  cellKeys(box, padding = 0) {
    const left = Math.floor((box.x - padding) / this.cellSize);
    const right = Math.floor((box.x + box.width + padding) / this.cellSize);
    const top = Math.floor((box.y - padding) / this.cellSize);
    const bottom = Math.floor((box.y + box.height + padding) / this.cellSize);
    const keys = [];
    for (let x = left; x <= right; x += 1) {
      for (let y = top; y <= bottom; y += 1) keys.push(`${x}:${y}`);
    }
    return keys;
  }

  add(box) {
    this.boxes.push(box);
    box.__labelCells = this.cellKeys(box);
    box.__labelCells.forEach((key) => {
      if (!this.cells.has(key)) this.cells.set(key, new Set());
      this.cells.get(key).add(box);
    });
    return box;
  }

  remove(box) {
    (box.__labelCells || []).forEach((key) => {
      const bucket = this.cells.get(key);
      if (!bucket) return;
      bucket.delete(box);
      if (!bucket.size) this.cells.delete(key);
    });
    box.__labelCells = [];
  }

  update(box, next) {
    this.remove(box);
    Object.assign(box, next);
    box.__labelCells = this.cellKeys(box);
    box.__labelCells.forEach((key) => {
      if (!this.cells.has(key)) this.cells.set(key, new Set());
      this.cells.get(key).add(box);
    });
  }

  find(predicate) {
    return this.boxes.find(predicate);
  }

  collides(box, padding = 4, ignore = null) {
    const visited = new Set();
    for (const key of this.cellKeys(box, padding)) {
      const bucket = this.cells.get(key);
      if (!bucket) continue;
      for (const other of bucket) {
        if (other === ignore || visited.has(other)) continue;
        visited.add(other);
        if (mapLabelBoxesOverlap(box, other, padding)) return true;
      }
    }
    return false;
  }
}

const labelMeasureCache = new Map();
let labelMeasureContext = null;
let cachedRootFontSize = 0;

function rootFontSize() {
  if (cachedRootFontSize > 0) return cachedRootFontSize;
  const value = parseFloat(getComputedStyle(document.documentElement).fontSize);
  cachedRootFontSize = Number.isFinite(value) && value > 0 ? value : 16;
  return cachedRootFontSize;
}

function measureMapLabel(text, {fontSizeRem, fontWeight, x, y, dx = 0, dy = 0, anchor = "middle"}) {
  if (!labelMeasureContext) {
    const canvas = document.createElement("canvas");
    labelMeasureContext = canvas.getContext("2d");
  }
  const fontSize = fontSizeRem * rootFontSize();
  const key = `${fontWeight}|${fontSize}|${text}`;
  let metrics = labelMeasureCache.get(key);
  if (!metrics) {
    labelMeasureContext.font = `${fontWeight} ${fontSize}px system-ui, sans-serif`;
    const measured = labelMeasureContext.measureText(text);
    metrics = {
      width: Math.ceil(measured.width + 2),
      height: Math.ceil(
        (measured.actualBoundingBoxAscent || fontSize * 0.76)
        + (measured.actualBoundingBoxDescent || fontSize * 0.24)
        + 2
      )
    };
    labelMeasureCache.set(key, metrics);
  }
  const centerX = x + Number(dx || 0);
  const centerY = y + Number(dy || 0);
  const boxX = anchor === "start" ? centerX : anchor === "end" ? centerX - metrics.width : centerX - metrics.width / 2;
  return {x: boxX, y: centerY - metrics.height / 2, width: metrics.width, height: metrics.height};
}

function normalize(value) {
  return String(value || "").trim().replace(/_/g, "-").toLowerCase();
}

function base(value) {
  return normalize(value).split("-")[0];
}

function localeScript(value) {
  const locale = normalize(value);
  if (!locale || typeof Intl === "undefined" || typeof Intl.Locale !== "function") return "";
  try {
    return new Intl.Locale(locale).maximize().script || "";
  } catch (error) {
    return "";
  }
}

function normalizedRecord(value) {
  return Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [normalize(key), item]));
}

export function toponymLookupKeys(locale, resolution = {}, localeFallbacks = {}) {
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

const compressedJsonFetches = new Map();

export function placeAssetPlanForLocale(assets, locale, resolution = {}, localeFallbacks = {}) {
  const availablePacks = {...(assets?.packs || {}), ...(assets?.scripts || {})};
  const available = new Map(Object.keys(availablePacks).map((script) => [normalize(script), script]));
  const scriptFallbacks = normalizedRecord(resolution.script_fallbacks);
  const seen = new Set();
  const scriptForKeys = (keys) => {
    const candidates = [];
    const appendScript = (value) => {
      const script = normalize(value);
      if (!script || seen.has(script)) return;
      seen.add(script);
      candidates.push(script);
      (scriptFallbacks[script] || []).forEach(appendScript);
    };
    keys.map(localeScript).forEach(appendScript);
    return candidates.map((script) => available.get(script)).find(Boolean) || "";
  };

  const localeKeys = toponymLookupKeys(locale, resolution, localeFallbacks);
  let script = scriptForKeys(localeKeys);
  if (!script) {
    // English/Latn is the default only when the requested or explicitly
    // configured fallback script is unavailable. Non-English pivots such as
    // ka -> ru -> Cyrl are the exceptional policy entries.
    const defaultLocale = normalize(resolution.default_locale_fallback || "en");
    const defaultKeys = defaultLocale
      ? toponymLookupKeys(defaultLocale, resolution, localeFallbacks)
      : [];
    defaultKeys.forEach((key) => {
      if (!localeKeys.includes(key)) localeKeys.push(key);
    });
    script = scriptForKeys(defaultKeys);
  }
  if (!script) {
    const finalKeys = (resolution.final_scripts || ["Latn"])
      .map((candidate) => normalize(candidate))
      .filter(Boolean);
    script = finalKeys.map((candidate) => available.get(candidate)).find(Boolean) || "";
  }
  return {script, localeKeys};
}

export function placeScriptForLocale(assets, locale, resolution = {}, localeFallbacks = {}) {
  return placeAssetPlanForLocale(assets, locale, resolution, localeFallbacks).script;
}

function placeLocaleAssetKeys(assets, locale, resolution, localeFallbacks) {
  const available = normalizedRecord(assets?.locales);
  return placeAssetPlanForLocale(assets, locale, resolution, localeFallbacks).localeKeys
    .filter((key, index, keys) => available[key] && keys.indexOf(key) === index);
}

function fetchGzipJson(url, priority = "low") {
  if (!url) return Promise.reject(new Error("compressed JSON asset URL is missing"));
  if (!compressedJsonFetches.has(url)) {
    const request = fetch(url, {credentials: "same-origin", priority})
      .then((response) => {
        if (!response.ok) throw new Error(`compressed JSON asset unavailable: ${response.status}`);
        const contentEncoding = String(response.headers.get("content-encoding") || "").toLowerCase();
        if (contentEncoding.includes("gzip")) return response.json();
        if (typeof DecompressionStream !== "function" || !response.body) {
          throw new Error("gzip DecompressionStream is unavailable");
        }
        const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
        return new Response(stream).json();
      })
      .catch((error) => {
        compressedJsonFetches.delete(url);
        throw error;
      });
    compressedJsonFetches.set(url, request);
  }
  return compressedJsonFetches.get(url);
}

export function materializePlaceAssets(core, scriptPack, localePacks = []) {
  const names = Array.isArray(scriptPack?.names) ? scriptPack.names.slice() : [];
  // Packs arrive in lookup priority order. Apply low-priority fallbacks first
  // so an exact requested-locale override wins at the same place index.
  localePacks.slice().reverse().forEach((pack) => {
    const placeOverrides = Array.isArray(pack)
      ? pack
      : (pack?.places || pack?.overrides || []);
    placeOverrides.forEach(([index, value]) => {
      if (Number.isInteger(index) && index >= 0 && index < names.length && value) names[index] = value;
    });
  });
  const countries = {};
  let placeIndex = 0;
  Object.entries(core?.countries || {}).forEach(([country, configured]) => {
    countries[country] = {
      ...configured,
      places: (configured.places || []).map((row) => {
        const name = names[placeIndex];
        placeIndex += 1;
        return [...row, name || ""];
      })
    };
  });
  if (placeIndex !== names.length) {
    throw new Error(`place asset length mismatch: core=${placeIndex} names=${names.length}`);
  }
  return {
    schema: 2,
    countries
  };
}

export async function loadPlaceAssets(assets, locale, resolution = {}, localeFallbacks = {}, priority = "low") {
  const plan = placeAssetPlanForLocale(assets, locale, resolution, localeFallbacks);
  const script = plan.script;
  const packUrl = assets?.packs?.[script];
  if (packUrl) {
    if (!assets?.core || !script) {
      throw new Error(`place-name script is unavailable for ${locale || "unknown locale"}`);
    }
    const [core, pack] = await Promise.all([
      fetchGzipJson(assets.core, priority),
      fetchGzipJson(packUrl, priority)
    ]);
    if (
      !core?.countries
      || !Array.isArray(pack?.names)
    ) {
      throw new Error(`place-name pack is invalid for ${locale || "unknown locale"}`);
    }
    const packedLocales = normalizedRecord(pack.locales);
    const localeKeys = plan.localeKeys.filter((key) => packedLocales[key]);
    return {
      places: materializePlaceAssets(
        core,
        pack,
        localeKeys.map((key) => packedLocales[key])
      ),
      script,
      localeKeys
    };
  }
  if (!assets?.core || !script || !assets.scripts?.[script]) {
    throw new Error(`place-name script is unavailable for ${locale || "unknown locale"}`);
  }
  const localeKeys = placeLocaleAssetKeys(assets, locale, resolution, localeFallbacks);
  const [core, scriptPack, ...localePacks] = await Promise.all([
    fetchGzipJson(assets.core, priority),
    fetchGzipJson(assets.scripts[script], priority),
    ...localeKeys.map((key) => fetchGzipJson(normalizedRecord(assets.locales)[key], priority))
  ]);
  return {
    places: materializePlaceAssets(core, scriptPack, localePacks),
    script,
    localeKeys
  };
}

function profileFor(data, language) {
  const profiles = data.profiles || {};
  const aliases = [language.id].concat(language.aliases || []).map(normalize);
  return aliases.reduce((found, alias) => found || profiles[alias] || profiles[base(alias)], null) || {};
}

function localizedMessages(data, locale, override) {
  if (override && Object.keys(override).length) return override;
  const messages = data.messages || {};
  return messages[normalize(locale)] || messages[base(locale)] || messages.en || {};
}

function localizedFeatureName(properties, locale, resolution = {}, localeFallbacks = {}) {
  const names = properties && properties.name;
  if (names && typeof names === "object" && !Array.isArray(names)) {
    return resolveToponym(names, locale, resolution, localeFallbacks);
  }
  if (!properties) return "";
  const flatNames = {};
  Object.entries(properties).forEach(([key, value]) => {
    if (key.startsWith("name_") && value) flatNames[key.slice(5)] = value;
  });
  if (typeof properties.name === "string" && properties.name) flatNames.native = properties.name;
  return resolveToponym(
    flatNames,
    locale,
    resolution,
    localeFallbacks,
    properties.name_long || properties.name || ""
  );
}

function escapeText(value) {
  return String(value == null ? "" : value);
}

function classifiedCountry(entries, code) {
  return (entries || []).find((entry) => (typeof entry === "string" ? entry : entry.code) === code) || null;
}

function classifiedCountryMark(entries, role, code) {
  const entry = classifiedCountry(entries, code);
  if (!entry) return null;
  const configuredIntensity = typeof entry === "object" ? Number(entry.intensity) : NaN;
  const statusOnly = Boolean(typeof entry === "object" && entry.status_only);
  return {
    // A status-only country records nationwide legal/institutional standing,
    // not nationwide language use.  Keep it visible as the lighter
    // official/regional layer instead of painting the whole country as a
    // principal shared-language area.
    role: statusOnly && role === "countrywide" ? "official" : role,
    intensity: Number.isFinite(configuredIntensity)
      ? Math.max(0, Math.min(1, configuredIntensity))
      : null,
    statusOnly
  };
}

function classifiedCountryCode(entry) {
  return typeof entry === "string" ? entry : entry && entry.code;
}

function profileRoleEntries(profile, role) {
  if (!profile) return [];
  return Array.isArray(profile[role]) ? profile[role] : [];
}

function profileUsesAccessRole(profile, role) {
  if (profile && profile.roles_from_access === false) return false;
  const flag = `${String(role).replaceAll("-", "_")}_from_access`;
  return !profile || profile[flag] !== false;
}

function languageRoleCountryCodes(language, profile, role) {
  const profileEntries = profileRoleEntries(profile, role);
  const profileCodes = focusableCountryCodes(profileEntries);
  if (profileCodes.length || profileEntries.length) return profileCodes;
  if (!profileUsesAccessRole(profile, role)) return [];
  return focusableCountryCodes(language[role] || []);
}

function focusableCountryCodes(entries) {
  return Array.from(new Set((entries || [])
    .filter((entry) => typeof entry === "string" || !entry.status_only)
    .map(classifiedCountryCode)
    .filter(Boolean)));
}

function languageScopeCountryCodes(language, profile = {}, data = {}, featureSource = []) {
  const explicitOfficialEntries = profileRoleEntries(profile, "official");
  const official = Array.from(new Set([
    ...focusableCountryCodes(explicitOfficialEntries),
    ...languageRoleCountryCodes(language, profile, "official")
  ]));
  const protectedCountries = languageRoleCountryCodes(language, profile, "protected");
  // Official countries remain camera anchors even beyond a regional scope.
  // Only status-only countrywide entries are omitted: they are rendered as
  // regional/institutional coverage rather than a nationwide language core.
  // Neighbor-derived suggestions belong to the country-to-language view and
  // must not imply that the selected language is used across a whole neighbor.
  return Array.from(new Set([
    ...focusableCountryCodes(profileRoleEntries(profile, "countrywide")),
    ...languageRoleCountryCodes(language, profile, "countrywide"),
    ...official,
    ...protectedCountries
  ]));
}

function locationInsideScope(location, scope) {
  if (!Array.isArray(location) || location.length !== 2
    || !Array.isArray(scope) || scope.length !== 2) return false;
  const longitude = Number(location[0]);
  const latitude = Number(location[1]);
  const west = Number(scope[0][0]);
  const south = Number(scope[0][1]);
  const east = Number(scope[1][0]);
  const north = Number(scope[1][1]);
  if (![longitude, latitude, west, south, east, north].every(Number.isFinite)) return false;
  const longitudeInside = west <= east
    ? longitude >= west && longitude <= east
    : longitude >= west || longitude <= east;
  return longitudeInside && latitude >= south && latitude <= north;
}

function countryCodesInsideScope(codes, scope, data, featureSource) {
  const iso2ByIso3 = countryCodeIndex(data);
  for (const code of new Set(codes || [])) {
    const countryFeatures = (featureSource || []).filter((feature) => (
      iso2ByIso3.get(feature?.properties?.id) === code
    ));
    if (!countryFeatures.length) return false;
    const focused = focusFeatureGroup(countryFeatures, data);
    const bounds = geoBounds(focused);
    if (!locationInsideScope(geoCentroid(focused), scope)
      || !locationInsideScope(bounds[0], scope)
      || !locationInsideScope(bounds[1], scope)) return false;
  }
  return true;
}

function languageCameraAnchorCountryCodes(language, profile, data, featureSource) {
  const baseCodes = languageScopeCountryCodes(language, profile, data, featureSource);
  const residentCodes = languageRoleCountryCodes(language, profile, "resident");
  if (!residentCodes.length) return baseCodes;
  const scope = profile.scope && (data.scopes || {})[profile.scope];
  const candidateCodes = Array.from(new Set([...baseCodes, ...residentCodes]));
  // Resident distribution may enrich a regional view, but it must not turn a
  // regional language into an accidental world view. If the complete set no
  // longer fits its configured region, fall back to the three structural
  // roles above. A language with no regional cap may still be world-scale.
  return !scope || countryCodesInsideScope(candidateCodes, scope, data, featureSource)
    ? candidateCodes
    : baseCodes;
}

function countryCodeIndex(data) {
  const index = new Map(Object.entries(data.iso2_to_iso3 || {}).map(([iso2, iso3]) => [iso3, iso2]));
  Object.entries(data.feature_code_aliases || {}).forEach(([featureId, iso2]) => {
    index.set(featureId, iso2);
  });
  (data.feature_canonicalization || []).forEach((rule) => {
    const canonicalCode = index.get(rule.to);
    if (canonicalCode) index.set(rule.from, canonicalCode);
  });
  return index;
}

export function baseCountryFocusFeatureIds(data, countryCodes, featureSource) {
  const availableIds = new Set((featureSource || []).map((item) => (
    item && item.properties && item.properties.id
  )).filter(Boolean));
  const aliasesByCountry = new Map();
  Object.entries(data.feature_code_aliases || {}).forEach(([featureId, countryCode]) => {
    if (!aliasesByCountry.has(countryCode)) aliasesByCountry.set(countryCode, []);
    aliasesByCountry.get(countryCode).push(featureId);
  });
  return new Set(Array.from(countryCodes || []).flatMap((code) => {
    const primaryId = (data.iso2_to_iso3 || {})[code];
    if (primaryId && availableIds.has(primaryId)) return [primaryId];
    // Natural Earth occasionally uses a non-ISO feature id (for example SDS
    // for South Sudan).  Use that alias only when the ordinary base feature is
    // absent, so remote aliases such as Clipperton do not widen France's fit.
    return (aliasesByCountry.get(code) || []).filter((featureId) => availableIds.has(featureId));
  }));
}

function worldCenterLongitudeForViewpoint(data, viewpointCountry, featureSource) {
  const country = viewpointCountryCode(viewpointCountry);
  if (!country) return DEFAULT_WORLD_CENTER_LONGITUDE;
  const featureIds = baseCountryFocusFeatureIds(data, new Set([country]), featureSource);
  const countryFeatures = (featureSource || []).filter((item) => (
    item && item.properties && featureIds.has(item.properties.id)
  ));
  if (!countryFeatures.length) return DEFAULT_WORLD_CENTER_LONGITUDE;
  const longitude = Number(geoCentroid({
    type: "FeatureCollection",
    features: countryFeatures
  })[0]);
  if (!Number.isFinite(longitude)) return DEFAULT_WORLD_CENTER_LONGITUDE;
  // Pick the nearest of three regional world centres on a circular longitude
  // axis. Their opposite seams keep the principal landmass for that viewpoint
  // together: the Americas at 90°W, Europe/Africa at 10°E, and Asia/Pacific at
  // 150°E.
  return [
    AMERICAS_WORLD_CENTER_LONGITUDE,
    ATLANTIC_WORLD_CENTER_LONGITUDE,
    DEFAULT_WORLD_CENTER_LONGITUDE
  ].reduce((nearest, candidate) => {
    const candidateDistance = Math.abs(normalizeRotationLongitude(longitude - candidate));
    const nearestDistance = Math.abs(normalizeRotationLongitude(longitude - nearest));
    return candidateDistance < nearestDistance ? candidate : nearest;
  }, DEFAULT_WORLD_CENTER_LONGITUDE);
}

export function languageCountryContextDrivesCamera(contextCountries, preserveCamera = false) {
  return Boolean((contextCountries || []).length) && !preserveCamera;
}

export function preserveProjectedNavigation(projectedNavigation, preserveNavigation, activeProjection) {
  return Boolean(projectedNavigation && preserveNavigation && activeProjection);
}

function uniqueCodes(codes) {
  return Array.from(new Set((codes || []).filter(Boolean)));
}

function viewpointCountryCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

function configuredViewpointCountry(value) {
  const requested = String(value || "").trim();
  if (!requested) return "";
  const country = viewpointCountryCode(requested);
  if (!country) throw new Error("viewpoint must be a two-letter country code");
  return country;
}

function configuredViewpoint(value, override = false, availableCountries = null) {
  const country = configuredViewpointCountry(value);
  if (override != null && typeof override !== "boolean") {
    throw new Error("viewpointOverride must be boolean");
  }
  if (override && !country) throw new Error("viewpointOverride requires viewpoint");
  if (country && availableCountries && !Object.prototype.hasOwnProperty.call(availableCountries, country)) {
    throw new Error(`viewpoint country is not configured by the map: ${country}`);
  }
  return {country, override: Boolean(override)};
}

function partyCountriesForRule(rule) {
  if (!rule) return [];
  if (Array.isArray(rule.party_countries)) return uniqueCodes(rule.party_countries);
  return uniqueCodes(rule.countries);
}

function viewpointSelectionForRule(rule, viewpointCountry) {
  if (!rule || !viewpointCountry || !rule.viewpoint_selections) return [];
  const match = Object.entries(rule.viewpoint_selections).find(([, viewpoints]) => (
    Array.isArray(viewpoints) && viewpoints.includes(viewpointCountry)
  ));
  return match ? [match[0]] : [];
}

function resolutionMatchesViewpoint(resolution, viewpointCountry, viewpointGroups = {}) {
  if (!resolution || !viewpointCountry) return false;
  if (Array.isArray(resolution.viewpoints) && resolution.viewpoints.includes(viewpointCountry)) return true;
  const groupNames = uniqueCodes([
    ...(resolution.viewpoint_groups || []),
    resolution.viewpoint_group
  ]);
  return groupNames.some((name) => {
    const group = viewpointGroups[name];
    const countries = Array.isArray(group) ? group : group && group.countries;
    return Array.isArray(countries) && countries.includes(viewpointCountry);
  });
}

export function viewpointResolutionForRule(rule, viewpointCountry, viewpointGroups = {}, defaultViewpointCountry = "") {
  if (!rule || !Array.isArray(rule.viewpoint_resolutions)) return null;
  const exact = rule.viewpoint_resolutions.find((resolution) => (
    resolutionMatchesViewpoint(resolution, viewpointCountry, viewpointGroups)
  ));
  if (exact) return exact;
  const fallbackViewpoint = rule.default_viewpoint_country || defaultViewpointCountry;
  const fallback = fallbackViewpoint
    ? rule.viewpoint_resolutions.find((resolution) => (
        !resolution.default && resolutionMatchesViewpoint(resolution, fallbackViewpoint, viewpointGroups)
      ))
    : null;
  return fallback || rule.viewpoint_resolutions.find((resolution) => resolution.default === true) || null;
}

function resolutionSelectionCountries(resolution) {
  if (!resolution) return [];
  return uniqueCodes(resolution.selection_countries || resolution.countries);
}

function partyEquivalentSelectionForViewpoint(rule, viewpointCountry) {
  if (!rule || !viewpointCountry) return [];
  const parties = partyCountriesForRule(rule);
  if (parties.includes(viewpointCountry)) return [viewpointCountry];
  const match = Object.entries(rule.party_equivalent_viewpoint_selections || {}).find(([, viewpoints]) => (
    Array.isArray(viewpoints) && viewpoints.includes(viewpointCountry)
  ));
  return match ? [match[0]] : [];
}

export function partyEquivalentSelectionForRule(rule, viewpointCountry, defaultViewpointCountry = "") {
  if (!rule) return [];
  const viewpointEquivalent = partyEquivalentSelectionForViewpoint(rule, viewpointCountry);
  if (viewpointEquivalent.length) return viewpointEquivalent;
  const fallbackViewpoint = rule.default_viewpoint_country || defaultViewpointCountry;
  const viewpointSelection = viewpointSelectionForRule(rule, viewpointCountry);
  const fallbackEquivalent = partyEquivalentSelectionForViewpoint(rule, fallbackViewpoint);
  if (viewpointSelection.length) {
    // The configured viewpoint is a presentation floor. Promote a weaker
    // third-country position only when it resolves to the same party as a
    // stronger party-equivalent configured position. An opposing position
    // from the current access country still takes precedence.
    return fallbackEquivalent.length && viewpointSelection[0] === fallbackEquivalent[0]
      ? fallbackEquivalent
      : [];
  }
  return fallbackEquivalent;
}

export function selectionCountriesForRule(rule, viewpointCountry, viewpointGroups = {}, defaultViewpointCountry = "") {
  if (!rule) return [];
  const resolution = viewpointResolutionForRule(rule, viewpointCountry, viewpointGroups, defaultViewpointCountry);
  if (resolution) return resolutionSelectionCountries(resolution);
  const partyEquivalentSelection = partyEquivalentSelectionForRule(rule, viewpointCountry, defaultViewpointCountry);
  if (partyEquivalentSelection.length) return partyEquivalentSelection;
  const viewpointSelection = viewpointSelectionForRule(rule, viewpointCountry);
  if (viewpointSelection.length) return viewpointSelection;
  const fallbackViewpoint = rule.default_viewpoint_country || defaultViewpointCountry;
  const fallbackSelection = viewpointSelectionForRule(rule, fallbackViewpoint);
  if (fallbackSelection.length) return fallbackSelection;
  if (Array.isArray(rule.default_viewpoint_selection)) {
    return uniqueCodes(rule.default_viewpoint_selection);
  }
  return uniqueCodes(rule.countries);
}

export function displayCountriesForRule(rule, viewpointCountry = "", viewpointGroups = {}, defaultViewpointCountry = "") {
  if (!rule) return [];
  const resolution = viewpointResolutionForRule(rule, viewpointCountry, viewpointGroups, defaultViewpointCountry);
  if (resolution) return resolutionSelectionCountries(resolution);
  const partyEquivalentSelection = partyEquivalentSelectionForRule(rule, viewpointCountry, defaultViewpointCountry);
  if (partyEquivalentSelection.length) return partyEquivalentSelection;
  const parties = partyCountriesForRule(rule);
  return parties.length > 1 || rule.highlight_with_related ? parties : [];
}

export function overlayPresentationForRule(rule, viewpointCountry, viewpointGroups = {}, defaultViewpointCountry = "") {
  if (!rule) return {hidden: false, masksUnderlying: false, partyEquivalentView: false, viewpointLevel: ""};
  const resolution = viewpointResolutionForRule(rule, viewpointCountry, viewpointGroups, defaultViewpointCountry);
  if (resolution) {
    const viewpointLevel = resolution.level || "";
    return {
      hidden: viewpointLevel === "hidden",
      masksUnderlying: ["administered", "recognized", "unclaimed"].includes(viewpointLevel),
      partyEquivalentView: viewpointLevel === "administered" || viewpointLevel === "recognized",
      viewpointLevel
    };
  }
  const partyEquivalentSelection = partyEquivalentSelectionForRule(rule, viewpointCountry, defaultViewpointCountry);
  const partyEquivalentView = Boolean(partyEquivalentSelection.length);
  return {
    hidden: false,
    masksUnderlying: partyEquivalentView,
    partyEquivalentView,
    viewpointLevel: ""
  };
}

export function isClaimOnlySelection(item, selectedCountryCodes, selectedRegionId = "") {
  if (!item || !item.disputed) return false;
  if (item.viewpointLevel === "claimed") return Boolean(item.selectionCodes && item.selectionCodes.length);
  if (item.partyEquivalentView) return false;
  if (item.selfAdministered && selectedRegionId === item.featureId) return false;
  const selectedParties = uniqueCodes(selectedCountryCodes).filter((code) => (item.partyCodes || []).includes(code));
  if ((item.adminCodes || []).some((code) => selectedParties.includes(code))) return false;
  if ((item.claimOnlyCodes || []).length) return selectedParties.some((code) => item.claimOnlyCodes.includes(code));
  if (item.selfAdministered) return Boolean(selectedParties.length);
  if (!(item.adminCodes || []).length) return false;
  return Boolean(selectedParties.length);
}

function selectionRuleForFeature(data, item) {
  const featureId = item.properties.id;
  const embeddedRule = item.properties.selection_rule;
  if (embeddedRule) return {rule: embeddedRule, regionSelection: true};
  const rule = (data.feature_selections || {})[featureId];
  return {rule, regionSelection: Boolean(rule)};
}

function capCountryFocus(projection, width, height, horizontalPadding, verticalPadding, center, focusSpan, data) {
  const minimum = data.geometry && data.geometry.country_focus_minimum_degrees || [18, 12];
  const absoluteMinimum = data.geometry && data.geometry.country_focus_absolute_minimum_degrees || [1.5, 1.2];
  const multiplier = Math.max(1, Number(data.geometry && data.geometry.country_focus_feature_span_multiplier) || 18);
  const effectiveMinimum = [0, 1].map((axis) => Math.min(
    Math.max(1, Number(minimum[axis]) || (axis ? 12 : 18)),
    Math.max(
      Math.max(0.1, Number(absoluteMinimum[axis]) || (axis ? 1.2 : 1.5)),
      Math.max(0, Number(focusSpan && focusSpan[axis]) || 0) * multiplier
    )
  ));
  const minimumLongitude = effectiveMinimum[0] * Math.PI / 180;
  const minimumLatitude = effectiveMinimum[1] * Math.PI / 180;
  const maximumScale = Math.min(
    (width - horizontalPadding * 2) / minimumLongitude,
    (height - verticalPadding * 2) / minimumLatitude
  );
  if (!Number.isFinite(maximumScale) || projection.scale() <= maximumScale) return projection;
  projection.scale(maximumScale);
  const projectedCenter = projection(center);
  const translate = projection.translate();
  if (projectedCenter) {
    projection.translate([
      translate[0] + width / 2 - projectedCenter[0],
      translate[1] + height / 2 - projectedCenter[1]
    ]);
  }
  return projection;
}

function longitudeSpan(bounds) {
  const west = bounds[0][0];
  const east = bounds[1][0];
  return east >= west ? east - west : 360 - west + east;
}

function longitudeCenter(bounds) {
  return normalizeRotationLongitude(bounds[0][0] + longitudeSpan(bounds) / 2);
}

export function automaticProjectionDecision(bounds, preferAzimuthal = false) {
  const span = longitudeSpan(bounds);
  const south = Number(bounds[0][1]);
  const north = Number(bounds[1][1]);
  const latitudeSpan = Math.max(0, north - south);
  const middleLatitude = (south + north) / 2;
  const eastWestSpan = span * Math.max(0.12, Math.cos(middleLatitude * Math.PI / 180));
  const northSouthRatio = latitudeSpan / Math.max(0.001, eastWestSpan);
  const eastWestRatio = eastWestSpan / Math.max(0.001, latitudeSpan);
  const polarFocus = north <= -55 || south >= 70;

  let family = "equal-earth";
  let reason = "world";
  if (polarFocus) {
    family = "azimuthal";
    reason = "polar";
  } else if (span > 150 || latitudeSpan > 110) {
    family = "equal-earth";
    reason = "world";
  } else if (
    latitudeSpan >= 12
    && span <= 50
    && Math.abs(middleLatitude) < 72
    && northSouthRatio >= 2
  ) {
    family = "transverse-mercator";
    reason = "north-south";
  } else if (
    Math.abs(middleLatitude) >= 18
    && Math.abs(middleLatitude) <= 70
    && span <= 140
    && latitudeSpan <= 70
    && eastWestRatio >= 1.55
  ) {
    family = "conic-equal-area";
    reason = "east-west";
  } else if (preferAzimuthal || (span <= 115 && latitudeSpan <= 95)) {
    family = "azimuthal";
    reason = "regional";
  }
  return {family, reason, span, latitudeSpan, middleLatitude, northSouthRatio, eastWestRatio};
}

export function automaticProjectionFamily(bounds, preferAzimuthal = false) {
  return automaticProjectionDecision(bounds, preferAzimuthal).family;
}

function configureFocusedConicProjection(projection, bounds, latitude) {
  if (typeof projection.parallels !== "function") return projection;
  const south = Math.max(-80, Number(bounds[0][1]));
  const north = Math.min(80, Number(bounds[1][1]));
  const span = Math.max(2, north - south);
  const lower = Math.max(-80, Math.min(80, south + span / 6));
  const upper = Math.max(-80, Math.min(80, north - span / 6));
  projection.parallels([lower, upper]).center([0, latitude]);
  return projection;
}

function automaticProjectionBounds(focusedCollection, focusedItems, preferDominantLandmass) {
  const completeBounds = geoBounds(focusedCollection);
  if (!preferDominantLandmass) return completeBounds;
  const parts = focusedItems.flatMap((item) => geometryPolygons(item).map((polygon) => ({
    area: polygonArea(polygon),
    feature: {
      type: "Feature",
      properties: {},
      geometry: {type: "Polygon", coordinates: polygon}
    }
  }))).filter((item) => item.area > 0);
  if (!parts.length) return completeBounds;
  const totalArea = parts.reduce((sum, item) => sum + item.area, 0);
  const dominant = parts.reduce((largest, item) => item.area > largest.area ? item : largest);
  return dominant.area / totalArea >= 0.6 ? geoBounds(dominant.feature) : completeBounds;
}

function projectionFamily(projection) {
  return projection && projection.__atlasProjectionFamily || "equal-earth";
}

function markProjection(projection, family) {
  projection.__atlasProjectionFamily = family;
  return projection;
}

function projectionForFamily(family) {
  const factories = {
    azimuthal: geoAzimuthalEqualArea,
    "azimuthal-equidistant": geoAzimuthalEquidistant,
    stereographic: geoStereographic,
    gnomonic: geoGnomonic,
    "conic-equal-area": geoConicEqualArea,
    "conic-conformal": geoConicConformal,
    "conic-equidistant": geoConicEquidistant,
    equirectangular: geoEquirectangular,
    orthographic: geoOrthographic,
    mercator: geoMercator,
    "transverse-mercator": geoTransverseMercator,
    "equal-earth": geoEqualEarth,
    "natural-earth-1": geoNaturalEarth1
  };
  return markProjection(
    (factories[family] || geoEqualEarth)(),
    family
  );
}

function cloneProjection(source) {
  const clone = projectionForFamily(projectionFamily(source));
  clone
    .center(source.center())
    .rotate(source.rotate())
    .angle(source.angle())
    .reflectX(source.reflectX())
    .reflectY(source.reflectY())
    .scale(source.scale())
    .translate(source.translate())
    .precision(source.precision());
  const clipAngle = source.clipAngle();
  if (clipAngle != null) clone.clipAngle(clipAngle);
  const clipExtent = source.clipExtent();
  if (clipExtent != null) clone.clipExtent(clipExtent);
  if (typeof source.parallels === "function" && typeof clone.parallels === "function") {
    clone.parallels(source.parallels());
  }
  if (source.__atlasAutomaticDecision) {
    clone.__atlasAutomaticDecision = {...source.__atlasAutomaticDecision};
  }
  return clone;
}

function projectedNavigation(baseProjection, transform, width, height) {
  const center = [width / 2, height / 2];
  const geographicCenter = baseProjection.invert(transform.invert(center));
  const next = cloneProjection(baseProjection);
  const scale = Math.max(1, baseProjection.scale() * transform.k);
  if (geographicCenter && geographicCenter.every(Number.isFinite)) {
    const roll = baseProjection.rotate()[2] || 0;
    next.center([0, 0]).rotate([-geographicCenter[0], -geographicCenter[1], roll]);
  }
  return next.scale(scale).translate(center);
}

function transverseMercatorNavigation(baseProjection, transform, anchor) {
  const sourceLocation = baseProjection.invert(anchor);
  const target = transform.apply(anchor);
  const next = cloneProjection(baseProjection)
    .scale(Math.max(1, baseProjection.scale() * transform.k));
  const baseRotation = baseProjection.rotate();
  const baseCenter = baseProjection.center();
  const roll = baseRotation[2] || 0;
  let longitude = baseRotation[0];
  let centerLatitude = Math.max(-89.5, Math.min(89.5, baseCenter[1] || 0));
  const centerLongitude = baseCenter[0] || 0;
  const probeStep = 0.04;

  // A transverse Mercator has a fixed transverse axis. Reusing the globe
  // orbit solver tilts that axis through rotation[1], which can pull a pole
  // and the projection's singular line into the viewport. Pan it instead by
  // changing the central meridian and the latitude of the projected centre;
  // rotation[1] must remain zero throughout the gesture.
  const applyView = () => next
    .center([centerLongitude, centerLatitude])
    .rotate([longitude, 0, roll]);
  applyView();
  if (!sourceLocation || !sourceLocation.every(Number.isFinite)) return next;

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const current = next(sourceLocation);
    if (!current || !current.every(Number.isFinite)) break;
    const errorX = target[0] - current[0];
    const errorY = target[1] - current[1];
    if (Math.hypot(errorX, errorY) < 0.04) break;

    next.rotate([longitude + probeStep, 0, roll]);
    const longitudeProbe = next(sourceLocation);
    next.rotate([longitude, 0, roll]).center([centerLongitude, centerLatitude + probeStep]);
    const latitudeProbe = next(sourceLocation);
    applyView();
    if (!longitudeProbe || !latitudeProbe
      || !longitudeProbe.every(Number.isFinite) || !latitudeProbe.every(Number.isFinite)) break;
    const dxLongitude = (longitudeProbe[0] - current[0]) / probeStep;
    const dyLongitude = (longitudeProbe[1] - current[1]) / probeStep;
    const dxLatitude = (latitudeProbe[0] - current[0]) / probeStep;
    const dyLatitude = (latitudeProbe[1] - current[1]) / probeStep;
    const determinant = dxLongitude * dyLatitude - dxLatitude * dyLongitude;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) break;
    longitude = normalizeRotationLongitude(longitude + clampRotationStep(
      (errorX * dyLatitude - errorY * dxLatitude) / determinant,
      18
    ));
    centerLatitude = Math.max(-89.5, Math.min(89.5, centerLatitude + clampRotationStep(
      (dxLongitude * errorY - dyLongitude * errorX) / determinant,
      12
    )));
    applyView();
  }
  return next;
}

function scaleProjectionAtPoint(projection, nextScale, point) {
  const anchor = projection.invert(point);
  projection.scale(nextScale);
  if (!anchor || !anchor.every(Number.isFinite)) return projection;
  const projectedAnchor = projection(anchor);
  if (!projectedAnchor || !projectedAnchor.every(Number.isFinite)) return projection;
  const translate = projection.translate();
  return projection.translate([
    translate[0] + point[0] - projectedAnchor[0],
    translate[1] + point[1] - projectedAnchor[1]
  ]);
}

function translatedNavigation(baseProjection, transform) {
  const translate = baseProjection.translate();
  const transformedTranslate = transform.apply(translate);
  return cloneProjection(baseProjection)
    .scale(Math.max(1, baseProjection.scale() * transform.k))
    .translate(transformedTranslate);
}

function rotationQuaternion(rotation) {
  const radians = Math.PI / 180;
  const lambda = rotation[0] * radians / 2;
  const phi = rotation[1] * radians / 2;
  const gamma = rotation[2] * radians / 2;
  const sinLambda = Math.sin(lambda);
  const cosLambda = Math.cos(lambda);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const sinGamma = Math.sin(gamma);
  const cosGamma = Math.cos(gamma);
  return [
    cosLambda * cosPhi * cosGamma + sinLambda * sinPhi * sinGamma,
    sinLambda * cosPhi * cosGamma - cosLambda * sinPhi * sinGamma,
    cosLambda * sinPhi * cosGamma + sinLambda * cosPhi * sinGamma,
    cosLambda * cosPhi * sinGamma - sinLambda * sinPhi * cosGamma
  ];
}

function cartesianLocation(location) {
  const radians = Math.PI / 180;
  const lambda = location[0] * radians;
  const phi = location[1] * radians;
  const cosPhi = Math.cos(phi);
  return [cosPhi * Math.cos(lambda), cosPhi * Math.sin(lambda), Math.sin(phi)];
}

function quaternionDelta(from, to) {
  const cross = [
    from[1] * to[2] - from[2] * to[1],
    from[2] * to[0] - from[0] * to[2],
    from[0] * to[1] - from[1] * to[0]
  ];
  const length = Math.hypot(...cross);
  if (!(length > 1e-12)) return [1, 0, 0, 0];
  const dot = Math.max(-1, Math.min(1, from[0] * to[0] + from[1] * to[1] + from[2] * to[2]));
  const angle = Math.acos(dot) / 2;
  const scale = Math.sin(angle) / length;
  return [Math.cos(angle), cross[2] * scale, -cross[1] * scale, cross[0] * scale];
}

function multiplyQuaternions(left, right) {
  return [
    left[0] * right[0] - left[1] * right[1] - left[2] * right[2] - left[3] * right[3],
    left[0] * right[1] + left[1] * right[0] + left[2] * right[3] - left[3] * right[2],
    left[0] * right[2] - left[1] * right[3] + left[2] * right[0] + left[3] * right[1],
    left[0] * right[3] + left[1] * right[2] - left[2] * right[1] + left[3] * right[0]
  ];
}

function quaternionRotation(quaternion) {
  const degrees = 180 / Math.PI;
  const [w, x, y, z] = quaternion;
  return [
    Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * degrees,
    Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))) * degrees,
    Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * degrees
  ];
}

function clampRotationStep(value, limit) {
  return Math.max(-limit, Math.min(limit, value));
}

function normalizeRotationLongitude(value) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function fixedOrientationRoll(mode) {
  const rolls = {
    "north-up": 0,
    "northeast-up": 45,
    "east-up": 90,
    "southeast-up": 135,
    "south-up": 180,
    "southwest-up": -135,
    "west-up": -90,
    "northwest-up": -45
  };
  return Object.prototype.hasOwnProperty.call(rolls, mode) ? rolls[mode] : null;
}

function requestedOrientationRoll(mode, customRoll = 0) {
  const fixedRoll = fixedOrientationRoll(mode);
  if (fixedRoll != null) return fixedRoll;
  return mode === "custom" ? normalizeRotationLongitude(customRoll) : null;
}

function orientationDialAngle(roll) {
  return normalizeRotationLongitude(-roll);
}

function projectionRollFromDial(angle) {
  return normalizeRotationLongitude(-angle);
}

function projectedNorthAngle(projection, width, height, fallback = 0) {
  if (!projection || typeof projection.invert !== "function") return fallback;
  const viewportCenter = [width / 2, height / 2];
  const location = projection.invert(viewportCenter);
  if (!location || !location.every(Number.isFinite)) return fallback;
  const projectedCenter = projection(location);
  if (!projectedCenter || !projectedCenter.every(Number.isFinite)
    || Math.hypot(projectedCenter[0] - viewportCenter[0], projectedCenter[1] - viewportCenter[1]) > 1) {
    return fallback;
  }
  const latitude = Math.max(-90, Math.min(90, location[1]));
  if (Math.abs(latitude) > 89.99) return fallback;
  const step = latitude > 89.5 ? -0.05 : 0.05;
  const northward = projection([location[0], latitude + step]);
  if (!northward || !northward.every(Number.isFinite)) return fallback;
  const direction = step > 0 ? 1 : -1;
  const dx = (northward[0] - projectedCenter[0]) * direction;
  const dy = (northward[1] - projectedCenter[1]) * direction;
  if (Math.hypot(dx, dy) < 1e-6) return fallback;
  return normalizeRotationLongitude(Math.atan2(dx, -dy) * 180 / Math.PI);
}

function preserveFixedOrientationAnchor(projection, location, target, initialRotation, roll = 0) {
  let longitude = initialRotation[0];
  let latitude = Math.max(-89.999, Math.min(89.999, initialRotation[1]));
  const probeStep = 0.04;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    projection.rotate([longitude, latitude, roll]);
    const current = projection(location);
    if (!current || !current.every(Number.isFinite)) break;
    const errorX = target[0] - current[0];
    const errorY = target[1] - current[1];
    if (Math.hypot(errorX, errorY) < 0.04) break;
    projection.rotate([longitude + probeStep, latitude, roll]);
    const longitudeProbe = projection(location);
    projection.rotate([longitude, latitude + probeStep, roll]);
    const latitudeProbe = projection(location);
    if (!longitudeProbe || !latitudeProbe
      || !longitudeProbe.every(Number.isFinite) || !latitudeProbe.every(Number.isFinite)) break;
    const dxLongitude = (longitudeProbe[0] - current[0]) / probeStep;
    const dyLongitude = (longitudeProbe[1] - current[1]) / probeStep;
    const dxLatitude = (latitudeProbe[0] - current[0]) / probeStep;
    const dyLatitude = (latitudeProbe[1] - current[1]) / probeStep;
    const determinant = dxLongitude * dyLatitude - dxLatitude * dyLongitude;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) break;
    longitude = normalizeRotationLongitude(longitude + clampRotationStep(
      (errorX * dyLatitude - errorY * dxLatitude) / determinant,
      18
    ));
    latitude = Math.max(-89.999, Math.min(89.999, latitude + clampRotationStep(
      (dxLongitude * errorY - dyLongitude * errorX) / determinant,
      12
    )));
  }
  return projection.rotate([longitude, latitude, roll]);
}

function anchoredNavigation(baseProjection, transform, anchor, fixedRoll = null) {
  const sourceLocation = baseProjection.invert(anchor);
  const target = transform.apply(anchor);
  const next = cloneProjection(baseProjection)
    .scale(Math.max(1, baseProjection.scale() * transform.k));
  const targetLocation = next.invert(target);
  if (sourceLocation && targetLocation
    && sourceLocation.every(Number.isFinite) && targetLocation.every(Number.isFinite)) {
    const rotation = multiplyQuaternions(
      rotationQuaternion(baseProjection.rotate()),
      quaternionDelta(cartesianLocation(sourceLocation), cartesianLocation(targetLocation))
    );
    const nextRotation = quaternionRotation(rotation);
    if (fixedRoll != null) preserveFixedOrientationAnchor(next, sourceLocation, target, nextRotation, fixedRoll);
    else next.rotate(nextRotation);
  }
  return next;
}

function projectedAnchorError(projection, location, target) {
  const point = projection(location);
  return point && point.every(Number.isFinite)
    ? Math.hypot(point[0] - target[0], point[1] - target[1])
    : Infinity;
}

function anchoredFixedOrientationNavigation(baseProjection, transform, anchor, freeProjection, amount, fixedRoll) {
  const sourceLocation = baseProjection.invert(anchor);
  const target = transform.apply(anchor);
  if (!sourceLocation || !sourceLocation.every(Number.isFinite)) return freeProjection;
  const freeRoll = freeProjection.rotate()[2] || 0;
  const rollDifference = normalizeRotationLongitude(freeRoll - fixedRoll);
  const anchorTolerance = 0.35;
  let lower = 0;
  let upper = Math.max(0, Math.min(1, amount));
  let best = freeProjection;
  for (let iteration = 0; iteration < 7; iteration += 1) {
    const correction = iteration === 0 ? upper : (lower + upper) / 2;
    const candidate = anchoredNavigation(
      baseProjection,
      transform,
      anchor,
      normalizeRotationLongitude(fixedRoll + rollDifference * (1 - correction))
    );
    if (projectedAnchorError(candidate, sourceLocation, target) <= anchorTolerance) {
      best = candidate;
      lower = correction;
      if (correction === upper) break;
    } else upper = correction;
  }
  return best;
}

function graticuleStep(pixelsPerDegree) {
  const spacing = Math.max(0.001, pixelsPerDegree);
  const targetPixels = 72;
  return GRATICULE_STEPS.reduce((best, step) => (
    Math.abs(Math.log(step * spacing / targetPixels))
      < Math.abs(Math.log(best * spacing / targetPixels)) ? step : best
  ), GRATICULE_STEPS[0]);
}

function graticuleSteps(projection, width, height, navigationScale = 1) {
  const center = projection.invert([width / 2, height / 2]) || [0, 0];
  const origin = projection(center);
  if (!origin || !origin.every(Number.isFinite)) return [30, 30];
  const longitudePoint = projection([center[0] + 1, center[1]]);
  const latitudeDirection = center[1] >= 89 ? -1 : 1;
  const latitudePoint = projection([center[0], center[1] + latitudeDirection]);
  const longitudePixels = longitudePoint && longitudePoint.every(Number.isFinite)
    ? Math.hypot(longitudePoint[0] - origin[0], longitudePoint[1] - origin[1]) * navigationScale
    : 0;
  const latitudePixels = latitudePoint && latitudePoint.every(Number.isFinite)
    ? Math.hypot(latitudePoint[0] - origin[0], latitudePoint[1] - origin[1]) * navigationScale
    : 0;
  return [graticuleStep(longitudePixels), graticuleStep(latitudePixels)];
}

function majorGraticuleStep(step) {
  const target = step * 4;
  const candidates = MAJOR_GRATICULE_STEPS.filter((candidate) => (
    candidate >= step && Math.abs(candidate / step - Math.round(candidate / step)) < 1e-6
  ));
  return candidates.reduce((best, candidate) => (
    Math.abs(Math.log(candidate / target)) < Math.abs(Math.log(best / target))
      ? candidate : best
  ), candidates[0] || step);
}

function isMajorGraticuleValue(value, step) {
  return Math.abs(value / step - Math.round(value / step)) < 1e-6;
}

function graticuleRange(start, end, interval) {
  const values = [];
  const first = Math.ceil((start - interval * 1e-6) / interval) * interval;
  for (let value = first; value <= end + interval * 1e-6; value += interval) {
    values.push(Number(value.toFixed(8)));
  }
  return values;
}

function graticuleLine(start, end, interval, coordinate) {
  const values = graticuleRange(start, end, interval);
  if (!values.length || values[0] > start + interval * 0.25) values.unshift(start);
  if (values[values.length - 1] < end - interval * 0.25) values.push(end);
  return values.map(coordinate);
}

function visibleGraticule(projection, width, height, longitudeStep, latitudeStep, simplified = false) {
  const center = projection.invert([width / 2, height / 2]) || [0, 0];
  const centerLongitude = Number.isFinite(center[0]) ? center[0] : 0;
  const longitudes = [];
  const latitudes = [];
  const divisions = 6;
  for (let row = 0; row <= divisions; row += 1) {
    for (let column = 0; column <= divisions; column += 1) {
      const location = projection.invert([width * column / divisions, height * row / divisions]);
      if (!location || !location.every(Number.isFinite)) continue;
      longitudes.push(centerLongitude + normalizeRotationLongitude(location[0] - centerLongitude));
      latitudes.push(location[1]);
    }
  }
  if (!longitudes.length || !latitudes.length) {
    return {
      minorGeometry: {type: "MultiLineString", coordinates: []},
      majorGeometry: {type: "MultiLineString", coordinates: []},
      lines: [],
      poles: []
    };
  }
  const northVisible = projectedLocationVisible(projection, [centerLongitude, 89.999], width, height);
  const southVisible = projectedLocationVisible(projection, [centerLongitude, -89.999], width, height);
  let minimumLongitude = Math.min(...longitudes) - longitudeStep;
  let maximumLongitude = Math.max(...longitudes) + longitudeStep;
  if (northVisible || southVisible || maximumLongitude - minimumLongitude > 330) {
    minimumLongitude = centerLongitude - 180;
    maximumLongitude = centerLongitude + 180;
  }
  let minimumLatitude = Math.max(-89.999, Math.min(...latitudes) - latitudeStep);
  let maximumLatitude = Math.min(89.999, Math.max(...latitudes) + latitudeStep);
  if (northVisible) maximumLatitude = 89.999;
  if (southVisible) minimumLatitude = -89.999;
  const poles = [];
  if (northVisible) poles.push({location: [centerLongitude, 89.999], label: "90°N"});
  if (southVisible) poles.push({location: [centerLongitude, -89.999], label: "90°S"});
  const detailedPrecision = Math.max(0.01, Math.min(2.5, Math.min(longitudeStep, latitudeStep) / 5));
  const precision = simplified
    ? Math.max(detailedPrecision, Math.min(5, Math.max(0.25, Math.min(longitudeStep, latitudeStep))))
    : detailedPrecision;
  const minorCoordinates = [];
  const majorCoordinates = [];
  const lines = [];
  const longitudeMajorStep = majorGraticuleStep(longitudeStep);
  const latitudeMajorStep = majorGraticuleStep(latitudeStep);
  graticuleRange(minimumLongitude, maximumLongitude, longitudeStep).forEach((longitude) => {
    const line = graticuleLine(
      minimumLatitude,
      maximumLatitude,
      precision,
      (latitude) => [longitude, latitude]
    );
    const major = isMajorGraticuleValue(longitude, longitudeMajorStep);
    (major ? majorCoordinates : minorCoordinates).push(line);
    lines.push({axis: "longitude", value: longitude, coordinates: line, major});
  });
  graticuleRange(minimumLatitude, maximumLatitude, latitudeStep).forEach((latitude) => {
    const line = graticuleLine(
      minimumLongitude,
      maximumLongitude,
      precision,
      (longitude) => [longitude, latitude]
    );
    const major = isMajorGraticuleValue(latitude, latitudeMajorStep);
    (major ? majorCoordinates : minorCoordinates).push(line);
    lines.push({axis: "latitude", value: latitude, coordinates: line, major});
  });
  return {
    minorGeometry: {type: "MultiLineString", coordinates: minorCoordinates},
    majorGeometry: {type: "MultiLineString", coordinates: majorCoordinates},
    lines,
    poles,
    longitudeMajorStep,
    latitudeMajorStep
  };
}

function graticuleLabel(value, axis, step) {
  const normalized = axis === "longitude" ? normalizeRotationLongitude(value) : value;
  const absolute = Math.abs(normalized);
  const digits = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const number = absolute.toFixed(digits).replace(/\.0+$|(?<=\.[0-9])0+$/, "");
  if (absolute < 1e-8) return "0°";
  if (axis === "longitude" && Math.abs(absolute - 180) < 1e-8) return "180°";
  const direction = axis === "longitude"
    ? (normalized > 0 ? "E" : "W")
    : (normalized > 0 ? "N" : "S");
  return `${number}°${direction}`;
}

function graticuleLabelPoint(projection, line, width, height, excludedPoints = []) {
  const inset = 12;
  const points = line.coordinates
    .map((location) => projection(location))
    .filter((point) => point && point.every(Number.isFinite)
      && point[0] >= inset && point[0] <= width - inset
      && point[1] >= inset && point[1] <= height - inset
      && excludedPoints.every((excluded) => Math.hypot(point[0] - excluded[0], point[1] - excluded[1]) >= 72));
  if (!points.length) return null;
  return line.axis === "longitude"
    ? points.reduce((best, point) => (
      Math.abs(point[1] - height * 0.8) < Math.abs(best[1] - height * 0.8) ? point : best
    ))
    : points.reduce((best, point) => point[0] < best[0] ? point : best);
}

function updateGraticuleLabels(canvas, projection, lines, poles, width, height, longitudeStep, latitudeStep) {
  const labels = canvas.querySelector(".location-map__graticule-labels");
  if (!labels) return;
  labels.replaceChildren();
  const polePoints = poles
    .map((pole) => projection(pole.location))
    .filter((point) => point && point.every(Number.isFinite));
  lines.forEach((line) => {
    if (!line.major) return;
    const point = graticuleLabelPoint(projection, line, width, height, polePoints);
    if (!point) return;
    const step = line.axis === "longitude" ? longitudeStep : latitudeStep;
    const label = svgElement("text", {
      x: point[0],
      y: point[1],
      dx: line.axis === "latitude" ? 5 : 0,
      dy: line.axis === "longitude" ? -5 : 1,
      class: `location-map__graticule-label location-map__graticule-label--${line.axis}`
    });
    label.dataset.major = line.major ? "true" : "false";
    label.textContent = graticuleLabel(line.value, line.axis, step);
    labels.append(label);
  });
  poles.forEach((pole) => {
    const point = projection(pole.location);
    if (!point || !point.every(Number.isFinite)) return;
    const marker = svgElement("g", {class: "location-map__pole"});
    marker.append(svgElement("circle", {cx: point[0], cy: point[1], r: 3.2}));
    const label = svgElement("text", {x: point[0], y: point[1], dx: 7, dy: -7});
    label.textContent = pole.label;
    marker.append(label);
    labels.append(marker);
  });
}

function updateGraticule(canvas, projection, navigationScale = 1, force = false, simplified = false) {
  const minorShape = canvas.querySelector(".location-map__graticule--minor");
  const majorShape = canvas.querySelector(".location-map__graticule--major");
  if (!minorShape || !majorShape) return;
  const viewBox = canvas.ownerSVGElement && canvas.ownerSVGElement.viewBox.baseVal;
  const width = viewBox && viewBox.width || 1200;
  const height = viewBox && viewBox.height || 540;
  const [longitudeStep, latitudeStep] = graticuleSteps(projection, width, height, navigationScale);
  const stepKey = `${longitudeStep}x${latitudeStep}:${simplified ? "preview" : "detail"}`;
  if (!force && minorShape.dataset.step === stepKey && minorShape.getAttribute("d")) return;
  const graticule = visibleGraticule(
    projection,
    width,
    height,
    longitudeStep,
    latitudeStep,
    simplified
  );
  const path = geoPath(projection);
  minorShape.setAttribute("d", path(graticule.minorGeometry));
  majorShape.setAttribute("d", path(graticule.majorGeometry));
  const labels = canvas.querySelector(".location-map__graticule-labels");
  if (labels) labels.hidden = simplified;
  if (!simplified) {
    updateGraticuleLabels(
      canvas,
      projection,
      graticule.lines,
      graticule.poles,
      width,
      height,
      longitudeStep,
      latitudeStep
    );
  }
  minorShape.dataset.step = stepKey;
  minorShape.dataset.longitudeStep = String(longitudeStep);
  minorShape.dataset.latitudeStep = String(latitudeStep);
  minorShape.dataset.longitudeMajorStep = String(graticule.longitudeMajorStep);
  minorShape.dataset.latitudeMajorStep = String(graticule.latitudeMajorStep);
}

function visibleProjectedLocation(projection, location, width, height, padding = 0) {
  const rawClipAngle = projection.clipAngle();
  const clipAngle = rawClipAngle == null ? Number.NaN : Number(rawClipAngle);
  const sphericalClip = Number.isFinite(clipAngle) && clipAngle > 0;
  const center = sphericalClip ? projection.invert(projection.translate()) : null;
  if (sphericalClip && center
    && geoDistance(center, location) * 180 / Math.PI > clipAngle + 1e-6) return null;
  const point = projection(location);
  return point && point.every(Number.isFinite)
    && point[0] >= padding && point[0] <= width - padding
    && point[1] >= padding && point[1] <= height - padding
    ? point
    : null;
}

function projectedLocationVisible(projection, location, width, height) {
  return Boolean(visibleProjectedLocation(projection, location, width, height));
}

function poleNearViewportCenter(projection, width, height, distanceRatio = POLAR_CENTER_ENTER_RATIO) {
  const center = [width / 2, height / 2];
  const centerLocation = projection.invert(center);
  const longitude = centerLocation && Number.isFinite(centerLocation[0]) ? centerLocation[0] : 0;
  const threshold = Math.max(36, Math.min(width, height) * distanceRatio);
  return [89.999, -89.999].some((latitude) => {
    const point = projection([longitude, latitude]);
    return point && point.every(Number.isFinite)
      && Math.hypot(point[0] - center[0], point[1] - center[1]) <= threshold;
  });
}

function polarFixedOrientationAmount(projection, width, height) {
  const center = [width / 2, height / 2];
  const centerLocation = projection.invert(center);
  const longitude = centerLocation && Number.isFinite(centerLocation[0]) ? centerLocation[0] : 0;
  const minimumDimension = Math.max(1, Math.min(width, height));
  const distanceRatio = Math.min(...[89.999, -89.999].map((latitude) => {
    const point = projection([longitude, latitude]);
    return point && point.every(Number.isFinite)
      ? Math.hypot(point[0] - center[0], point[1] - center[1]) / minimumDimension
      : Infinity;
  }));
  const start = Math.max(POLAR_CENTER_ENTER_RATIO, 36 / minimumDimension);
  const progress = Math.max(0, Math.min(1,
    (distanceRatio - start) / Math.max(0.01, POLAR_CENTER_RECOVERY_RATIO - start)
  ));
  return progress * progress * (3 - 2 * progress);
}

function viewportProjection(projection, width, height, padding = 24) {
  return cloneProjection(projection).clipExtent([
    [-padding, -padding],
    [width + padding, height + padding]
  ]);
}

function focusedProjection(collection, focusItems, width, height, inset, data, paddingRatio = 0.1, preferAzimuthal = false, projectionMode = "auto", orientationMode = "north-up", orientationRoll = 0) {
  const focusedCollection = focusFeatureGroup(focusItems, data);
  const focusedItems = focusedCollection.features;
  const effectivePaddingRatio = focusedCollection.__atlasPrunedRemoteParts
    ? Math.max(paddingRatio, PRUNED_LANGUAGE_FOCUS_PADDING_RATIO)
    : paddingRatio;
  const center = geoCentroid(focusedCollection);
  const bounds = geoBounds(focusedCollection);
  const span = longitudeSpan(bounds);
  // fitExtent initially frames every retained part correctly.  When the
  // country-focus scale cap applies, keep that same whole-country framing:
  // using only the largest polygon here pushed split countries such as
  // Malaysia toward Borneo and clipped the peninsula from the viewport.
  const boundedLongitude = longitudeCenter(bounds);
  const longitude = Number.isFinite(boundedLongitude) ? boundedLongitude : center[0];
  const latitude = Number.isFinite(center[1]) ? center[1] : 0;
  const latitudeSpan = Math.max(0, bounds[1][1] - bounds[0][1]);
  const horizontalPadding = Math.max(inset, width * effectivePaddingRatio);
  const verticalPadding = Math.max(inset, height * effectivePaddingRatio);
  const automaticBounds = automaticProjectionBounds(focusedCollection, focusedItems, preferAzimuthal);
  const automaticDecision = automaticProjectionDecision(automaticBounds, preferAzimuthal);
  const family = projectionMode === "auto" ? automaticDecision.family : projectionMode;
  const rotatesToFocus = family === "azimuthal"
    || family === "azimuthal-equidistant"
    || family === "stereographic"
    || family === "gnomonic"
    || family === "orthographic";
  const roll = requestedOrientationRoll(orientationMode, orientationRoll) ?? orientationRoll;
  const projection = projectionForFamily(family);
  projection.__atlasAutomaticDecision = automaticDecision;
  if (family.startsWith("conic-")) configureFocusedConicProjection(projection, bounds, latitude);
  projection.rotate(rotatesToFocus ? [-longitude, -latitude, roll] : [-longitude, 0, roll]);
  projection.fitExtent(
    [[horizontalPadding, verticalPadding], [width - horizontalPadding, height - verticalPadding]],
    focusedCollection
  );
  return capCountryFocus(
    projection,
    width,
    height,
    horizontalPadding,
    verticalPadding,
    [longitude, latitude],
    [span, latitudeSpan],
    data
  );
}

function worldProjection(width, height, inset, centerLongitude = DEFAULT_WORLD_CENTER_LONGITUDE, projectionMode = "auto", orientationMode = "north-up", orientationRoll = 0) {
  const roll = requestedOrientationRoll(orientationMode, orientationRoll) ?? orientationRoll;
  const family = projectionMode === "auto" ? "equal-earth" : projectionMode;
  const projection = projectionForFamily(family);
  if (projectionMode === "auto") {
    projection.__atlasAutomaticDecision = {
      family: "equal-earth",
      reason: "world",
      span: 360,
      latitudeSpan: 180,
      middleLatitude: 0,
      northSouthRatio: 0.5,
      eastWestRatio: 2
    };
  }
  projection.rotate([-centerLongitude, 0, roll]);
  return projection.fitExtent(
    [[inset, inset], [width - inset, height - inset]],
    {type: "Sphere"}
  );
}

export function navigationLimits(path, width, height) {
  const fallback = {scaleExtent: [1, MAXIMUM_NAVIGATION_ZOOM], translateExtent: [[0, 0], [width, height]]};
  const bounds = path.bounds({type: "Sphere"});
  if (!bounds.flat().every(Number.isFinite)) return fallback;
  const worldWidth = bounds[1][0] - bounds[0][0];
  const worldHeight = bounds[1][1] - bounds[0][1];
  if (!(worldWidth > 0) || !(worldHeight > 0)) return fallback;
  const fitScale = Math.min(width / worldWidth, height / worldHeight);
  return {
    scaleExtent: [Math.min(1, fitScale), MAXIMUM_NAVIGATION_ZOOM],
    translateExtent: bounds
  };
}

export function absoluteZoomForProjectionScale(scale) {
  const numericScale = Number(scale);
  if (!(numericScale > 0)) return NaN;
  return Math.log2(numericScale / ABSOLUTE_ZOOM_BASE_SCALE);
}

export function projectionScaleForAbsoluteZoom(zoomLevel) {
  const numericZoom = Number(zoomLevel);
  if (!Number.isFinite(numericZoom)) return NaN;
  return ABSOLUTE_ZOOM_BASE_SCALE * (2 ** numericZoom);
}

function countrySelectionFocusFeatures(data, countryCodes = [], featureId = "", featureSource = features) {
  const countrySet = new Set(countryCodes || []);
  const selectionRules = new Map(Object.entries(data.feature_selections || {}));
  featureSource.forEach((item) => {
    if (item.properties && item.properties.selection_rule) {
      selectionRules.set(item.properties.id, item.properties.selection_rule);
    }
  });
  const focusedSelectionFeatureIds = new Set(Array.from(selectionRules.entries()).filter(([, rule]) => {
    return rule.focus_feature && (rule.countries || []).some((code) => countrySet.has(code));
  }).map(([id]) => id));
  const baseCountryFeatureIds = baseCountryFocusFeatureIds(data, countrySet, featureSource);
  return featureSource.filter((item) => {
    return item.properties.id === featureId
      || focusedSelectionFeatureIds.has(item.properties.id)
      // Claims, bases, and non-ISO aliases remain visible, but they must not
      // expand an ordinary country's fit extent.  Otherwise Akrotiri makes a
      // GB focus span Europe and Clipperton makes a FR focus span the Atlantic.
      || baseCountryFeatureIds.has(item.properties.id);
  });
}

function countrySelectionVisibleRatio(data, countryCodes, featureId, featureSource, projection, width, height) {
  if (!projection || !(width > 0) || !(height > 0)) return 0;
  const focusItems = countrySelectionFocusFeatures(data, countryCodes, featureId, featureSource);
  if (!focusItems.length) return 0;
  const collection = {
    type: "FeatureCollection",
    features: focusItems.map(focusFeature)
  };
  const inset = Math.min(
    COUNTRY_FOCUS_VIEWPORT_INSET,
    width * 0.04,
    height * 0.04
  );
  const clippedProjection = cloneProjection(projection).clipExtent([
    [inset, inset],
    [width - inset, height - inset]
  ]);
  const centroid = geoCentroid(collection);
  const centroidPath = geoPath(clippedProjection)({type: "Point", coordinates: centroid});
  if (!centroidPath) return 0;
  const totalProjection = cloneProjection(projection).clipExtent(null).clipAngle(null);
  const totalArea = geoPath(totalProjection).area(collection);
  if (!(totalArea > 0)) return 0;
  const visibleArea = geoPath(clippedProjection).area(collection);
  return Math.max(0, Math.min(1, visibleArea / totalArea));
}

function distributionRegionFocusFeature(region) {
  const longitude = Number(region?.center?.[0]);
  const latitude = Number(region?.center?.[1]);
  const radiusKm = Math.max(20, Number(region?.radius_km) || 100);
  if (![longitude, latitude, radiusKm].every(Number.isFinite)) return null;
  const latitudeRadians = latitude * Math.PI / 180;
  const longitudeRadians = longitude * Math.PI / 180;
  const angularRadius = radiusKm / 6371.0088;
  const ring = [];
  for (let index = 0; index <= 24; index += 1) {
    const bearing = index / 24 * Math.PI * 2;
    const latitudeAtBearing = Math.asin(
      Math.sin(latitudeRadians) * Math.cos(angularRadius)
      + Math.cos(latitudeRadians) * Math.sin(angularRadius) * Math.cos(bearing)
    );
    const longitudeAtBearing = longitudeRadians + Math.atan2(
      Math.sin(bearing) * Math.sin(angularRadius) * Math.cos(latitudeRadians),
      Math.cos(angularRadius) - Math.sin(latitudeRadians) * Math.sin(latitudeAtBearing)
    );
    ring.push([
      normalizeRotationLongitude(longitudeAtBearing * 180 / Math.PI),
      latitudeAtBearing * 180 / Math.PI
    ]);
  }
  return {
    type: "Feature",
    properties: {atlasRegion: true},
    geometry: {type: "Polygon", coordinates: [ring]}
  };
}

function fitProjection(width, height, data, language, countryCodes = [], featureId = "", forceWorld = false, viewpointCountry = "", projectionMode = "auto", featureSource = features, orientationMode = "north-up", orientationRoll = 0, languageRegionFeatures = [], regionalCountryReplacements = []) {
  const inset = width < 520 ? 8 : 14;
  const defaultWorldCenterLongitude = worldCenterLongitudeForViewpoint(data, viewpointCountry, featureSource);
  if (forceWorld) return worldProjection(width, height, inset, defaultWorldCenterLongitude, projectionMode, orientationMode, orientationRoll);
  const iso2ByIso3 = countryCodeIndex(data);
  const countrySet = new Set(countryCodes || []);
  const focusFeatures = countrySelectionFocusFeatures(data, countryCodes, featureId, featureSource);
  if (focusFeatures.length) {
    const collection = {type: "FeatureCollection", features: focusFeatures};
    return focusedProjection(collection, focusFeatures, width, height, inset, data, 0.1, countrySet.size === 1, projectionMode, orientationMode, orientationRoll);
  }
  const profile = language ? profileFor(data, language) : {};
  const distributionRegionFeatures = (profile.regions || [])
    .map(distributionRegionFocusFeature)
    .filter(Boolean);
  const scope = profile.scope && (data.scopes || {})[profile.scope];
  if (Array.isArray(scope) && scope.length === 2 && profile.force_scope) {
    const west = Number(scope[0][0]);
    const south = Number(scope[0][1]);
    const east = Number(scope[1][0]);
    const north = Number(scope[1][1]);
    const scopeFeature = {type: "Feature", properties: {}, geometry: {type: "Polygon", coordinates: [[[west, south], [west, north], [east, north], [east, south], [west, south]]]}};
    // A curated scope supplies useful surrounding context (for example the
    // Arabic-speaking resident population in Europe), but it must not crop
    // countries where the language has its principal or official status.
    const requiredCodes = new Set(languageScopeCountryCodes(language, profile, data, featureSource));
    const requiredFeatures = featureSource.filter((item) => requiredCodes.has(iso2ByIso3.get(item.properties.id)));
    const scopedFocusFeatures = [scopeFeature, ...requiredFeatures];
    const scopedCollection = {type: "FeatureCollection", features: scopedFocusFeatures};
    return focusedProjection(scopedCollection, scopedFocusFeatures, width, height, inset, data, 0.06, false, projectionMode, orientationMode, orientationRoll);
  }
  const centerLongitude = Number(profile.center_longitude);
  if (Number.isFinite(centerLongitude)) {
    return worldProjection(width, height, inset, centerLongitude, projectionMode, orientationMode, orientationRoll);
  }
  const regionalFocusFeatures = [...languageRegionFeatures, ...distributionRegionFeatures];
  if (language && regionalFocusFeatures.length) {
    const anchorCodes = new Set(languageCameraAnchorCountryCodes(language, profile, data, featureSource));
    const replacedCountries = new Set(regionalCountryReplacements || []);
    // A regional Admin-1 rule can replace a nationwide institutional fill.
    // In that case its exact regional geometry, rather than the whole parent
    // country, defines the camera extent. Other official countries remain
    // regular anchors (for example Fiji in a Hindi view).
    const anchorFeatures = featureSource.filter((item) => {
      const countryCode = iso2ByIso3.get(item.properties.id);
      return anchorCodes.has(countryCode) && !replacedCountries.has(countryCode);
    });
    const focusItems = [...regionalFocusFeatures, ...anchorFeatures];
    const collection = {type: "FeatureCollection", features: focusItems};
    return focusedProjection(collection, focusItems, width, height, inset, data, LANGUAGE_FOCUS_PADDING_RATIO, false, projectionMode, orientationMode, orientationRoll);
  }
  if (language) {
    const focusCodes = new Set(languageCameraAnchorCountryCodes(language, profile, data, featureSource));
    const languageFocusFeatures = featureSource.filter((item) => focusCodes.has(iso2ByIso3.get(item.properties.id)));
    if (languageFocusFeatures.length) {
      const collection = {type: "FeatureCollection", features: languageFocusFeatures};
      return focusedProjection(collection, languageFocusFeatures, width, height, inset, data, LANGUAGE_FOCUS_PADDING_RATIO, false, projectionMode, orientationMode, orientationRoll);
    }
  }
  return worldProjection(width, height, inset, defaultWorldCenterLongitude, projectionMode, orientationMode, orientationRoll);
}

function radiusPixels(projection, region, width) {
  const longitude = Number(region.center[0]);
  const latitude = Number(region.center[1]);
  const radiusKm = Math.max(20, Number(region.radius_km) || 100);
  const longitudeDegrees = radiusKm / (111.32 * Math.max(0.24, Math.cos(latitude * Math.PI / 180)));
  const center = projection([longitude, latitude]);
  const edge = projection([longitude + longitudeDegrees, latitude]);
  if (!center || !edge) return 0;
  return Math.max(10, Math.min(width * 0.23, Math.abs(edge[0] - center[0])));
}

function createMap(root, data, initialOptions) {
  let options = initialOptions;
  const selectedBoundaryMaskId = `atlas-selected-boundary-mask-${++mapInstanceSequence}`;
  const projectionModes = ["auto", "azimuthal", "azimuthal-equidistant", "stereographic", "gnomonic", "conic-equal-area", "conic-conformal", "conic-equidistant", "equirectangular", "orthographic", "equal-earth", "natural-earth-1", "mercator", "transverse-mercator"];
  const orientationModes = ["north-up", "northeast-up", "east-up", "southeast-up", "south-up", "southwest-up", "west-up", "northwest-up", "free", "custom"];
  const initialViewState = options.initialViewState || {};
  const initialCenter = Array.isArray(initialViewState.center)
    ? initialViewState.center.map(Number).slice(0, 2)
    : [];
  const initialZoom = Number(initialViewState.zoom);
  let viewpointCountry = viewpointCountryCode(options.viewpointCountry);
  const dataViewpointModel = data.viewpoint_resolution_model || {};
  const optionViewpointSpecified = Object.prototype.hasOwnProperty.call(options, "viewpoint")
    || Object.prototype.hasOwnProperty.call(options, "viewpointOverride");
  let configuredTerritorialViewpoint = configuredViewpoint(
    optionViewpointSpecified ? options.viewpoint : dataViewpointModel.viewpoint,
    optionViewpointSpecified ? options.viewpointOverride : dataViewpointModel.viewpoint_override,
    data.iso2_to_iso3
  );
  let mode = "country";
  let selectedCountry = options.initialCountry || "";
  let selectedCountries = new Set(selectedCountry ? [selectedCountry] : []);
  let selectedCountryLabel = "";
  let selectedFeatureId = "";
  let selectedLanguage = "";
  let selectedLanguageIds = [];
  let selectedLanguageLabel = "";
  let selectedLanguagesIgnoreAdmin1 = false;
  let resizeFrame = 0;
  let zoomBehavior = null;
  let navigationTransform = zoomIdentity;
  let navigationFrame = 0;
  let navigationGeneration = 0;
  let refreshNavigationSelection = null;
  let detailRestoreTimer = 0;
  let projectionMode = projectionModes.includes(initialViewState.projection) ? initialViewState.projection : "auto";
  let pendingProjectionView = initialCenter.length === 2
    && initialCenter.every(Number.isFinite)
    ? {
        center: initialCenter,
        ...(Number.isFinite(initialZoom) ? {zoom: initialZoom} : {})
      }
    : null;
  let movementMode = initialViewState.movement === "planar"
    ? "planar"
    : (initialViewState.movement === "globe"
      ? "globe"
      : (["mercator", "equirectangular"].includes(projectionMode) ? "planar" : "globe"));
  let shiftGesturePreview = false;
  let orientationMode = orientationModes.includes(initialViewState.orientation) ? initialViewState.orientation : "north-up";
  let orientationRoll = Number.isFinite(Number(initialViewState.roll))
    ? normalizeRotationLongitude(Number(initialViewState.roll))
    : (requestedOrientationRoll(orientationMode, 0) || 0);
  let placesData = null;
  let placeCountryEntries = [];
  let placeLoadGeneration = 0;
  let placeLoadLanguage = "";
  const placeLanguageLoads = new Map();
  let activeProjection = null;
  let planarProjection = null;
  let fittedProjectionScale = 1;
  let projectionScaleExtent = [1, Infinity];
  let cameraCustomized = Boolean(pendingProjectionView);
  let countryFocused = Boolean(selectedCountry);
  // Country context can constrain language results without taking ownership
  // of the camera. Map clicks use that in-place context; explicit country
  // navigation still asks fitProjection() to frame the selection.
  let countrySelectionDrivesCamera = Boolean(selectedCountry);
  let forceWorldView = false;
  let drawGeneration = 0;
  let destroyed = false;
  let lastUserInteractionAt = Date.now();
  let detailUpgradeTimer = 0;
  let detailUpgradeIdle = 0;
  const detailUpgradeNotBefore = Date.now() + 1000;
  const detailQuietWindowMs = 1200;
  const noteUserInteraction = () => { lastUserInteractionAt = Date.now(); };
  ["pointerdown", "keydown", "input", "wheel"].forEach((eventName) => {
    window.addEventListener(eventName, noteUserInteraction, {capture: true, passive: true});
  });
  let admin1Manifest = null;
  let admin1ManifestPromise = null;
  let admin1RequestKey = "";
  const admin1SourcePromises = new Map();
  const admin1BackgroundFetches = new Map();
  const admin1CountryPrefetches = new Map();
  const admin1CountryPrefetchPromises = new Map();
  const admin1FeaturesByCountryPrefetch = new Map();
  const admin1PrefetchedCountries = new Set();
  const countryAdmin1FeaturesByCode = new Map();
  const countryAdmin1LoadPromises = new Map();
  const countryAdmin1RegionLoadPromises = new Map();
  const countryAdmin1LoadedRegions = new Set();
  let countryAdmin1BoundaryGeneration = 0;
  let countryAdmin1RegionIndex = null;
  let admin1WorldPrefetch = null;
  let admin1WorldPrefetchPromise = null;
  let admin1BackgroundQueue = Promise.resolve();
  let cachedLabelScene = null;
  let placeLabelRelayoutToken = 0;
  let placeLabelRelayoutIdle = 0;
  let placeLabelRelayoutTimer = 0;

  function rememberLabelScene(scene) {
    cachedLabelScene = scene || null;
  }

  function cancelPlaceLabelRelayout() {
    placeLabelRelayoutToken += 1;
    if (placeLabelRelayoutIdle && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(placeLabelRelayoutIdle);
    }
    placeLabelRelayoutIdle = 0;
    if (placeLabelRelayoutTimer) window.clearTimeout(placeLabelRelayoutTimer);
    placeLabelRelayoutTimer = 0;
  }

  function schedulePlaceLabelRelayout(callback) {
    if (placeLabelRelayoutIdle && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(placeLabelRelayoutIdle);
    }
    placeLabelRelayoutIdle = 0;
    if (placeLabelRelayoutTimer) window.clearTimeout(placeLabelRelayoutTimer);
    placeLabelRelayoutTimer = 0;
    const token = ++placeLabelRelayoutToken;
    const run = () => {
      placeLabelRelayoutIdle = 0;
      placeLabelRelayoutTimer = 0;
      if (destroyed || token !== placeLabelRelayoutToken) return;
      callback();
    };
    if (typeof window.requestIdleCallback === "function") {
      placeLabelRelayoutIdle = window.requestIdleCallback(run, {timeout: 1200});
    } else {
      placeLabelRelayoutTimer = window.setTimeout(run, 0);
    }
  }

  function withLocalizedLabelScene(scene) {
    if (!scene) return null;
    const countryRows = countryRowsByCode();
    return {
      projection: scene.projection,
      countryAreas: scene.countryAreas,
      countryCandidates: scene.countryCandidates.map((item) => ({
        ...item,
        name: (countryRows.get(item.code) || {}).name || item.name,
        selected: selectedCountries.has(item.code)
      })).sort((left, right) => (
        Number(right.selected) - Number(left.selected) || right.area - left.area
      ))
    };
  }

  function placesReadyForUiLanguage() {
    return Boolean(
      placesData
      && placeLoadLanguage === normalize(options.language)
      && root.dataset.mapPlacesState === "ready"
    );
  }

  function placeLabelKey(coordinate) {
    return `${Number(coordinate[0])},${Number(coordinate[1])}`;
  }

  function relocalizePlaceLabelText(canvas) {
    if (!placesData || !canvas) return 0;
    const namesByKey = new Map();
    placeCountryEntries.forEach(([, country]) => {
      (country.places || []).forEach((row) => {
        namesByKey.set(placeLabelKey([row[0], row[1]]), placeName(row));
      });
    });
    let updated = 0;
    canvas.querySelectorAll(".location-map__place-label").forEach((label) => {
      const coordinate = label.__atlasCoordinate;
      if (!coordinate) return;
      const next = namesByKey.get(placeLabelKey(coordinate));
      if (next == null || label.textContent === next) return;
      label.textContent = next;
      updated += 1;
    });
    return updated;
  }

  function occupiedFromCountryLabels(canvas) {
    const occupied = new LabelCollisionIndex();
    canvas.querySelectorAll(".location-map__country-label").forEach((label) => {
      const selected = label.dataset.selected === "true";
      const x = Number(label.getAttribute("x"));
      const y = Number(label.getAttribute("y"));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const box = measureMapLabel(label.textContent || "", {
        fontSizeRem: selected ? 0.64 : 0.61,
        fontWeight: selected ? 800 : 720,
        x,
        y
      });
      occupied.add({
        x: box.x, y: box.y, width: box.width, height: box.height,
        countryCode: label.dataset.countryCode || "",
        element: label,
        originX: x,
        originY: y,
        originBoxX: box.x,
        originBoxY: box.y
      });
    });
    return occupied;
  }

  function paintLocalizedLabels(canvas, projection, width, height, iso2ByIso3) {
    cancelPlaceLabelRelayout();
    const drawingProjection = usesProjectedNavigation()
      ? viewportProjection(projection, width, height)
      : projection;
    const path = geoPath(drawingProjection);
    let labelScene = withLocalizedLabelScene(cachedLabelScene);
    let rebuiltScene = false;
    if (!labelScene) {
      labelScene = buildProjectedLabelScene(path, iso2ByIso3, width, height);
      rememberLabelScene(labelScene);
      rebuiltScene = true;
    }
    const occupied = drawCountryLabels(canvas, path, iso2ByIso3, width, height, null, labelScene);
    if (!placesReadyForUiLanguage()) {
      root.dataset.mapPlaceLabelsReused = "true";
      root.dataset.mapLabelSceneReused = rebuiltScene ? "false" : "true";
      return;
    }
    const hasPlaceLabels = Boolean(canvas.querySelector(".location-map__place-label"));
    if (hasPlaceLabels) {
      relocalizePlaceLabelText(canvas);
      root.dataset.mapPlaceLabelsReused = "true";
      root.dataset.mapLabelSceneReused = rebuiltScene ? "false" : "true";
      schedulePlaceLabelRelayout(() => {
        if (!canvas.isConnected || !placesReadyForUiLanguage()) return;
        const currentScene = withLocalizedLabelScene(cachedLabelScene) || labelScene;
        drawPlaceLabels(
          canvas,
          projection,
          width,
          height,
          occupiedFromCountryLabels(canvas),
          currentScene
        );
        root.dataset.mapPlaceLabelsReused = "false";
      });
      return;
    }
    drawPlaceLabels(canvas, projection, width, height, occupied, labelScene);
    root.dataset.mapPlaceLabelsReused = "false";
    root.dataset.mapLabelSceneReused = rebuiltScene ? "false" : "true";
  }

  function installPlaces(nextPlaces) {
    placesData = nextPlaces && nextPlaces.countries ? nextPlaces : null;
    placeCountryEntries = placesData ? Object.entries(placesData.countries) : [];
    root.dataset.mapPlacesLoaded = placesData ? "true" : "false";
  }

  function loadPlacesForUiLanguage(language, priority = "low") {
    const normalizedLanguage = normalize(language);
    if (!placeLanguageLoads.has(normalizedLanguage)) {
      const request = loadPlaceAssets(
        data.places,
        normalizedLanguage,
        data.toponym_resolution,
        options.toponymFallbackLocales,
        priority
      ).catch((error) => {
        placeLanguageLoads.delete(normalizedLanguage);
        throw error;
      });
      placeLanguageLoads.set(normalizedLanguage, request);
    }
    return placeLanguageLoads.get(normalizedLanguage);
  }

  function requestPlacesForUiLanguage() {
    if (!data.places) return false;
    const language = normalize(options.language);
    if (placeLoadLanguage === language && root.dataset.mapPlacesState === "loading") return true;
    if (placeLoadLanguage === language && placesData && root.dataset.mapPlacesState === "ready") return true;
    placeLoadLanguage = language;
    const generation = ++placeLoadGeneration;
    root.dataset.mapPlacesState = "loading";
    delete root.dataset.mapPlacesError;
    void loadPlacesForUiLanguage(language, "high").then((loaded) => {
      if (destroyed || generation !== placeLoadGeneration) return;
      installPlaces(loaded.places);
      root.dataset.mapPlacesState = "ready";
      root.dataset.mapPlacesScript = loaded.script;
      root.dataset.mapPlacesLocales = loaded.localeKeys.join(",");
      refreshLocalizedMap();
    }).catch((error) => {
      if (destroyed || generation !== placeLoadGeneration) return;
      root.dataset.mapPlacesState = "fallback";
      root.dataset.mapPlacesError = error?.message || "place labels unavailable";
    });
    return true;
  }

  function scheduleDetailedUpgrade(callback) {
    const queueWhenQuiet = () => {
      if (destroyed) return;
      const now = Date.now();
      const wait = Math.max(
        0,
        detailUpgradeNotBefore - now,
        detailQuietWindowMs - (now - lastUserInteractionAt)
      );
      if (wait > 0) {
        detailUpgradeTimer = window.setTimeout(queueWhenQuiet, wait);
        return;
      }
      const queueBackgroundWork = () => {
        if (destroyed) return;
        if (Date.now() - lastUserInteractionAt < detailQuietWindowMs) {
          queueWhenQuiet();
          return;
        }
        runBackgroundTask(() => {
          if (destroyed) return;
          if (Date.now() - lastUserInteractionAt < detailQuietWindowMs) {
            queueWhenQuiet();
            return;
          }
          callback();
        }).catch(() => {});
      };
      if (typeof window.requestIdleCallback === "function") {
        detailUpgradeIdle = window.requestIdleCallback(queueBackgroundWork, {timeout: 2500});
      } else {
        detailUpgradeTimer = window.setTimeout(queueBackgroundWork, 0);
      }
    };
    queueWhenQuiet();
  }

  function usesCylindricalProjection(mode = projectionMode) {
    return mode === "mercator" || mode === "transverse-mercator" || mode === "equirectangular";
  }

  function usesPlanarDefaultProjection(mode = projectionMode) {
    return mode === "mercator" || mode === "equirectangular";
  }

  function usesProjectedNavigation() {
    return movementMode === "globe" || usesCylindricalProjection();
  }
  const admin1FeaturesBySource = new Map();
  const admin1ConfiguredLanguages = new Set(data.admin1_languages || []);
  const admin1ConfiguredLanguageIds = Array.from(admin1ConfiguredLanguages);

  const initialChanges = prepareFeatures(data);
  const overviewFeatures = features.slice();
  const overviewFeaturesById = new Map(overviewFeatures.map((item) => [item.properties.id, item]));
  root.dataset.mapViewpointCountry = viewpointCountry;
  root.dataset.mapConfiguredViewpoint = configuredTerritorialViewpoint.country;
  root.dataset.mapViewpointOverride = String(configuredTerritorialViewpoint.override);
  root.dataset.mapUiLanguage = normalize(options.language);
  root.dataset.featureCanonicalization = String(initialChanges.canonicalized);
  root.dataset.geometryExclusions = String(initialChanges.exclusions);
  root.dataset.territoryExtracts = String(initialChanges.extracts);
  root.dataset.featureRegions = String(initialChanges.regions);
  root.dataset.mapProjection = projectionMode;
  root.dataset.mapMovement = movementMode;
  root.dataset.mapOrientation = orientationMode;
  root.dataset.mapOrientationRoll = String(orientationRoll);

  root.innerHTML = [
    '<label class="location-map__language" hidden><span></span><select></select></label>',
    '<div class="location-map__stage">',
    '  <svg class="location-map__svg" role="img"></svg>',
    '  <span class="location-map__center-marker" aria-hidden="true"></span>',
    '  <div class="location-map__topbar">',
    '    <div class="location-map__navigation" role="group">',
    '      <select class="location-map__navigation-mode" data-map-action="projection"></select>',
    '      <button type="button" class="location-map__navigation-mode" data-map-action="movement"></button>',
    '    </div>',
    '    <div class="location-map__projection-note"></div>',
    '  </div>',
  '  <div class="location-map__orientation-pad" role="group">',
    '    <span class="location-map__orientation-ring" aria-hidden="true"></span>',
    '    <kbd class="location-map__modifier-hint location-map__modifier-hint--orientation" aria-hidden="true">Ctrl/⌘</kbd>',
    '    <button type="button" data-map-orientation="northwest-up"></button>',
    '    <button type="button" data-map-orientation="north-up"></button>',
    '    <button type="button" data-map-orientation="northeast-up"></button>',
    '    <button type="button" data-map-orientation="west-up"></button>',
    '    <button type="button" data-map-orientation="free"></button>',
    '    <button type="button" data-map-orientation="east-up"></button>',
    '    <button type="button" data-map-orientation="southwest-up"></button>',
    '    <button type="button" data-map-orientation="south-up"></button>',
    '    <button type="button" data-map-orientation="southeast-up"></button>',
    '  </div>',
    '  <div class="location-map__stage-footer">',
    '    <div class="location-map__status" aria-live="polite"></div>',
    '    <div class="location-map__zoom-pad" role="group">',
    '      <button type="button" data-map-action="zoom-in">+</button>',
    '      <button type="button" data-map-action="world">◎</button>',
    '      <button type="button" data-map-action="viewpoint"><span aria-hidden="true">⌖</span></button>',
    '      <button type="button" data-map-action="zoom-out">−</button>',
    '      <output class="location-map__center-coordinates" hidden></output>',
    '    </div>',
    '    <div class="location-map__legend"></div>',
    '  </div>',
    '</div>'
  ].join("");

  const languageField = root.querySelector(".location-map__language");
  const languageLabel = languageField.querySelector("span");
  const languageSelect = languageField.querySelector("select");
  const navigation = root.querySelector(".location-map__navigation");
  const projectionNote = root.querySelector(".location-map__projection-note");
  const svg = root.querySelector(".location-map__svg");
  const stage = root.querySelector(".location-map__stage");
  const centerCoordinates = root.querySelector(".location-map__center-coordinates");
  const legend = root.querySelector(".location-map__legend");
  const status = root.querySelector(".location-map__status");

  function viewportCenterLocation(projectionOverride = null) {
    const width = Math.max(280, stage.clientWidth || root.clientWidth || 600);
    const height = Number(svg.getAttribute("height")) || Math.max(210, width * 0.53);
    let center = null;
    if (projectionOverride && typeof projectionOverride.invert === "function") {
      center = projectionOverride.invert([width / 2, height / 2]);
    } else if (usesProjectedNavigation() && activeProjection) {
      center = activeProjection.invert([width / 2, height / 2]);
    } else if (planarProjection) {
      center = planarProjection.invert(navigationTransform.invert([width / 2, height / 2]));
    }
    if (!center || center.length !== 2 || !center.every(Number.isFinite)) return null;
    return [normalizeRotationLongitude(center[0]), Math.max(-90, Math.min(90, center[1]))];
  }

  function formattedCoordinate(value, positiveSuffix, negativeSuffix) {
    const displayValue = Math.abs(value) < 0.005 ? 0 : value;
    return `${Math.abs(displayValue).toFixed(2)}\u00b0${displayValue < 0 ? negativeSuffix : positiveSuffix}`;
  }

  function syncCenterCoordinates(projectionOverride = null) {
    const center = viewportCenterLocation(projectionOverride);
    centerCoordinates.hidden = !center;
    if (!center) {
      centerCoordinates.textContent = "";
      delete root.dataset.mapCenterLongitude;
      delete root.dataset.mapCenterLatitude;
      return;
    }
    const [longitude, latitude] = center;
    const latitudeText = formattedCoordinate(latitude, "N", "S");
    const longitudeText = formattedCoordinate(longitude, "E", "W");
    const text = `${latitudeText}  ${longitudeText}`;
    centerCoordinates.textContent = `${latitudeText}\n${longitudeText}`;
    centerCoordinates.setAttribute("aria-label", text);
    centerCoordinates.setAttribute("title", text);
    root.dataset.mapCenterLongitude = longitude.toFixed(4);
    root.dataset.mapCenterLatitude = latitude.toFixed(4);
  }

  function currentViewState() {
    const state = {
      projection: projectionMode,
      movement: movementMode,
      orientation: orientationMode,
      roll: currentOrientationRoll()
    };
    if (!cameraCustomized) return state;
    const center = viewportCenterLocation();
    const zoomLevel = navigationZoomLevel();
    if (center && center.length === 2 && center.every(Number.isFinite) && Number.isFinite(zoomLevel)) {
      state.center = center;
      state.zoom = zoomLevel;
    }
    return state;
  }

  function notifyViewChange() {
    if (typeof options.onViewChange === "function") options.onViewChange(currentViewState());
  }

  function messages() {
    return localizedMessages(data, options.language, options.messages);
  }

  function countryByCode(code) {
    return (options.countries || []).find((item) => item.code === code);
  }

  function countrySetSummary(codes, label) {
    const rows = (codes || []).map(countryByCode).filter(Boolean);
    const candidates = new Set(rows.flatMap((item) => item.candidateLocales || []));
    return {
      flag: rows.length === 1 ? rows[0].flag : "",
      name: label || rows.map((item) => item.name).join(" + "),
      candidateCount: candidates.size
    };
  }

  function featureInfo(item, iso2ByIso3, countryRows) {
    const featureId = item.properties.id;
    const selectionRule = selectionRuleForFeature(data, item);
    const rule = selectionRule.rule;
    const directCode = iso2ByIso3.get(featureId) || (data.feature_code_aliases || {})[featureId] || "";
    const resolutionViewpointCountry = configuredTerritorialViewpoint.override
      ? configuredTerritorialViewpoint.country
      : viewpointCountry;
    const defaultViewpointCountry = !configuredTerritorialViewpoint.override
      ? configuredTerritorialViewpoint.country
      : "";
    const selectionCodes = rule
      ? selectionCountriesForRule(rule, resolutionViewpointCountry, data.viewpoint_groups, defaultViewpointCountry)
      : (directCode ? [directCode] : []);
    const displayCodes = displayCountriesForRule(rule, resolutionViewpointCountry, data.viewpoint_groups, defaultViewpointCountry);
    const presentation = overlayPresentationForRule(rule, resolutionViewpointCountry, data.viewpoint_groups, defaultViewpointCountry);
    const locale = normalize(options.language);
    const propertyLabel = localizedFeatureName(
      item.properties,
      locale,
      data.toponym_resolution,
      options.toponymFallbackLocales
    );
    const ruleLabels = rule && rule.name && typeof rule.name === "object" && !Array.isArray(rule.name)
      ? {...rule.name}
      : {};
    const localizedLabel = rule
      ? resolveToponym(
        ruleLabels,
        locale,
        data.toponym_resolution,
        options.toponymFallbackLocales,
        propertyLabel
      )
      : propertyLabel;
    if (!selectionCodes.length) {
      const unclaimed = Boolean(rule && presentation.viewpointLevel === "unclaimed");
      return {
        featureId,
        code: "",
        selectionCodes: [],
        displayCodes: [],
        country: null,
        name: localizedLabel,
        disputed: unclaimed,
        regionSelection: unclaimed && selectionRule.regionSelection,
        regionOverlay: unclaimed && Boolean(rule.region_overlay),
        clickPriority: false,
        focusFeature: false,
        overlayHidden: presentation.hidden,
        masksUnderlying: presentation.masksUnderlying,
        partyEquivalentView: false,
        viewpointLevel: presentation.viewpointLevel,
        settledBoundary: Boolean(item.properties.settled_boundary)
      };
    }
    if (!rule) {
      const country = countryRows.get(directCode);
      return {featureId, code: directCode, selectionCodes, displayCodes: [], country, name: country && country.name, selectionName: country && country.name, disputed: false, regionSelection: false, regionOverlay: false, clickPriority: false, focusFeature: false, overlayHidden: false, masksUnderlying: false, partyEquivalentView: false, settledBoundary: Boolean(item.properties.settled_boundary)};
    }
    const selectionNames = rule.selection_name && typeof rule.selection_name === "object"
      ? rule.selection_name
      : {};
    const explicitSelectionLabel = resolveToponym(
      selectionNames,
      locale,
      data.toponym_resolution,
      options.toponymFallbackLocales,
      ""
    );
    const parties = partyCountriesForRule(rule);
    const partyView = Boolean(resolutionViewpointCountry && parties.includes(resolutionViewpointCountry));
    const resolvedCountry = selectionCodes.length === 1 ? countryRows.get(selectionCodes[0]) : null;
    const countryNames = selectionCodes.map((code) => countryRows.get(code)).filter(Boolean).map((country) => country.name);
    const selectionName = explicitSelectionLabel || (partyView && resolvedCountry ? resolvedCountry.name : countryNames.join(" + ")) || localizedLabel;
    const candidates = new Set();
    selectionCodes.forEach((code) => {
      const country = countryRows.get(code);
      (country && country.candidateLocales || []).forEach((localeId) => candidates.add(localeId));
    });
    return {
      featureId,
      code: selectionCodes[0],
      selectionCodes,
      displayCodes,
      country: {code: featureId, name: selectionName, flag: "", candidateCount: candidates.size},
      name: localizedLabel,
      selectionName,
      disputed: parties.length > 1 || Boolean(rule.self_administered),
      regionSelection: selectionRule.regionSelection,
      regionOverlay: Boolean(rule.region_overlay),
      clickPriority: Boolean(rule.click_priority),
      focusFeature: Boolean(rule.focus_feature),
      overlayHidden: presentation.hidden,
      masksUnderlying: presentation.masksUnderlying,
      partyEquivalentView: presentation.partyEquivalentView,
      viewpointLevel: presentation.viewpointLevel,
      adminCodes: uniqueCodes(rule.admin_countries),
      partyCodes: parties,
      selfAdministered: Boolean(rule.self_administered),
      claimOnlyCodes: uniqueCodes(rule.claim_only_countries),
      settledBoundary: Boolean(item.properties.settled_boundary)
    };
  }

  let countryRowsSource = null;
  let countryRowsCache = new Map();
  let labelFeatureFactsSource = null;
  let labelFeatureFactsCache = [];

  function countryRowsByCode() {
    if (countryRowsSource !== options.countries) {
      countryRowsSource = options.countries;
      countryRowsCache = new Map((options.countries || []).map((item) => [item.code, item]));
    }
    return countryRowsCache;
  }

  function labelFeatureFacts() {
    if (labelFeatureFactsSource === features) return labelFeatureFactsCache;
    const startedAt = performance.now();
    labelFeatureFactsSource = features;
    labelFeatureFactsCache = features.map((item) => {
      // Country-label placement only needs a stable representative polygon.
      // Reuse the already prepared 110m overview geometry when possible rather
      // than walking every vertex of the settled 10m map.  Keep the current
      // feature object for names, selection rules, and viewpoint handling.
      const geometrySource = overviewFeaturesById.get(item.properties.id) || item;
      const polygons = geometryPolygons(geometrySource);
      const largest = polygons.map((coordinates) => {
        const geometry = {type: "Polygon", coordinates};
        return {geometry, area: geoArea(geometry)};
      }).sort((left, right) => right.area - left.area)[0];
      const geometry = largest && largest.geometry || geometrySource;
      return {
        item,
        geometry,
        center: geoCentroid(geometry),
        sphericalArea: largest ? largest.area : geoArea(geometrySource)
      };
    });
    root.dataset.mapLabelFactsMs = (performance.now() - startedAt).toFixed(2);
    root.dataset.mapLabelFacts = String(labelFeatureFactsCache.length);
    return labelFeatureFactsCache;
  }

  function projectedLabelFact(fact, path, width, height) {
    const projection = path.projection();
    if (!projection || !fact.center || !fact.center.every(Number.isFinite)) return null;
    // A point path is enough to honour the projection's clipping rules.  It
    // avoids walking every vertex of the 10m polygon just to learn whether its
    // label anchor is visible.
    const pointGeometry = {type: "Point", coordinates: fact.center};
    const bounds = path.bounds(pointGeometry);
    if (!bounds.flat().every(Number.isFinite)
      || bounds[1][0] < 0 || bounds[0][0] > width
      || bounds[1][1] < 0 || bounds[0][1] > height) return null;
    const point = projection(fact.center);
    if (!point || !point.every(Number.isFinite)
      || point[0] < 0 || point[0] > width
      || point[1] < 0 || point[1] > height) return null;

    // Estimate projected land area from the cached spherical area and the
    // projection's local Jacobian.  Label density only needs a stable visual
    // weight, not the exact SVG path area.  This turns an O(total vertices)
    // operation into O(number of features) per frame.
    const epsilon = 0.04;
    const longitude = fact.center[0];
    const latitude = Math.max(-89.9, Math.min(89.9, fact.center[1]));
    const east = projection([longitude + epsilon, latitude]);
    const north = projection([longitude, Math.min(89.95, latitude + epsilon)]);
    if (!east || !north || !east.every(Number.isFinite) || !north.every(Number.isFinite)) return null;
    const determinant = Math.abs(
      (east[0] - point[0]) * (north[1] - point[1])
      - (east[1] - point[1]) * (north[0] - point[0])
    );
    const radians = epsilon * Math.PI / 180;
    const localSteradians = Math.max(1e-10, Math.cos(latitude * Math.PI / 180) * radians * radians);
    const area = Math.min(width * height, fact.sphericalArea * determinant / localSteradians);
    if (!Number.isFinite(area) || area <= 0) return null;
    return {point, area};
  }

  function buildProjectedLabelScene(path, iso2ByIso3, width, height, visibleFeatureIds = null) {
    const startedAt = performance.now();
    const countryRows = countryRowsByCode();
    const candidates = new Map();
    const countryAreas = new Map();
    const minimumArea = Math.max(150, width * height * 0.00016);
    labelFeatureFacts().forEach((fact) => {
      const item = fact.item;
      const info = featureInfo(item, iso2ByIso3, countryRows);
      if (!info.country || info.regionSelection || info.disputed || info.selectionCodes.length !== 1) return;
      const projected = projectedLabelFact(fact, path, width, height);
      if (!projected) return;
      const {area, point} = projected;
      const code = info.selectionCodes[0];
      // Keep the largest visible component.  Summing every remote island would
      // make a country look denser than the land actually visible in this view.
      countryAreas.set(code, Math.max(countryAreas.get(code) || 0, area));
      if (visibleFeatureIds && !visibleFeatureIds.has(info.featureId)
        && !selectedCountries.has(code)) return;
      const selected = selectedCountries.has(info.selectionCodes[0]);
      if (!selected && area < minimumArea) return;
      const candidate = {
        code: info.selectionCodes[0],
        name: info.country.name,
        area,
        point,
        coordinate: fact.center,
        selected
      };
      const previous = candidates.get(candidate.code);
      if (!previous || candidate.area > previous.area) candidates.set(candidate.code, candidate);
    });
    const scene = {
      projection: path.projection(),
      countryAreas,
      countryCandidates: Array.from(candidates.values()).sort((left, right) => (
        Number(right.selected) - Number(left.selected) || right.area - left.area
      ))
    };
    root.dataset.mapLabelSceneMs = (performance.now() - startedAt).toFixed(2);
    return scene;
  }

  function countryLabelCandidates(path, iso2ByIso3, width, height, visibleFeatureIds = null, labelScene = null) {
    const scene = labelScene || buildProjectedLabelScene(path, iso2ByIso3, width, height, visibleFeatureIds);
    return scene.countryCandidates;
  }

  function labelBoxesOverlap(left, right, padding = 4) {
    return mapLabelBoxesOverlap(left, right, padding);
  }

  function drawCountryLabels(canvas, path, iso2ByIso3, width, height, visibleFeatureIds = null, labelScene = null) {
    const startedAt = performance.now();
    const previous = canvas.querySelector(".location-map__country-labels");
    if (previous) previous.remove();
    const group = svgElement("g", {class: "location-map__country-labels", "aria-hidden": "true"});
    const occupied = new LabelCollisionIndex();
    delete root.dataset.mapCountryLabelsSuppressed;
    const candidates = countryLabelCandidates(path, iso2ByIso3, width, height, visibleFeatureIds, labelScene);
    root.dataset.mapCountryLabelCandidates = String(candidates.length);
    root.dataset.mapLabelLayout = "measured-grid";
    canvas.append(group);
    candidates.slice(0, 60).forEach((item) => {
      const placeCountry = placesData?.countries?.[item.code];
      if (item.selected && placeCountry?.prefer_place_labels_when_selected) return;
      const label = svgElement("text", {
        x: item.point[0],
        y: item.point[1],
        class: "location-map__country-label"
      });
      label.dataset.countryCode = item.code;
      if (item.selected) label.dataset.selected = "true";
      label.__atlasCoordinate = item.coordinate;
      label.textContent = item.name;
      const box = measureMapLabel(item.name, {
        fontSizeRem: item.selected ? 0.64 : 0.61,
        fontWeight: item.selected ? 800 : 720,
        x: item.point[0], y: item.point[1]
      });
      const inside = box.x >= 3 && box.y >= 3
        && box.x + box.width <= width - 3
        && box.y + box.height <= height - 3;
      if (!inside || occupied.collides(box)) return;
      group.append(label);
      occupied.add({
        x: box.x, y: box.y, width: box.width, height: box.height,
        countryCode: item.code,
        element: label,
        originX: item.point[0],
        originY: item.point[1],
        originBoxX: box.x,
        originBoxY: box.y
      });
    });
    root.dataset.mapCountryLabelMs = (performance.now() - startedAt).toFixed(2);
    return occupied;
  }

  function relocateCountryLabelForCapital(countryCode, capitalBox, occupied, width, height) {
    const countryBox = occupied.find((item) => item.countryCode === countryCode && item.element);
    if (!countryBox || !labelBoxesOverlap(capitalBox, countryBox, 3)) return;
    const shifts = [
      [0, -15], [0, 15], [-34, 0], [34, 0],
      [-28, -14], [28, -14], [-28, 14], [28, 14]
    ];
    for (const [dx, dy] of shifts) {
      const next = {
        x: countryBox.originBoxX + dx,
        y: countryBox.originBoxY + dy,
        width: countryBox.width,
        height: countryBox.height
      };
      const inside = next.x >= 3 && next.y >= 3
        && next.x + next.width <= width - 3 && next.y + next.height <= height - 3;
      const collides = labelBoxesOverlap(next, capitalBox, 3)
        || occupied.collides(next, 3, countryBox);
      if (!inside || collides) continue;
      countryBox.element.setAttribute("x", String(countryBox.originX + dx));
      countryBox.element.setAttribute("y", String(countryBox.originY + dy));
      occupied.update(countryBox, next);
      return;
    }
    countryBox.element.setAttribute("x", String(countryBox.originX));
    countryBox.element.setAttribute("y", String(countryBox.originY));
  }

  function placeName(row) {
    const localized = row[6] || {};
    return resolveToponym(
      localized,
      options.language,
      data.toponym_resolution,
      options.toponymFallbackLocales,
      row[5]
    );
  }

  function placeZoomLevel(projection, width, height) {
    const family = projectionFamily(projection);
    const reference = worldProjection(width, height, 14, DEFAULT_WORLD_CENTER_LONGITUDE, family, "north-up");
    const ratio = projection.scale() / Math.max(1, reference.scale());
    return Math.max(1, 1 + Math.log2(Math.max(1, ratio)));
  }

  function projectedCountryAreas(projection, width, height, labelScene = null) {
    if (labelScene) return labelScene.countryAreas;
    const path = geoPath(projection);
    const iso2ByIso3 = countryCodeIndex(data);
    return buildProjectedLabelScene(path, iso2ByIso3, width, height).countryAreas;
  }

  function placeMarkerProfile(row) {
    const population = Math.max(0, Number(row[4]) || 0);
    return {
      radius: population >= 10_000_000 ? 3.4
        : population >= 5_000_000 ? 3.0
          : population >= 2_000_000 ? 2.55
            : population >= 1_000_000 ? 2.2
              : population >= 500_000 ? 1.85 : 1.55,
      scale: population >= 10_000_000 ? "mega"
        : population >= 5_000_000 ? "large"
          : population >= 2_000_000 ? "major"
            : population >= 500_000 ? "regional" : "local"
    };
  }

  function appendPlaceMarker(group, row, point, {capital = false, representative = false} = {}) {
    const profile = placeMarkerProfile(row);
    const marker = svgElement("circle", {
      cx: point[0], cy: point[1], r: profile.radius,
      class: "location-map__place-marker"
    });
    marker.dataset.scale = profile.scale;
    if (capital) marker.dataset.capital = "true";
    if (representative) marker.dataset.representative = "true";
    marker.__atlasCoordinate = [Number(row[0]), Number(row[1])];
    group.append(marker);
    return marker;
  }

  function placeLabelStyle(markerScale, capital, representative) {
    if (capital || representative) return {fontSizeRem: 0.55, fontWeight: 760};
    if (markerScale === "mega") return {fontSizeRem: 0.58, fontWeight: 820};
    if (markerScale === "large") return {fontSizeRem: 0.55, fontWeight: 760};
    if (markerScale === "major") return {fontSizeRem: 0.52, fontWeight: 680};
    return {fontSizeRem: 0.49, fontWeight: 590};
  }

  function capitalMarkerVisibleAtZoom(minimumZoom, zoomLevel, prioritized) {
    if (prioritized) return true;
    return zoomLevel + 2 >= Math.max(1, Number(minimumZoom) || 9);
  }

  function placePriorityCountryCodes() {
    if (mode !== "language") return selectedCountries;
    const languages = selectedLanguages();
    const prioritized = new Set();
    languages.forEach((language) => {
      const profile = profileFor(data, language);
      (options.countries || []).forEach((country) => {
        const role = countryRole(language, profile, country.code);
        if (role === "countrywide" || role === "official") prioritized.add(country.code);
      });
    });
    selectedAdmin1Regions(languages).forEach((item) => {
      if (item.country) prioritized.add(item.country);
    });
    return prioritized;
  }

  function drawPlaceLabels(canvas, projection, width, height, occupied = new LabelCollisionIndex(), labelScene = null) {
    const startedAt = performance.now();
    const previous = canvas.querySelector(".location-map__place-labels");
    if (previous) previous.remove();
    if (!placesData || !placesData.countries) {
      root.dataset.mapPlaceLabelMs = "0.00";
      return;
    }
    const collisionIndex = occupied instanceof LabelCollisionIndex
      ? occupied
      : new LabelCollisionIndex();
    if (Array.isArray(occupied)) occupied.forEach((box) => collisionIndex.add(box));
    const group = svgElement("g", {class: "location-map__place-labels", "aria-hidden": "true"});
    const placeProjection = labelScene?.projection || projection;
    const countryAreas = projectedCountryAreas(projection, width, height, labelScene);
    const zoomLevel = placeZoomLevel(placeProjection, width, height);
    const selected = placePriorityCountryCodes();
    root.dataset.mapPlacePriorityCountries = String(selected.size);
    root.dataset.mapPlaceZoom = zoomLevel.toFixed(2);
    // Capitals are geographic anchors, but rendering every capital on a world
    // view overwhelms the map and makes every motion frame unnecessarily
    // expensive. Reuse the curated minimum-zoom ranks, with a two-level marker
    // allowance so important capitals appear before their labels. Prioritized
    // countries remain visible regardless of zoom.
    let capitalAreaCountries = 0;
    let visibleCapitalMarkers = 0;
    const capitalMarkers = new Map();
    const placeMarkerKey = (row) => `${row[0]},${row[1]}`;
    placeCountryEntries.forEach(([countryCode, country]) => {
      if ((countryAreas.get(countryCode) || 0) < 0.75) return;
      capitalAreaCountries += 1;
      (country.places || []).forEach((row) => {
        if (!row[3]) return;
        if (!capitalMarkerVisibleAtZoom(row[2], zoomLevel, selected.has(countryCode))) return;
        const point = visibleProjectedLocation(
          placeProjection,
          [Number(row[0]), Number(row[1])],
          width,
          height,
          3
        );
        if (!point) return;
        capitalMarkers.set(
          placeMarkerKey(row),
          appendPlaceMarker(group, row, point, {capital: true})
        );
        visibleCapitalMarkers += 1;
      });
    });
    root.dataset.mapPlaceCapitalAreaCountries = String(capitalAreaCountries);
    root.dataset.mapPlaceVisibleCapitals = String(visibleCapitalMarkers);
    const candidates = [];
    // Projected land area is the primary density signal: large countries
    // should not remain visually empty merely because their population is
    // sparse.  Country-specific priorities still promote globally familiar
    // cities in smaller countries.
    const labelAreaUnit = Math.max(2200, width * height * 0.0055);
    root.dataset.mapPlaceAreaUnit = String(Math.round(labelAreaUnit));
    placeCountryEntries.forEach(([countryCode, country]) => {
      const isSelected = selected.has(countryCode);
      const budget = Number(country.budget || 1);
      const projectedCapacity = Math.max(1, Math.ceil((countryAreas.get(countryCode) || 0) / labelAreaUnit));
      const broadLabelFloor = Math.min(budget, Math.max(1, Number(country.broad_label_floor) || 1));
      const selectedLabelFloor = Math.min(
        budget,
        Math.max(broadLabelFloor, Number(country.selected_label_floor) || 2)
      );
      const selectedFloor = isSelected ? selectedLabelFloor : broadLabelFloor;
      const limit = Math.min(budget, Math.max(selectedFloor, projectedCapacity));
      const areaVisibilityBoost = Math.min(2, Math.max(0, projectedCapacity - 1) * 0.35);
      const detailVisibilityBoost = zoomLevel >= 4.5 ? 0.75 : zoomLevel >= 3.8 ? 0.35 : 0;
      const visibilityBoost = isSelected
        ? 2.25
        : Math.max(areaVisibilityBoost, detailVisibilityBoost);
      const visible = [];
      (country.places || []).forEach((row, index) => {
        const point = visibleProjectedLocation(
          placeProjection,
          [Number(row[0]), Number(row[1])],
          width,
          height,
          8
        );
        const minimumZoom = Number(row[2]) || 9;
        const capital = Boolean(row[3]);
        const representative = Number.isInteger(country.representative_place_index)
          ? index === country.representative_place_index
          : Boolean(country.representative_place && row[5] === country.representative_place);
        const population = Math.max(0, Number(row[4]) || 0);
        const prominenceBoost = capital
          ? 0.35
          : population >= 5_000_000 ? 0.45
            : population >= 1_500_000 ? 0.25 : 0;
        if (!point || zoomLevel + visibilityBoost + prominenceBoost < minimumZoom) return;
        visible.push({countryCode, row, point, capital, representative, isSelected, index, countryLimit: limit});
      });
      // Do not slice here.  A capital can collide with its country label; later
      // cities must remain available to fill the country's projected capacity.
      candidates.push(...visible);
    });
    candidates.sort((left, right) => (
      Number(right.isSelected) - Number(left.isSelected)
      || Number(right.representative) - Number(left.representative)
      || Number(right.capital) - Number(left.capital)
      || left.index - right.index
    ));
    canvas.append(group);
    const offsets = [[6, -4], [6, 4], [-6, -4], [-6, 4], [0, -7], [0, 7]];
    const renderedByCountry = new Map();
    let rendered = 0;
    candidates.some((item) => {
      if (rendered >= 80) return true;
      if ((renderedByCountry.get(item.countryCode) || 0) >= item.countryLimit) return false;
      const markerScale = placeMarkerProfile(item.row).scale;
      // Move an always-on capital anchor into the label's paint position.  If
      // the pre-pass clipped it, create it here.  Either way an accepted
      // capital label and its dot stay coupled without duplicating markers.
      const persistentCapitalMarker = item.capital
        ? capitalMarkers.get(placeMarkerKey(item.row))
        : null;
      const marker = persistentCapitalMarker || appendPlaceMarker(group, item.row, item.point, {
        capital: item.capital,
        representative: item.representative
      });
      if (persistentCapitalMarker) group.append(marker);
      let accepted = false;
      for (const [dx, dy] of offsets) {
        const anchor = dx < 0 ? "end" : dx > 0 ? "start" : "middle";
        const text = placeName(item.row);
        const label = svgElement("text", {
          x: item.point[0], y: item.point[1], dx, dy,
          class: "location-map__place-label"
        });
        label.dataset.anchor = anchor;
        label.dataset.scale = markerScale;
        if (item.capital) label.dataset.capital = "true";
        if (item.representative) label.dataset.representative = "true";
        label.__atlasCoordinate = [Number(item.row[0]), Number(item.row[1])];
        label.textContent = text;
        const box = measureMapLabel(text, {
          ...placeLabelStyle(markerScale, item.capital, item.representative),
          x: item.point[0], y: item.point[1], dx, dy, anchor
        });
        const inside = box.x >= 3 && box.y >= 3
          && box.x + box.width <= width - 3 && box.y + box.height <= height - 3;
        if (inside && (item.capital || item.representative)) {
          relocateCountryLabelForCapital(item.countryCode, box, collisionIndex, width, height);
        }
        if (inside && !collisionIndex.collides(box, 3)) {
          group.append(label);
          collisionIndex.add(box);
          accepted = true;
          rendered += 1;
          renderedByCountry.set(item.countryCode, (renderedByCountry.get(item.countryCode) || 0) + 1);
          break;
        }
      }
      if (!accepted && marker && !persistentCapitalMarker) marker.remove();
      return false;
    });
    root.dataset.mapPlaceLabels = String(rendered);
    root.dataset.mapLabelCollisionChecks = "grid";
    root.dataset.mapPlaceLabelMs = (performance.now() - startedAt).toFixed(2);
  }

  function languageById(id) {
    return (options.languages || []).find((item) => item.id === id);
  }

  function languageForUi() {
    const requested = normalize(options.language);
    return (options.languages || []).find((item) => {
      const aliases = [item.id].concat(item.aliases || []).map(normalize);
      return aliases.includes(requested) || aliases.map(base).includes(base(requested));
    });
  }

  function selectedLanguages() {
    const ids = selectedLanguageIds.length ? selectedLanguageIds : [selectedLanguage];
    return ids.map(languageById).filter(Boolean);
  }

  function selectedLanguagesText(languages = selectedLanguages()) {
    if (!languages.length) return "";
    if (languages.length === 1) return languages[0].name;
    if (selectedLanguageLabel) return `${selectedLanguageLabel} · ${languages.length}`;
    const template = messages().selectedLanguages || "{count} languages selected";
    return template.replace("{count}", String(languages.length));
  }

  function combinedLanguage(languages) {
    const collect = (key) => Array.from(new Set(languages.flatMap((language) => language[key] || [])));
    return {
      id: "__selection__",
      name: selectedLanguagesText(languages),
      countrywide: collect("countrywide"),
      official: collect("official"),
      regional: collect("regional"),
      protected: collect("protected"),
      // A multi-language selection represents a family, branch, script, or
      // other analytical group. Resident communities remain visible through
      // the individual language layers, but they must not pull the shared
      // camera away from the group's structural language regions.
      resident: [],
      global: languages.some((language) => language.global)
    };
  }

  function syncLanguageSelect() {
    const languages = (options.languages || []).slice().sort((a, b) => a.name.localeCompare(b.name, options.language));
    const knownIds = new Set(languages.map((item) => item.id));
    selectedLanguageIds = selectedLanguageIds.filter((id) => knownIds.has(id));
    if (!selectedLanguageIds.length) {
      const uiLanguage = languageForUi();
      selectedLanguage = languageById(selectedLanguage) ? selectedLanguage : (uiLanguage || languages[0] || {}).id || "";
      selectedLanguageIds = selectedLanguage ? [selectedLanguage] : [];
    } else {
      selectedLanguage = selectedLanguageIds[0];
    }
    const languageOptions = languages.map((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name;
      return option;
    });
    if (selectedLanguageIds.length > 1) {
      const option = document.createElement("option");
      option.value = "__selection__";
      option.textContent = selectedLanguagesText();
      languageOptions.unshift(option);
    }
    languageSelect.replaceChildren(...languageOptions);
    languageSelect.value = selectedLanguageIds.length > 1 ? "__selection__" : selectedLanguage;
  }

  function syncNavigationControls(projectionOverride = null) {
    const copy = messages();
    const projectionSelect = navigation.querySelector('[data-map-action="projection"]');
    const movementButton = navigation.querySelector('[data-map-action="movement"]');
    const orientationPad = root.querySelector(".location-map__orientation-pad");
    const controlProjection = projectionOverride || activeProjection;
    if (controlProjection) {
      root.dataset.mapProjectionRotationLatitude = String(controlProjection.rotate()[1] || 0);
      root.dataset.mapProjectionCenterLatitude = String(controlProjection.center()[1] || 0);
    }
    const projectionNames = {
      auto: copy.projectionAuto || "Auto",
      azimuthal: copy.projectionAzimuthal || "Azimuthal equal-area",
      "azimuthal-equidistant": copy.projectionAzimuthalEquidistant || "Azimuthal equidistant",
      stereographic: copy.projectionStereographic || "Stereographic",
      gnomonic: copy.projectionGnomonic || "Gnomonic",
      "conic-equal-area": copy.projectionConicEqualArea || "Equal-area conic",
      "conic-conformal": copy.projectionConicConformal || "Conformal conic",
      "conic-equidistant": copy.projectionConicEquidistant || "Equidistant conic",
      equirectangular: copy.projectionEquirectangular || "Equidistant cylindrical",
      orthographic: copy.projectionOrthographic || "Orthographic",
      "equal-earth": copy.projectionEqualEarth || "Equal Earth",
      "natural-earth-1": copy.projectionNaturalEarth1 || "Natural Earth 1",
      mercator: copy.projectionMercator || "Mercator",
      "transverse-mercator": copy.projectionTransverseMercator || "Transverse Mercator"
    };
    const movementNames = {
      planar: copy.movementPlanar || "Planar",
      globe: copy.movementGlobe || "Globe"
    };
    const projectionGroups = [
      {values: ["auto"]},
      {
        label: copy.projectionGroupAzimuthal || "Azimuthal projections",
        values: ["azimuthal", "azimuthal-equidistant", "stereographic", "gnomonic", "orthographic"]
      },
      {
        label: copy.projectionGroupConic || "Conic projections",
        values: ["conic-equal-area", "conic-conformal", "conic-equidistant"]
      },
      {
        label: copy.projectionGroupCylindrical || "Cylindrical projections",
        values: ["equirectangular", "mercator", "transverse-mercator"]
      },
      {
        label: copy.projectionGroupPseudocylindrical || "Pseudocylindrical projections",
        values: ["equal-earth", "natural-earth-1"]
      }
    ];
    const projectionDescriptions = {
      auto: copy.projectionDescriptionAuto || "Chooses a projection suited to the current selection.",
      azimuthal: copy.projectionDescriptionAzimuthal || "Preserves area and directions from the center; shapes distort toward the edge.",
      "azimuthal-equidistant": copy.projectionDescriptionAzimuthalEquidistant || "Preserves directions and distances from the center; area and shape distort toward the edge.",
      stereographic: copy.projectionDescriptionStereographic || "Preserves angles locally, while area expands rapidly away from the center.",
      gnomonic: copy.projectionDescriptionGnomonic || "Draws great-circle routes as straight lines, but cannot show a full hemisphere at once.",
      orthographic: copy.projectionDescriptionOrthographic || "Resembles a globe viewed from afar and shows only the facing hemisphere.",
      "conic-equal-area": copy.projectionDescriptionConicEqualArea || "Preserves area and suits east–west regions in the middle latitudes.",
      "conic-conformal": copy.projectionDescriptionConicConformal || "Preserves local angles and shapes and suits middle-latitude maps.",
      "conic-equidistant": copy.projectionDescriptionConicEquidistant || "Preserves distance along meridians and scale along its standard parallels.",
      equirectangular: copy.projectionDescriptionEquirectangular || "Uses evenly spaced straight longitude and latitude lines; area and distance generally distort.",
      mercator: copy.projectionDescriptionMercator || "Preserves angles and makes rhumb lines straight, but greatly enlarges high latitudes.",
      "equal-earth": copy.projectionDescriptionEqualEarth || "Preserves world-area proportions while moderating visible shape distortion.",
      "natural-earth-1": copy.projectionDescriptionNaturalEarth1 || "Balances the appearance of a world map without strictly preserving area, angle, or distance.",
      "transverse-mercator": copy.projectionDescriptionTransverseMercator || "Turns the Mercator cylinder sideways; well suited to north–south regions, with distortion increasing away from the central meridian."
    };
    const resolvedProjectionMode = projectionMode === "auto"
      ? (controlProjection && projectionFamily(controlProjection)
        || root.dataset.mapResolvedProjection
        || "")
      : projectionMode;
    const resolvedProjectionName = projectionNames[resolvedProjectionMode] || "";
    const projectionDescription = projectionMode === "auto" && resolvedProjectionName
      ? (copy.projectionAutoSelected || "Automatically selected: {mode}. {description}")
        .replace("{mode}", resolvedProjectionName)
        .replace("{description}", projectionDescriptions[resolvedProjectionMode])
      : projectionDescriptions[projectionMode];
    const displayedMovementMode = shiftGesturePreview
      ? (movementMode === "planar" ? "globe" : "planar")
      : movementMode;
    const movementName = usesCylindricalProjection(resolvedProjectionMode) && displayedMovementMode === "globe"
      ? (copy.movementMercatorAxis || "Projection axis")
      : movementNames[displayedMovementMode];
    const orientationNames = {
      "north-up": copy.orientationNorthUp || "North up",
      "northeast-up": copy.orientationNortheastUp || "Northeast up",
      "east-up": copy.orientationEastUp || "East up",
      "southeast-up": copy.orientationSoutheastUp || "Southeast up",
      "south-up": copy.orientationSouthUp || "South up",
      "southwest-up": copy.orientationSouthwestUp || "Southwest up",
      "west-up": copy.orientationWestUp || "West up",
      "northwest-up": copy.orientationNorthwestUp || "Northwest up",
      free: copy.orientationFree || "Free rotation",
      custom: copy.orientationCustom || "Custom angle"
    };
    const cardinalLabels = {
      "north-up": copy.orientationNorthShort || "N",
      "east-up": copy.orientationEastShort || "E",
      "south-up": copy.orientationSouthShort || "S",
      "west-up": copy.orientationWestShort || "W"
    };
    const projectionLabel = (copy.projectionControl || "Projection: {mode}").replace("{mode}", projectionNames[projectionMode]);
    const movementLabel = (copy.movementControl || "Movement: {mode}").replace("{mode}", movementName);
    const shiftGestureHint = copy.shiftGestureHint || "Shift + drag to temporarily switch movement";
    const rollGestureHint = copy.rollGestureHint || "Ctrl/⌘ + drag to rotate";
    projectionSelect.replaceChildren(...projectionGroups.flatMap((group) => {
      const options = group.values.map((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = projectionNames[value];
        return option;
      });
      if (!group.label) return options;
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.label;
      optgroup.append(...options);
      return [optgroup];
    }));
    projectionSelect.value = projectionMode;
    projectionSelect.setAttribute("aria-label", projectionLabel);
    projectionSelect.setAttribute("title", `${projectionLabel} — ${projectionDescription}`);
    projectionSelect.dataset.value = projectionMode;
    projectionNote.textContent = projectionDescription;
    const movementModifierHint = document.createElement("kbd");
    movementModifierHint.className = "location-map__modifier-hint";
    movementModifierHint.textContent = "⇧ Shift";
    movementModifierHint.setAttribute("aria-hidden", "true");
    movementButton.replaceChildren(document.createTextNode(movementName), movementModifierHint);
    movementButton.setAttribute("aria-label", `${movementLabel} — ${shiftGestureHint}`);
    movementButton.setAttribute("title", `${movementLabel} — ${shiftGestureHint}`);
    movementButton.setAttribute("aria-pressed", movementMode === "globe" ? "true" : "false");
    movementButton.dataset.value = movementMode;
    movementButton.dataset.gesture = displayedMovementMode;
    movementButton.disabled = false;
    if (shiftGesturePreview) movementButton.dataset.shiftPreview = "true";
    else delete movementButton.dataset.shiftPreview;
    orientationPad.hidden = !usesProjectedNavigation();
    const orientationControlLabel = copy.orientationControlLabel || "Map orientation";
    orientationPad.setAttribute("aria-label", `${orientationControlLabel} — ${rollGestureHint}`);
    orientationPad.setAttribute("title", rollGestureHint);
    const configuredRoll = requestedOrientationRoll(orientationMode, orientationRoll) ?? orientationRoll;
    const actualRoll = normalizeRotationLongitude(controlProjection
      ? (controlProjection.rotate()[2] || 0)
      : configuredRoll);
    const fallbackDialAngle = orientationDialAngle(actualRoll);
    const viewBox = svg.viewBox && svg.viewBox.baseVal;
    const dialAngle = controlProjection && viewBox && viewBox.width && viewBox.height
      ? projectedNorthAngle(controlProjection, viewBox.width, viewBox.height, fallbackDialAngle)
      : fallbackDialAngle;
    const roundedRoll = Math.round(dialAngle);
    orientationPad.style.setProperty("--map-roll", `${dialAngle}deg`);
    orientationPad.dataset.roll = String(dialAngle);
    orientationPad.dataset.custom = orientationMode === "custom" ? "true" : "false";
    orientationPad.setAttribute("aria-valuetext", `${roundedRoll}°`);
    orientationPad.querySelectorAll("button[data-map-orientation]").forEach((button) => {
      const value = button.dataset.mapOrientation;
      const displayMode = value === "free" && orientationMode === "custom"
        ? `${orientationNames.custom} (${roundedRoll}°)`
        : orientationNames[value];
      const label = (copy.orientationControl || "Orientation: {mode}").replace("{mode}", displayMode);
      if (cardinalLabels[value]) button.dataset.cardinalLabel = cardinalLabels[value];
      else delete button.dataset.cardinalLabel;
      if (value === "free") button.dataset.angle = `${roundedRoll}°`;
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
      button.setAttribute("aria-pressed", value === orientationMode
        || (value === "free" && orientationMode === "custom") ? "true" : "false");
      button.disabled = value !== "free" && root.dataset.mapOrientationAuto === "polar-center";
      if (button.disabled) button.dataset.auto = "relaxed";
      else delete button.dataset.auto;
    });
    syncCenterCoordinates(projectionOverride);
  }

  function syncResolvedProjectionSummary(projection) {
    const resolvedMode = projectionFamily(projection);
    root.dataset.mapResolvedProjection = resolvedMode;
    root.dataset.mapProjectionRotationLatitude = String(projection.rotate()[1] || 0);
    root.dataset.mapProjectionCenterLatitude = String(projection.center()[1] || 0);
    const decision = projection.__atlasAutomaticDecision;
    if (decision) {
      root.dataset.mapAutoReason = decision.reason;
      root.dataset.mapAutoLongitudeSpan = decision.span.toFixed(2);
      root.dataset.mapAutoLatitudeSpan = decision.latitudeSpan.toFixed(2);
      root.dataset.mapAutoNorthSouthRatio = decision.northSouthRatio.toFixed(2);
      root.dataset.mapAutoEastWestRatio = decision.eastWestRatio.toFixed(2);
    } else {
      delete root.dataset.mapAutoReason;
      delete root.dataset.mapAutoLongitudeSpan;
      delete root.dataset.mapAutoLatitudeSpan;
      delete root.dataset.mapAutoNorthSouthRatio;
      delete root.dataset.mapAutoEastWestRatio;
    }
    if (projectionMode !== "auto") return;
    const copy = messages();
    const names = {
      azimuthal: copy.projectionAzimuthal || "Azimuthal equal-area",
      "conic-equal-area": copy.projectionConicEqualArea || "Equal-area conic",
      "equal-earth": copy.projectionEqualEarth || "Equal Earth",
      "transverse-mercator": copy.projectionTransverseMercator || "Transverse Mercator"
    };
    const descriptions = {
      azimuthal: copy.projectionDescriptionAzimuthal || "Preserves area and directions from the center; shapes distort toward the edge.",
      "conic-equal-area": copy.projectionDescriptionConicEqualArea || "Preserves area and suits east–west regions in the middle latitudes.",
      "equal-earth": copy.projectionDescriptionEqualEarth || "Preserves world-area proportions while moderating visible shape distortion.",
      "transverse-mercator": copy.projectionDescriptionTransverseMercator || "Turns the Mercator cylinder sideways; well suited to north–south regions, with distortion increasing away from the central meridian."
    };
    const name = names[resolvedMode] || resolvedMode;
    const description = (copy.projectionAutoSelected || "Automatically selected: {mode}. {description}")
      .replace("{mode}", name)
      .replace("{description}", descriptions[resolvedMode] || "");
    if (projectionNote.textContent !== description) projectionNote.textContent = description;
    const projectionSelect = navigation.querySelector('[data-map-action="projection"]');
    const projectionLabel = (copy.projectionControl || "Projection: {mode}")
      .replace("{mode}", copy.projectionAuto || "Auto");
    projectionSelect.setAttribute("title", `${projectionLabel} — ${description}`);

    const movementButton = navigation.querySelector('[data-map-action="movement"]');
    const displayedMovementMode = shiftGesturePreview
      ? (movementMode === "planar" ? "globe" : "planar")
      : movementMode;
    const movementName = usesCylindricalProjection(resolvedMode) && displayedMovementMode === "globe"
      ? (copy.movementMercatorAxis || "Projection axis")
      : (displayedMovementMode === "planar"
        ? (copy.movementPlanar || "Planar")
        : (copy.movementGlobe || "Globe"));
    const movementLabel = (copy.movementControl || "Movement: {mode}").replace("{mode}", movementName);
    const shiftGestureHint = copy.shiftGestureHint || "Shift + drag to temporarily switch movement";
    const movementModifierHint = document.createElement("kbd");
    movementModifierHint.className = "location-map__modifier-hint";
    movementModifierHint.textContent = "⇧ Shift";
    movementModifierHint.setAttribute("aria-hidden", "true");
    movementButton.replaceChildren(document.createTextNode(movementName), movementModifierHint);
    movementButton.setAttribute("aria-label", `${movementLabel} — ${shiftGestureHint}`);
    movementButton.setAttribute("title", `${movementLabel} — ${shiftGestureHint}`);
  }

  function populateControls() {
    const copy = messages();
    languageLabel.textContent = copy.languageLabel || "Language to display";
    languageSelect.setAttribute("aria-label", copy.languageLabel || "Language to display");
    syncLanguageSelect();
    languageField.hidden = true;
    const navigationLabels = {
      "zoom-out": copy.zoomOut || "Zoom out",
      world: copy.resetView || "Reset to the current selection",
      "zoom-in": copy.zoomIn || "Zoom in"
    };
    root.querySelectorAll('button[data-map-action^="zoom"], button[data-map-action="world"]').forEach((button) => {
      const label = navigationLabels[button.dataset.mapAction];
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    });
    const viewpointButton = root.querySelector('[data-map-action="viewpoint"]');
    const viewpoint = countryByCode(viewpointCountry);
    viewpointButton.hidden = !viewpoint;
    viewpointButton.disabled = !viewpoint;
    if (viewpoint) {
      const label = (copy.goToViewpointCountry || "Go to detected country: {country}")
        .replace("{country}", viewpoint.name);
      viewpointButton.setAttribute("aria-label", label);
      viewpointButton.setAttribute("title", label);
    }
    syncNavigationControls();
    const atlas = root.closest(".country-atlas");
    if (atlas) atlas.dataset.mapMode = mode;
  }

  function setMode(nextMode, preserveNavigation = false) {
    mode = nextMode === "language" ? "language" : "country";
    forceWorldView = false;
    if (!preserveNavigation) {
      activeProjection = null;
      navigationTransform = zoomIdentity;
      pendingProjectionView = null;
    }
    const atlas = root.closest(".country-atlas");
    if (atlas) atlas.dataset.mapMode = mode;
    languageField.hidden = true;
    draw(preserveNavigation, !preserveNavigation);
  }

  function updateCountryStatus(country, labelOnly = false) {
    if (!country) return;
    status.textContent = labelOnly
      ? `${country.flag || ""} ${country.name}`.trim()
      : `${country.flag || ""} ${country.name} — ${country.candidateCount} ${options.labels.locationTotal}`.trim();
  }

  function featureStatusName(item) {
    if (!item) return "";
    return item.name || item.selectionName || "";
  }

  function selectedCountryUsesRegionLabel() {
    if (!selectedCountryLabel) return false;
    const ordinaryLabel = Array.from(selectedCountries)
      .map(countryByCode)
      .filter(Boolean)
      .map((country) => country.name)
      .join(" + ");
    return selectedCountryLabel !== ordinaryLabel;
  }

  function updateLanguageStatus(languages) {
    if (!languages.length) return;
    const text = selectedLanguagesText(languages);
    const href = languages.length === 1 && languages[0].available !== false
      ? languages[0].href
      : "";
    if (!href) {
      status.textContent = text;
      return;
    }
    const link = document.createElement("a");
    link.href = href;
    link.textContent = text;
    link.dataset.mapLanguageLink = languages[0].id;
    status.replaceChildren(link);
  }

  function updateLanguageCountryStatus(country, role) {
    if (!country) return;
    const copy = messages();
    const labels = {
      countrywide: options.labels.countrywide || copy.countrywide,
      official: options.labels.official || copy.officialLegend,
      regional: options.labels.regional || copy.regional,
      protected: options.labels.protected || copy.protectedLegend,
      "neighbor-countrywide": options.labels.neighborCountrywide,
      resident: options.labels.resident || copy.residentLegend,
      "neighbor-official": options.labels.neighborOfficial
    };
    status.textContent = `${country.flag || ""} ${country.name}${labels[role] ? ` — ${labels[role]}` : ""}`.trim();
  }

  // Paint semantics are weak -> strong. Whole-country shapes are compacted to
  // the strongest visible mark; the result is identical to drawing every layer
  // in this order without paying for duplicate paths.
  const countryRolePaintOrder = [
    "neighbor-official",
    "resident",
    "neighbor-countrywide",
    "protected",
    "regional",
    "official",
    "countrywide"
  ];
  const countryRolePriority = new Map(
    countryRolePaintOrder.map((role, index) => [role, index + 1])
  );
  const accessRoleProperty = {
    "neighbor-official": "neighborOfficial",
    resident: "resident",
    "neighbor-countrywide": "neighborCountrywide",
    official: "official",
    regional: "regional",
    protected: "protected",
    countrywide: "countrywide"
  };

  function strongerCountryMark(best, candidate) {
    if (!candidate) return best;
    if (!best) return candidate;
    const bestPriority = countryRolePriority.get(best.role) || 0;
    const candidatePriority = countryRolePriority.get(candidate.role) || 0;
    if (candidatePriority !== bestPriority) {
      return candidatePriority > bestPriority ? candidate : best;
    }
    const bestIntensity = Number.isFinite(best.intensity) ? best.intensity : 1;
    const candidateIntensity = Number.isFinite(candidate.intensity) ? candidate.intensity : 1;
    return candidateIntensity > bestIntensity ? candidate : best;
  }

  function compactCountryMarks(marks) {
    return (marks || []).filter(Boolean).reduce(strongerCountryMark, null);
  }

  function accessCountryMarks(language, profile, code) {
    return countryRolePaintOrder.map((role) => {
      if (!profileUsesAccessRole(profile, role)) return null;
      return classifiedCountryMark(language[accessRoleProperty[role]] || [], role, code);
    }).filter(Boolean);
  }

  function accessCountryMark(language, profile, code) {
    return compactCountryMarks(accessCountryMarks(language, profile, code));
  }

  function countryMarks(language, profile, code) {
    return [
      ...accessCountryMarks(language, profile, code),
      classifiedCountryMark(profileRoleEntries(profile, "resident"), "resident", code),
      classifiedCountryMark(profileRoleEntries(profile, "official"), "official", code),
      classifiedCountryMark(profileRoleEntries(profile, "countrywide"), "countrywide", code)
    ].filter(Boolean);
  }

  function countryMark(language, profile, code) {
    return compactCountryMarks(countryMarks(language, profile, code));
  }

  function countryRole(language, profile, code) {
    return countryMark(language, profile, code)?.role || "";
  }

  function admin1RuleFeatures(rule) {
    const regionIds = new Set(rule.regions || []);
    const featureIds = new Set(rule.feature_ids || []);
    const source = rule.source || rule.country;
    const countryPrefetchFeatures = (admin1FeaturesByCountryPrefetch.get(rule.country) || [])
      .filter((feature) => {
        const languages = feature.properties?.prefetch_languages || [];
        return !languages.length || languages.includes(source);
      });
    const sourceFeatures = admin1FeaturesBySource.has(source)
      ? (admin1FeaturesBySource.get(source) || [])
      : countryPrefetchFeatures;
    const regionalFeatures = regionIds.size
      ? sourceFeatures.filter(
        (feature) => regionIds.has(feature.properties?.id)
      )
      : [];
    const mapFeatures = featureIds.size
      ? features.filter((feature) => featureIds.has(feature.properties?.id))
      : [];
    return [...regionalFeatures, ...mapFeatures];
  }

  function admin1RuleGeometryReady(rule) {
    if ((rule.feature_ids || []).length) return true;
    const source = rule.source || rule.country;
    if (admin1FeaturesBySource.has(source)) return true;
    const regionIds = new Set(rule.regions || []);
    if (!regionIds.size) return true;
    const availableIds = new Set(
      (admin1FeaturesByCountryPrefetch.get(rule.country) || [])
        .filter((feature) => {
          const languages = feature.properties?.prefetch_languages || [];
          return !languages.length || languages.includes(source);
        })
        .map((feature) => feature.properties?.id)
        .filter(Boolean)
    );
    return Array.from(regionIds).every((id) => availableIds.has(id));
  }

  function admin1LanguageId(language) {
    const requested = normalize(language?.id || language);
    const exact = admin1ConfiguredLanguageIds.find((id) => normalize(id) === requested);
    if (exact) return exact;
    const aliases = [language?.id || language].concat(language?.aliases || [])
      .map(normalize)
      .filter(Boolean);
    const direct = admin1ConfiguredLanguageIds.find((id) => aliases.includes(normalize(id)));
    if (direct) return direct;
    const baseMatches = admin1ConfiguredLanguageIds.filter((id) => (
      aliases.some((alias) => base(alias) === base(id))
    ));
    return baseMatches.length === 1 ? baseMatches[0] : "";
  }

  function admin1RulesForLanguage(language) {
    if (!admin1Manifest) return [];
    const languageId = admin1LanguageId(language);
    return languageId ? (admin1Manifest.languages?.[languageId] || []) : [];
  }

  function admin1ReplacementRule(languageId, country) {
    if (!admin1Manifest) return null;
    return admin1RulesForLanguage(languageId).find((rule) => {
      return rule.country === country
        && rule.replace_country_role === true
        && admin1RuleFeatures(rule).length > 0;
    }) || null;
  }

  function admin1ReplacesCountryRole(languageId, country) {
    return Boolean(admin1ReplacementRule(languageId, country));
  }

  function admin1CountryRemainderMark(languageId, country) {
    const rule = admin1ReplacementRule(languageId, country);
    if (!rule || !rule.remainder_role) return null;
    return {
      role: rule.remainder_role,
      intensity: Number.isFinite(rule.remainder_intensity) ? rule.remainder_intensity : null,
      statusOnly: false
    };
  }

  function layeredCountryMarks(language, profile, code) {
    const marks = countryMarks(language, profile, code);
    if (!admin1ReplacesCountryRole(language.id, code)) return marks;

    // An Admin-1 replacement is more specific than every whole-country fill,
    // including adjacency-derived recommendations. Otherwise an indigenous
    // regional language can still paint its parent country as a neighboring
    // language (for example Azerbaijani in Iran), obscuring the regional role.
    const replacedWholeCountryRoles = new Set([
      "countrywide",
      "official",
      "regional",
      "protected",
      "resident",
      "neighbor-countrywide",
      "neighbor-official"
    ]);
    const withoutReplacedCountryRoles = marks.filter(
      (mark) => !replacedWholeCountryRoles.has(mark.role)
    );
    const remainder = admin1CountryRemainderMark(language.id, code);
    if (remainder && countryRolePriority.has(remainder.role)) withoutReplacedCountryRoles.push(remainder);
    return withoutReplacedCountryRoles;
  }

  function admin1LanguageIds(languages) {
    return Array.from(new Set(languages.map(admin1LanguageId).filter(Boolean)));
  }

  function loadAdmin1Manifest() {
    if (admin1Manifest) return Promise.resolve(admin1Manifest);
    if (!data.admin1_url) return Promise.resolve(null);
    if (!admin1ManifestPromise) {
      admin1ManifestPromise = fetch(data.admin1_url, {credentials: "same-origin"})
        .then((response) => {
          if (!response.ok) throw new Error(`Admin-1 manifest unavailable: ${response.status}`);
          return response.json();
        })
        .then((manifest) => {
          admin1Manifest = manifest;
          return manifest;
        })
        .catch((error) => {
          // A preload failure must not permanently cache a rejected promise;
          // selecting a regional language later should be able to retry.
          admin1ManifestPromise = null;
          throw error;
        });
    }
    return admin1ManifestPromise;
  }

  function admin1SourceUrl(manifest, source) {
    return manifest.sources?.[source] || manifest.countries?.[source] || "";
  }

  function loadAdmin1Source(source, url) {
    if (admin1FeaturesBySource.has(source)) {
      return Promise.resolve(admin1FeaturesBySource.get(source));
    }
    if (!admin1SourcePromises.has(source)) {
      const backgroundFetch = admin1BackgroundFetches.get(source);
      const fetchCollection = () => fetchGzipJson(url);
      const collection = backgroundFetch
        ? backgroundFetch.catch(fetchCollection)
        : fetchCollection();
      const request = collection
        .then((collection) => {
          // Custom regional geometries can come from sources with the opposite
          // ring convention. D3 treats that as the globe complement, so defend
          // here as well as in the build step for already-published chunks.
          const sourceFeatures = Array.isArray(collection?.features)
            ? collection.features.map(normalizeFeatureWinding)
            : [];
          admin1FeaturesBySource.set(source, sourceFeatures);
          return sourceFeatures;
        })
        .catch((error) => {
          // Allow a language-specific request to retry a chunk whose
          // background preload failed.
          admin1SourcePromises.delete(source);
          throw error;
        });
      admin1SourcePromises.set(source, request);
    }
    return admin1SourcePromises.get(source);
  }

  function runWhenIdle(callback) {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(callback, {timeout: 2000});
      return;
    }
    window.setTimeout(callback, 250);
  }

  function prefetchAdmin1Source(source, url) {
    if (!source || !url || admin1FeaturesBySource.has(source) || admin1SourcePromises.has(source)) {
      return Promise.resolve();
    }
    if (!admin1BackgroundFetches.has(source)) {
      const request = fetchGzipJson(url, "low")
        .catch((error) => {
          admin1BackgroundFetches.delete(source);
          throw error;
        });
      admin1BackgroundFetches.set(source, request);
    }
    return admin1BackgroundFetches.get(source);
  }

  function prefetchAdmin1Country(country, url) {
    if (!country || !url || admin1FeaturesByCountryPrefetch.has(country)) {
      return Promise.resolve();
    }
    if (!admin1CountryPrefetches.has(country)) {
      const request = fetchGzipJson(url, "low")
        .catch((error) => {
          admin1CountryPrefetches.delete(country);
          throw error;
        });
      admin1CountryPrefetches.set(country, request);
    }
    return admin1CountryPrefetches.get(country);
  }

  function cacheAdmin1PrefetchSources(collection, features) {
    const sources = Array.isArray(collection?.prefetch_sources)
      ? collection.prefetch_sources
      : [];
    sources.forEach((source) => {
      if (!source || admin1FeaturesBySource.has(source)) return;
      const sourceFeatures = features.filter((feature) => {
        const languages = feature.properties?.prefetch_languages || [];
        return languages.includes(source);
      });
      if (sourceFeatures.length) admin1FeaturesBySource.set(source, sourceFeatures);
    });
    root.dataset.mapAdmin1SourceCache = Array.from(admin1FeaturesBySource.keys()).join(",");
  }

  function loadPrefetchedAdmin1Country(country) {
    if (admin1FeaturesByCountryPrefetch.has(country)) {
      return Promise.resolve(admin1FeaturesByCountryPrefetch.get(country));
    }
    const backgroundFetch = admin1CountryPrefetches.get(country);
    if (!backgroundFetch) return Promise.resolve([]);
    if (!admin1CountryPrefetchPromises.has(country)) {
      const request = backgroundFetch
        .then((collection) => {
          const countryFeatures = Array.isArray(collection?.features)
            ? collection.features.map(normalizeFeatureWinding)
            : [];
          admin1FeaturesByCountryPrefetch.set(country, countryFeatures);
          cacheAdmin1PrefetchSources(collection, countryFeatures);
          root.dataset.mapAdmin1CountryCache = Array.from(admin1FeaturesByCountryPrefetch.keys()).join(",");
          return countryFeatures;
        })
        .catch(() => {
          admin1CountryPrefetchPromises.delete(country);
          return [];
        });
      admin1CountryPrefetchPromises.set(country, request);
    }
    return admin1CountryPrefetchPromises.get(country);
  }

  function prefetchAdmin1World(url) {
    if (!url || admin1WorldPrefetchPromise) return Promise.resolve();
    if (!admin1WorldPrefetch) {
      admin1WorldPrefetch = fetchGzipJson(url, "low")
        .catch((error) => {
          admin1WorldPrefetch = null;
          throw error;
        });
    }
    return admin1WorldPrefetch;
  }

  function loadPrefetchedAdmin1World() {
    if (admin1WorldPrefetchPromise) return admin1WorldPrefetchPromise;
    if (!admin1WorldPrefetch) return Promise.resolve([]);
    admin1WorldPrefetchPromise = admin1WorldPrefetch
      .then((collection) => {
        const featuresByCountry = new Map();
        const worldFeatures = Array.isArray(collection?.features)
          ? collection.features.map(normalizeFeatureWinding)
          : [];
        worldFeatures.forEach((feature) => {
          const country = feature.properties?.country;
          if (!country) return;
          if (!featuresByCountry.has(country)) featuresByCountry.set(country, []);
          featuresByCountry.get(country).push(feature);
        });
        featuresByCountry.forEach((countryFeatures, country) => {
          admin1FeaturesByCountryPrefetch.set(country, countryFeatures);
        });
        cacheAdmin1PrefetchSources(collection, worldFeatures);
        root.dataset.mapAdmin1WorldCache = "ready";
        root.dataset.mapAdmin1CountryCache = Array.from(admin1FeaturesByCountryPrefetch.keys()).join(",");
        return worldFeatures;
      })
      .catch(() => {
        admin1WorldPrefetch = null;
        admin1WorldPrefetchPromise = null;
        return [];
      });
    return admin1WorldPrefetchPromise;
  }

  function queueAdmin1SourcePrefetches(manifest, sources) {
    Array.from(new Set(sources || [])).forEach((source) => {
      const url = admin1SourceUrl(manifest, source);
      if (!url) return;
      // Keep speculative work serialized and low priority so it never
      // competes with the first map draw or an explicit language load.
      admin1BackgroundQueue = admin1BackgroundQueue
        .then(() => prefetchAdmin1Source(source, url))
        .catch(() => null);
    });
  }

  function queueAdmin1CountryPrefetches(manifest, countries) {
    Array.from(new Set(countries || [])).forEach((country) => {
      const url = manifest.prefetch?.[country];
      if (!url) return;
      admin1BackgroundQueue = admin1BackgroundQueue
        .then(() => prefetchAdmin1Country(country, url))
        .catch(() => null);
    });
  }

  function countriesPrefetchingAdmin1Sources(manifest, sources) {
    const requested = new Set(sources || []);
    if (!requested.size) return [];
    return Object.entries(manifest.prefetch_sources || {})
      .filter(([country, coveredSources]) => admin1CountryPrefetches.has(country)
        && (coveredSources || []).some((source) => requested.has(source)))
      .map(([country]) => country);
  }

  function prefetchAdmin1ForLanguages(languages, behavior = {}) {
    if (!data.admin1_url) return false;
    const languageIds = admin1LanguageIds(languages || []);
    if (!languageIds.length) return false;
    const start = () => {
      void loadAdmin1Manifest()
        .then((manifest) => {
          if (!manifest) return;
          if (admin1WorldPrefetch) return;
          const sources = languageIds.flatMap((id) => (
            manifest.languages?.[id] || []
          )).filter((rule) => !(rule.feature_ids || []).length)
            .map((rule) => rule.source || rule.country)
            .filter(Boolean)
            .filter((source) => !countriesPrefetchingAdmin1Sources(manifest, [source]).length);
          queueAdmin1SourcePrefetches(manifest, sources);
        })
        .catch(() => {});
    };
    if (behavior.deferUntilIdle === true) runWhenIdle(start);
    else start();
    return true;
  }

  function prefetchAdmin1ForCountries(codes, behavior = {}) {
    if (!data.admin1_url) return;
    const countries = Array.from(new Set(codes || []))
      .filter((code) => countryByCode(code) && !admin1PrefetchedCountries.has(code));
    if (!countries.length) return;
    const start = () => {
      const pendingCountries = countries.filter((code) => !admin1PrefetchedCountries.has(code));
      if (!pendingCountries.length) return;
      pendingCountries.forEach((code) => admin1PrefetchedCountries.add(code));
      void loadAdmin1Manifest()
        .then((manifest) => {
          if (!manifest) return;
          if (admin1WorldPrefetch) return;
          const packedCountries = pendingCountries.filter((code) => manifest.prefetch?.[code]);
          queueAdmin1CountryPrefetches(manifest, packedCountries);
          const unpackedCountries = pendingCountries.filter((code) => !manifest.prefetch?.[code]);
          const candidateLanguageIds = new Set(unpackedCountries.flatMap((code) => (
            countryByCode(code)?.candidateLocales || []
          )));
          const sources = Array.from(new Set(Array.from(candidateLanguageIds).flatMap((id) => (
            manifest.languages?.[id] || []
          )).filter((rule) => !(rule.feature_ids || []).length)
            .map((rule) => rule.source || rule.country)
            .filter(Boolean)));
          queueAdmin1SourcePrefetches(manifest, sources);
        })
        .catch(() => {
          pendingCountries.forEach((code) => admin1PrefetchedCountries.delete(code));
        });
    };
    if (behavior.deferUntilIdle === false) start();
    else runWhenIdle(start);
  }

  function prepareAdmin1ForCountries(codes) {
    if (!data.admin1_url) return Promise.resolve([]);
    const countries = Array.from(new Set(codes || [])).filter((code) => countryByCode(code));
    if (!countries.length) return Promise.resolve([]);
    return loadAdmin1Manifest()
      .then((manifest) => Promise.all(countries.map((country) => {
        const url = manifest?.prefetch?.[country];
        if (!url) return [];
        return prefetchAdmin1Country(country, url)
          .then(() => loadPrefetchedAdmin1Country(country));
      })))
      .catch(() => []);
  }

  function navigationZoomLevel() {
    if (usesProjectedNavigation() && activeProjection) {
      return absoluteZoomForProjectionScale(activeProjection.scale());
    }
    if (planarProjection) {
      return absoluteZoomForProjectionScale(planarProjection.scale() * navigationTransform.k);
    }
    return NaN;
  }

  function countryAdmin1BoundariesShouldShow(projection, width, height) {
    if (!COUNTRY_ADMIN1_REFERENCE_LAYER || mode !== "country" || !projection) return false;
    return placeZoomLevel(projection, width, height) >= COUNTRY_ADMIN1_BOUNDARY_ZOOM;
  }

  function visibleCountryCodesForAdmin1(projection, width, height) {
    const iso2ByIso3 = countryCodeIndex(data);
    const drawingProjection = usesProjectedNavigation()
      ? viewportProjection(projection, width, height)
      : projection;
    const path = geoPath(drawingProjection);
    const padding = Math.max(12, width * 0.04);
    const areas = new Map();
    const consider = (item) => {
      if (!item || !item.properties) return;
      const code = iso2ByIso3.get(item.properties.id)
        || (data.feature_code_aliases || {})[item.properties.id]
        || "";
      if (!code || !countryByCode(code)) return;
      const bounds = path.bounds(item);
      if (!bounds.flat().every(Number.isFinite)) return;
      if (bounds[1][0] < -padding || bounds[0][0] > width + padding
        || bounds[1][1] < -padding || bounds[0][1] > height + padding) return;
      const area = Math.max(0, bounds[1][0] - bounds[0][0]) * Math.max(0, bounds[1][1] - bounds[0][1]);
      if (area < 36) return;
      areas.set(code, Math.max(areas.get(code) || 0, area));
    };
    overviewFeatures.forEach(consider);
    // The focused country is often smaller than the neighbors framing it
    // (Syria beside Saudi Arabia and Turkey), so plain area order can push it
    // past the region budget and leave its own subdivisions unlabeled.
    return Array.from(areas.entries())
      .sort((left, right) => (
        Number(selectedCountries.has(right[0])) - Number(selectedCountries.has(left[0]))
        || right[1] - left[1]
      ))
      .slice(0, COUNTRY_ADMIN1_BOUNDARY_MAX_COUNTRIES)
      .map(([code]) => code);
  }

  function buildCountryAdmin1RegionIndex(manifest) {
    const regions = manifest?.regions || {};
    const byCountry = new Map();
    Object.keys(regions).forEach((regionId) => {
      const entry = regions[regionId] || {};
      (entry.countries || []).forEach((code) => {
        if (!byCountry.has(code)) byCountry.set(code, []);
        byCountry.get(code).push(regionId);
      });
    });
    return {regions, byCountry};
  }

  function ensureCountryAdmin1RegionIndex(manifest) {
    if (!countryAdmin1RegionIndex) {
      countryAdmin1RegionIndex = buildCountryAdmin1RegionIndex(manifest);
    }
    return countryAdmin1RegionIndex;
  }

  function ingestCountryAdmin1Region(regionId, collection) {
    const byCountry = new Map();
    (Array.isArray(collection?.features) ? collection.features : []).forEach((feature) => {
      const normalized = normalizeFeatureWinding(feature);
      const country = normalized.properties?.country || "";
      if (!country) return;
      if (!byCountry.has(country)) byCountry.set(country, []);
      byCountry.get(country).push(normalized);
    });
    byCountry.forEach((features, country) => {
      if (!countryAdmin1FeaturesByCode.has(country)) {
        countryAdmin1FeaturesByCode.set(country, features.slice());
        return;
      }
      const existing = countryAdmin1FeaturesByCode.get(country);
      const seen = new Set(existing.map((feature) => feature.properties?.id || ""));
      features.forEach((feature) => {
        const id = feature.properties?.id || "";
        if (id && seen.has(id)) return;
        if (id) seen.add(id);
        existing.push(feature);
      });
    });
    countryAdmin1LoadedRegions.add(regionId);
    root.dataset.mapCountryAdmin1Cache = Array.from(countryAdmin1FeaturesByCode.keys()).join(",");
    root.dataset.mapCountryAdmin1Regions = Array.from(countryAdmin1LoadedRegions).join(",");
  }

  function loadCountryAdmin1Region(regionId) {
    if (!regionId) return Promise.resolve(false);
    if (countryAdmin1LoadedRegions.has(regionId)) return Promise.resolve(true);
    if (!countryAdmin1RegionLoadPromises.has(regionId)) {
      const request = loadAdmin1Manifest()
        .then((manifest) => {
          const index = ensureCountryAdmin1RegionIndex(manifest);
          const entry = index.regions[regionId];
          const url = entry?.url;
          if (!url) return false;
          return fetchGzipJson(url, "low").then((collection) => {
            ingestCountryAdmin1Region(regionId, collection);
            return true;
          });
        })
        .catch(() => {
          countryAdmin1RegionLoadPromises.delete(regionId);
          return false;
        });
      countryAdmin1RegionLoadPromises.set(regionId, request);
    }
    return countryAdmin1RegionLoadPromises.get(regionId);
  }

  function loadCountryAdmin1Features(country) {
    // Tiny territories must never become their own requests: only orphan codes
    // outside every region pack may fall back to a country chunk.
    if (!country) return Promise.resolve([]);
    if (countryAdmin1FeaturesByCode.has(country) && (countryAdmin1FeaturesByCode.get(country) || []).length) {
      return Promise.resolve(countryAdmin1FeaturesByCode.get(country));
    }
    if (!countryAdmin1LoadPromises.has(country)) {
      const request = loadAdmin1Manifest()
        .then((manifest) => {
          const index = ensureCountryAdmin1RegionIndex(manifest);
          const regionIds = index.byCountry.get(country) || [];
          if (regionIds.length) {
            return Promise.all(regionIds.map(loadCountryAdmin1Region)).then(() => (
              countryAdmin1FeaturesByCode.get(country) || []
            ));
          }
          const url = manifest?.countries?.[country];
          if (!url) {
            countryAdmin1FeaturesByCode.set(country, []);
            return [];
          }
          return fetchGzipJson(url).then((collection) => {
            const nextFeatures = Array.isArray(collection?.features)
              ? collection.features
                .map(normalizeFeatureWinding)
                .filter((feature) => (feature.properties?.country || country) === country)
              : [];
            countryAdmin1FeaturesByCode.set(country, nextFeatures);
            root.dataset.mapCountryAdmin1Cache = Array.from(countryAdmin1FeaturesByCode.keys()).join(",");
            return nextFeatures;
          });
        })
        .catch(() => {
          countryAdmin1LoadPromises.delete(country);
          return [];
        });
      countryAdmin1LoadPromises.set(country, request);
    }
    return countryAdmin1LoadPromises.get(country);
  }

  function regionIdsForAdmin1Countries(codes, manifest) {
    const index = ensureCountryAdmin1RegionIndex(manifest);
    const regionIds = new Set();
    codes.forEach((code) => {
      (index.byCountry.get(code) || []).forEach((regionId) => regionIds.add(regionId));
    });
    return Array.from(regionIds);
  }

  function focusedAdmin1LoadPlan(codes, manifest) {
    const index = ensureCountryAdmin1RegionIndex(manifest);
    const regionIds = [];
    const acceptedCodes = [];
    const seenRegions = new Set();
    for (const code of codes || []) {
      const owners = index.byCountry.get(code) || [];
      if (!owners.length) continue;
      const prospective = new Set(seenRegions);
      owners.forEach((regionId) => prospective.add(regionId));
      if (prospective.size > COUNTRY_ADMIN1_BOUNDARY_MAX_REGIONS) {
        if (!acceptedCodes.length) {
          // Always allow the primary country's packs (e.g. RU west+east).
          owners.forEach((regionId) => {
            if (seenRegions.has(regionId)) return;
            seenRegions.add(regionId);
            regionIds.push(regionId);
          });
          acceptedCodes.push(code);
        }
        // A later country may still live in a pack we already fetched, so keep
        // scanning instead of dropping the rest of the frame.
        continue;
      }
      owners.forEach((regionId) => {
        if (seenRegions.has(regionId)) return;
        seenRegions.add(regionId);
        regionIds.push(regionId);
      });
      acceptedCodes.push(code);
    }
    return {codes: acceptedCodes, regionIds};
  }

  function ensureCountryAdmin1Features(codes) {
    const countries = Array.from(new Set(codes || [])).filter((code) => countryByCode(code));
    if (!countries.length) return Promise.resolve(false);
    return loadAdmin1Manifest().then((manifest) => {
      if (!manifest) return false;
      const plan = focusedAdmin1LoadPlan(countries, manifest);
      if (!plan.regionIds.length && !plan.codes.length) return false;
      const orphanCountries = plan.codes.filter((code) => !(ensureCountryAdmin1RegionIndex(manifest).byCountry.get(code) || []).length);
      return Promise.all([
        ...plan.regionIds.map(loadCountryAdmin1Region),
        ...orphanCountries.map(loadCountryAdmin1Features)
      ]).then((results) => results.some(Boolean) || plan.codes.some((code) => (
        Array.isArray(countryAdmin1FeaturesByCode.get(code)) && countryAdmin1FeaturesByCode.get(code).length > 0
      )));
    });
  }

  function prefetchNeighborAdmin1Regions(regionIds) {
    if (!regionIds.length) return;
    const run = () => {
      void loadAdmin1Manifest().then((manifest) => {
        if (!manifest) return;
        const index = ensureCountryAdmin1RegionIndex(manifest);
        const pending = new Set();
        regionIds.forEach((regionId) => {
          const neighbors = index.regions[regionId]?.neighbors || [];
          neighbors.forEach((neighborId) => {
            if (!countryAdmin1LoadedRegions.has(neighborId)) pending.add(neighborId);
          });
        });
        Array.from(pending).forEach((neighborId) => {
          void loadCountryAdmin1Region(neighborId);
        });
      });
    };
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(run, {timeout: 2500});
    } else {
      window.setTimeout(run, 0);
    }
  }

  function warmCountryAdmin1Boundaries(codes, projection = null, width = 0, height = 0) {
    if (!data.admin1_url || mode !== "country") return;
    const active = projection
      || (usesProjectedNavigation() ? activeProjection : planarProjection);
    if (!active) return;
    const nextWidth = width || Math.max(280, stage.clientWidth || root.clientWidth || 600);
    const nextHeight = height || Number(svg.getAttribute("height")) || 540;
    // Never download region packs for a world overview / unfocused frame.
    if (!countryAdmin1BoundariesShouldShow(active, nextWidth, nextHeight)) return;
    const generation = ++countryAdmin1BoundaryGeneration;
    void loadAdmin1Manifest().then((manifest) => {
      if (!manifest || destroyed || generation !== countryAdmin1BoundaryGeneration) return;
      const visibleCodes = (codes && codes.length)
        ? codes
        : visibleCountryCodesForAdmin1(active, nextWidth, nextHeight);
      const plan = focusedAdmin1LoadPlan(visibleCodes, manifest);
      if (!plan.regionIds.length && !plan.codes.length) return;
      return ensureCountryAdmin1Features(plan.codes).then((loaded) => {
        if (!loaded || destroyed || generation !== countryAdmin1BoundaryGeneration) return;
        const canvas = svg.querySelector(".location-map__viewport:last-of-type");
        if (!canvas) return;
        if (!countryAdmin1BoundariesShouldShow(active, nextWidth, nextHeight)) return;
        const drawingProjection = usesProjectedNavigation()
          ? viewportProjection(active, nextWidth, nextHeight)
          : active;
        syncCountryAdmin1Boundaries(canvas, geoPath(drawingProjection), active, nextWidth, nextHeight);
        const iso2ByIso3 = countryCodeIndex(data);
        const labelScene = buildProjectedLabelScene(
          geoPath(drawingProjection),
          iso2ByIso3,
          nextWidth,
          nextHeight
        );
        rememberLabelScene(labelScene);
        const occupied = drawCountryLabels(
          canvas,
          geoPath(drawingProjection),
          iso2ByIso3,
          nextWidth,
          nextHeight,
          null,
          labelScene
        );
        if (placesReadyForUiLanguage()) {
          drawPlaceLabels(canvas, active, nextWidth, nextHeight, occupied, labelScene);
        }
      });
    });
  }

  function removeCountryAdmin1Boundaries(canvas) {
    if (!canvas) return;
    canvas.querySelectorAll(".location-map__admin1-boundaries").forEach((node) => node.remove());
    delete root.dataset.mapCountryAdmin1Boundaries;
    delete root.dataset.mapCountryAdmin1Targets;
  }

  function syncCountryAdmin1Boundaries(canvas, path, projection, width, height) {
    if (!canvas || !path || !projection) return false;
    removeCountryAdmin1Boundaries(canvas);
    if (!countryAdmin1BoundariesShouldShow(projection, width, height)) return false;
    const visibleCodes = visibleCountryCodesForAdmin1(projection, width, height);
    root.dataset.mapCountryAdmin1Zoom = placeZoomLevel(projection, width, height).toFixed(2);
    if (!visibleCodes.length) return false;
    const manifest = admin1Manifest;
    if (!manifest) {
      warmCountryAdmin1Boundaries(visibleCodes, projection, width, height);
      return false;
    }
    const plan = focusedAdmin1LoadPlan(visibleCodes, manifest);
    root.dataset.mapCountryAdmin1Targets = plan.codes.join(",");
    root.dataset.mapCountryAdmin1RegionsFocused = plan.regionIds.join(",");
    if (!plan.codes.length) return false;
    const nextFeatures = [];
    const missing = [];
    plan.codes.forEach((code) => {
      if (!countryAdmin1FeaturesByCode.has(code)) missing.push(code);
      else {
        const cached = countryAdmin1FeaturesByCode.get(code) || [];
        if (cached.length) nextFeatures.push(...cached);
        else missing.push(code);
      }
    });
    if (missing.length) warmCountryAdmin1Boundaries(plan.codes, projection, width, height);
    else prefetchNeighborAdmin1Regions(plan.regionIds);
    if (!nextFeatures.length) return false;
    const group = svgElement("g", {
      class: "location-map__admin1-boundaries",
      "aria-hidden": "true"
    });
    nextFeatures.forEach((feature) => {
      const country = feature.properties?.country || "";
      if (plan.codes.indexOf(country) === -1) return;
      const shape = svgElement("path", {
        d: path(feature),
        class: "location-map__admin1-boundary"
      });
      if (country && selectedCountries.has(country)) shape.dataset.selected = "true";
      shape.__atlasFeature = feature;
      group.append(shape);
    });
    // Keep admin1 under national borders so shared outer edges stay readable as borders.
    const before = canvas.querySelector(
      ".location-map__borders, .location-map__coastlines, .location-map__selected-boundaries, .location-map__graticule-labels, .location-map__country-labels, .location-map__place-labels"
    );
    if (before) canvas.insertBefore(group, before);
    else canvas.append(group);
    root.dataset.mapCountryAdmin1Boundaries = "true";
    return true;
  }

  function ensureAdmin1ForLanguages(languages) {
    const languageIds = admin1LanguageIds(languages);
    root.dataset.mapAdmin1Selected = languages.map((language) => language.id).join(",");
    root.dataset.mapAdmin1Resolved = languageIds.join(",");
    if (selectedLanguagesIgnoreAdmin1) {
      admin1RequestKey = "";
      root.dataset.mapAdmin1 = "ignored";
      return;
    }
    if (!languageIds.length || !data.admin1_url) {
      delete root.dataset.mapAdmin1;
      return;
    }
    if (admin1Manifest) {
      const rules = languageIds.flatMap((id) => admin1Manifest.languages?.[id] || []);
      const missingSources = Array.from(new Set(rules
        .filter((rule) => !admin1RuleGeometryReady(rule))
        .map((rule) => rule.source || rule.country)))
        .filter(Boolean);
      if (!missingSources.length) {
        root.dataset.mapAdmin1 = "ready";
        return;
      }
    }
    const requested = languageIds.join(",");
    if (admin1RequestKey === requested) return;
    admin1RequestKey = requested;
    root.dataset.mapAdmin1 = "loading";
    loadAdmin1Manifest()
      .then((manifest) => {
        if (!manifest) return [];
        const rules = languageIds.flatMap((id) => manifest.languages?.[id] || []);
        const worldLoad = admin1WorldPrefetch
          ? loadPrefetchedAdmin1World()
          : Promise.resolve([]);
        return worldLoad
          .then(() => {
            const unresolvedSources = Array.from(new Set(rules
              .filter((rule) => !admin1RuleGeometryReady(rule))
              .map((rule) => rule.source || rule.country)
              .filter(Boolean)));
            const prefetchedCountries = Array.from(new Set(rules
              .filter((rule) => !admin1RuleGeometryReady(rule))
              .map((rule) => rule.country)
              .filter((country) => admin1CountryPrefetches.has(country))
              .concat(countriesPrefetchingAdmin1Sources(manifest, unresolvedSources))));
            return Promise.all(prefetchedCountries.map(loadPrefetchedAdmin1Country));
          })
          .then(() => {
            const sources = Array.from(new Set(rules
              .filter((rule) => !admin1RuleGeometryReady(rule))
              .map((rule) => rule.source || rule.country)
              .filter(Boolean)));
            return Promise.all(sources.map((source) => {
              const url = admin1SourceUrl(manifest, source);
              return url ? loadAdmin1Source(source, url) : Promise.resolve([]);
            }));
          });
      })
      .then(() => {
        if (destroyed) return;
        admin1RequestKey = "";
        if (selectedLanguagesIgnoreAdmin1) {
          root.dataset.mapAdmin1 = "ignored";
          return;
        }
        root.dataset.mapAdmin1 = "ready";
        if (mode === "language" && admin1LanguageIds(selectedLanguages()).join(",") === requested) {
          // The first pass may only know the country-wide fallback. Once the
          // regional geometry arrives, refit the untouched initial view to the
          // actual language area (for example, the Basque Country).
          draw(cameraCustomized);
        }
      })
      .catch(() => {
        admin1RequestKey = "";
        if (!destroyed) {
          root.dataset.mapAdmin1 = selectedLanguagesIgnoreAdmin1 ? "ignored" : "fallback";
        }
      });
  }

  function selectedAdmin1Regions(languages) {
    const selected = new Map();
    if (selectedLanguagesIgnoreAdmin1) return selected;
    if (!admin1Manifest) return selected;
    const ruleLayer = (rule) => rule.layer || (rule.role === "distribution" ? "distribution" : "relation");
    const visualRole = (language, profile, rule) => {
      if (ruleLayer(rule) === "scope") {
        if (classifiedCountry(language.regional || [], rule.country)) return "regional";
        if (classifiedCountry(language.protected || [], rule.country)) return "protected";
        return countryRole(language, profile, rule.country);
      }
      if (rule.role === "distribution") {
        // Density is a second dimension, not a competing relationship class.
        // Keep scoped distributions in the relationship's semantic color
        // family.  The generic blue density color is only for nationwide
        // languages, whose semantic family is already blue.
        const relationRole = countryRole(language, profile, rule.country);
        if (["official", "regional", "protected", "resident"].includes(relationRole)) {
          return relationRole;
        }
        return "distribution";
      }
      if (rule.role === "regional") return "regional";
      if (rule.role === "resident"
        || rule.role === "neighbor-countrywide"
        || rule.role === "neighbor-official") return rule.role;
      return "official";
    };
    const visualRolePriority = new Map([
      ["neighbor-official", 1],
      ["resident", 2],
      ["neighbor-countrywide", 3],
      ["distribution", 4],
      ["protected", 5],
      ["regional", 6],
      ["official", 7]
    ]);
    languages.forEach((language) => {
      const profile = profileFor(data, language);
      admin1RulesForLanguage(language).forEach((rule) => {
        admin1RuleFeatures(rule).forEach((feature) => {
          const id = feature.properties?.id;
          const layer = ruleLayer(rule);
          const role = visualRole(language, profile, rule);
          // A scope rule can only narrow a Country x lang relation that already
          // exists. Admin-1 geometry never creates or promotes a semantic role.
          if (!role) return;
          const selectionKey = `${layer === "distribution" ? "distribution" : "relation"}:${id}`;
          const previous = selected.get(selectionKey);
          const candidate = {
            feature,
            regionId: id,
            country: rule.country || feature.properties?.country || "",
            replacesCountryRole: rule.replace_country_role === true,
            layer,
            role,
            semanticRole: layer === "scope" ? role : (rule.role || "distribution"),
            basis: rule.basis || "unspecified",
            intensity: Number.isFinite(rule.intensity) ? rule.intensity : 1,
            languages: [language.id]
          };
          if (!previous) {
            selected.set(selectionKey, candidate);
            return;
          }
          if (!previous.languages.includes(language.id)) previous.languages.push(language.id);
          if (!previous.country) previous.country = candidate.country;
          if (candidate.replacesCountryRole) previous.replacesCountryRole = true;
          if (candidate.basis !== "unspecified") previous.basis = candidate.basis;
          if (candidate.semanticRole !== "distribution") previous.semanticRole = candidate.semanticRole;
          if (candidate.layer === "distribution" || (visualRolePriority.get(candidate.role) || 0)
            >= (visualRolePriority.get(previous.role) || 0)) {
            previous.role = candidate.role;
            previous.intensity = Math.max(previous.intensity, candidate.intensity);
          }
        });
      });
    });
    return selected;
  }

  function drawAdmin1Overlays(canvas, path, languages, distributionContextCountries = new Set()) {
    const selected = selectedAdmin1Regions(languages);
    if (!selected.size) return;
    const group = svgElement("g", {class: "location-map__admin1-layer"});
    selected.forEach((item) => {
      const countrywideDistributionContext = item.layer === "distribution"
        && distributionContextCountries.has(item.country);
      const baseOpacity = {
        official: 0.72,
        regional: 0.6,
        protected: 0.48,
        distribution: countrywideDistributionContext ? 0.76 : 0.56,
        resident: 0.4,
        "neighbor-countrywide": 0.52,
        "neighbor-official": 0.52
      }[item.role] || 0.62;
      // A whole-country neighbor recommendation is intentionally faint, but
      // a scoped admin-1 rule carries real regional information. Preserve the
      // rule's relative intensity while keeping that geometry visibly above
      // the faint whole-country fallbacks by compressing it into a clearly
      // visible regional range.
      const visualIntensity = item.role === "neighbor-countrywide"
        ? 0.56 + (0.44 * item.intensity)
        : item.role === "neighbor-official"
          ? 0.56 + (0.44 * item.intensity)
          : item.intensity;
      const shape = svgElement("path", {
        d: path(item.feature),
        class: "location-map__admin1",
        "data-region": item.regionId,
        "data-layer": item.layer,
        "data-role": item.role,
        "data-semantic-role": item.semanticRole,
        "data-basis": item.basis,
        "data-languages": item.languages.join(","),
        "fill-opacity": String(baseOpacity * visualIntensity)
      });
      if (countrywideDistributionContext) shape.dataset.countrywideDistributionContext = "true";
      shape.__atlasFeature = item.feature;
      group.append(shape);
    });
    canvas.append(group);
  }

  function localizedCountryItem(feature) {
    return {
      feature,
      ...featureInfo(feature, countryCodeIndex(data), countryRowsByCode())
    };
  }

  function bindCountryInteraction(shape, item, role) {
    const title = svgElement("title");
    title.textContent = item && item.name
      ? item.name
      : localizedFeatureName(
        item.feature.properties,
        options.language,
        data.toponym_resolution,
        options.toponymFallbackLocales
      );
    shape.append(title);
    if (item.selectionCodes && item.selectionCodes.length && item.country) {
      // Resolve names from the live options on interaction so a UI-language
      // refresh can keep the existing geometry without stale closed-over copy.
      shape.addEventListener("pointermove", () => {
        const currentItem = localizedCountryItem(item.feature);
        if (mode === "language") updateLanguageCountryStatus(currentItem.country, role);
        else updateCountryStatus(
          {...currentItem.country, name: featureStatusName(currentItem) || currentItem.country.name},
          currentItem.regionSelection || (currentItem.selectionCodes || []).length > 1
        );
      });
      shape.addEventListener("click", () => {
        const currentItem = localizedCountryItem(item.feature);
        selectedCountries = new Set(currentItem.selectionCodes);
        selectedCountry = currentItem.selectionCodes[0];
        selectedFeatureId = currentItem.regionSelection || currentItem.focusFeature ? currentItem.featureId : "";
        const countryLabel = currentItem.regionSelection || currentItem.disputed
          ? currentItem.selectionName || currentItem.name
          : currentItem.selectionCodes.map(countryByCode).filter(Boolean).map((country) => country.name).join(" + ");
        selectedCountryLabel = countryLabel;
        const statusSummary = countrySetSummary(currentItem.selectionCodes, featureStatusName(currentItem) || countryLabel);
        if (currentItem.regionSelection) statusSummary.flag = "";
        updateCountryStatus(statusSummary, currentItem.regionSelection || currentItem.disputed);
        if (mode === "language") {
          countryFocused = true;
          countrySelectionDrivesCamera = false;
          if (typeof options.onCountriesSelect === "function") options.onCountriesSelect(currentItem.selectionCodes, countryLabel, selectedFeatureId);
          else if (typeof options.onCountrySelect === "function") options.onCountrySelect(selectedCountry);
          else {
            countrySelectionDrivesCamera = true;
            setMode("country");
          }
        } else if (typeof options.onCountriesSelect === "function") {
          options.onCountriesSelect(currentItem.selectionCodes, countryLabel, selectedFeatureId);
        } else if (typeof options.onCountrySelect === "function") {
          options.onCountrySelect(selectedCountry);
        } else {
          countryFocused = true;
          countrySelectionDrivesCamera = true;
          draw();
        }
      });
    }
  }

  function countryPathNode(path, item, role, renderNow = true) {
    const shape = svgElement("path", {
      d: renderNow ? path(item.feature) : "",
      class: "location-map__country",
      "data-feature-id": item.featureId,
      "data-role": role || "background"
    });
    shape.__atlasFeature = item.feature;
    if (item.disputed) shape.dataset.disputed = "true";
    if (item.settledBoundary) shape.dataset.settledBoundary = "true";
    if (item.selectionCodes && item.selectionCodes.length) shape.dataset.countryCodes = item.selectionCodes.join(",");
    if (item.regionOverlay) shape.dataset.regionOverlay = "true";
    if (item.redundantFill) shape.dataset.redundantFill = "true";
    if (item.countrywideDistributionContext) shape.dataset.countrywideDistributionContext = "true";
    if (item.clickPriority) shape.dataset.clickPriority = "true";
    if (item.overlayHidden) shape.dataset.overlayHidden = "true";
    if (item.masksUnderlying) shape.dataset.masksUnderlying = "true";
    if (item.viewpointLevel) shape.dataset.viewpointLevel = item.viewpointLevel;
    if (item.adminCodes && item.adminCodes.length) shape.dataset.adminCountries = item.adminCodes.join(",");
    if (Number.isFinite(item.roleIntensity)) {
      shape.dataset.roleIntensity = String(item.roleIntensity);
      if (role === "countrywide") {
        // Some nationwide shared languages sit only just above the practical
        // L1 + L2 threshold. Keep their national context visibly blue without
        // giving it the same visual weight as a more dominant national core.
        const opacity = Math.max(0.42, Math.min(0.9, item.roleIntensity));
        shape.style.setProperty("--map-countrywide-opacity", String(opacity));
        shape.style.setProperty("--map-countrywide-context-opacity", String(Math.min(0.74, opacity)));
      }
    }
    const isSelected = countryItemIsSelected(item);
    if (isSelected) shape.dataset.selected = "true";
    const claimOnly = isSelected && isClaimOnlySelection(item, Array.from(selectedCountries), selectedFeatureId);
    if (claimOnly) shape.dataset.claimOnly = "true";
    bindCountryInteraction(shape, item, role);
    return shape;
  }

  function countryItemIsSelected(item) {
    return mode === "country" && (
      item.featureId === selectedFeatureId
      || ((item.selectionCodes || []).length === 1 && selectedCountries.has(item.selectionCodes[0]))
      || (item.displayCodes || []).some((itemCode) => selectedCountries.has(itemCode))
    );
  }

  function appendSelectedCountryBoundaryLayer(canvas, path, iso2ByIso3) {
    const previous = canvas.querySelector(".location-map__selected-boundaries");
    if (previous) previous.remove();
    canvas.querySelectorAll('[data-viewpoint-boundary-mask="true"]').forEach((shape) => {
      shape.removeAttribute("mask");
      delete shape.dataset.viewpointBoundaryMask;
    });
    if (!countryFocused || !selectedCountries.size) {
      root.dataset.mapSelectedBoundaryFeatures = "0";
      root.dataset.mapSelectedBoundaryDisputed = "0";
      return;
    }
    const countryRows = countryRowsByCode();
    const selected = new Set(selectedCountries);
    const boundaryItems = [];
    const maskedPathData = [];
    features.forEach((feature) => {
      const info = featureInfo(feature, iso2ByIso3, countryRows);
      const rule = selectionRuleForFeature(data, feature).rule;
      const isSelected = countryItemIsSelected(info);
      const pathData = path(feature);
      if (pathData && info.masksUnderlying && !info.overlayHidden && !isSelected) {
        // The base country geometry can still contain a disputed territory
        // that the active viewpoint resolves to another party. Its ordinary
        // fill is covered by this overlay, so remove the same area from the
        // separately redrawn selected-country outline as well.
        maskedPathData.push(pathData);
      }
      // Keep the selected-country outline in lockstep with the selected fill.
      // A viewpoint can resolve a disputed feature to only one party; using
      // every historical party here would revive a claim that the fill has
      // intentionally hidden.
      if (!isSelected) return;
      const partyCodes = partyCountriesForRule(rule);
      const relatedCodes = uniqueCodes([
        ...(info.selectionCodes || []),
        ...(info.displayCodes || [])
      ]);
      const disputed = Boolean(info.disputed || partyCodes.length > 1 || (rule && rule.self_administered));
      if (!pathData) return;
      boundaryItems.push({feature, info, relatedCodes, disputed, pathData});
    });
    root.dataset.mapSelectedBoundaryFeatures = String(boundaryItems.length);
    root.dataset.mapSelectedBoundaryDisputed = String(boundaryItems.filter((item) => item.disputed).length);
    if (!boundaryItems.length) return;
    const group = svgElement("g", {
      class: "location-map__selected-boundaries",
      "aria-hidden": "true"
    });
    let boundaryGroup = group;
    if (maskedPathData.length) {
      const viewBox = canvas.ownerSVGElement && canvas.ownerSVGElement.viewBox.baseVal;
      const width = viewBox && viewBox.width || 1200;
      const height = viewBox && viewBox.height || 540;
      const defs = svgElement("defs");
      const mask = svgElement("mask", {
        id: selectedBoundaryMaskId,
        x: 0,
        y: 0,
        width,
        height,
        maskUnits: "userSpaceOnUse",
        maskContentUnits: "userSpaceOnUse"
      });
      mask.style.setProperty("mask-type", "luminance");
      mask.append(svgElement("rect", {x: 0, y: 0, width, height, fill: "white"}));
      maskedPathData.forEach((pathData) => {
        mask.append(svgElement("path", {
          d: pathData,
          fill: "black",
          stroke: "black",
          "stroke-width": 6,
          "vector-effect": "non-scaling-stroke"
        }));
      });
      defs.append(mask);
      group.append(defs);
      boundaryGroup = svgElement("g", {mask: `url(#${selectedBoundaryMaskId})`});
      group.append(boundaryGroup);
      canvas.querySelectorAll('.location-map__country[data-selected="true"]').forEach((shape) => {
        shape.setAttribute("mask", `url(#${selectedBoundaryMaskId})`);
        shape.dataset.viewpointBoundaryMask = "true";
      });
    }
    ["halo", "line"].forEach((layer) => {
      boundaryItems.forEach((item) => {
        const shape = svgElement("path", {
          d: item.pathData,
          class: `location-map__selected-boundary location-map__selected-boundary--${layer}`,
          "data-feature-id": item.info.featureId,
          "data-country-codes": item.relatedCodes.filter((code) => selected.has(code)).join(","),
          "data-disputed": item.disputed ? "true" : "false"
        });
        shape.__atlasFeature = item.feature;
        boundaryGroup.append(shape);
      });
    });
    const labelLayer = canvas.querySelector(
      ".location-map__graticule-labels, .location-map__country-labels, .location-map__place-labels"
    );
    if (labelLayer) canvas.insertBefore(group, labelLayer);
    else canvas.append(group);
  }

  function pointMarkerPosition(path, item) {
    const polygons = geometryPolygons(item);
    const coordinates = polygons.length ? polygonCenter(polygons[0]) : geoCentroid(item);
    const projection = path.projection();
    const point = projection ? projection(coordinates) : path.centroid(item);
    const visible = Boolean(path({type: "Point", coordinates}))
      && point && point.every(Number.isFinite);
    return {point, visible};
  }

  function countryHitNode(path, item, role) {
    const needsPointMarker = item.featureId === "VAT";
    const marker = needsPointMarker ? pointMarkerPosition(path, item.feature) : null;
    const shape = needsPointMarker
      ? svgElement("circle", {
        cx: marker && marker.point ? marker.point[0] : 0,
        cy: marker && marker.point ? marker.point[1] : 0,
        r: 6,
        class: "location-map__hit",
        "data-small": "true"
      })
      : svgElement("path", {d: path(item.feature), class: "location-map__hit"});
    if (marker && !marker.visible) shape.style.display = "none";
    shape.__atlasFeature = item.feature;
    if (item.regionOverlay) shape.dataset.regionOverlay = "true";
    shape.dataset.featureId = item.featureId;
    if (item.selectionCodes && item.selectionCodes.length) shape.dataset.countryCodes = item.selectionCodes.join(",");
    bindCountryInteraction(shape, item, role);
    return shape;
  }

  function appendPriorityHitLayer(canvas, path, items, visibleFeatureIds = null) {
    const prioritized = items.filter((item) => {
      if (!item.clickPriority || !item.country) return false;
      if (visibleFeatureIds && !visibleFeatureIds.has(item.featureId)
        && !(item.selectionCodes || []).some((code) => selectedCountries.has(code))) return false;
      return true;
    }).sort((left, right) => Number(right.regionOverlay) - Number(left.regionOverlay));
    if (!prioritized.length) return;
    const group = svgElement("g", {class: "location-map__hits"});
    prioritized.forEach((item) => group.append(countryHitNode(path, item, item.role || "selectable")));
    canvas.append(group);
  }

  function drawCountryMode(canvas, path, iso2ByIso3, visibleFeatureIds = null) {
    const countryRows = new Map((options.countries || []).map((item) => [item.code, item]));
    const group = svgElement("g");
    const renderedItems = [];
    features.forEach((item) => {
      const info = featureInfo(item, iso2ByIso3, countryRows);
      const wrapped = {feature: item, ...info, role: info.country ? "selectable" : "background"};
      renderedItems.push(wrapped);
      const renderNow = !visibleFeatureIds || visibleFeatureIds.has(wrapped.featureId)
        || wrapped.featureId === selectedFeatureId
        || (wrapped.selectionCodes || []).some((code) => selectedCountries.has(code));
      group.append(countryPathNode(path, wrapped, wrapped.role, renderNow));
    });
    canvas.append(group);
    appendPriorityHitLayer(canvas, path, renderedItems, visibleFeatureIds);
    updateCountryModeStatus(iso2ByIso3, countryRows);
  }

  function updateCountryModeStatus(iso2ByIso3, countryRows = null) {
    const rows = countryRows || new Map((options.countries || []).map((item) => [item.code, item]));
    legend.replaceChildren();
    const selectedFeature = selectedFeatureId ? features.find((item) => item.properties.id === selectedFeatureId) : null;
    const selectedInfo = selectedFeature ? featureInfo(selectedFeature, iso2ByIso3, rows) : null;
    const selectedSummary = selectedCountries.size
      ? countrySetSummary(
        Array.from(selectedCountries),
        selectedInfo && selectedInfo.country ? featureStatusName(selectedInfo) : selectedCountryLabel
      )
      : countryByCode(selectedCountry) || (options.countries || [])[0];
    if (selectedInfo && selectedInfo.regionSelection) selectedSummary.flag = "";
    updateCountryStatus(selectedSummary, selectedCountries.size > 1 || Boolean(selectedInfo && selectedInfo.regionSelection) || selectedCountryUsesRegionLabel());
  }

  function updateCountrySelectionInPlace() {
    const canvas = svg.querySelector(".location-map__viewport:last-of-type");
    if (!canvas || mode !== "country") return false;
    // Keep the existing projection and gesture handlers. The settled SVG and
    // the transient GPU renderer are both updated below. In particular, do
    // not cancel a pending detailed restore here: that restore is also what
    // retires the motion layer after a drag. Cancelling it left the transient
    // layer active and made the next gesture start from an inconsistent view.
    const startedAt = performance.now();
    const iso2ByIso3 = countryCodeIndex(data);
    const countryRows = new Map((options.countries || []).map((item) => [item.code, item]));
    canvas.querySelectorAll(".location-map__country").forEach((shape) => {
      const feature = shape.__atlasFeature;
      if (!feature) return;
      const item = {feature, ...featureInfo(feature, iso2ByIso3, countryRows)};
      const isSelected = countryItemIsSelected(item);
      if (isSelected) shape.dataset.selected = "true";
      else delete shape.dataset.selected;
      if (isSelected && isClaimOnlySelection(item, Array.from(selectedCountries), selectedFeatureId)) {
        shape.dataset.claimOnly = "true";
      } else {
        delete shape.dataset.claimOnly;
      }
    });
    canvas.querySelectorAll(".location-map__country-label").forEach((label) => {
      if (selectedCountries.has(label.dataset.countryCode)) label.dataset.selected = "true";
      else delete label.dataset.selected;
    });
    if (activeProjection) {
      const width = Math.max(280, stage.clientWidth || root.clientWidth || 600);
      const height = Number(svg.getAttribute("height")) || Math.max(210, width * 0.7);
      const drawingPath = geoPath(viewportProjection(activeProjection, width, height));
      appendSelectedCountryBoundaryLayer(canvas, drawingPath, iso2ByIso3);
      syncCountryAdmin1Boundaries(canvas, drawingPath, activeProjection, width, height);
    } else {
      removeCountryAdmin1Boundaries(canvas);
    }
    updateCountryModeStatus(iso2ByIso3, countryRows);
    root.dataset.mapCountrySelectionInPlace = "true";
    root.dataset.mapPlaceLabelsReused = "true";
    root.dataset.mapLabelSceneMs = "0.00";
    root.dataset.mapCountryLabelMs = "0.00";
    root.dataset.mapPlaceLabelMs = "0.00";
    root.dataset.mapCountrySelectionMs = (performance.now() - startedAt).toFixed(2);
    if (refreshNavigationSelection) {
      refreshNavigationSelection();
    }
    return true;
  }

  function distributionColorRole(language, profile, center, iso2ByIso3, countryRows) {
    const relationRoles = new Set();
    features.forEach((feature) => {
      const info = featureInfo(feature, iso2ByIso3, countryRows);
      if (info.disputed || info.regionOverlay || info.selectionCodes.length !== 1) return;
      if (!geoContains(feature, center)) return;
      const role = countryRole(language, profile, info.selectionCodes[0]);
      if (role) relationRoles.add(role);
    });
    for (const role of ["official", "regional", "protected", "resident"]) {
      if (relationRoles.has(role)) return role;
    }
    return "distribution";
  }

  function drawGradients(canvas, projection, language, profile, width, prefix, iso2ByIso3, countryRows) {
    const regions = profile.regions || [];
    if (!regions.length) return;
    const defs = svgElement("defs");
    const group = svgElement("g", {class: "location-map__halos"});
    regions.forEach((region, index) => {
      const center = projection(region.center);
      if (!center) return;
      const radius = radiusPixels(projection, region, width);
      if (!radius) return;
      const id = `atlas-language-map-gradient-${String(prefix).replace(/[^a-z0-9_-]/gi, "-")}-${index}`;
      const gradient = svgElement("radialGradient", {id, class: "location-map__gradient"});
      const colorRole = distributionColorRole(
        language,
        profile,
        region.center,
        iso2ByIso3,
        countryRows
      );
      const gradientColor = {
        official: "#32aab2",
        regional: "#55aa70",
        protected: "#a17fbd",
        resident: "#d49a3d",
        distribution: "#5268cf"
      }[colorRole];
      gradient.style.setProperty("--map-gradient-color", gradientColor);
      gradient.dataset.role = colorRole;
      // radius_km is the distribution bandwidth; intensity is its peak
      // concentration.  Overlapping translucent kernels accumulate, so
      // broad/weak and narrow/strong regions remain distinct.
      const intensity = Math.max(0.18, Math.min(1, Number(region.intensity) || 0.6));
      gradient.append(
        svgElement("stop", {offset: "0%", "stop-opacity": String(0.82 * intensity)}),
        svgElement("stop", {offset: "28%", "stop-opacity": String(0.52 * intensity)}),
        svgElement("stop", {offset: "60%", "stop-opacity": String(0.24 * intensity)}),
        svgElement("stop", {offset: "84%", "stop-opacity": String(0.07 * intensity)}),
        svgElement("stop", {offset: "100%", "stop-opacity": "0"})
      );
      defs.append(gradient);
      const halo = svgElement("circle", {
        cx: center[0],
        cy: center[1],
        r: radius,
        fill: `url(#${id})`,
        class: "location-map__halo",
        "data-role": colorRole,
        "data-density-radius-km": String(region.radius_km || ""),
        "data-density-intensity": String(intensity)
      });
      halo.__atlasRegion = region;
      group.append(halo);
    });
    canvas.append(defs);
    canvas.append(group);
  }

  function updateLanguageModeStatus(languages, distributionContextCountries = null) {
    if (!languages.length) return;
    const distributionCountries = distributionContextCountries || new Set(
      Array.from(selectedAdmin1Regions(languages).values())
        .filter((item) => item.layer === "distribution" && item.country)
        .map((item) => item.country)
    );
    const copy = messages();
    const countrywideKeyClass = distributionCountries.size
      ? "location-map__key--countrywide-context"
      : "location-map__key--countrywide";
    const legendItems = [
      '<span><i class="location-map__key ' + countrywideKeyClass + '" aria-hidden="true"></i>' + escapeText(options.labels.countrywide || copy.countrywide) + '</span>',
      '<span><i class="location-map__key location-map__key--official" aria-hidden="true"></i>' + escapeText(options.labels.official || copy.officialLegend) + '</span>',
      '<span><i class="location-map__key location-map__key--regional" aria-hidden="true"></i>' + escapeText(options.labels.regional || copy.regional || "Regional") + '</span>',
      '<span><i class="location-map__key location-map__key--protected" aria-hidden="true"></i>' + escapeText(options.labels.protected || copy.protectedLegend || "Protected") + '</span>',
      '<span><i class="location-map__key location-map__key--distribution" aria-hidden="true"></i>' + escapeText(copy.distributionLegend || "Usage core and spread") + '</span>',
      '<span><i class="location-map__key location-map__key--neighbor-countrywide" aria-hidden="true"></i>' + escapeText(options.labels.neighborCountrywide) + '</span>',
      '<span><i class="location-map__key location-map__key--resident" aria-hidden="true"></i>' + escapeText(options.labels.resident || copy.residentLegend) + '</span>',
    ];
    const legendDefinitions = [
      [options.labels.countrywide || copy.countrywide, copy.countrywideDescription],
      [options.labels.official || copy.officialLegend, copy.officialDescription],
      [options.labels.regional || copy.regional || "Regional", copy.regionalDescription],
      [options.labels.protected || copy.protectedLegend || "Protected", copy.protectedDescription],
      [options.labels.resident || copy.residentLegend, copy.residentDescription],
      [options.labels.global || copy.globalLegend, copy.globalDescription]
    ].filter((entry) => entry[1]);
    const helpLabel = copy.classificationHelp || copy.countryCopy || "Language role definitions";
    const legendOverview = copy.approximateNote
      ? '<div class="location-map__legend-overview">' + escapeText(copy.approximateNote) + '</div>'
      : "";
    const legendHelp = legendDefinitions.length
      ? '<details class="location-map__legend-help"><summary title="' + escapeText(helpLabel) + '" aria-label="' + escapeText(helpLabel) + '">ⓘ</summary><div class="location-map__legend-explanations">' + legendOverview + legendDefinitions.map((entry) => (
        '<div><b>' + escapeText(entry[0]) + '</b> ' + escapeText(entry[1]) + '</div>'
      )).join("") + '</div></details>'
      : "";
    legend.innerHTML = legendItems.join("") + legendHelp;
    updateLanguageStatus(languages);
  }

  function drawLanguageMode(canvas, path, projection, iso2ByIso3, width, languages, visibleFeatureIds = null) {
    if (!languages.length) return;
    // Keep the on-demand load tied to the actual language renderer as well as
    // the early draw pass.  The request is deduplicated, while updates from a
    // bootstrap map with no language rows cannot skip a newly selected locale.
    ensureAdmin1ForLanguages(languages);
    root.dataset.activeMapLanguages = languages.map((language) => language.id).join(",");
    const countryRows = new Map((options.countries || []).map((item) => [item.code, item]));
    const directCountryFeatures = new Map();
    features.forEach((feature) => {
      const info = featureInfo(feature, iso2ByIso3, countryRows);
      if (info.disputed || info.regionOverlay || info.selectionCodes.length !== 1) return;
      const code = info.selectionCodes[0];
      const countryFeatures = directCountryFeatures.get(code) || [];
      countryFeatures.push(feature);
      directCountryFeatures.set(code, countryFeatures);
    });
    const languageProfiles = languages.map((language) => ({
      language,
      profile: profileFor(data, language)
    }));
    const distributionContextCountries = new Set(
      Array.from(selectedAdmin1Regions(languages).values())
        .filter((item) => item.layer === "distribution" && item.country)
        .map((item) => item.country)
    );
    // Script-wide selections can contain dozens of languages.  In the
    // country-only mode, resolve each country's combined mark once instead of
    // repeating every language/profile lookup for every geographic feature.
    const countryMarkCache = selectedLanguagesIgnoreAdmin1 ? new Map() : null;
    const aggregateCountryMark = (code) => {
      if (countryMarkCache?.has(code)) return countryMarkCache.get(code);
      const mark = compactCountryMarks(languageProfiles.flatMap(({ language, profile }) =>
        layeredCountryMarks(language, profile, code)
      ).filter(Boolean));
      if (countryMarkCache) countryMarkCache.set(code, mark || null);
      return mark;
    };
    const markForCodes = (codes) => selectedLanguagesIgnoreAdmin1
      ? compactCountryMarks((codes || []).map(aggregateCountryMark).filter(Boolean))
      : compactCountryMarks(
        languageProfiles.flatMap(({ language, profile }) =>
          (codes || []).flatMap((code) => layeredCountryMarks(language, profile, code))
        ).filter(Boolean)
      );
    const baseGroup = svgElement("g");
    const renderedItems = [];
    features.forEach((item) => {
      const info = featureInfo(item, iso2ByIso3, countryRows);
      const mark = markForCodes(info.selectionCodes);
      const role = mark?.role || "";
      const centroid = (info.disputed || info.regionOverlay) && role
        ? geoCentroid(item)
        : null;
      const redundantFill = Boolean(centroid && Array.from(directCountryFeatures.entries()).some(([code, countryFeatures]) => {
        const baseMark = markForCodes([code]);
        if (!baseMark || baseMark.role !== role) return false;
        const baseIntensity = baseMark.intensity ?? 1;
        const overlayIntensity = mark?.intensity ?? 1;
        if (Math.abs(baseIntensity - overlayIntensity) > 0.001) return false;
        return countryFeatures.some((feature) =>
          geoContains(feature, centroid)
        );
      }));
      const wrapped = {
        feature: item,
        ...info,
        role: role || "background",
        roleIntensity: mark?.intensity ?? null,
        countrywideDistributionContext: role === "countrywide"
          && info.selectionCodes.some((code) => distributionContextCountries.has(code)),
        redundantFill
      };
      renderedItems.push(wrapped);
      baseGroup.append(countryPathNode(
        path,
        wrapped,
        role || "background",
        !visibleFeatureIds || visibleFeatureIds.has(wrapped.featureId)
      ));
    });
    canvas.append(baseGroup);
    // Regional distributions are deliberately approximate. Draw the smooth
    // density surface over the nationwide context wash, then keep the known
    // Admin-1 distribution polygons crisp above it. Borders and labels are
    // appended after language mode.
    if (!selectedLanguagesIgnoreAdmin1) {
      languages.forEach((language, index) => {
        drawGradients(
          canvas,
          projection,
          language,
          profileFor(data, language),
          width,
          `${language.id}-${index}`,
          iso2ByIso3,
          countryRows
        );
      });
    }
    drawAdmin1Overlays(canvas, path, languages, distributionContextCountries);
    appendPriorityHitLayer(canvas, path, renderedItems, visibleFeatureIds);
    updateLanguageModeStatus(languages, distributionContextCountries);
  }

  function visibleOverviewFeatureIds(projection, width, height) {
    const path = geoPath(projection);
    const padding = Math.max(18, width * 0.06);
    const visible = new Set();
    const addIfVisible = (item) => {
      const bounds = path.bounds(item);
      if (!bounds.flat().every(Number.isFinite)) return;
      if (bounds[1][0] < -padding || bounds[0][0] > width + padding
        || bounds[1][1] < -padding || bounds[0][1] > height + padding) return;
      visible.add(item.properties.id);
    };
    overviewFeatures.forEach(addIfVisible);
    features.forEach(addIfVisible);
    return visible;
  }

  function cancelDetailedRestore() {
    if (detailRestoreTimer) window.clearTimeout(detailRestoreTimer);
    detailRestoreTimer = 0;
  }

  function scheduleDetailedRestore(canvas, projection, width, delay = DETAIL_RESTORE_DELAY, onRestored = null) {
    cancelDetailedRestore();
    detailRestoreTimer = window.setTimeout(() => {
      detailRestoreTimer = 0;
      if (!canvas.isConnected) {
        delete root.dataset.mapNavigating;
        if (onRestored) onRestored(false);
        return;
      }
      renderProjectedViewport(canvas, projection, width, false);
      if (onRestored) onRestored(true);
      delete root.dataset.mapGestureResolution;
      delete root.dataset.mapDeferredOffscreen;
      delete root.dataset.mapNavigating;
    }, delay);
  }

  function renderProjectedViewport(canvas, projection, width, useOverview = false) {
    const viewBox = canvas.ownerSVGElement && canvas.ownerSVGElement.viewBox.baseVal;
    const height = viewBox && viewBox.height || 540;
    const path = geoPath(useOverview ? projection : viewportProjection(projection, width, height));
    canvas.querySelectorAll("path").forEach((shape) => {
      if (shape.__atlasFeature) {
        shape.setAttribute("d", path(shape.__atlasFeature));
      } else if (shape.classList.contains("location-map__borders")) {
        shape.setAttribute("d", path(borders));
      } else if (shape.classList.contains("location-map__coastlines")) {
        shape.setAttribute("d", path(coastlines));
      }
    });
    canvas.querySelectorAll('circle[data-small="true"]').forEach((shape) => {
      if (!shape.__atlasFeature) return;
      const marker = pointMarkerPosition(path, shape.__atlasFeature);
      shape.style.display = marker.visible ? "" : "none";
      if (!marker.visible) return;
      shape.setAttribute("cx", String(marker.point[0]));
      shape.setAttribute("cy", String(marker.point[1]));
    });
    canvas.querySelectorAll("circle.location-map__halo").forEach((shape) => {
      const region = shape.__atlasRegion;
      if (!region) return;
      const center = projection(region.center);
      if (!center) return;
      shape.setAttribute("cx", String(center[0]));
      shape.setAttribute("cy", String(center[1]));
      shape.setAttribute("r", String(radiusPixels(projection, region, width)));
    });
    updateGraticule(canvas, projection, 1, true, useOverview);
    if (!useOverview) {
      const iso2ByIso3 = countryCodeIndex(data);
      cancelPlaceLabelRelayout();
      syncCountryAdmin1Boundaries(canvas, path, projection, width, height);
      const labelScene = buildProjectedLabelScene(path, iso2ByIso3, width, height);
      rememberLabelScene(labelScene);
      const occupied = drawCountryLabels(canvas, path, iso2ByIso3, width, height, null, labelScene);
      drawPlaceLabels(canvas, projection, width, height, occupied, labelScene);
      root.dataset.mapPlaceLabelsReused = "false";
      root.dataset.mapLabelSceneReused = "false";
    } else {
      removeCountryAdmin1Boundaries(canvas);
    }
  }

  function refreshLocalizedMap() {
    const startedAt = performance.now();
    const copy = messages();
    const languages = selectedLanguages();
    populateControls();
    svg.setAttribute("aria-label", mode === "country"
      ? copy.countryMode
      : `${copy.languageMode}: ${selectedLanguagesText(languages)}`);
    const iso2ByIso3 = countryCodeIndex(data);
    if (mode === "country") updateCountryModeStatus(iso2ByIso3);
    else updateLanguageModeStatus(languages);

    const canvas = svg.querySelector(".location-map__viewport:last-of-type");
    const projection = usesProjectedNavigation() ? activeProjection : planarProjection;
    if (canvas && projection) {
      const countryRows = countryRowsByCode();
      canvas.querySelectorAll(".location-map__country, .location-map__hit").forEach((shape) => {
        if (!shape.__atlasFeature) return;
        const info = featureInfo(shape.__atlasFeature, iso2ByIso3, countryRows);
        const title = shape.querySelector("title");
        if (title) title.textContent = info.name || localizedFeatureName(
          shape.__atlasFeature.properties,
          options.language,
          data.toponym_resolution,
          options.toponymFallbackLocales
        );
      });
      const width = Math.max(280, stage.clientWidth || root.clientWidth || 600);
      const viewBox = svg.viewBox && svg.viewBox.baseVal;
      const height = viewBox && viewBox.height || 540;
      // Keep projected label anchors. Only re-measure country names and swap
      // place-label copy; collision for places runs when the browser is idle
      // or when a full draw invalidates the cached scene.
      paintLocalizedLabels(canvas, projection, width, height, iso2ByIso3);
    }
    root.dataset.mapLocalizationRefreshMs = (performance.now() - startedAt).toFixed(2);
  }

  function createMotionRenderer(settledCanvas, width, settledProjection) {
    const viewBox = settledCanvas.ownerSVGElement && settledCanvas.ownerSVGElement.viewBox.baseVal;
    const height = viewBox && viewBox.height || 540;
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const layer = svgElement("foreignObject", {
      x: "0",
      y: "0",
      width: String(width),
      height: String(height),
      class: "location-map__motion-surface",
      "aria-hidden": "true"
    });
    const stack = document.createElement("div");
    stack.style.position = "relative";
    stack.style.width = `${width}px`;
    stack.style.height = `${height}px`;
    // The settled SVG is transparent and gets its ocean colour from the
    // surrounding stage.  The transient canvases replace that SVG while a
    // gesture is active, so give their stack the same opaque backdrop.  This
    // also prevents a one-frame flash when the motion renderer is activated.
    const transparentPaint = (value) => {
      const normalized = String(value || "").trim().toLowerCase();
      return !normalized || normalized === "transparent"
        || /^rgba\([^)]*[,/]\s*0(?:\.0+)?\s*\)$/.test(normalized);
    };
    const configuredOcean = window.getComputedStyle(root).getPropertyValue("--map-ocean").trim();
    const svgOcean = window.getComputedStyle(settledCanvas.ownerSVGElement).backgroundColor;
    const oceanColor = !transparentPaint(configuredOcean) ? configuredOcean
      : !transparentPaint(svgOcean) ? svgOcean : "#e7f5fb";
    stack.style.backgroundColor = oceanColor;
    // Keep the ocean independent from both renderers.  The WebGL canvas can
    // briefly become transparent while its context is being restored or when
    // a projection cannot use the affine fast path.  Likewise, the 2D canvas
    // is intentionally transparent so the GPU fills remain visible.  Without
    // a dedicated opaque bottom layer either case exposes the settled SVG's
    // neutral land colour, which looks like the sea turning grey when the
    // selected country is panned out of view.
    const oceanSurface = document.createElement("div");
    oceanSurface.className = "location-map__motion-ocean";
    oceanSurface.style.position = "absolute";
    oceanSurface.style.inset = "0";
    oceanSurface.style.zIndex = "0";
    oceanSurface.style.backgroundColor = oceanColor;
    const fillSurface = document.createElement("canvas");
    const surface = document.createElement("canvas");
    [fillSurface, surface].forEach((item) => {
      item.width = Math.ceil(width * pixelRatio);
      item.height = Math.ceil(height * pixelRatio);
      item.style.position = "absolute";
      item.style.inset = "0";
      item.style.width = `${width}px`;
      item.style.height = `${height}px`;
    });
    // WebGL owns the detailed 10m country fills while the map is moving. Its
    // CSS background is deliberately the ocean colour too: should a context
    // be lost, or an individual projection frame be unsuitable for the GPU
    // affine approximation, the browser must never expose the neutral page
    // background as a grey flash.
    fillSurface.style.backgroundColor = oceanColor;
    fillSurface.style.zIndex = "1";
    surface.style.zIndex = "2";
    stack.append(oceanSurface, fillSurface, surface);
    layer.append(stack);
    layer.style.display = "none";
    layer.style.pointerEvents = "none";
    const context = surface.getContext("2d", {alpha: true});

    // Keep a projection-independent cache of every country label and capital.
    // Caching only the labels accepted by the settled SVG meant that labels
    // entering the viewport during a drag could not appear until the gesture
    // ended.  Preview frames still avoid SVG measurement and DOM replacement:
    // they project this compact cache, apply a cheap screen-space collision
    // pass, and paint only the candidates currently in view.
    const labelPaint = (item) => {
      const style = window.getComputedStyle(item);
      return {
        fill: style.fill || "#24304c",
        stroke: style.stroke || "rgba(247,251,255,.96)",
        strokeWidth: Number.parseFloat(style.strokeWidth) || 0,
        font: `${style.fontWeight || 600} ${style.fontSize || "10px"} ${style.fontFamily || "system-ui, sans-serif"}`,
        align: item.dataset.anchor === "start" ? "left"
          : item.dataset.anchor === "end" ? "right" : "center"
      };
    };
    const styleProbe = (tag, className, dataset = {}) => {
      const item = svgElement(tag, {class: className});
      Object.entries(dataset).forEach(([name, value]) => { item.dataset[name] = value; });
      item.style.visibility = "hidden";
      settledCanvas.append(item);
      return item;
    };
    const normalCountryProbe = settledCanvas.querySelector('.location-map__country-label:not([data-selected="true"])')
      || styleProbe("text", "location-map__country-label");
    const selectedCountryProbe = settledCanvas.querySelector('.location-map__country-label[data-selected="true"]')
      || styleProbe("text", "location-map__country-label", {selected: "true"});
    const capitalLabelProbe = settledCanvas.querySelector('.location-map__place-label[data-capital="true"]')
      || styleProbe("text", "location-map__place-label", {capital: "true", anchor: "start"});
    const capitalMarkerProbe = settledCanvas.querySelector('.location-map__place-marker[data-capital="true"]')
      || styleProbe("circle", "location-map__place-marker", {capital: "true"});
    const countryPaint = labelPaint(normalCountryProbe);
    const selectedCountryPaint = labelPaint(selectedCountryProbe);
    const capitalPaint = labelPaint(capitalLabelProbe);
    capitalPaint.align = "left";
    const capitalMarkerStyle = window.getComputedStyle(capitalMarkerProbe);

    const iso2ByIso3 = countryCodeIndex(data);
    const countryRows = countryRowsByCode();
    const motionCountries = new Map();
    labelFeatureFacts().forEach((fact) => {
      const info = featureInfo(fact.item, iso2ByIso3, countryRows);
      if (!info.country || info.regionSelection || info.disputed || info.selectionCodes.length !== 1) return;
      const code = info.selectionCodes[0];
      const candidate = {
        kind: "country",
        code,
        coordinate: fact.center,
        text: info.country.name,
        sphericalArea: fact.sphericalArea,
        selected: selectedCountries.has(code),
        offset: [0, 0],
        paint: selectedCountries.has(code) ? selectedCountryPaint : countryPaint
      };
      const previous = motionCountries.get(code);
      if (!previous || candidate.sphericalArea > previous.sphericalArea) motionCountries.set(code, candidate);
    });
    const motionCountryLabels = Array.from(motionCountries.values());
    const motionCapitalMarkers = [];
    const motionCapitalLabels = [];
    placeCountryEntries.forEach(([countryCode, country]) => {
      (country.places || []).forEach((row) => {
        if (!row[3]) return;
        const coordinate = [Number(row[0]), Number(row[1])];
        if (!coordinate.every(Number.isFinite)) return;
        const profile = placeMarkerProfile(row);
        motionCapitalMarkers.push({
          countryCode,
          coordinate,
          minimumZoom: Number(row[2]) || 9,
          population: Math.max(0, Number(row[4]) || 0),
          radius: profile.radius,
          fill: capitalMarkerStyle.fill || "#d24b5d",
          stroke: capitalMarkerStyle.stroke || "#fff",
          strokeWidth: Number.parseFloat(capitalMarkerStyle.strokeWidth) || 1.5
        });
        motionCapitalLabels.push({
          kind: "capital",
          countryCode,
          coordinate,
          population: Math.max(0, Number(row[4]) || 0),
          text: placeName(row),
          offset: [6, -6],
          paint: capitalPaint
        });
      });
    });
    [normalCountryProbe, selectedCountryProbe, capitalLabelProbe, capitalMarkerProbe]
      .forEach((item) => { if (item.style.visibility === "hidden") item.remove(); });
    const motionTextLabels = [...motionCountryLabels, ...motionCapitalLabels];
    motionTextLabels.forEach((item) => {
      context.font = item.paint.font;
      item.textWidth = Math.ceil(context.measureText(item.text || "").width);
      item.textHeight = Math.max(8, Number.parseFloat(item.paint.font.match(/([\d.]+)px/)?.[1]) || 10);
    });
    root.dataset.mapMotionLabels = String(motionTextLabels.length);
    root.dataset.mapMotionCapitals = String(motionCapitalMarkers.length);

    const paintFor = (shape) => {
      const style = shape ? window.getComputedStyle(shape) : null;
      const number = (value, fallback) => {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
      };
      const fill = style && style.fill || "none";
      const fillOpacity = number(style && style.fillOpacity, 1);
      return {
        fill,
        fillOpacity,
        fillRule: style && style.fillRule === "evenodd" ? "evenodd" : "nonzero",
        stroke: style && style.stroke || "none",
        strokeOpacity: number(style && style.strokeOpacity, 1),
        strokeWidth: number(style && style.strokeWidth, 0),
        opacity: number(style && style.opacity, 1),
        lineCap: style && style.strokeLinecap || "butt",
        lineJoin: style && style.strokeLinejoin || "miter"
      };
    };

    const drawGeometry = (path, geometry, paint) => {
      if (!geometry || !paint || paint.opacity <= 0) return;
      context.beginPath();
      path(geometry);
      if (paint.fill !== "none" && paint.fillOpacity > 0) {
        context.globalAlpha = paint.opacity * paint.fillOpacity;
        context.fillStyle = paint.fill;
        context.fill(paint.fillRule);
      }
      if (paint.stroke !== "none" && paint.strokeWidth > 0 && paint.strokeOpacity > 0) {
        context.globalAlpha = paint.opacity * paint.strokeOpacity;
        context.strokeStyle = paint.stroke;
        context.lineWidth = paint.strokeWidth;
        context.lineCap = paint.lineCap;
        context.lineJoin = paint.lineJoin;
        context.stroke();
      }
      context.globalAlpha = 1;
    };

    const paintKey = (paint) => [
      paint.fill,
      paint.fillOpacity,
      paint.fillRule,
      paint.stroke,
      paint.strokeOpacity,
      paint.strokeWidth,
      paint.opacity,
      paint.lineCap,
      paint.lineJoin
    ].join("\u0000");

    const semanticAttributes = [
      "role", "disputed", "settledBoundary",
      "regionOverlay", "masksUnderlying", "viewpointLevel", "selected", "claimOnly"
    ];
    const motionShapes = [];
    settledCanvas.querySelectorAll("path.location-map__country").forEach((shape) => {
      if (!shape.__atlasFeature || shape.dataset.overlayHidden === "true") return;
      const attributes = Object.fromEntries(semanticAttributes.map((name) => [name, shape.dataset[name] || ""]));
      const ordered = attributes.disputed === "true"
        || attributes.settledBoundary === "true"
        || attributes.regionOverlay === "true"
        || attributes.masksUnderlying === "true"
        || attributes.claimOnly === "true";
      // Keep all selectable overlay geometry in the static mesh. An overlay
      // that is not currently selected is transparent; changing countries
      // then only updates its colour buffer instead of rebuilding and
      // retriangulating the complete 10m scene.
      motionShapes.push({
        shape,
        feature: shape.__atlasFeature,
        // Ordinary countries can use the topology-safe 110m feature while a
        // gesture is active.  Both fills and borders then come from the same
        // resolution and pass through D3's geographic clipper, so the preview
        // cannot grow seam-crossing triangles or expose a mismatched 10m/110m
        // coastline.  Semantic overlays (disputes, claims, extracted regions)
        // stay on their detailed geometry because their small boundaries are
        // the information being presented.
        motionFeature: ordered
          ? shape.__atlasFeature
          : (overviewFeaturesById.get(shape.__atlasFeature.properties.id)
            || shape.__atlasFeature),
        ordered,
        vertexStart: 0,
        vertexCount: 0,
        color: null
      });
    });
    const effectivePaint = (entry) => {
      const paint = paintFor(entry.shape);
      if (!entry.ordered || entry.shape.dataset.selected === "true") return paint;
      return {...paint, fillOpacity: 0, strokeOpacity: 0};
    };
    const borderPaint = paintFor(settledCanvas.querySelector(".location-map__borders"));
    const coastlinePaint = paintFor(settledCanvas.querySelector(".location-map__coastlines"));
    const minorGraticulePaint = paintFor(settledCanvas.querySelector(".location-map__graticule--minor"));
    const majorGraticulePaint = paintFor(settledCanvas.querySelector(".location-map__graticule--major"));
    settledCanvas.parentNode.insertBefore(layer, settledCanvas.nextSibling);
    let visible = false;

    // A longitude/latitude polygon cannot be triangulated once and then safely
    // rotated through every projection seam.  The old static WebGL mesh
    // wrapped each vertex independently, so triangles crossing the active
    // antimeridian or horizon could stretch across the viewport or disappear.
    // Keep that experimental renderer dormant until it performs topology-aware
    // spherical clipping.  The exact Canvas path below uses D3's geographic
    // stream, which clips at the current seam and horizon on every frame.
    const topologySafeWebglMotion = false;
    const gl = topologySafeWebglMotion
      ? fillSurface.getContext("webgl2", {alpha: true, antialias: true})
      : null;
    let webgl = null;
    const compileShader = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) || "Map motion shader compilation failed");
      }
      return shader;
    };
    const colorComponents = (value, opacity) => {
      const hex = String(value || "").trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
      if (hex) {
        const expanded = hex[1].length === 3
          ? hex[1].split("").map((item) => item + item).join("") : hex[1];
        return [
          Number.parseInt(expanded.slice(0, 2), 16) / 255,
          Number.parseInt(expanded.slice(2, 4), 16) / 255,
          Number.parseInt(expanded.slice(4, 6), 16) / 255,
          Math.max(0, Math.min(1, opacity))
        ];
      }
      const match = String(value || "").match(/^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
      if (!match) return [0, 0, 0, 0];
      return [
        Number(match[1]) / 255,
        Number(match[2]) / 255,
        Number(match[3]) / 255,
        Math.max(0, Math.min(1, (match[4] == null ? 1 : Number(match[4])) * opacity))
      ];
    };
    const oceanComponents = colorComponents(oceanColor, 1);
    const meshShapes = () => {
      const vertices = [];
      const colors = [];
      const indices = [];
      motionShapes.forEach((entry) => {
        const item = entry.feature;
        entry.vertexStart = vertices.length / 2;
        if (item && item.geometry) {
          const polygons = item.geometry.type === "Polygon" ? [item.geometry.coordinates]
            : item.geometry.type === "MultiPolygon" ? item.geometry.coordinates : [];
          polygons.forEach((polygon) => {
            const rings = polygon.map((ring) => {
              if (ring.length > 1
                && ring[0][0] === ring[ring.length - 1][0]
                && ring[0][1] === ring[ring.length - 1][1]) return ring.slice(0, -1);
              return ring;
            }).filter((ring) => ring.length >= 3);
            if (!rings.length) return;
            const flat = flattenEarcut(rings);
            const base = vertices.length / 2;
            vertices.push(...flat.vertices);
            earcut(flat.vertices, flat.holes, flat.dimensions).forEach((index) => indices.push(base + index));
          });
        }
        entry.vertexCount = vertices.length / 2 - entry.vertexStart;
        const paint = effectivePaint(entry);
        entry.color = colorComponents(paint.fill, paint.opacity * paint.fillOpacity);
        for (let index = 0; index < entry.vertexCount; index += 1) colors.push(...entry.color);
      });
      return {
        vertices: new Float32Array(vertices),
        colors: new Float32Array(colors),
        indices: new Uint32Array(indices)
      };
    };
    const rawPoint = (projection, location) => {
      const radians = Math.PI / 180;
      let lambda = location[0] * radians;
      let phi = location[1] * radians;
      const rotation = projection.rotate().map((value) => value * radians);
      lambda += rotation[0];
      if (lambda > Math.PI) lambda -= 2 * Math.PI;
      else if (lambda < -Math.PI) lambda += 2 * Math.PI;
      if (rotation[1] || rotation[2]) {
        const cosPhi = Math.cos(phi);
        const x = Math.cos(lambda) * cosPhi;
        const y = Math.sin(lambda) * cosPhi;
        const z = Math.sin(phi);
        const cosDeltaPhi = Math.cos(rotation[1]);
        const sinDeltaPhi = Math.sin(rotation[1]);
        const cosDeltaGamma = Math.cos(rotation[2]);
        const sinDeltaGamma = Math.sin(rotation[2]);
        const k = z * cosDeltaPhi + x * sinDeltaPhi;
        lambda = Math.atan2(y * cosDeltaGamma - k * sinDeltaGamma, x * cosDeltaPhi - z * sinDeltaPhi);
        phi = Math.asin(Math.max(-1, Math.min(1, k * cosDeltaGamma + y * sinDeltaGamma)));
      }
      const family = projectionFamily(projection);
      if (family === "orthographic") return [Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
      if (family === "azimuthal") {
        const denominator = 1 + Math.cos(lambda) * Math.cos(phi);
        if (denominator <= 1e-9) return [Infinity, Infinity];
        const k = Math.sqrt(2 / denominator);
        return [k * Math.cos(phi) * Math.sin(lambda), k * Math.sin(phi)];
      }
      if (family === "mercator") {
        return [lambda, Math.log(Math.tan((Math.PI / 2 + Math.max(-1.570795, Math.min(1.570795, phi))) / 2))];
      }
      const A1 = 1.340264;
      const A2 = -0.081106;
      const A3 = 0.000893;
      const A4 = 0.003796;
      const M = Math.sqrt(3) / 2;
      const l = Math.asin(M * Math.sin(phi));
      const l2 = l * l;
      const l6 = l2 * l2 * l2;
      return [
        lambda * Math.cos(l) / (M * (A1 + 3 * A2 * l2 + l6 * (7 * A3 + 9 * A4 * l2))),
        l * (A1 + A2 * l2 + l6 * (A3 + A4 * l2))
      ];
    };
    const affineForProjection = (projection) => {
      const translate = projection.translate();
      const screen = [translate, [translate[0] + 8, translate[1]], [translate[0], translate[1] + 8]];
      const geographic = screen.map((point) => projection.invert(point));
      if (geographic.some((point) => !point || !point.every(Number.isFinite))) return null;
      const raw = geographic.map((point) => rawPoint(projection, point));
      if (raw.some((point) => !point.every(Number.isFinite))) return null;
      const x0 = raw[0][0]; const y0 = raw[0][1];
      const x1 = raw[1][0]; const y1 = raw[1][1];
      const x2 = raw[2][0]; const y2 = raw[2][1];
      const determinant = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (Math.abs(determinant) < 1e-12) return null;
      const solve = (values) => {
        const d1 = values[1] - values[0];
        const d2 = values[2] - values[0];
        const a = (d1 * (y2 - y0) - d2 * (y1 - y0)) / determinant;
        const b = ((x1 - x0) * d2 - (x2 - x0) * d1) / determinant;
        return [a, b, values[0] - a * x0 - b * y0];
      };
      return [...solve(screen.map((point) => point[0])), ...solve(screen.map((point) => point[1]))];
    };
    if (gl) {
      try {
        const vertexSource = `#version 300 es
          precision highp float;
          in vec2 a_lonlat;
          in vec4 a_color;
          uniform vec3 u_affine_x;
          uniform vec3 u_affine_y;
          uniform vec3 u_rotate;
          uniform vec2 u_viewport;
          uniform int u_projection;
          out float v_visible;
          out vec4 v_color;
          const float PI = 3.141592653589793;
          void main() {
            float lambda = radians(a_lonlat.x) + u_rotate.x;
            lambda = mod(lambda + PI, 2.0 * PI) - PI;
            float phi = radians(a_lonlat.y);
            if (u_rotate.y != 0.0 || u_rotate.z != 0.0) {
              float cosPhi = cos(phi);
              float x = cos(lambda) * cosPhi;
              float y = sin(lambda) * cosPhi;
              float z = sin(phi);
              float k = z * cos(u_rotate.y) + x * sin(u_rotate.y);
              lambda = atan(y * cos(u_rotate.z) - k * sin(u_rotate.z), x * cos(u_rotate.y) - z * sin(u_rotate.y));
              phi = asin(clamp(k * cos(u_rotate.z) + y * sin(u_rotate.z), -1.0, 1.0));
            }
            vec2 raw;
            v_visible = 1.0;
            if (u_projection == 1) {
              raw = vec2(cos(phi) * sin(lambda), sin(phi));
              v_visible = cos(phi) * cos(lambda);
            } else if (u_projection == 2) {
              float denominator = 1.0 + cos(lambda) * cos(phi);
              float k = sqrt(2.0 / max(denominator, 1e-8));
              raw = vec2(k * cos(phi) * sin(lambda), k * sin(phi));
              v_visible = denominator > 1e-7 ? 1.0 : -1.0;
            } else if (u_projection == 3) {
              raw = vec2(lambda, log(tan((PI / 2.0 + clamp(phi, -1.570795, 1.570795)) / 2.0)));
            } else {
              const float A1 = 1.340264;
              const float A2 = -0.081106;
              const float A3 = 0.000893;
              const float A4 = 0.003796;
              const float M = 0.8660254037844386;
              float l = asin(M * sin(phi));
              float l2 = l * l;
              float l6 = l2 * l2 * l2;
              raw = vec2(
                lambda * cos(l) / (M * (A1 + 3.0 * A2 * l2 + l6 * (7.0 * A3 + 9.0 * A4 * l2))),
                l * (A1 + A2 * l2 + l6 * (A3 + A4 * l2))
              );
            }
            vec2 pixel = vec2(dot(u_affine_x, vec3(raw, 1.0)), dot(u_affine_y, vec3(raw, 1.0)));
            vec2 clip = vec2(pixel.x / u_viewport.x * 2.0 - 1.0, 1.0 - pixel.y / u_viewport.y * 2.0);
            // Keep back-facing vertices at their projected position and let
            // the fragment shader clip the hidden part of the triangle.
            // Moving every hidden vertex to one off-screen point stretches
            // country triangles across the viewport; with globally relevant
            // languages that showed up as long horizontal streaks while the
            // globe was moving.
            gl_Position = vec4(clip, 0.0, 1.0);
            v_color = a_color;
          }`;
        const fragmentSource = `#version 300 es
          precision mediump float;
          in float v_visible;
          in vec4 v_color;
          out vec4 out_color;
          void main() { if (v_visible < 0.0) discard; out_color = v_color; }`;
        const program = gl.createProgram();
        gl.attachShader(program, compileShader(gl.VERTEX_SHADER, vertexSource));
        gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fragmentSource));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        const mesh = meshShapes();
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const vertexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
        const location = gl.getAttribLocation(program, "a_lonlat");
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
        const colorBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.colors, gl.DYNAMIC_DRAW);
        const colorLocation = gl.getAttribLocation(program, "a_color");
        gl.enableVertexAttribArray(colorLocation);
        gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, 0, 0);
        const indexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        webgl = {program, vao, mesh, colorBuffer};
        root.dataset.mapMotionMeshVertices = String(mesh.vertices.length / 2);
        root.dataset.mapMotionMeshTriangles = String(mesh.indices.length / 3);
      } catch (error) {
        console.warn("Kotonohatlas: WebGL motion renderer unavailable; using Canvas2D", error);
        webgl = null;
      }
    }

    const clearWebglSurface = () => {
      if (!webgl || !gl || gl.isContextLost()) return false;
      gl.viewport(0, 0, fillSurface.width, fillSurface.height);
      gl.clearColor(oceanComponents[0], oceanComponents[1], oceanComponents[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return true;
    };
    const renderFills = (projection) => {
      if (!clearWebglSurface()) return false;
      // Clear first. affineForProjection can legitimately fail for a frame
      // close to a projection singularity; leaving the preceding GPU frame in
      // place there produced the intermittent grey/stale map seen on drag.
      const affine = affineForProjection(projection);
      if (!affine) return false;
      try {
        const {program, vao, mesh} = webgl;
        const familyIds = {"equal-earth": 0, orthographic: 1, azimuthal: 2, mercator: 3};
        const rotation = projection.rotate().map((value) => value * Math.PI / 180);
        gl.useProgram(program);
        gl.bindVertexArray(vao);
        gl.uniform3fv(gl.getUniformLocation(program, "u_affine_x"), affine.slice(0, 3));
        gl.uniform3fv(gl.getUniformLocation(program, "u_affine_y"), affine.slice(3, 6));
        gl.uniform3fv(gl.getUniformLocation(program, "u_rotate"), rotation);
        gl.uniform2f(gl.getUniformLocation(program, "u_viewport"), width, height);
        gl.uniform1i(gl.getUniformLocation(program, "u_projection"), familyIds[projectionFamily(projection)] || 0);
        gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_INT, 0);
        return true;
      } catch (error) {
        console.warn("Kotonohatlas: WebGL motion frame failed; using Canvas2D", error);
        webgl = null;
        root.dataset.mapRenderer = "svg-settled+canvas-motion";
        return false;
      }
    };

    const updateSelection = () => {
      const startedAt = performance.now();
      let changedShapes = 0;
      let changedVertices = 0;
      // The settled SVG may be replaced while a country-selection callback is
      // still completing. Recompute the transient mesh selection from the map
      // state itself instead of trusting the dataset values captured when the
      // renderer was created; otherwise the following drag can briefly paint
      // the previously selected country.
      const iso2ByIso3 = countryCodeIndex(data);
      const countryRows = new Map((options.countries || []).map((item) => [item.code, item]));
      const selectedCodes = Array.from(selectedCountries);
      motionShapes.forEach((entry) => {
        const item = {feature: entry.feature, ...featureInfo(entry.feature, iso2ByIso3, countryRows)};
        const selected = countryItemIsSelected(item);
        if (selected) entry.shape.dataset.selected = "true";
        else delete entry.shape.dataset.selected;
        if (selected && isClaimOnlySelection(item, selectedCodes, selectedFeatureId)) {
          entry.shape.dataset.claimOnly = "true";
        } else {
          delete entry.shape.dataset.claimOnly;
        }
      });
      motionCountryLabels.forEach((item) => {
        const selected = selectedCountries.has(item.code);
        if (item.selected === selected) return;
        item.selected = selected;
        item.paint = selected ? selectedCountryPaint : countryPaint;
        context.font = item.paint.font;
        item.textWidth = Math.ceil(context.measureText(item.text || "").width);
        item.textHeight = Math.max(8, Number.parseFloat(item.paint.font.match(/([\d.]+)px/)?.[1]) || 10);
      });
      motionShapes.forEach((entry) => {
        const paint = effectivePaint(entry);
        const color = colorComponents(paint.fill, paint.opacity * paint.fillOpacity);
        if (entry.color && color.every((value, index) => Math.abs(value - entry.color[index]) < 1e-6)) return;
        entry.color = color;
        changedShapes += 1;
        changedVertices += entry.vertexCount;
        if (!webgl || !entry.vertexCount) return;
        const values = new Float32Array(entry.vertexCount * 4);
        for (let index = 0; index < entry.vertexCount; index += 1) values.set(color, index * 4);
        gl.bindBuffer(gl.ARRAY_BUFFER, webgl.colorBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, entry.vertexStart * 4 * Float32Array.BYTES_PER_ELEMENT, values);
      });
      root.dataset.mapMotionSelectionShapes = String(changedShapes);
      root.dataset.mapMotionSelectionVertices = String(changedVertices);
      root.dataset.mapMotionSelectionMs = (performance.now() - startedAt).toFixed(2);
      return changedShapes > 0;
    };

    const drawExactMotionShapes = (path) => {
      // Most ordinary country shapes share one paint.  Feeding those features
      // to a single geographic stream preserves D3's seam/horizon clipping
      // while avoiding one complete path setup per country. Detailed dispute,
      // mask, and region-overlay geometry is intentionally omitted during the
      // gesture and restored atomically with the settled 10m SVG.
      const baseGroups = new Map();
      motionShapes.forEach((entry) => {
        const paint = effectivePaint(entry);
        if (paint.opacity <= 0
          || ((paint.fill === "none" || paint.fillOpacity <= 0)
            && (paint.stroke === "none" || paint.strokeOpacity <= 0 || paint.strokeWidth <= 0))) return;
        if (entry.ordered) return;
        const key = paintKey(paint);
        if (!baseGroups.has(key)) baseGroups.set(key, {paint, features: []});
        baseGroups.get(key).features.push(entry.motionFeature);
      });
      baseGroups.forEach(({paint, features}) => {
        drawGeometry(path, {type: "FeatureCollection", features}, paint);
      });
      root.dataset.mapMotionFillDraws = String(baseGroups.size);
    };

    const drawMotionLabels = (projection) => {
      const startedAt = performance.now();
      const rawClipAngle = projection.clipAngle();
      const clipAngle = rawClipAngle == null ? Number.NaN : Number(rawClipAngle);
      const sphericalClip = Number.isFinite(clipAngle) && clipAngle > 0;
      const center = sphericalClip ? projection.invert(projection.translate()) : null;
      const visiblePoint = (coordinate) => {
        if (sphericalClip && center
          && geoDistance(center, coordinate) * 180 / Math.PI > clipAngle + 0.5) return null;
        const point = projection(coordinate);
        if (!point || !point.every(Number.isFinite)
          || point[0] < -24 || point[0] > width + 24
          || point[1] < -24 || point[1] > height + 24) return null;
        return point;
      };
      const minimumCountryArea = Math.max(150, width * height * 0.00016);
      const projectedCountries = new Map();
      motionCountryLabels.forEach((item) => {
        const point = visiblePoint(item.coordinate);
        if (!point) return;
        const epsilon = 0.04;
        const longitude = item.coordinate[0];
        const latitude = Math.max(-89.9, Math.min(89.9, item.coordinate[1]));
        const east = projection([longitude + epsilon, latitude]);
        const north = projection([longitude, Math.min(89.95, latitude + epsilon)]);
        if (!east || !north || !east.every(Number.isFinite) || !north.every(Number.isFinite)) return;
        const determinant = Math.abs(
          (east[0] - point[0]) * (north[1] - point[1])
          - (east[1] - point[1]) * (north[0] - point[0])
        );
        const radians = epsilon * Math.PI / 180;
        const localSteradians = Math.max(1e-10, Math.cos(latitude * Math.PI / 180) * radians * radians);
        const area = Math.min(width * height, item.sphericalArea * determinant / localSteradians);
        if (Number.isFinite(area) && area > 0) projectedCountries.set(item.code, {item, point, area});
      });
      const motionPlaceZoom = placeZoomLevel(projection, width, height);
      const motionPriorityCountries = placePriorityCountryCodes();
      const visibleCapitals = motionCapitalMarkers.map((item) => ({item, point: visiblePoint(item.coordinate)}))
        .filter(({item, point}) => (
          point
          && (projectedCountries.get(item.countryCode)?.area || 0) >= 0.75
          && capitalMarkerVisibleAtZoom(
            item.minimumZoom,
            motionPlaceZoom,
            motionPriorityCountries.has(item.countryCode)
          )
        ));
      context.save();
      visibleCapitals.forEach(({item, point}) => {
        context.beginPath();
        context.arc(point[0], point[1], item.radius, 0, Math.PI * 2);
        context.fillStyle = item.fill;
        context.fill();
        if (item.stroke !== "none" && item.strokeWidth > 0) {
          context.strokeStyle = item.stroke;
          context.lineWidth = item.strokeWidth;
          context.stroke();
        }
      });
      const visibleCapitalCodes = new Set(visibleCapitals.map(({item}) => item.countryCode));
      const labelCandidates = [
        ...Array.from(projectedCountries.values())
          .filter(({item, area}) => item.selected || area >= minimumCountryArea)
          .sort((left, right) => Number(right.item.selected) - Number(left.item.selected) || right.area - left.area)
          .map(({item, point}) => ({item, point})),
        ...motionCapitalLabels
          .filter((item) => visibleCapitalCodes.has(item.countryCode))
          .sort((left, right) => right.population - left.population)
          .map((item) => ({item, point: visiblePoint(item.coordinate)}))
          .filter(({point}) => point)
      ];
      const occupied = [];
      let rendered = 0;
      labelCandidates.some(({item, point}) => {
        if (rendered >= 80) return true;
        if (!item.text) return false;
        const x = point[0] + item.offset[0];
        const y = point[1] + item.offset[1];
        const {paint} = item;
        const left = paint.align === "left" ? x
          : paint.align === "right" ? x - item.textWidth : x - item.textWidth / 2;
        const box = {
          x: left - 2,
          y: y - item.textHeight / 2 - 2,
          width: item.textWidth + 4,
          height: item.textHeight + 4
        };
        const inside = box.x >= 2 && box.y >= 2
          && box.x + box.width <= width - 2 && box.y + box.height <= height - 2;
        const collides = occupied.some((other) => !(
          box.x + box.width + 2 <= other.x || other.x + other.width + 2 <= box.x
          || box.y + box.height + 2 <= other.y || other.y + other.height + 2 <= box.y
        ));
        if (!inside || collides) return false;
        context.font = paint.font;
        context.textAlign = paint.align;
        context.textBaseline = "middle";
        context.lineJoin = "round";
        if (paint.stroke !== "none" && paint.strokeWidth > 0) {
          context.strokeStyle = paint.stroke;
          context.lineWidth = paint.strokeWidth;
          context.strokeText(item.text, x, y);
        }
        context.fillStyle = paint.fill;
        context.fillText(item.text, x, y);
        occupied.push(box);
        rendered += 1;
        return false;
      });
      context.restore();
      root.dataset.mapMotionVisibleLabels = String(rendered);
      root.dataset.mapMotionLabelMs = (performance.now() - startedAt).toFixed(2);
    };

    let lastRenderDuration = 0;
    const render = (projection) => {
      const startedAt = performance.now();
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = oceanColor;
      context.fillRect(0, 0, width, height);
      const path = geoPath(projection, context);
      const [longitudeStep, latitudeStep] = graticuleSteps(projection, width, height, 1);
      const graticule = visibleGraticule(
        projection,
        width,
        height,
        longitudeStep,
        latitudeStep,
        true
      );
      drawGeometry(path, graticule.minorGeometry, minorGraticulePaint);
      drawGeometry(path, graticule.majorGeometry, majorGraticulePaint);
      const graticuleAt = performance.now();
      drawExactMotionShapes(path);
      const countriesAt = performance.now();
      drawGeometry(path, motionOverviewCoastlines, coastlinePaint);
      drawGeometry(path, motionOverviewBorders, borderPaint);
      const linesAt = performance.now();
      drawMotionLabels(projection);
      const completedAt = performance.now();
      root.dataset.mapMotionGraticuleMs = (graticuleAt - startedAt).toFixed(2);
      root.dataset.mapMotionCountriesMs = (countriesAt - graticuleAt).toFixed(2);
      root.dataset.mapMotionLinesMs = (linesAt - countriesAt).toFixed(2);
      root.dataset.mapMotionRenderMs = (completedAt - startedAt).toFixed(2);
      lastRenderDuration = completedAt - startedAt;
    };
    const show = (projection) => {
      // Paint the hidden canvas first and then overlay it. Keep the settled
      // SVG underneath instead of swapping it out: pointer-driven gestures
      // can invalidate or replace the transient layer, and hiding the only
      // complete frame made the map disappear until the next preview draw.
      // A click can update the selection immediately before the drag begins.
      // Synchronize the dynamic colour buffer once more at gesture start so
      // the first motion frame cannot expose the previous selection.
      updateSelection();
      render(projection);
      if (!visible) {
        layer.style.display = "";
        visible = true;
      }
      root.dataset.mapMotionActive = "true";
    };
    const hide = () => {
      layer.style.display = "none";
      layer.removeAttribute("transform");
      // Clear an old inline value left by pages generated before the motion
      // layer became an overlay rather than a replacement.
      settledCanvas.style.visibility = "";
      visible = false;
      delete root.dataset.mapMotionActive;
    };
    root.dataset.mapRenderer = webgl ? "svg-settled+webgl-motion" : "svg-settled+canvas-motion-exact";
    root.dataset.mapMotionDraws = String((webgl ? 1 : motionShapes.length) + 6);
    root.dataset.mapMotionFeatures = String(motionShapes.length);
    root.dataset.mapMotionGeometry = "110m-base+110m-coastline+110m-borders";
    root.dataset.mapMotionLineGeometry = "110m-coastline+110m-borders";
    root.dataset.mapMotionDisputes = webgl
      ? "static-mesh+dynamic-selection"
      : "exact-geographic-stream+dynamic-selection";
    return {
      render,
      show,
      hide,
      updateSelection,
      renderDuration: () => lastRenderDuration
    };
  }

  function enablePlanarNavigation(canvas, projection, path, width, height, preserveNavigation, deferredOffscreen) {
    refreshNavigationSelection = null;
    planarProjection = cloneProjection(projection);
    const selection = select(svg);
    const limits = navigationLimits(path, width, height);
    const currentScale = Math.max(1e-9, navigationTransform.k);
    const scaleExtent = [
      Math.min(currentScale, limits.scaleExtent[0]),
      Math.max(currentScale, limits.scaleExtent[1])
    ];
    let hydrated = !deferredOffscreen;
    let gestureStartTransform = zoomIdentity;
    let gestureActive = false;
    selection.on(".zoom", null);
    zoomBehavior = zoom()
      .scaleExtent(scaleExtent)
      .extent([[0, 0], [width, height]])
      .translateExtent([[-width * 100, -height * 100], [width * 101, height * 101]])
      .clickDistance(4)
      .wheelDelta((event) => -event.deltaY * (event.deltaMode ? 0.05 : 0.002))
      .on("start", (event) => {
        gestureStartTransform = event.transform;
        gestureActive = false;
      })
      .on("zoom", (event) => {
        const moved = Math.hypot(
          event.transform.x - gestureStartTransform.x,
          event.transform.y - gestureStartTransform.y
        ) > 4;
        const scaled = Math.abs(Math.log(Math.max(1e-9, event.transform.k / gestureStartTransform.k))) > 1e-4;
        if (!gestureActive && (moved || scaled)) {
          gestureActive = true;
          cancelDetailedRestore();
          root.dataset.mapNavigating = "true";
        }
        if (!hydrated && (moved || scaled)) {
          renderProjectedViewport(canvas, projection, width, true);
          root.dataset.mapGestureResolution = root.dataset.mapResolution || "10m";
          hydrated = true;
        }
        navigationTransform = event.transform;
        canvas.setAttribute("transform", event.transform);
        updateGraticule(canvas, projection, event.transform.k);
        syncZoomControls();
      })
      .on("end", () => {
        if (!gestureActive) {
          delete root.dataset.mapNavigating;
          return;
        }
        cameraCustomized = true;
        if (root.dataset.mapGestureResolution) {
          scheduleDetailedRestore(canvas, projection, width);
        } else delete root.dataset.mapNavigating;
        notifyViewChange();
      });
    const initialTransform = preserveNavigation ? navigationTransform : zoomIdentity;
    selection.call(zoomBehavior);
    selection.property("__zoom", initialTransform);
    navigationTransform = initialTransform;
    if (initialTransform === zoomIdentity) canvas.removeAttribute("transform");
    else canvas.setAttribute("transform", initialTransform);
    syncZoomControls();
  }

  function enableGlobeNavigation(canvas, projection, path, width, height, defaultGestureMode = "orbit") {
    planarProjection = null;
    const generation = ++navigationGeneration;
    const selection = select(svg);
    const limits = navigationLimits(path, width, height);
    const fittedScale = Math.max(1, fittedProjectionScale || projection.scale());
    const currentScale = Math.max(1, projection.scale());
    projectionScaleExtent = [
      Math.max(1, currentScale * limits.scaleExtent[0]),
      Math.max(currentScale, fittedScale * MAXIMUM_NAVIGATION_ZOOM)
    ];
    activeProjection = cloneProjection(projection);
    let gestureProjection = cloneProjection(activeProjection);
    let latestTransform = zoomIdentity;
    let previewTimer = 0;
    let gestureAnchor = null;
    let anchoredGesture = false;
    let gestureMode = defaultGestureMode;
    let gestureStartRoll = activeProjection.rotate()[2] || 0;
    let temporaryPolarRotation = false;
    let overviewActive = false;
    const motionRenderer = createMotionRenderer(canvas, width, activeProjection);
    // Keep every visible motion frame on the actual globe projection.  An
    // affine transform of the previously projected canvas is cheaper, but it
    // is not a valid approximation near the projection seam or a pole: land
    // can tear, coastlines can leave the ocean backdrop, and the old settled
    // SVG may show through.  Coalesce input to one exact geographically
    // clipped render per animation frame instead.
    let motionRendererWarmed = false;
    let motionRendererWarmScheduled = false;
    const warmMotionRenderer = () => {
      motionRendererWarmScheduled = false;
      if (generation !== navigationGeneration
        || motionRendererWarmed
        || !document.documentElement.contains(svg)) return;
      // Do not let an idle callback steal time from a gesture that started
      // before the browser found an idle slot. The next settled interval can
      // safely absorb this one-time shader/graticule warm-up instead.
      if (root.dataset.mapNavigating === "true") {
        scheduleMotionRendererWarm(120);
        return;
      }
      motionRendererWarmed = true;
      motionRenderer.render(activeProjection);
      motionRenderer.hide();
      root.dataset.mapMotionWarmed = "true";
    };
    const scheduleMotionRendererWarm = (timeout = 120) => {
      if (motionRendererWarmScheduled || generation !== navigationGeneration) return;
      motionRendererWarmScheduled = true;
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(warmMotionRenderer, {timeout});
      } else {
        window.setTimeout(warmMotionRenderer, Math.min(timeout, 32));
      }
    };
    refreshNavigationSelection = () => {
      if (generation !== navigationGeneration) return false;
      // Selection only changes a few per-vertex colours and label flags. Keep
      // the projection, GPU geometry and gesture handlers intact so a map
      // click is visible immediately and the following drag starts from the
      // same camera without briefly restoring the previous country.
      motionRenderer.updateSelection();
      // Updating the WebGL colour buffer does not repaint pixels which are
      // already on the visible motion canvas. Repaint that canvas immediately
      // when a selection arrives while a detailed SVG restore is pending.
      // The pending restore is intentionally left intact so it can hide the
      // transient layer and leave the following drag in a settled state.
      if (root.dataset.mapMotionActive === "true") {
        motionRenderer.render(activeProjection);
      }
      return true;
    };
    scheduleMotionRendererWarm(1500);
    const setPolarOrientationOverride = (active) => {
      const value = active ? "polar-center" : "";
      if (temporaryPolarRotation === active
        && (root.dataset.mapOrientationAuto || "") === value) return;
      temporaryPolarRotation = active;
      if (value) root.dataset.mapOrientationAuto = value;
      else delete root.dataset.mapOrientationAuto;
      syncNavigationControls();
    };
    setPolarOrientationOverride(
      requestedOrientationRoll(orientationMode, orientationRoll) != null
      && poleNearViewportCenter(activeProjection, width, height)
    );
    const renderGlobeProjection = (transform, useOverview) => {
      let projected;
      if (gestureMode === "roll") {
        const rollDistance = Math.max(160, Math.min(width, height));
        const roll = normalizeRotationLongitude(gestureStartRoll + transform.x / rollDistance * 180);
        projected = cloneProjection(gestureProjection);
        const rotation = projected.rotate();
        projected.rotate([rotation[0], rotation[1], roll]);
        orientationMode = "custom";
        orientationRoll = roll;
        root.dataset.mapOrientation = orientationMode;
        root.dataset.mapOrientationRoll = String(orientationRoll);
        setPolarOrientationOverride(false);
      } else if (gestureMode === "pan") {
        projected = translatedNavigation(gestureProjection, transform);
        setPolarOrientationOverride(false);
      } else if (projectionFamily(gestureProjection) === "transverse-mercator") {
        projected = transverseMercatorNavigation(
          gestureProjection,
          transform,
          anchoredGesture && gestureAnchor ? gestureAnchor : [width / 2, height / 2]
        );
        setPolarOrientationOverride(false);
      } else if (anchoredGesture && gestureAnchor) {
        const freeProjection = anchoredNavigation(gestureProjection, transform, gestureAnchor);
        const fixedRoll = requestedOrientationRoll(orientationMode, orientationRoll);
        if (fixedRoll != null) {
          const fixedOrientationAmount = polarFixedOrientationAmount(freeProjection, width, height);
          projected = anchoredFixedOrientationNavigation(
            gestureProjection,
            transform,
            gestureAnchor,
            freeProjection,
            fixedOrientationAmount,
            fixedRoll
          );
          setPolarOrientationOverride(poleNearViewportCenter(freeProjection, width, height));
        } else {
          projected = freeProjection;
          setPolarOrientationOverride(false);
        }
      } else {
        projected = projectedNavigation(gestureProjection, transform, width, height);
      }
      projected.scale(Math.max(projectionScaleExtent[0], Math.min(projectionScaleExtent[1], projected.scale())));
      if (orientationMode === "free") {
        orientationRoll = normalizeRotationLongitude(projected.rotate()[2] || 0);
        root.dataset.mapOrientationRoll = String(orientationRoll);
      }
      if (useOverview) motionRenderer.render(projected);
      else {
        motionRenderer.hide();
        renderProjectedViewport(canvas, projected, width, false);
      }
      activeProjection = cloneProjection(projected);
      syncNavigationControls();
      return projected;
    };
    const scheduleProjectionPreview = () => {
      if (previewTimer) return;
      previewTimer = window.requestAnimationFrame(() => {
        previewTimer = 0;
        renderGlobeProjection(latestTransform, true);
      });
    };
    const activateOverview = () => {
      if (overviewActive) return;
      overviewActive = true;
      cancelDetailedRestore();
      root.dataset.mapNavigating = "true";
      root.dataset.mapGestureResolution = root.dataset.mapMotionGeometry
        || root.dataset.mapResolution
        || "10m";
      motionRenderer.show(activeProjection);
    };
    selection.on(".zoom", null);
    selection.on("contextmenu.map-roll", (event) => {
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    });
    selection.property("__zoom", zoomIdentity);
    canvas.removeAttribute("transform");
    navigationTransform = zoomIdentity;
    zoomBehavior = zoom()
      .filter((event) => event.type === "wheel" || event.button === 0)
      .scaleExtent([0.2, MAXIMUM_NAVIGATION_ZOOM])
      .extent([[0, 0], [width, height]])
      .translateExtent([[-width * 100, -height * 100], [width * 101, height * 101]])
      .clickDistance(4)
      .wheelDelta((event) => -event.deltaY * (event.deltaMode ? 0.05 : 0.002))
      .on("start", (event) => {
        gestureProjection = cloneProjection(activeProjection);
        const sourceType = event.sourceEvent && event.sourceEvent.type || "";
        const source = event.sourceEvent || {};
        const pointerGesture = sourceType === "mousedown" || sourceType === "pointerdown";
        const alternateGestureMode = defaultGestureMode === "pan" ? "orbit" : "pan";
        gestureMode = pointerGesture && (source.ctrlKey || source.metaKey)
          ? "roll"
          : (pointerGesture && source.shiftKey ? alternateGestureMode : defaultGestureMode);
        gestureStartRoll = gestureProjection.rotate()[2] || 0;
        root.dataset.mapGestureMode = gestureMode;
        anchoredGesture = gestureMode !== "roll" && (
          sourceType === "mousedown"
          || sourceType === "touchstart"
          || sourceType === "pointerdown"
          || sourceType === "wheel"
        );
        gestureAnchor = anchoredGesture ? pointer(event.sourceEvent, svg) : null;
        const polarOverride = requestedOrientationRoll(orientationMode, orientationRoll) != null
          && poleNearViewportCenter(gestureProjection, width, height);
        setPolarOrientationOverride(polarOverride);
        latestTransform = zoomIdentity;
        overviewActive = false;
        delete root.dataset.mapGestureResolution;
      })
      .on("zoom", (event) => {
        const moved = Math.hypot(event.transform.x, event.transform.y) > 4;
        const scaled = Math.abs(Math.log(Math.max(1e-9, event.transform.k))) > 1e-4;
        if (moved || scaled) activateOverview();
        navigationTransform = event.transform;
        latestTransform = event.transform;
        if (gestureMode === "pan") {
          const dialProjection = translatedNavigation(gestureProjection, latestTransform);
          dialProjection.scale(Math.max(
            projectionScaleExtent[0],
            Math.min(projectionScaleExtent[1], dialProjection.scale())
          ));
          syncNavigationControls(dialProjection);
        }
        if (overviewActive) {
          if (gestureMode === "roll") renderGlobeProjection(latestTransform, true);
          else scheduleProjectionPreview();
        }
      })
      .on("end", (event) => {
        if (!overviewActive) {
          navigationTransform = zoomIdentity;
          motionRenderer.hide();
          canvas.removeAttribute("transform");
          delete root.dataset.mapNavigating;
          selection.property("__zoom", zoomIdentity);
          delete root.dataset.mapGestureMode;
          syncZoomControls();
          scheduleMotionRendererWarm(80);
          return;
        }
        const transform = event.transform;
        if (previewTimer) window.cancelAnimationFrame(previewTimer);
        previewTimer = 0;
        activeProjection = renderGlobeProjection(transform, true);
        navigationTransform = zoomIdentity;
        scheduleDetailedRestore(canvas, activeProjection, width, DETAIL_RESTORE_DELAY, () => motionRenderer.hide());
        scheduleMotionRendererWarm(80);
        selection.property("__zoom", zoomIdentity);
        delete root.dataset.mapGestureMode;
        syncNavigationControls();
        syncZoomControls();
        cameraCustomized = true;
        notifyViewChange();
      });
    selection.call(zoomBehavior);
    syncZoomControls();
  }

  function enableMapNavigation(canvas, projection, path, width, height, preserveNavigation, deferredOffscreen) {
    if (usesProjectedNavigation()) {
      enableGlobeNavigation(
        canvas,
        projection,
        path,
        width,
        height,
        movementMode === "planar" ? "pan" : "orbit"
      );
      return;
    }
    navigationGeneration += 1;
    activeProjection = null;
    enablePlanarNavigation(canvas, projection, path, width, height, preserveNavigation, deferredOffscreen);
  }

  function syncZoomControls() {
    const zoomOutButton = root.querySelector('[data-map-action="zoom-out"]');
    const zoomInButton = root.querySelector('[data-map-action="zoom-in"]');
    let currentScale = navigationTransform.k;
    let minimumScale = 1;
    let maximumScale = MAXIMUM_NAVIGATION_ZOOM;
    if (usesProjectedNavigation() && activeProjection) {
      currentScale = activeProjection.scale();
      [minimumScale, maximumScale] = projectionScaleExtent;
    } else if (zoomBehavior) {
      [minimumScale, maximumScale] = zoomBehavior.scaleExtent();
    }
    const tolerance = Math.max(1e-6, Math.abs(currentScale) * 1e-6);
    zoomOutButton.disabled = currentScale <= minimumScale + tolerance;
    zoomInButton.disabled = currentScale >= maximumScale - tolerance;
    syncCenterCoordinates();
  }

  function currentOrientationRoll() {
    if (activeProjection) return normalizeRotationLongitude(activeProjection.rotate()[2] || 0);
    return normalizeRotationLongitude(requestedOrientationRoll(orientationMode, orientationRoll) ?? orientationRoll);
  }

  function applyOrientationRoll(nextRoll, nextMode = "custom", useOverview = false) {
    orientationRoll = normalizeRotationLongitude(nextRoll);
    orientationMode = nextMode;
    root.dataset.mapOrientation = orientationMode;
    root.dataset.mapOrientationRoll = String(orientationRoll);
    delete root.dataset.mapOrientationAuto;
    if (activeProjection) {
      const rotation = activeProjection.rotate();
      activeProjection.rotate([rotation[0], rotation[1], orientationRoll]);
      const width = Math.max(280, stage.clientWidth || root.clientWidth || 600);
      const canvas = svg.querySelector(".location-map__viewport:last-of-type");
      if (canvas) renderProjectedViewport(canvas, activeProjection, width, useOverview);
    }
    syncNavigationControls();
    syncZoomControls();
    if (!activeProjection) draw(true);
  }

  function finishOrientationChange() {
    if (!activeProjection) return;
    const width = Math.max(280, stage.clientWidth || root.clientWidth || 600);
    const canvas = svg.querySelector(".location-map__viewport:last-of-type");
    if (canvas) scheduleDetailedRestore(canvas, activeProjection, width);
  }

  function animateNavigation(target, duration = 220) {
    if (!zoomBehavior) return;
    cancelAnimationFrame(navigationFrame);
    const start = navigationTransform;
    const startedAt = performance.now();
    const selection = select(svg);
    const tick = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const transform = zoomIdentity
        .translate(
          start.x + (target.x - start.x) * eased,
          start.y + (target.y - start.y) * eased
        )
        .scale(start.k + (target.k - start.k) * eased);
      selection.call(zoomBehavior.transform, transform);
      syncZoomControls();
      if (progress < 1) navigationFrame = requestAnimationFrame(tick);
      else {
        cameraCustomized = true;
        notifyViewChange();
      }
    };
    navigationFrame = requestAnimationFrame(tick);
  }

  function zoomBy(factor) {
    const width = Math.max(280, stage.clientWidth || root.clientWidth || 600);
    const height = Number(svg.getAttribute("height")) || Math.max(210, width * 0.53);
    if (usesProjectedNavigation() && activeProjection) {
      const nextScale = Math.max(
        projectionScaleExtent[0],
        Math.min(projectionScaleExtent[1], activeProjection.scale() * factor)
      );
      scaleProjectionAtPoint(activeProjection, nextScale, [width / 2, height / 2]);
      const canvas = svg.querySelector(".location-map__viewport:last-of-type");
      if (canvas) renderProjectedViewport(canvas, activeProjection, width);
      syncZoomControls();
      cameraCustomized = true;
      notifyViewChange();
      return;
    }
    const [minimumScale, maximumScale] = zoomBehavior
      ? zoomBehavior.scaleExtent()
      : [1, MAXIMUM_NAVIGATION_ZOOM];
    const nextScale = Math.max(minimumScale, Math.min(maximumScale, navigationTransform.k * factor));
    const ratio = nextScale / navigationTransform.k;
    const centerX = width / 2;
    const centerY = height / 2;
    animateNavigation(zoomIdentity
      .translate(
        centerX - (centerX - navigationTransform.x) * ratio,
        centerY - (centerY - navigationTransform.y) * ratio
      )
      .scale(nextScale));
  }

  function viewportFittedMapHeight(width) {
    const viewportHeight = Math.max(
      320,
      Number(window.visualViewport && window.visualViewport.height)
        || Number(window.innerHeight)
        || Math.min(700, width * 0.74)
    );
    const section = root.closest("section");
    if (!section) return Math.max(210, Math.min(700, width * 0.74));
    const sectionBounds = section.getBoundingClientRect();
    const stageBounds = stage.getBoundingClientRect();
    const rootBounds = root.getBoundingClientRect();
    const leadingHeight = Math.max(0, stageBounds.top - sectionBounds.top);
    const trailingHeight = Math.max(0, rootBounds.bottom - stageBounds.bottom);
    const height = Math.max(210, Math.floor(viewportHeight - leadingHeight - trailingHeight - 12));
    root.dataset.mapViewportHeight = String(Math.round(viewportHeight));
    root.dataset.mapViewportLeadingHeight = String(Math.round(leadingHeight));
    root.dataset.mapViewportTrailingHeight = String(Math.round(trailingHeight));
    return height;
  }

  function draw(preserveNavigation = false, animateProjection = false) {
    cancelDetailedRestore();
    cancelPlaceLabelRelayout();
    const generation = ++drawGeneration;
    const copy = messages();
    const width = Math.max(280, stage.clientWidth || root.clientWidth || 600);
    // Localized headings wrap to different heights, so measure the portion of
    // the viewport already occupied above and below the stage. The section
    // title plus the complete map card then fills one viewport without relying
    // on a brittle fixed header subtraction.
    const height = viewportFittedMapHeight(width);
    const languages = selectedLanguages();
    // Start regional-data loading as soon as a language draw begins.  Keeping
    // this inside drawLanguageMode made the request depend on all projection
    // and viewport preparation completing first; an interrupted/replaced draw
    // could therefore leave a selected regional language on its whole-country
    // fallback without ever requesting its Admin-1 chunk.
    if (mode === "language" && languages.length) ensureAdmin1ForLanguages(languages);
    const projectionLanguage = languages.length > 1 ? combinedLanguage(languages) : languages[0];
    const selectedLanguageRegions = mode === "language"
      ? Array.from(selectedAdmin1Regions(languages).values())
      : [];
    const languageRegionFeatures = selectedLanguageRegions.map((item) => item.feature);
    const regionalCountryReplacements = Array.from(new Set(selectedLanguageRegions
      .filter((item) => item.replacesCountryRole && item.country)
      .map((item) => item.country)));
    const focusCodes = countryFocused && countrySelectionDrivesCamera
      ? Array.from(selectedCountries)
      : [];
    const focusFeature = countryFocused && countrySelectionDrivesCamera
      ? selectedFeatureId
      : "";
    const fittedProjection = fitProjection(
      width,
      height,
      data,
      mode === "language" ? projectionLanguage : null,
      focusCodes,
      focusFeature,
      forceWorldView,
      viewpointCountry,
      projectionMode,
      features,
      orientationMode,
      orientationRoll,
      languageRegionFeatures,
      regionalCountryReplacements
    );
    // An in-place map selection owns the current camera, including its
    // projection family. The newly selected context may prefer a different
    // automatic family, but adopting it here would recenter the map instead of
    // preserving the viewport requested by the click path.
    const preservesActiveProjection = preserveProjectedNavigation(
      usesProjectedNavigation(),
      preserveNavigation,
      activeProjection
    );
    if (!preservesActiveProjection) fittedProjectionScale = fittedProjection.scale();
    let projection = preservesActiveProjection
      ? cloneProjection(activeProjection)
      : fittedProjection;
    if (usesProjectedNavigation() && pendingProjectionView) {
      const view = pendingProjectionView;
      pendingProjectionView = null;
      const requestedScale = Number.isFinite(view.zoom)
        ? projectionScaleForAbsoluteZoom(view.zoom)
        : (Number.isFinite(view.scale) ? view.scale : fittedProjection.scale());
      if (view.center && view.center.every(Number.isFinite) && Number.isFinite(requestedScale)) {
        const roll = fittedProjection.rotate()[2] || 0;
        projection = cloneProjection(fittedProjection);
        if (projectionFamily(projection) === "transverse-mercator") {
          projection
            .center([0, Math.max(-89.5, Math.min(89.5, view.center[1]))])
            .rotate([-view.center[0], 0, roll]);
        } else {
          projection
            .center([0, 0])
            .rotate([-view.center[0], -view.center[1], roll]);
        }
        projection
          .scale(requestedScale)
          .translate([width / 2, height / 2]);
      }
    }
    syncResolvedProjectionSummary(projection);
    const path = geoPath(projection);
    const deferredOffscreen = !forceWorldView && (
      focusCodes.length > 0
      || Boolean(focusFeature)
      || (mode === "language" && projectionLanguage)
    );
    const visibleFeatureIds = deferredOffscreen
      ? visibleOverviewFeatureIds(projection, width, height)
      : null;
    const drawingPath = deferredOffscreen
      ? geoPath(viewportProjection(projection, width, height))
      : path;
    if (deferredOffscreen) root.dataset.mapDeferredOffscreen = "true";
    else delete root.dataset.mapDeferredOffscreen;
    const iso2ByIso3 = countryCodeIndex(data);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("height", String(height));
    svg.setAttribute("aria-label", mode === "country" ? copy.countryMode : `${copy.languageMode}: ${selectedLanguagesText(languages)}`);
    const previousCanvases = Array.from(svg.querySelectorAll(".location-map__viewport"));
    svg.querySelectorAll(".location-map__motion-viewport, .location-map__motion-surface").forEach((item) => item.remove());
    if (!animateProjection) svg.replaceChildren();
    const canvas = svgElement("g", {class: "location-map__viewport"});
    if (animateProjection && previousCanvases.length) canvas.style.opacity = "0";
    svg.append(canvas);
    if (mode === "country") drawCountryMode(canvas, drawingPath, iso2ByIso3, visibleFeatureIds);
    else drawLanguageMode(canvas, drawingPath, projection, iso2ByIso3, width, languages, visibleFeatureIds);
    const initialBorders = borders;
    canvas.append(svgElement("path", {class: "location-map__graticule location-map__graticule--minor"}));
    canvas.append(svgElement("path", {class: "location-map__graticule location-map__graticule--major"}));
    canvas.append(svgElement("path", {d: drawingPath(initialBorders), class: "location-map__borders"}));
    canvas.append(svgElement("path", {d: drawingPath(coastlines), class: "location-map__coastlines"}));
    syncCountryAdmin1Boundaries(canvas, drawingPath, projection, width, height);
    appendSelectedCountryBoundaryLayer(canvas, drawingPath, iso2ByIso3);
    canvas.append(svgElement("g", {class: "location-map__graticule-labels"}));
    updateGraticule(canvas, projection);
    {
      const labelScene = buildProjectedLabelScene(drawingPath, iso2ByIso3, width, height, visibleFeatureIds);
      rememberLabelScene(labelScene);
      const occupied = drawCountryLabels(canvas, drawingPath, iso2ByIso3, width, height, visibleFeatureIds, labelScene);
      drawPlaceLabels(canvas, projection, width, height, occupied, labelScene);
      root.dataset.mapPlaceLabelsReused = "false";
      root.dataset.mapLabelSceneReused = "false";
    }
    if (!usesProjectedNavigation() && pendingProjectionView) {
      const view = pendingProjectionView;
      pendingProjectionView = null;
      const point = view.center && view.center.every(Number.isFinite) ? projection(view.center) : null;
      const zoomLevel = Number(view.zoom);
      const requestedScale = Number.isFinite(zoomLevel)
        ? projectionScaleForAbsoluteZoom(zoomLevel)
        : projection.scale();
      if (point && point.every(Number.isFinite) && Number.isFinite(requestedScale)) {
        const transformScale = requestedScale / projection.scale();
        navigationTransform = zoomIdentity
          .translate(width / 2 - point[0] * transformScale, height / 2 - point[1] * transformScale)
          .scale(transformScale);
        preserveNavigation = true;
      }
    }
    enableMapNavigation(canvas, projection, path, width, height, preserveNavigation, deferredOffscreen);
    if (animateProjection && previousCanvases.length) {
      previousCanvases.forEach((previous) => {
        previous.classList.add("location-map__viewport--leaving");
        previous.style.pointerEvents = "none";
        previous.querySelectorAll(".location-map__hit").forEach((hit) => {
          hit.style.display = "none";
        });
      });
      requestAnimationFrame(() => {
        if (generation !== drawGeneration) return;
        canvas.style.opacity = "1";
        previousCanvases.forEach((previous) => { previous.style.opacity = "0"; });
      });
      window.setTimeout(() => {
        previousCanvases.forEach((previous) => previous.remove());
      }, 320);
    }
  }

  languageSelect.addEventListener("change", () => {
    if (languageSelect.value === "__selection__") return;
    selectedLanguage = languageSelect.value;
    selectedLanguageIds = selectedLanguage ? [selectedLanguage] : [];
    selectedLanguageLabel = "";
    forceWorldView = false;
    activeProjection = null;
    navigationTransform = zoomIdentity;
    pendingProjectionView = null;
    cameraCustomized = false;
    if (typeof options.onLanguagesSelect === "function") {
      options.onLanguagesSelect(selectedLanguageIds, selectedLanguagesText());
    }
    draw(false, true);
    notifyViewChange();
  });
  navigation.querySelector('[data-map-action="projection"]').addEventListener("change", (event) => {
    const nextMode = event.target.value;
    const modes = ["auto", "azimuthal", "azimuthal-equidistant", "stereographic", "gnomonic", "conic-equal-area", "conic-conformal", "conic-equidistant", "equirectangular", "orthographic", "equal-earth", "natural-earth-1", "mercator", "transverse-mercator"];
    if (!modes.includes(nextMode) || nextMode === projectionMode) return;
    if (!usesCylindricalProjection(nextMode) && usesProjectedNavigation() && activeProjection) {
      const width = Math.max(280, stage.clientWidth || root.clientWidth || 600);
      const height = Number(svg.getAttribute("height")) || Math.max(210, width * 0.53);
      pendingProjectionView = {
        center: activeProjection.invert([width / 2, height / 2]),
        scale: activeProjection.scale()
      };
    }
    projectionMode = nextMode;
    movementMode = usesPlanarDefaultProjection(nextMode) ? "planar" : "globe";
    root.dataset.mapMovement = movementMode;
    if (usesPlanarDefaultProjection(nextMode)) {
      pendingProjectionView = null;
      orientationMode = "north-up";
      orientationRoll = 0;
      root.dataset.mapOrientation = orientationMode;
      root.dataset.mapOrientationRoll = String(orientationRoll);
      delete root.dataset.mapOrientationAuto;
    }
    root.dataset.mapProjection = projectionMode;
    activeProjection = null;
    navigationTransform = zoomIdentity;
    cameraCustomized = Boolean(pendingProjectionView);
    syncNavigationControls();
    draw(false, true);
    notifyViewChange();
  });
  navigation.querySelector('[data-map-action="movement"]').addEventListener("click", () => {
    movementMode = movementMode === "planar" ? "globe" : "planar";
    root.dataset.mapMovement = movementMode;
    activeProjection = null;
    navigationTransform = zoomIdentity;
    pendingProjectionView = null;
    cameraCustomized = false;
    syncNavigationControls();
    draw(false, true);
    notifyViewChange();
  });
  const orientationPad = root.querySelector(".location-map__orientation-pad");
  const setShiftGesturePreview = (active) => {
    if (shiftGesturePreview === active) return;
    shiftGesturePreview = active;
    syncNavigationControls();
  };
  const setControlGesturePreview = (active) => {
    if (active) orientationPad.dataset.controlPreview = "true";
    else delete orientationPad.dataset.controlPreview;
  };
  const handleModifierKeyDown = (event) => {
    if (event.key === "Shift") setShiftGesturePreview(true);
    if (event.key === "Control" || event.key === "Meta") setControlGesturePreview(true);
  };
  const handleModifierKeyUp = (event) => {
    if (event.key === "Shift") setShiftGesturePreview(false);
    if (event.key === "Control" || event.key === "Meta") setControlGesturePreview(false);
  };
  const clearModifierPreviews = () => {
    setShiftGesturePreview(false);
    setControlGesturePreview(false);
  };
  window.addEventListener("keydown", handleModifierKeyDown);
  window.addEventListener("keyup", handleModifierKeyUp);
  window.addEventListener("blur", clearModifierPreviews);
  let orientationDialGesture = null;
  let suppressOrientationClick = false;
  const orientationAngleAt = (event) => {
    const bounds = orientationPad.getBoundingClientRect();
    const x = event.clientX - (bounds.left + bounds.width / 2);
    const y = event.clientY - (bounds.top + bounds.height / 2);
    return normalizeRotationLongitude(Math.atan2(x, -y) * 180 / Math.PI);
  };
  orientationPad.addEventListener("click", (event) => {
    if (suppressOrientationClick) return;
    const button = event.target.closest("button[data-map-orientation]");
    if (!button || button.disabled) return;
    const nextMode = button.dataset.mapOrientation;
    if (nextMode === "free") {
      orientationRoll = currentOrientationRoll();
      orientationMode = "free";
      root.dataset.mapOrientation = orientationMode;
      root.dataset.mapOrientationRoll = String(orientationRoll);
      delete root.dataset.mapOrientationAuto;
      syncNavigationControls();
      notifyViewChange();
      return;
    }
    applyOrientationRoll(fixedOrientationRoll(nextMode), nextMode);
    notifyViewChange();
  });
  orientationPad.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    orientationDialGesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      onButton: Boolean(event.target.closest("button[data-map-orientation]")),
      dragged: false
    };
    cancelDetailedRestore();
  });
  orientationPad.addEventListener("pointermove", (event) => {
    if (!orientationDialGesture || orientationDialGesture.pointerId !== event.pointerId) return;
    const distance = Math.hypot(
      event.clientX - orientationDialGesture.startX,
      event.clientY - orientationDialGesture.startY
    );
    if (!orientationDialGesture.dragged && distance < 3) return;
    if (!orientationDialGesture.dragged) {
      orientationPad.setPointerCapture(event.pointerId);
      orientationPad.dataset.dragging = "true";
    }
    orientationDialGesture.dragged = true;
    event.preventDefault();
    applyOrientationRoll(projectionRollFromDial(orientationAngleAt(event)), "custom", true);
  });
  const endOrientationDialGesture = (event) => {
    if (!orientationDialGesture || orientationDialGesture.pointerId !== event.pointerId) return;
    const dragged = orientationDialGesture.dragged;
    const clickedDial = !dragged && !orientationDialGesture.onButton && event.type === "pointerup";
    if (clickedDial) {
      applyOrientationRoll(projectionRollFromDial(orientationAngleAt(event)), "custom", true);
    }
    if (dragged || clickedDial) {
      suppressOrientationClick = true;
      window.setTimeout(() => { suppressOrientationClick = false; }, 0);
      finishOrientationChange();
      notifyViewChange();
    }
    if (orientationPad.hasPointerCapture(event.pointerId)) orientationPad.releasePointerCapture(event.pointerId);
    orientationDialGesture = null;
    delete orientationPad.dataset.dragging;
  };
  orientationPad.addEventListener("pointerup", endOrientationDialGesture);
  orientationPad.addEventListener("pointercancel", endOrientationDialGesture);
  orientationPad.tabIndex = 0;
  orientationPad.addEventListener("keydown", (event) => {
    if (event.target !== orientationPad) return;
    const step = event.shiftKey ? 15 : 1;
    const dialAngle = orientationDialAngle(currentOrientationRoll());
    if (event.key === "ArrowLeft") {
      applyOrientationRoll(projectionRollFromDial(dialAngle - step));
    } else if (event.key === "ArrowRight") {
      applyOrientationRoll(projectionRollFromDial(dialAngle + step));
    } else if (event.key === "ArrowUp") applyOrientationRoll(0);
    else if (event.key === "ArrowDown") applyOrientationRoll(180);
    else return;
    event.preventDefault();
    finishOrientationChange();
    notifyViewChange();
  });

  let nativeRollGesture = null;
  svg.addEventListener("gesturestart", (event) => {
    nativeRollGesture = {
      base: currentOrientationRoll(),
      start: Number(event.rotation) || 0
    };
    cancelDetailedRestore();
    event.preventDefault();
  }, {passive: false});
  svg.addEventListener("gesturechange", (event) => {
    if (!nativeRollGesture) return;
    applyOrientationRoll(
      nativeRollGesture.base + (Number(event.rotation) || 0) - nativeRollGesture.start,
      "custom",
      true
    );
    event.preventDefault();
  }, {passive: false});
  svg.addEventListener("gestureend", (event) => {
    if (!nativeRollGesture) return;
    nativeRollGesture = null;
    finishOrientationChange();
    notifyViewChange();
    event.preventDefault();
  }, {passive: false});
  root.querySelector('[data-map-action="zoom-out"]').addEventListener("click", () => zoomBy(1 / 1.45));
  root.querySelector('[data-map-action="zoom-in"]').addEventListener("click", () => zoomBy(1.45));
  root.querySelector('[data-map-action="viewpoint"]').addEventListener("click", () => {
    const country = countryByCode(viewpointCountry);
    if (!country) return;
    if (typeof options.onCountrySelect === "function") {
      options.onCountrySelect(viewpointCountry, false);
      return;
    }
    selectedCountries = new Set([viewpointCountry]);
    selectedCountry = viewpointCountry;
    selectedCountryLabel = country.name;
    selectedFeatureId = "";
    countryFocused = true;
    countrySelectionDrivesCamera = true;
    forceWorldView = false;
    cameraCustomized = false;
    setMode("country");
    notifyViewChange();
  });
  root.querySelector('[data-map-action="world"]').addEventListener("click", () => {
    forceWorldView = false;
    projectionMode = "auto";
    movementMode = "globe";
    orientationMode = "north-up";
    orientationRoll = 0;
    root.dataset.mapProjection = projectionMode;
    root.dataset.mapMovement = movementMode;
    root.dataset.mapOrientation = orientationMode;
    root.dataset.mapOrientationRoll = "0";
    delete root.dataset.mapOrientationAuto;
    activeProjection = null;
    navigationTransform = zoomIdentity;
    pendingProjectionView = null;
    cameraCustomized = false;
    syncNavigationControls();
    draw(false, true);
    notifyViewChange();
  });
  const handleViewportResize = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => draw(cameraCustomized));
  };
  const observer = new ResizeObserver(handleViewportResize);
  observer.observe(stage);
  window.addEventListener("resize", handleViewportResize);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", handleViewportResize);
  populateControls();
  draw();
  requestPlacesForUiLanguage();
  prefetchAdmin1ForCountries(options.prefetchInitialCountries || []);
  // Do not warm country-mode Admin-1 packs until the camera is actually focused;
  // otherwise the first world frame downloads regional geometry for nothing.
  root.dataset.mapResolution = "110m";
  root.dataset.mapDetailState = "loading";
  const detailedAssets = Promise.all([
    loadDetailedTopology(data),
    loadDisputedFeatures(data)
  ]);
  detailedAssets.then(([detailTopology, disputed]) => {
    scheduleDetailedUpgrade(() => {
      try {
        if (destroyed) return;
        const changes = installTopology(detailTopology, data);
        features = features.concat(disputed.features || []);
        root.dataset.mapResolution = (data.geometry && data.geometry.resolution) || "10m";
        root.dataset.mapDetailState = "ready";
        root.dataset.featureCanonicalization = String(changes && changes.canonicalized || 0);
        root.dataset.geometryExclusions = String(changes && changes.exclusions || 0);
        root.dataset.territoryExtracts = String(changes && changes.extracts || 0);
        root.dataset.featureRegions = String(changes && changes.regions || 0);
        root.dataset.disputedRegions = String(disputed.count || 0);
        const refitActiveSelection = !forceWorldView && !cameraCustomized && (
          (mode === "country" && countryFocused)
          || (mode === "language" && selectedLanguages().length > 0)
        );
        draw(!refitActiveSelection, refitActiveSelection);
      } catch (error) {
        root.dataset.mapResolution = "110m";
        root.dataset.mapDetailState = "overview";
        root.dataset.mapError = error && error.message ? error.message : "map detail load failed";
      }
    });
  }).catch((error) => {
      root.dataset.mapResolution = "110m";
      root.dataset.mapDetailState = "overview";
      root.dataset.mapError = error && error.message ? error.message : "map detail load failed";
  });

  return {
    setViewpointCountry(code) {
      const nextCountry = viewpointCountryCode(code);
      if (viewpointCountry === nextCountry) return false;
      viewpointCountry = nextCountry;
      root.dataset.mapViewpointCountry = viewpointCountry;
      draw(cameraCustomized, !cameraCustomized);
      return true;
    },
    prefetchCountries(codes) {
      const known = Array.from(new Set(codes || [])).filter((code) => countryByCode(code));
      if (!known.length) return false;
      prefetchAdmin1ForCountries(known, {deferUntilIdle: false});
      return true;
    },
    prefetchLanguages(ids) {
      const known = Array.from(new Set(ids || [])).map(languageById).filter(Boolean);
      if (!known.length) return false;
      return prefetchAdmin1ForLanguages(known, {deferUntilIdle: false});
    },
    prefetchPlaces(language) {
      if (!data.places || !normalize(language)) return false;
      void loadPlacesForUiLanguage(language, "high").catch(() => {});
      return true;
    },
    prefetchWorld() {
      if (!data.admin1_url) return false;
      void loadAdmin1Manifest()
        .then((manifest) => {
          const url = manifest?.prefetch_world;
          if (!url) return;
          admin1BackgroundQueue = admin1BackgroundQueue
            .then(() => prefetchAdmin1World(url))
            .catch(() => null);
        })
        .catch(() => {});
      return true;
    },
    selectCountry(code, behavior = {}) {
      return this.selectCountries([code], "", "", behavior);
    },
    selectCountries(codes, label = "", featureId = "", behavior = {}) {
      const known = Array.from(new Set(codes || [])).filter((code) => countryByCode(code));
      if (!known.length) return false;
      // A country selected from the page combobox means "take me there" and
      // therefore refits the camera. A country clicked on the map is already
      // visible; that input path explicitly requests an in-place selection so
      // only the highlight and related information change.
      const preserveCamera = Boolean(behavior && behavior.preserveCamera);
      let visibleRatio = 0;
      if (preserveCamera && mode === "country" && countryFocused && !forceWorldView) {
        const width = Math.max(280, stage.clientWidth || root.clientWidth || 600);
        const height = Number(svg.getAttribute("height"))
          || Math.max(210, Math.min(700, width * 0.7));
        visibleRatio = countrySelectionVisibleRatio(data, known, featureId || "", features, activeProjection, width, height);
      }
      root.dataset.mapCountryFocusVisibleRatio = visibleRatio.toFixed(3);
      root.dataset.mapCountryFocusBehavior = preserveCamera ? "preserve" : "refocus";
      selectedCountries = new Set(known);
      selectedCountry = known[0];
      selectedCountryLabel = label || known.map(countryByCode).filter(Boolean).map((country) => country.name).join(" + ");
      selectedFeatureId = featureId || "";
      countryFocused = true;
      countrySelectionDrivesCamera = true;
      forceWorldView = false;
      cameraCustomized = preserveCamera;
      root.dataset.mapLanguageCountryContext = "";
      if (mode === "country") {
        if (!preserveCamera || !updateCountrySelectionInPlace()) {
          delete root.dataset.mapCountrySelectionInPlace;
          draw(false, true);
        }
      }
      else setMode("country", preserveCamera);
      if (!behavior || behavior.prefetch !== false) {
        prefetchAdmin1ForCountries(known, {deferUntilIdle: false});
        void prepareAdmin1ForCountries(known);
        warmCountryAdmin1Boundaries(known);
      }
      notifyViewChange();
      return true;
    },
    selectLanguage(id) {
      return this.selectLanguages([id], "");
    },
    selectLanguages(ids, label = "", selectionOptions = {}) {
      const known = Array.from(new Set(ids || [])).map(languageById).filter(Boolean);
      if (!known.length) return false;
      const contextCountries = Array.from(new Set(selectionOptions.contextCountries || [])).filter((code) => countryByCode(code));
      const preserveCamera = Boolean(selectionOptions.preserveCamera);
      selectedLanguageIds = known.map((language) => language.id);
      selectedLanguage = selectedLanguageIds[0];
      selectedLanguageLabel = label;
      selectedLanguagesIgnoreAdmin1 = selectionOptions.ignoreAdmin1 === true;
      selectedCountries = new Set(contextCountries);
      selectedCountry = contextCountries[0] || "";
      selectedCountryLabel = contextCountries.map(countryByCode).filter(Boolean).map((country) => country.name).join(" + ");
      selectedFeatureId = contextCountries.length ? selectionOptions.contextFeatureId || "" : "";
      countryFocused = contextCountries.length > 0;
      countrySelectionDrivesCamera = languageCountryContextDrivesCamera(
        contextCountries,
        preserveCamera
      );
      root.dataset.mapLanguageCountryContext = contextCountries.join(",");
      root.dataset.mapCountryFocusBehavior = preserveCamera ? "preserve" : "refocus";
      root.dataset.mapAdmin1Policy = selectedLanguagesIgnoreAdmin1 ? "country-only" : "regional";
      syncLanguageSelect();
      forceWorldView = false;
      cameraCustomized = preserveCamera;
      setMode("language", preserveCamera);
      notifyViewChange();
      return true;
    },
    clearSelection() {
      selectedCountries = new Set();
      selectedCountry = "";
      selectedCountryLabel = "";
      selectedFeatureId = "";
      selectedLanguageIds = [];
      selectedLanguage = "";
      selectedLanguageLabel = "";
      selectedLanguagesIgnoreAdmin1 = false;
      countryFocused = false;
      countrySelectionDrivesCamera = false;
      cameraCustomized = false;
      root.dataset.mapLanguageCountryContext = "";
      root.dataset.mapAdmin1Policy = "regional";
      syncLanguageSelect();
      setMode("country");
      notifyViewChange();
      return true;
    },
    getViewState() {
      return currentViewState();
    },
    setViewState(nextState = {}) {
      const nextProjection = projectionModes.includes(nextState.projection) ? nextState.projection : "auto";
      const nextMovement = nextState.movement === "planar"
        ? "planar"
        : (nextState.movement === "globe"
          ? "globe"
          : (["mercator", "equirectangular"].includes(nextProjection) ? "planar" : "globe"));
      const nextOrientation = orientationModes.includes(nextState.orientation) ? nextState.orientation : "north-up";
      const nextRoll = Number.isFinite(Number(nextState.roll))
        ? normalizeRotationLongitude(Number(nextState.roll))
        : (requestedOrientationRoll(nextOrientation, 0) || 0);
      const center = Array.isArray(nextState.center) ? nextState.center.map(Number).slice(0, 2) : [];
      const zoomLevel = Number(nextState.zoom);
      projectionMode = nextProjection;
      movementMode = nextMovement;
      orientationMode = nextOrientation;
      orientationRoll = nextRoll;
      pendingProjectionView = center.length === 2
        && center.every(Number.isFinite)
        ? {
            center,
            ...(Number.isFinite(zoomLevel) ? {zoom: zoomLevel} : {})
          }
        : null;
      cameraCustomized = Boolean(pendingProjectionView);
      root.dataset.mapProjection = projectionMode;
      root.dataset.mapMovement = movementMode;
      root.dataset.mapOrientation = orientationMode;
      root.dataset.mapOrientationRoll = String(orientationRoll);
      activeProjection = null;
      planarProjection = null;
      navigationTransform = zoomIdentity;
      syncNavigationControls();
      draw(false, true);
      notifyViewChange();
      return true;
    },
    update(nextOptions, behavior = {}) {
      const previousLanguage = normalize(options.language);
      const previousViewpointCountry = viewpointCountry;
      const previousConfiguredViewpoint = configuredTerritorialViewpoint;
      options = applyPlugins(data, nextOptions);
      const languageChanged = normalize(options.language) !== previousLanguage;
      const nextViewpointCountry = Object.prototype.hasOwnProperty.call(options, "viewpointCountry")
        ? viewpointCountryCode(options.viewpointCountry)
        : previousViewpointCountry;
      const nextConfiguredViewpointSpecified = Object.prototype.hasOwnProperty.call(options, "viewpoint")
        || Object.prototype.hasOwnProperty.call(options, "viewpointOverride");
      const nextConfiguredViewpoint = nextConfiguredViewpointSpecified
        ? configuredViewpoint(options.viewpoint, options.viewpointOverride, data.iso2_to_iso3)
        : previousConfiguredViewpoint;
      const viewpointChanged = nextViewpointCountry !== previousViewpointCountry;
      const configuredViewpointChanged = nextConfiguredViewpoint.country !== previousConfiguredViewpoint.country
        || nextConfiguredViewpoint.override !== previousConfiguredViewpoint.override;
      root.dataset.mapUiLanguage = normalize(options.language);
      if (languageChanged && selectedCountries.size && !selectedFeatureId) {
        selectedCountryLabel = Array.from(selectedCountries)
          .map(countryByCode)
          .filter(Boolean)
          .map((country) => country.name)
          .join(" + ");
      }
      viewpointCountry = nextViewpointCountry;
      configuredTerritorialViewpoint = nextConfiguredViewpoint;
      root.dataset.mapViewpointCountry = viewpointCountry;
      root.dataset.mapConfiguredViewpoint = configuredTerritorialViewpoint.country;
      root.dataset.mapViewpointOverride = String(configuredTerritorialViewpoint.override);
      if (!selectedCountries.size && options.initialCountry) {
        selectedCountry = options.initialCountry;
        selectedCountries = new Set([selectedCountry]);
        selectedCountryLabel = (countryByCode(selectedCountry) || {}).name || "";
      }
      populateControls();
      if (languageChanged) requestPlacesForUiLanguage();
      // A UI-language change replaces labels and copy, not the geographic
      // subject. Keep the user's centre, zoom, projection and orientation
      // while the newly localized labels are painted in place — even when a
      // deferred selection asked to skip draw(). Any viewpoint change must
      // repaint because disputed-feature ownership, click targets, and
      // presentation attributes can all change.
      if (languageChanged && !viewpointChanged && !configuredViewpointChanged) {
        refreshLocalizedMap();
      } else if (behavior.draw !== false || viewpointChanged || configuredViewpointChanged) {
        const preserveNavigation = behavior.preserveNavigation == null
          ? (languageChanged || cameraCustomized)
          : Boolean(behavior.preserveNavigation);
        draw(preserveNavigation, !preserveNavigation);
      }
    },
    setPlaces(nextPlaces) {
      installPlaces(nextPlaces);
      if (placesData) draw(true);
    },
    destroy() {
      destroyed = true;
      cancelPlaceLabelRelayout();
      countryAdmin1BoundaryGeneration += 1;
      cachedLabelScene = null;
      ["pointerdown", "keydown", "input", "wheel"].forEach((eventName) => {
        window.removeEventListener(eventName, noteUserInteraction, {capture: true});
      });
      window.removeEventListener("keydown", handleModifierKeyDown);
      window.removeEventListener("keyup", handleModifierKeyUp);
      window.removeEventListener("blur", clearModifierPreviews);
      window.removeEventListener("resize", handleViewportResize);
      if (window.visualViewport) window.visualViewport.removeEventListener("resize", handleViewportResize);
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      cancelAnimationFrame(navigationFrame);
      window.clearTimeout(detailUpgradeTimer);
      placeLoadGeneration += 1;
      if (detailUpgradeIdle && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(detailUpgradeIdle);
      root.replaceChildren();
    }
  };
}

export function applyPlugins(data, requestedOptions) {
  let options = {...(requestedOptions || {})};
  (options.plugins || []).forEach((plugin) => {
    if (!plugin || typeof plugin.contribute !== "function") return;
    const contribution = plugin.contribute({data, options: {...options}}) || {};
    options = {
      ...options,
      ...contribution,
      labels: {...(options.labels || {}), ...(contribution.labels || {})},
      messages: {...(options.messages || {}), ...(contribution.messages || {})}
    };
  });
  return options;
}

export async function mount(requestedOptions) {
  const response = await fetch(requestedOptions.dataUrl, {credentials: "same-origin"});
  if (!response.ok) throw new Error(`language map data unavailable: ${response.status}`);
  const data = await response.json();
  const options = applyPlugins(data, requestedOptions);
  const controller = createMap(options.root, data, options);
  if (!data.places && data.places_url) {
    window.setTimeout(async () => {
      try {
        const placesResponse = await fetch(data.places_url, {credentials: "same-origin"});
        if (!placesResponse.ok) return;
        const places = await placesResponse.json();
        await runBackgroundTask(() => controller.setPlaces(places));
      } catch (error) {
        // Place labels are an optional enhancement; the map remains usable without them.
      }
    }, 0);
  }
  return controller;
}
