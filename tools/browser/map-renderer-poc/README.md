# Map renderer benchmark PoC

This directory is deliberately isolated from `language-distribution-map.js`.
It does not change the production map. It compares renderer costs while using
the same D3/topojson data family and fixed interaction scenarios.

Run from the repository root:

```sh
python3 -m http.server 8140
```

Then open:

```text
http://localhost:8140/tools/browser/map-renderer-poc/?autorun=1
```

The viewport can be fixed for reproducible runs:

```text
http://localhost:8140/tools/browser/map-renderer-poc/?autorun=1&mapWidth=960&mapHeight=540
```

The page exposes the completed result as `window.__mapPerfResults`.
It also measures 10m globe movement with the mesh retained and labels frozen
during interaction, which is the candidate path for keeping detailed geometry
visible while dragging.

The `current-svg` row intentionally reproduces the expensive shape of the
current implementation: repeated `bounds`/`area`/`centroid`, SVG path-string
serialization, full layer replacement, and synchronous `getBBox()` reads.
The other renderer rows share a cached scene model so that renderer cost is not
confounded with repeated geographic analysis.

Measured results and the proposed migration boundary are documented in
[`REPORT.md`](./REPORT.md).

## Label pipeline benchmark

The label-specific page isolates the country/place label pipeline while keeping
the final labels as SVG text:

```text
http://localhost:8140/tools/browser/map-renderer-poc/label-benchmark.html?autorun=1
```

It compares the current-style repeated 10m geographic analysis,
`getBBox()` reads, quadratic collision checks, and DOM replacement with cached
geographic anchors, cached text widths, a uniform collision grid, viewport
culling, and retained keyed SVG nodes. The completed result is exposed as
`window.__labelPerfResults`.
