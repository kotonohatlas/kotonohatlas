import world110 from "../vendor/map/atlas-countries-110m-1.0.0.mjs";
import {feature, mesh} from "../vendor/map/topojson-client-3.1.0.mjs";
import {
  geoArea, geoBounds, geoCentroid, geoEquirectangular, geoOrthographic,
  geoPath
} from "../vendor/map/d3-geo-3.1.1.mjs";
import earcut, {flatten as flattenEarcut} from "../vendor/map/earcut-3.0.2.mjs";

const NS = "http://www.w3.org/2000/svg";
const DPR = Math.min(2, window.devicePixelRatio || 1);
const runButton = document.querySelector("#run");
const detailSelect = document.querySelector("#detail");
const statusNode = document.querySelector("#status");
const resultBody = document.querySelector("#results tbody");
const rawNode = document.querySelector("#raw");
const svg = document.querySelector("#svg-surface");
const canvas = document.querySelector("#canvas-surface");
const canvasLabels = document.querySelector("#canvas-labels");
const glCanvas = document.querySelector("#webgl-surface");
const glLabels = document.querySelector("#webgl-labels");
const measureCanvas = document.createElement("canvas");
const measureContext = measureCanvas.getContext("2d");
measureContext.font = "650 10px system-ui";

let topology10Promise;
let webglRenderer;
let retainedSvg;
let longTasks = [];
const observer = "PerformanceObserver" in window
  ? new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => ({start: entry.startTime, duration: entry.duration}))))
  : null;
try { observer && observer.observe({type: "longtask", buffered: true}); } catch (_) { /* Safari */ }

function svgNode(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function percent(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function stats(values) {
  return {
    p50: percent(values, 0.50),
    p95: percent(values, 0.95),
    max: Math.max(0, ...values),
    over16: values.filter((value) => value > 16.7).length,
    over50: values.filter((value) => value > 50).length,
    samples: values.length
  };
}

function timed(fn) {
  const start = performance.now();
  const value = fn();
  return {duration: performance.now() - start, value};
}

function geometry(topology) {
  const object = topology.objects.features;
  return {
    topology,
    features: feature(topology, object).features,
    borders: mesh(topology, object, (a, b) => a !== b),
    coastlines: mesh(topology, object, (a, b) => a === b)
  };
}

async function load10m() {
  if (!topology10Promise) {
    topology10Promise = import("../vendor/map/atlas-countries-10m-1.0.0.mjs").then((module) => module.default);
  }
  return geometry(await topology10Promise);
}

function dimensions() {
  const params = new URLSearchParams(location.search);
  const requestedWidth = Number(params.get("mapWidth"));
  const requestedHeight = Number(params.get("mapHeight"));
  const width = Number.isFinite(requestedWidth) && requestedWidth > 0
    ? requestedWidth : Math.max(320, document.querySelector(".view").clientWidth);
  const height = Number.isFinite(requestedHeight) && requestedHeight > 0
    ? requestedHeight : Math.max(250, document.querySelector(".view").clientHeight);
  [svg, canvasLabels, glLabels].forEach((surface) => {
    surface.setAttribute("viewBox", `0 0 ${width} ${height}`);
    surface.setAttribute("width", width);
    surface.setAttribute("height", height);
  });
  [canvas, glCanvas].forEach((surface) => {
    surface.width = Math.round(width * DPR);
    surface.height = Math.round(height * DPR);
    surface.style.width = `${width}px`;
    surface.style.height = `${height}px`;
  });
  return {width, height};
}

function identity(featureItem) {
  return String(featureItem.id || featureItem.properties && (featureItem.properties.id || featureItem.properties.ADM0_A3) || "");
}

function names(features) {
  return new Map(features.map((item, index) => [identity(item), item.properties && (
    item.properties.NAME || item.properties.NAME_LONG || item.properties.ADMIN
  ) || identity(item) || `feature-${index}`]));
}

function selectFixtures(features) {
  const candidates = features.filter((item) => identity(item) !== "ATA").map((item) => ({item, area: geoArea(item)}));
  const large = candidates.slice().sort((a, b) => b.area - a.area)[0].item;
  const micro = candidates.filter((item) => item.area > 0).sort((a, b) => a.area - b.area)[0].item;
  return {large, micro};
}

function projectionFor(scenario, width, height, target) {
  if (scenario.kind === "globe") {
    return geoOrthographic()
      .rotate(scenario.rotate || [0, -20, 0])
      .clipAngle(90)
      .fitExtent([[8, 8], [width - 8, height - 8]], {type: "Sphere"});
  }
  const projection = geoEquirectangular();
  const object = target || {type: "Sphere"};
  return projection.fitExtent([[12, 12], [width - 12, height - 12]], object);
}

function projectedMetrics(path, features) {
  return features.map((item) => ({
    id: identity(item),
    feature: item,
    bounds: path.bounds(item),
    area: path.area(item),
    centroid: path.centroid(item)
  }));
}

function labelsFor(metrics, nameMap, width, height, maximum = 44) {
  return metrics
    .filter((item) => item.area > 20 && item.centroid.every(Number.isFinite)
      && item.centroid[0] > 3 && item.centroid[0] < width - 3
      && item.centroid[1] > 3 && item.centroid[1] < height - 3)
    .sort((a, b) => b.area - a.area)
    .slice(0, maximum)
    .map((item) => ({...item, label: nameMap.get(item.id) || item.id}));
}

function appendLabelsGetBBox(layer, labels, width, height) {
  const occupied = [];
  labels.forEach((item) => {
    const node = svgNode("text", {x: item.centroid[0], y: item.centroid[1]});
    node.textContent = item.label;
    layer.append(node);
    const box = node.getBBox();
    if (box.x < 2 || box.y < 2 || box.x + box.width > width - 2 || box.y + box.height > height - 2
      || occupied.some((other) => box.x < other.x + other.width + 3 && box.x + box.width + 3 > other.x
        && box.y < other.y + other.height + 3 && box.y + box.height + 3 > other.y)) {
      node.remove();
    } else occupied.push(box);
  });
}

function measuredLabelLayout(labels, width, height) {
  const occupied = [];
  const accepted = [];
  labels.forEach((item) => {
    const textWidth = measureContext.measureText(item.label).width;
    const box = {x: item.centroid[0] - textWidth / 2, y: item.centroid[1] - 8, width: textWidth, height: 11};
    if (box.x < 2 || box.y < 2 || box.x + box.width > width - 2 || box.y + box.height > height - 2) return;
    if (occupied.some((other) => box.x < other.x + other.width + 3 && box.x + box.width + 3 > other.x
      && box.y < other.y + other.height + 3 && box.y + box.height + 3 > other.y)) return;
    occupied.push(box);
    accepted.push(item);
  });
  return accepted;
}

function updateLabelSvg(surface, labels) {
  const nodes = Array.from(surface.children);
  labels.forEach((item, index) => {
    let node = nodes[index];
    if (!node) {
      node = svgNode("text");
      surface.append(node);
    }
    node.textContent = item.label;
    node.setAttribute("x", item.centroid[0]);
    node.setAttribute("y", item.centroid[1]);
    node.setAttribute("text-anchor", "middle");
    node.style.display = "";
  });
  for (let index = labels.length; index < nodes.length; index += 1) nodes[index].style.display = "none";
}

class CurrentStyleSvg {
  constructor(surface) { this.surface = surface; }
  render(scene) {
    const phases = {};
    let value;
    ({duration: phases.boundsAreaCentroid, value} = timed(() => projectedMetrics(scene.path, scene.features)));
    // Reproduce the present second projected-area/bounds pass used by place labels.
    ({duration: phases.duplicateGeoMetrics} = timed(() => scene.features.map((item) => ({
      bounds: scene.path.bounds(item), area: scene.path.area(item)
    }))));
    let paths;
    ({duration: phases.pathStrings, value: paths} = timed(() => scene.features.map((item) => scene.path(item))));
    ({duration: phases.domAndGetBBox} = timed(() => {
      this.surface.replaceChildren();
      const land = svgNode("g", {fill: "#dfe4f0", stroke: "#69738a", "stroke-width": ".45"});
      paths.forEach((d, index) => {
        const node = svgNode("path", {d: d || ""});
        if (scene.highlight.has(identity(scene.features[index]))) node.setAttribute("fill", "#566bc4");
        land.append(node);
      });
      land.append(svgNode("path", {d: scene.path(scene.borders) || "", fill: "none"}));
      const labelLayer = svgNode("g");
      this.surface.append(land, labelLayer);
      appendLabelsGetBBox(labelLayer, labelsFor(value, scene.nameMap, scene.width, scene.height), scene.width, scene.height);
    }));
    phases.total = Object.values(phases).reduce((sum, duration) => sum + duration, 0);
    return phases;
  }
}

class RetainedSvg {
  constructor(surface) {
    this.surface = surface;
    this.land = svgNode("g", {fill: "#dfe4f0", stroke: "#69738a", "stroke-width": ".45"});
    this.border = svgNode("path", {fill: "none"});
    this.labels = svgNode("g");
    surface.replaceChildren(this.land, this.border, this.labels);
    this.paths = [];
  }
  render(scene) {
    if (!this.land.isConnected) this.surface.replaceChildren(this.land, this.border, this.labels);
    const phases = {};
    let metrics;
    ({duration: phases.sceneBuild, value: metrics} = timed(() => projectedMetrics(scene.path, scene.features)));
    let strings;
    ({duration: phases.pathStrings, value: strings} = timed(() => scene.features.map((item) => scene.path(item))));
    ({duration: phases.retainedDom} = timed(() => {
      strings.forEach((d, index) => {
        let node = this.paths[index];
        if (!node) {
          node = svgNode("path");
          this.paths[index] = node;
          this.land.append(node);
        }
        node.setAttribute("d", d || "");
        node.setAttribute("fill", scene.highlight.has(identity(scene.features[index])) ? "#566bc4" : "#dfe4f0");
      });
      this.border.setAttribute("d", scene.path(scene.borders) || "");
      updateLabelSvg(this.labels, measuredLabelLayout(labelsFor(metrics, scene.nameMap, scene.width, scene.height), scene.width, scene.height));
    }));
    phases.total = Object.values(phases).reduce((sum, duration) => sum + duration, 0);
    return phases;
  }
}

class CanvasRenderer {
  constructor(surface, labels) {
    this.surface = surface;
    this.context = surface.getContext("2d");
    this.labels = labels;
    this.picking = document.createElement("canvas");
    this.pickingContext = this.picking.getContext("2d", {willReadFrequently: true});
  }
  render(scene) {
    this.picking.width = this.surface.width;
    this.picking.height = this.surface.height;
    const phases = {};
    let metrics;
    ({duration: phases.sceneBuild, value: metrics} = timed(() => projectedMetrics(scene.path, scene.features)));
    ({duration: phases.canvasDraw} = timed(() => {
      const context = this.context;
      const drawPath = geoPath(scene.projection, context);
      context.setTransform(DPR, 0, 0, DPR, 0, 0);
      context.clearRect(0, 0, scene.width, scene.height);
      context.fillStyle = "#eaf6fb";
      context.fillRect(0, 0, scene.width, scene.height);
      scene.features.forEach((item) => {
        context.beginPath();
        drawPath(item);
        context.fillStyle = scene.highlight.has(identity(item)) ? "#566bc4" : "#dfe4f0";
        context.fill();
        context.strokeStyle = "#69738a";
        context.lineWidth = .45;
        context.stroke();
      });
    }));
    ({duration: phases.pickingDraw} = timed(() => {
      const context = this.pickingContext;
      const pickPath = geoPath(scene.projection, context);
      context.setTransform(DPR, 0, 0, DPR, 0, 0);
      context.clearRect(0, 0, scene.width, scene.height);
      scene.features.forEach((item, index) => {
        const id = index + 1;
        context.beginPath();
        pickPath(item);
        context.fillStyle = `rgb(${id & 255},${(id >> 8) & 255},${(id >> 16) & 255})`;
        context.fill();
      });
    }));
    ({duration: phases.labels} = timed(() => updateLabelSvg(
      this.labels,
      measuredLabelLayout(labelsFor(metrics, scene.nameMap, scene.width, scene.height), scene.width, scene.height)
    )));
    phases.total = Object.values(phases).reduce((sum, duration) => sum + duration, 0);
    return phases;
  }
}

function flattenPolygons(features) {
  const vertices = [];
  const featureIds = [];
  const triangles = [];
  const lines = [];
  features.forEach((item, featureIndex) => {
    if (!item.geometry) return;
    const polygons = item.geometry.type === "Polygon" ? [item.geometry.coordinates]
      : item.geometry.type === "MultiPolygon" ? item.geometry.coordinates : [];
    polygons.forEach((polygon) => {
      const flat = flattenEarcut(polygon);
      const base = vertices.length / 2;
      for (let index = 0; index < flat.vertices.length; index += 2) {
        vertices.push(flat.vertices[index], flat.vertices[index + 1]);
        featureIds.push(featureIndex);
      }
      earcut(flat.vertices, flat.holes, flat.dimensions).forEach((index) => triangles.push(base + index));
      let ringOffset = 0;
      polygon.forEach((ring) => {
        for (let index = 0; index + 1 < ring.length; index += 1) lines.push(base + ringOffset + index, base + ringOffset + index + 1);
        ringOffset += ring.length;
      });
    });
  });
  return {
    vertices: new Float32Array(vertices),
    featureIds: new Uint16Array(featureIds),
    triangles: new Uint32Array(triangles),
    lines: new Uint32Array(lines)
  };
}

function shader(gl, type, source) {
  const value = gl.createShader(type);
  gl.shaderSource(value, source);
  gl.compileShader(value);
  if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value));
  return value;
}

class WebGlRenderer {
  constructor(surface, labels, features) {
    this.surface = surface;
    this.labels = labels;
    this.gl = surface.getContext("webgl2", {antialias: true, preserveDrawingBuffer: true});
    if (!this.gl) throw new Error("WebGL2 is unavailable");
    const gl = this.gl;
    const vertexSource = `#version 300 es
      precision highp float;
      in vec2 a_lonlat; in float a_feature;
      uniform vec2 u_center; uniform vec2 u_translate; uniform float u_scale;
      uniform vec2 u_viewport; uniform int u_projection; uniform float u_roll;
      flat out int v_feature;
      void main() {
        float lon = radians(a_lonlat.x) - u_center.x;
        lon = mod(lon + 3.14159265359, 6.28318530718) - 3.14159265359;
        float lat = radians(a_lonlat.y);
        float x; float y; float visible = 1.0;
        if (u_projection == 1) {
          float cl = cos(lat); float c0 = cos(u_center.y); float s0 = sin(u_center.y);
          x = cl * sin(lon); y = c0 * sin(lat) - s0 * cl * cos(lon);
          visible = s0 * sin(lat) + c0 * cl * cos(lon);
        } else { x = lon; y = lat - u_center.y; }
        float cr = cos(u_roll); float sr = sin(u_roll);
        vec2 p = vec2(x * cr - y * sr, x * sr + y * cr) * u_scale + u_translate;
        vec2 clip = vec2(p.x / u_viewport.x * 2.0 - 1.0, 1.0 - p.y / u_viewport.y * 2.0);
        gl_Position = visible < 0.0 ? vec4(2.0, 2.0, 0.0, 1.0) : vec4(clip, 0.0, 1.0);
        v_feature = int(a_feature + 0.5);
      }`;
    const fragmentSource = `#version 300 es
      precision highp float; precision highp int;
      uniform sampler2D u_colors; uniform bool u_pick;
      flat in int v_feature; out vec4 outColor;
      void main() {
        if (u_pick) {
          int id = v_feature + 1;
          outColor = vec4(float(id & 255) / 255.0, float((id >> 8) & 255) / 255.0, float((id >> 16) & 255) / 255.0, 1.0);
        } else outColor = texelFetch(u_colors, ivec2(v_feature, 0), 0);
      }`;
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl, gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, shader(gl, gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    this.program = program;
    this.buffers = flattenPolygons(features);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const positions = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positions);
    gl.bufferData(gl.ARRAY_BUFFER, this.buffers.vertices, gl.STATIC_DRAW);
    const positionLocation = gl.getAttribLocation(program, "a_lonlat");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    const ids = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ids);
    gl.bufferData(gl.ARRAY_BUFFER, this.buffers.featureIds, gl.STATIC_DRAW);
    const idLocation = gl.getAttribLocation(program, "a_feature");
    gl.enableVertexAttribArray(idLocation);
    gl.vertexAttribPointer(idLocation, 1, gl.UNSIGNED_SHORT, false, 0, 0);
    this.triangleBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triangleBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.buffers.triangles, gl.STATIC_DRAW);
    this.colorTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, features.length, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.features = features;
    this.meshBuildMs = 0;
  }
  uniforms(scene, pick) {
    const gl = this.gl;
    const projection = scene.projection;
    const rotate = projection.rotate ? projection.rotate() : [0, 0, 0];
    const center = [-rotate[0] * Math.PI / 180, -rotate[1] * Math.PI / 180];
    gl.uniform2f(gl.getUniformLocation(this.program, "u_center"), center[0], center[1]);
    gl.uniform2f(gl.getUniformLocation(this.program, "u_translate"), scene.width / 2, scene.height / 2);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_scale"), projection.scale());
    gl.uniform2f(gl.getUniformLocation(this.program, "u_viewport"), scene.width, scene.height);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_projection"), scene.scenario.kind === "globe" ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_roll"), (rotate[2] || 0) * Math.PI / 180);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_pick"), pick ? 1 : 0);
  }
  render(scene) {
    const gl = this.gl;
    const phases = {};
    let metrics;
    ({duration: phases.labelScene, value: metrics} = timed(() => projectedMetrics(scene.path, scene.features)));
    ({duration: phases.paletteUpdate} = timed(() => {
      const colors = new Uint8Array(scene.features.length * 4);
      scene.features.forEach((item, index) => {
        const selected = scene.highlight.has(identity(item));
        colors.set(selected ? [86, 107, 196, 255] : [223, 228, 240, 255], index * 4);
      });
      gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, scene.features.length, 1, gl.RGBA, gl.UNSIGNED_BYTE, colors);
    }));
    ({duration: phases.webglDraw} = timed(() => {
      gl.viewport(0, 0, this.surface.width, this.surface.height);
      gl.clearColor(234 / 255, 246 / 255, 251 / 255, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      this.uniforms(scene, false);
      gl.drawElements(gl.TRIANGLES, this.buffers.triangles.length, gl.UNSIGNED_INT, 0);
    }));
    ({duration: phases.pickPass} = timed(() => {
      this.uniforms(scene, true);
      gl.drawElements(gl.TRIANGLES, this.buffers.triangles.length, gl.UNSIGNED_INT, 0);
      const pixel = new Uint8Array(4);
      gl.readPixels(Math.floor(this.surface.width / 2), Math.floor(this.surface.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      this.uniforms(scene, false);
      gl.drawElements(gl.TRIANGLES, this.buffers.triangles.length, gl.UNSIGNED_INT, 0);
    }));
    ({duration: phases.labels} = timed(() => updateLabelSvg(
      this.labels,
      measuredLabelLayout(labelsFor(metrics, scene.nameMap, scene.width, scene.height), scene.width, scene.height)
    )));
    phases.total = Object.values(phases).reduce((sum, duration) => sum + duration, 0);
    return phases;
  }
  renderMotion(scene) {
    const gl = this.gl;
    const phases = {};
    ({duration: phases.webglDraw} = timed(() => {
      gl.viewport(0, 0, this.surface.width, this.surface.height);
      gl.clearColor(234 / 255, 246 / 255, 251 / 255, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      this.uniforms(scene, false);
      gl.drawElements(gl.TRIANGLES, this.buffers.triangles.length, gl.UNSIGNED_INT, 0);
    }));
    phases.total = phases.webglDraw;
    return phases;
  }
}

function buildScene(dataset, scenario, width, height, fixtures) {
  const target = scenario.target === "large" ? fixtures.large : scenario.target === "micro" ? fixtures.micro : null;
  const projection = projectionFor(scenario, width, height, target);
  const path = geoPath(projection);
  const highlight = scenario.language
    ? new Set(dataset.features.filter((_, index) => index % 5 === 0).map(identity))
    : target ? new Set([identity(target)]) : new Set();
  return {...dataset, scenario, projection, path, highlight, width, height, nameMap: names(dataset.features)};
}

function scenarioDefinitions() {
  return [
    {id: "initial-world", kind: "planar", frames: 8},
    {id: "large-country", kind: "planar", target: "large", frames: 8},
    {id: "microstate", kind: "planar", target: "micro", frames: 8},
    {id: "language-distribution", kind: "planar", language: true, frames: 8},
    {id: "wheel-zoom", kind: "planar", frames: 24, dynamic: (index, projection) => projection.scale(projection.scale() * (index % 2 ? 0.97 : 1.03))},
    {id: "polar-globe-drag", kind: "globe", frames: 36, dynamic: (index, projection) => projection.rotate([-index * 10, -70 + index * 4, index * .7])}
  ];
}

function addResult(records, scenario, renderer, phases) {
  const keys = new Set(phases.flatMap((item) => Object.keys(item)));
  keys.forEach((phase) => records.push({scenario, renderer, phase, ...stats(phases.map((item) => item[phase] || 0))}));
}

async function benchmarkRenderer(records, rendererName, renderer, dataset, scenario, size, fixtures) {
  const samples = [];
  let scene = buildScene(dataset, scenario, size.width, size.height, fixtures);
  renderer.render(scene); // warm-up
  await nextFrame();
  for (let index = 0; index < scenario.frames; index += 1) {
    if (scenario.dynamic) scenario.dynamic(index, scene.projection);
    scene.path = geoPath(scene.projection);
    samples.push(renderer.render(scene));
    if (index % 6 === 5) await nextFrame();
  }
  addResult(records, scenario.id, rendererName, samples);
}

async function runBenchmark() {
  runButton.disabled = true;
  resultBody.replaceChildren();
  rawNode.textContent = "";
  longTasks = [];
  const started = performance.now();
  const size = dimensions();
  const overview = geometry(world110);
  const fixtures = selectFixtures(overview.features);
  const current = new CurrentStyleSvg(svg);
  retainedSvg = new RetainedSvg(svg);
  const canvasRenderer = new CanvasRenderer(canvas, canvasLabels);
  const meshStart = performance.now();
  webglRenderer = new WebGlRenderer(glCanvas, glLabels, overview.features);
  const meshBuild = performance.now() - meshStart;
  const records = [{scenario: "one-time", renderer: "webgl", phase: "mesh-build-upload", ...stats([meshBuild])}];
  records.push({scenario: "polar-globe-drag", renderer: "current-scheduler", phase: "configured-preview-interval", ...stats([120])});
  records.push({scenario: "detail-restore", renderer: "current-scheduler", phase: "configured-detail-delay", ...stats([80])});
  for (const scenario of scenarioDefinitions()) {
    statusNode.textContent = `${scenario.id}: current SVG`;
    await benchmarkRenderer(records, "current-svg", current, overview, scenario, size, fixtures);
    statusNode.textContent = `${scenario.id}: retained SVG`;
    await benchmarkRenderer(records, "retained-svg", retainedSvg, overview, scenario, size, fixtures);
    statusNode.textContent = `${scenario.id}: Canvas2D`;
    await benchmarkRenderer(records, "canvas2d", canvasRenderer, overview, scenario, size, fixtures);
    statusNode.textContent = `${scenario.id}: WebGL2`;
    await benchmarkRenderer(records, "webgl2", webglRenderer, overview, scenario, size, fixtures);
  }
  statusNode.textContent = "detail restore: loading 10m";
  const detailLoadStart = performance.now();
  const detail = await load10m();
  const detailLoad = performance.now() - detailLoadStart;
  records.push({scenario: "detail-restore", renderer: "network/module", phase: "load-10m", ...stats([detailLoad])});
  const detailFixtures = selectFixtures(detail.features);
  const detailScene = buildScene(detail, {id: "detail-restore", kind: "planar", target: "large"}, size.width, size.height, detailFixtures);
  const detailCurrent = new CurrentStyleSvg(svg);
  const detailRetained = new RetainedSvg(svg);
  const detailCanvas = new CanvasRenderer(canvas, canvasLabels);
  addResult(records, "detail-restore", "current-svg", [detailCurrent.render(detailScene)]);
  addResult(records, "detail-restore", "retained-svg", [detailRetained.render(detailScene)]);
  addResult(records, "detail-restore", "canvas2d", [detailCanvas.render(detailScene)]);
  statusNode.textContent = "detail restore: building WebGL mesh";
  let detailWebgl;
  const detailMeshStart = performance.now();
  detailWebgl = new WebGlRenderer(glCanvas, glLabels, detail.features);
  const detailMeshBuild = performance.now() - detailMeshStart;
  records.push({scenario: "detail-restore", renderer: "webgl2", phase: "mesh-build-upload", ...stats([detailMeshBuild])});
  records.push({
    scenario: "detail-restore",
    renderer: "webgl2",
    phase: "mesh-buffer-megabytes",
    ...stats([(
      detailWebgl.buffers.vertices.byteLength
      + detailWebgl.buffers.featureIds.byteLength
      + detailWebgl.buffers.triangles.byteLength
      + detailWebgl.buffers.lines.byteLength
    ) / 1024 / 1024])
  });
  addResult(records, "detail-restore", "webgl2", [detailWebgl.render(detailScene)]);
  const detailMotionScenario = {id: "10m-polar-drag-frozen-labels", kind: "globe"};
  const detailMotionScene = buildScene(detail, detailMotionScenario, size.width, size.height, detailFixtures);
  const detailMotionSamples = [];
  detailWebgl.renderMotion(detailMotionScene);
  await nextFrame();
  for (let index = 0; index < 36; index += 1) {
    detailMotionScene.projection.rotate([-index * 10, -70 + index * 4, index * .7]);
    detailMotionSamples.push(detailWebgl.renderMotion(detailMotionScene));
    if (index % 6 === 5) await nextFrame();
  }
  addResult(records, detailMotionScenario.id, "webgl2", detailMotionSamples);
  const finished = performance.now();
  const result = {
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    devicePixelRatio: DPR,
    viewport: size,
    featureCounts: {overview: overview.features.length, detail: detail.features.length},
    elapsedMs: finished - started,
    longTasks,
    records
  };
  window.__mapPerfResults = result;
  renderResults(result);
  statusNode.textContent = `Complete in ${(result.elapsedMs / 1000).toFixed(1)}s; ${longTasks.length} long tasks`;
  runButton.disabled = false;
  window.dispatchEvent(new CustomEvent("map-perf-complete", {detail: result}));
}

function renderResults(result) {
  const totalRows = result.records.filter((row) => row.phase === "total");
  const winnerByScenario = new Map();
  totalRows.forEach((row) => {
    const prior = winnerByScenario.get(row.scenario);
    if (!prior || row.p50 < prior.p50) winnerByScenario.set(row.scenario, row);
  });
  result.records.forEach((row) => {
    const tr = document.createElement("tr");
    if (winnerByScenario.get(row.scenario) === row) tr.className = "winner";
    [row.scenario, `${row.renderer} / ${row.phase}`, row.p50.toFixed(2), row.p95.toFixed(2), row.max.toFixed(2), row.over16, row.over50]
      .forEach((value) => { const td = document.createElement("td"); td.textContent = value; tr.append(td); });
    resultBody.append(tr);
  });
  rawNode.textContent = JSON.stringify(result, null, 2);
}

runButton.addEventListener("click", () => runBenchmark().catch((error) => {
  statusNode.textContent = `Failed: ${error.message}`;
  console.error(error);
  runButton.disabled = false;
}));

statusNode.textContent = "Ready";
if (new URLSearchParams(location.search).get("autorun") === "1") runButton.click();
