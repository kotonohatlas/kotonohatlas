import world110 from "../vendor/map/atlas-countries-110m-1.0.0.mjs";
import {feature} from "../vendor/map/topojson-client-3.1.0.mjs";
import {geoArea, geoCentroid, geoEquirectangular, geoOrthographic, geoPath} from "../vendor/map/d3-geo-3.1.1.mjs";

const NS = "http://www.w3.org/2000/svg";
const width = 960;
const height = 420;
const runButton = document.querySelector("#run");
const statusNode = document.querySelector("#status");
const resultBody = document.querySelector("#results tbody");
const rawNode = document.querySelector("#raw");
const currentSurface = document.querySelector("#current");
const optimizedSurface = document.querySelector("#optimized");
const measureContext = document.createElement("canvas").getContext("2d");
measureContext.font = "650 10px system-ui";
[currentSurface, optimizedSurface].forEach((surface) => surface.setAttribute("viewBox", `0 0 ${width} ${height}`));

function svgNode(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
}

function timed(fn) {
  const start = performance.now();
  const value = fn();
  return {duration: performance.now() - start, value};
}

function nextFrame() { return new Promise((resolve) => requestAnimationFrame(resolve)); }
function identity(item) { return String(item.id || item.properties && (item.properties.id || item.properties.ADM0_A3) || ""); }
function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] || 0;
}
function stats(values) {
  return {
    p50: percentile(values, .5), p95: percentile(values, .95), max: Math.max(0, ...values),
    over16: values.filter((value) => value > 16.7).length,
    over50: values.filter((value) => value > 50).length,
    samples: values.length
  };
}
function addResults(records, scenario, engine, samples) {
  const phases = new Set(samples.flatMap((sample) => Object.keys(sample)));
  phases.forEach((phase) => records.push({scenario, engine, phase, ...stats(samples.map((sample) => sample[phase] || 0))}));
}

function flattenPlaces(data) {
  const places = [];
  Object.entries(data.countries).forEach(([country, item]) => item.places.forEach((place, index) => {
    const [longitude, latitude, minimumZoom, capital, population, name, localizedNames] = place;
    places.push({
      id: `${country}:${index}`, country, longitude, latitude, minimumZoom, capital: Boolean(capital),
      population, label: localizedNames.en || name,
      priority: (capital ? 1e13 : 0) + Math.max(0, population) * 100 - minimumZoom
    });
  }));
  return places.sort((a, b) => b.priority - a.priority);
}

function projectionFor(scenario) {
  if (scenario.globe) {
    return geoOrthographic().rotate(scenario.rotate).clipAngle(90)
      .fitExtent([[8, 8], [width - 8, height - 8]], {type: "Sphere"});
  }
  if (scenario.center) {
    return geoEquirectangular().center(scenario.center).scale(scenario.scale).translate([width / 2, height / 2]);
  }
  return geoEquirectangular().fitExtent([[8, 8], [width - 8, height - 8]], {type: "Sphere"});
}

function overlaps(a, b, gap = 3) {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x
    && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

const offsets = [[7, -5], [7, 11], [-7, -5], [-7, 11], [0, -9], [0, 14]];

class CurrentLabelEngine {
  constructor(surface, features, places) {
    this.surface = surface;
    this.features = features;
    this.places = places;
  }
  render(projection) {
    const phases = {};
    const path = geoPath(projection);
    let countries;
    ({duration: phases.countryMetrics, value: countries} = timed(() => this.features.map((item) => ({
      id: identity(item), area: path.area(item), bounds: path.bounds(item), anchor: path.centroid(item)
    }))));
    ({duration: phases.duplicateCountryAreas} = timed(() => this.features.map((item) => ({
      area: path.area(item), bounds: path.bounds(item)
    }))));
    let placeCandidates;
    ({duration: phases.placeCandidates, value: placeCandidates} = timed(() => this.places
      .map((item) => ({...item, anchor: projection([item.longitude, item.latitude])}))
      .filter((item) => item.anchor && item.anchor.every(Number.isFinite)
        && item.anchor[0] >= 0 && item.anchor[0] <= width && item.anchor[1] >= 0 && item.anchor[1] <= height)
      .sort((a, b) => b.priority - a.priority)));
    ({duration: phases.getBBoxLinearDom} = timed(() => {
      this.surface.replaceChildren();
      const occupied = [];
      let rendered = 0;
      const countryLayer = svgNode("g");
      const placeLayer = svgNode("g");
      this.surface.append(countryLayer, placeLayer);
      countries.filter((item) => item.area > 18 && item.anchor.every(Number.isFinite))
        .sort((a, b) => b.area - a.area).slice(0, 44).forEach((item) => {
          const node = svgNode("text", {x: item.anchor[0], y: item.anchor[1], "text-anchor": "middle"});
          node.textContent = item.id;
          countryLayer.append(node);
          const box = node.getBBox();
          if (box.x < 2 || box.y < 2 || box.x + box.width > width - 2 || box.y + box.height > height - 2
            || occupied.some((other) => overlaps(box, other))) node.remove();
          else occupied.push(box);
        });
      for (const item of placeCandidates) {
        if (rendered >= 80) break;
        const node = svgNode("text");
        node.textContent = item.label;
        placeLayer.append(node);
        let accepted = false;
        for (const [dx, dy] of offsets) {
          node.setAttribute("x", item.anchor[0] + dx);
          node.setAttribute("y", item.anchor[1] + dy);
          node.setAttribute("text-anchor", dx < 0 ? "end" : dx > 0 ? "start" : "middle");
          const box = node.getBBox();
          if (box.x < 2 || box.y < 2 || box.x + box.width > width - 2 || box.y + box.height > height - 2) continue;
          if (!occupied.some((other) => overlaps(box, other))) {
            occupied.push(box); accepted = true; rendered += 1; break;
          }
        }
        if (!accepted) node.remove();
      }
    }));
    phases.total = Object.values(phases).reduce((sum, value) => sum + value, 0);
    return phases;
  }
}

class CollisionGrid {
  constructor(cellSize = 32) { this.cellSize = cellSize; this.cells = new Map(); }
  keys(box) {
    const keys = [];
    const minX = Math.floor((box.x - 3) / this.cellSize), maxX = Math.floor((box.x + box.width + 3) / this.cellSize);
    const minY = Math.floor((box.y - 3) / this.cellSize), maxY = Math.floor((box.y + box.height + 3) / this.cellSize);
    for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) keys.push(`${x}:${y}`);
    return keys;
  }
  collides(box) {
    const seen = new Set();
    for (const key of this.keys(box)) for (const other of this.cells.get(key) || []) {
      if (!seen.has(other) && overlaps(box, other)) return true;
      seen.add(other);
    }
    return false;
  }
  add(box) {
    for (const key of this.keys(box)) {
      if (!this.cells.has(key)) this.cells.set(key, []);
      this.cells.get(key).push(box);
    }
  }
}

class CachedLabelEngine {
  constructor(surface, features, places) {
    this.surface = surface;
    this.countryLayer = svgNode("g");
    this.placeLayer = svgNode("g");
    surface.replaceChildren(this.countryLayer, this.placeLayer);
    this.nodes = new Map();
    this.countries = features.map((item) => ({
      id: identity(item), geographicArea: geoArea(item), geographicAnchor: geoCentroid(item)
    })).sort((a, b) => b.geographicArea - a.geographicArea);
    this.places = places.map((item) => ({...item, width: measureContext.measureText(item.label).width}));
  }
  reconcile(accepted) {
    const active = new Set();
    accepted.forEach((item) => {
      active.add(item.key);
      let node = this.nodes.get(item.key);
      if (!node) {
        node = svgNode("text");
        node.textContent = item.label;
        this.nodes.set(item.key, node);
        (item.kind === "country" ? this.countryLayer : this.placeLayer).append(node);
      }
      node.setAttribute("x", item.x);
      node.setAttribute("y", item.y);
      node.setAttribute("text-anchor", item.anchor);
      node.style.display = "";
    });
    this.nodes.forEach((node, key) => { if (!active.has(key)) node.style.display = "none"; });
  }
  render(projection) {
    const phases = {};
    let countryCandidates;
    ({duration: phases.projectCachedCountryAnchors, value: countryCandidates} = timed(() => this.countries
      .slice(0, 80).map((item) => ({...item, anchor: projection(item.geographicAnchor)}))
      .filter((item) => item.anchor && item.anchor.every(Number.isFinite)
        && item.anchor[0] >= 0 && item.anchor[0] <= width && item.anchor[1] >= 0 && item.anchor[1] <= height)));
    let placeCandidates;
    ({duration: phases.projectCullCachedPlaces, value: placeCandidates} = timed(() => {
      const result = [];
      for (const item of this.places) {
        const anchor = projection([item.longitude, item.latitude]);
        if (anchor && anchor.every(Number.isFinite) && anchor[0] >= 0 && anchor[0] <= width
          && anchor[1] >= 0 && anchor[1] <= height) result.push({...item, anchor});
      }
      return result;
    }));
    let accepted;
    ({duration: phases.gridLayout, value: accepted} = timed(() => {
      const grid = new CollisionGrid();
      const result = [];
      for (const item of countryCandidates.slice(0, 44)) {
        const label = item.id;
        const textWidth = measureContext.measureText(label).width;
        const box = {x: item.anchor[0] - textWidth / 2, y: item.anchor[1] - 8, width: textWidth, height: 11};
        if (box.x < 2 || box.y < 2 || box.x + box.width > width - 2 || box.y + box.height > height - 2 || grid.collides(box)) continue;
        grid.add(box);
        result.push({key: `country:${item.id}`, kind: "country", label, x: item.anchor[0], y: item.anchor[1], anchor: "middle"});
      }
      let rendered = 0;
      for (const item of placeCandidates) {
        if (rendered >= 80) break;
        for (const [dx, dy] of offsets) {
          const x = item.anchor[0] + dx;
          const y = item.anchor[1] + dy;
          const textAnchor = dx < 0 ? "end" : dx > 0 ? "start" : "middle";
          const box = {x: textAnchor === "end" ? x - item.width : textAnchor === "middle" ? x - item.width / 2 : x,
            y: y - 8, width: item.width, height: 11};
          if (box.x < 2 || box.y < 2 || box.x + box.width > width - 2 || box.y + box.height > height - 2 || grid.collides(box)) continue;
          grid.add(box);
          result.push({key: item.id, kind: "place", label: item.label, x, y, anchor: textAnchor});
          rendered += 1;
          break;
        }
      }
      return result;
    }));
    ({duration: phases.retainedDom} = timed(() => this.reconcile(accepted)));
    phases.total = Object.values(phases).reduce((sum, value) => sum + value, 0);
    return phases;
  }
}

function scenarios() {
  return [
    {id: "global", frames: 10},
    {id: "europe-dense", center: [12, 50], scale: 850, frames: 10},
    {id: "east-asia-dense", center: [130, 35], scale: 850, frames: 10},
    {id: "polar-drag", globe: true, rotate: [25, -72, 0], frames: 24,
      dynamic: (index, projection) => projection.rotate([25 + index * 4, -72 + index * .4, index * .2])}
  ];
}

function renderResults(result) {
  resultBody.replaceChildren();
  const totals = result.records.filter((row) => row.phase === "total");
  const winners = new Map();
  totals.forEach((row) => { if (!winners.has(row.scenario) || row.p50 < winners.get(row.scenario).p50) winners.set(row.scenario, row); });
  result.records.forEach((row) => {
    const tr = document.createElement("tr");
    if (winners.get(row.scenario) === row) tr.className = "winner";
    [row.scenario, `${row.engine} / ${row.phase}`, row.p50.toFixed(2), row.p95.toFixed(2), row.max.toFixed(2), row.over16, row.over50]
      .forEach((value) => { const td = document.createElement("td"); td.textContent = value; tr.append(td); });
    resultBody.append(tr);
  });
  rawNode.textContent = JSON.stringify(result, null, 2);
}

async function run() {
  runButton.disabled = true;
  statusNode.textContent = "Loading 10m and 2,613 place labels";
  const started = performance.now();
  const [topologyModule, placeData] = await Promise.all([
    import("../vendor/map/atlas-countries-10m-1.0.0.mjs"),
    fetch("../../../config/geography/places.json").then((response) => response.json())
  ]);
  const topology = topologyModule.default;
  const features = feature(topology, topology.objects.features).features;
  const places = flattenPlaces(placeData);
  const current = new CurrentLabelEngine(currentSurface, features, places);
  const preprocessStart = performance.now();
  const optimized = new CachedLabelEngine(optimizedSurface, features, places);
  const preprocessMs = performance.now() - preprocessStart;
  const records = [{scenario: "one-time", engine: "cached-retained", phase: "anchor-and-text-preprocess", ...stats([preprocessMs])}];
  for (const scenario of scenarios()) {
    statusNode.textContent = `${scenario.id}: current-style`;
    let projection = projectionFor(scenario);
    current.render(projection);
    await nextFrame();
    const currentSamples = [];
    for (let index = 0; index < scenario.frames; index += 1) {
      if (scenario.dynamic) scenario.dynamic(index, projection);
      currentSamples.push(current.render(projection));
      if (index % 5 === 4) await nextFrame();
    }
    addResults(records, scenario.id, "current-style", currentSamples);
    statusNode.textContent = `${scenario.id}: cached-retained`;
    projection = projectionFor(scenario);
    optimized.render(projection);
    await nextFrame();
    const optimizedSamples = [];
    for (let index = 0; index < scenario.frames; index += 1) {
      if (scenario.dynamic) scenario.dynamic(index, projection);
      optimizedSamples.push(optimized.render(projection));
      if (index % 5 === 4) await nextFrame();
    }
    addResults(records, scenario.id, "cached-retained", optimizedSamples);
  }
  const result = {
    generatedAt: new Date().toISOString(), userAgent: navigator.userAgent,
    featureCounts: {countries10m: features.length, places: places.length},
    elapsedMs: performance.now() - started, records
  };
  window.__labelPerfResults = result;
  renderResults(result);
  statusNode.textContent = `Complete in ${(result.elapsedMs / 1000).toFixed(1)}s`;
  runButton.disabled = false;
  window.dispatchEvent(new CustomEvent("label-perf-complete", {detail: result}));
}

runButton.addEventListener("click", () => run().catch((error) => {
  statusNode.textContent = `Failed: ${error.message}`;
  console.error(error);
  runButton.disabled = false;
}));
statusNode.textContent = "Ready";
if (new URLSearchParams(location.search).get("autorun") === "1") runButton.click();
