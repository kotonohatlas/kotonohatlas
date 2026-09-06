const cdpPort = Number(process.env.CDP_PORT || 9223);
const pagePrefix = process.env.MAP_PAGE || "http://localhost:8123/";

const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json());
const target = targets.find((item) => item.type === "page" && item.url.startsWith(pagePrefix));
if (!target) throw new Error(`No CDP page starts with ${pagePrefix}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
const exceptions = [];

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.exceptionThrown") {
    exceptions.push(message.params.exceptionDetails.text);
    return;
  }
  if (!message.id || !pending.has(message.id)) return;
  const {resolve, reject} = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, {once: true});
  socket.addEventListener("error", reject, {once: true});
});

function send(method, params = {}) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
  socket.send(JSON.stringify({id, method, params}));
  return promise;
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

await send("Runtime.enable");
await send("Page.enable");

const hostWait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
if (process.env.MAP_RELOAD === "1") {
  await send("Page.reload", {ignoreCache: true});
  await hostWait(1800);
}

const wait = (milliseconds) => evaluate(`new Promise((resolve) => setTimeout(resolve, ${milliseconds}))`);
await evaluate(`(() => {
  const svg = document.querySelector(".location-map__svg");
  if (!svg) return false;
  svg.scrollIntoView({block: "center", inline: "center"});
  return true;
})()`);
await wait(100);
const snapshot = () => evaluate(`(() => {
  const svg = document.querySelector(".location-map__svg");
  if (!svg) return {error: "map svg not found"};
  const root = svg.closest("[data-map-renderer]") || svg.parentElement.parentElement;
  const rect = svg.getBoundingClientRect();
  const motion = svg.querySelector(".location-map__motion-surface");
  const canvases = motion ? [...motion.querySelectorAll("canvas")] : [];
  return {
    rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
    renderer: root.dataset.mapRenderer || null,
    resolution: root.dataset.mapResolution || null,
    active: root.dataset.mapMotionActive || null,
    navigating: root.dataset.mapNavigating || null,
    gestureResolution: root.dataset.mapGestureResolution || null,
    warmed: root.dataset.mapMotionWarmed || null,
    renderMs: Number(root.dataset.mapMotionRenderMs || NaN),
    fillMs: Number(root.dataset.mapMotionCountriesMs || NaN),
    lineMs: Number(root.dataset.mapMotionLinesMs || NaN),
    graticuleMs: Number(root.dataset.mapMotionGraticuleMs || NaN),
    labelFactsMs: Number(root.dataset.mapLabelFactsMs || NaN),
    labelSceneMs: Number(root.dataset.mapLabelSceneMs || NaN),
    countryLabelMs: Number(root.dataset.mapCountryLabelMs || NaN),
    placeLabelMs: Number(root.dataset.mapPlaceLabelMs || NaN),
    countryLabelCandidates: Number(root.dataset.mapCountryLabelCandidates || 0),
    placeLabels: Number(root.dataset.mapPlaceLabels || 0),
    meshVertices: Number(root.dataset.mapMotionMeshVertices || 0),
    meshTriangles: Number(root.dataset.mapMotionMeshTriangles || 0),
    features: Number(root.dataset.mapMotionFeatures || 0),
    draws: Number(root.dataset.mapMotionDraws || 0),
    motionDisplay: motion ? getComputedStyle(motion).display : null,
    settledVisibility: getComputedStyle(svg.querySelector(".location-map__viewport")).visibility,
    canvasContexts: canvases.map((canvas) => ({
      width: canvas.width,
      height: canvas.height,
      webgl2: Boolean(canvas.getContext("webgl2")),
      canvas2d: Boolean(canvas.getContext("2d"))
    }))
  };
})()`);

const initial = await snapshot();
if (initial.error) throw new Error(initial.error);
const point = {
  x: initial.rect.x + initial.rect.width * 0.55,
  y: initial.rect.y + initial.rect.height * 0.48
};

await send("Input.dispatchMouseEvent", {
  type: "mouseWheel",
  x: point.x,
  y: point.y,
  deltaX: 0,
  deltaY: -180
});
await wait(16);
const wheelMotion = await snapshot();
// d3-zoom closes a wheel gesture after its own idle debounce; the map's
// detailed restore delay starts after that. Allow both timers to elapse.
await wait(300);
const wheelSettled = await snapshot();

await send("Input.dispatchMouseEvent", {type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1});
const dragFrames = [];
for (let index = 1; index <= 8; index += 1) {
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x + index * 11,
    y: point.y + index * 5,
    button: "left",
    buttons: 1
  });
  await wait(16);
  dragFrames.push(await snapshot());
}
await send("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  x: point.x + 88,
  y: point.y + 40,
  button: "left",
  clickCount: 1
});
await wait(130);
const dragSettled = await snapshot();

const finiteDragFrames = dragFrames.filter((item) => Number.isFinite(item.renderMs));
const renderTimes = finiteDragFrames.map((item) => item.renderMs).sort((left, right) => left - right);
const percentile = (values, ratio) => values.length
  ? values[Math.min(values.length - 1, Math.floor(values.length * ratio))]
  : null;

const concise = (item) => ({
  renderer: item.renderer,
  resolution: item.resolution,
  active: item.active,
  navigating: item.navigating,
  gestureResolution: item.gestureResolution,
  warmed: item.warmed,
  renderMs: item.renderMs,
  fillMs: item.fillMs,
  lineMs: item.lineMs,
  graticuleMs: item.graticuleMs,
  labelFactsMs: item.labelFactsMs,
  labelSceneMs: item.labelSceneMs,
  countryLabelMs: item.countryLabelMs,
  placeLabelMs: item.placeLabelMs,
  countryLabelCandidates: item.countryLabelCandidates,
  placeLabels: item.placeLabels,
  motionDisplay: item.motionDisplay,
  settledVisibility: item.settledVisibility
});

console.log(JSON.stringify({
  page: {url: target.url, title: target.title},
  geometry: {
    vertices: initial.meshVertices,
    triangles: initial.meshTriangles,
    features: initial.features,
    draws: initial.draws,
    webgl2: initial.canvasContexts.some((item) => item.webgl2),
    canvas2d: initial.canvasContexts.some((item) => item.canvas2d)
  },
  initial: concise(initial),
  wheel: {motion: concise(wheelMotion), settled: concise(wheelSettled)},
  drag: {
    frames: finiteDragFrames.length,
    p50: percentile(renderTimes, 0.5),
    p95: percentile(renderTimes, 0.95),
    max: renderTimes.length ? renderTimes.at(-1) : null,
    activeFrames: dragFrames.filter((item) => item.active === "true").length,
    settled: concise(dragSettled)
  },
  exceptions
}, null, 2));

socket.close();
