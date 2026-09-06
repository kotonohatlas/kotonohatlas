# Vendored map modules

These browser-ready ES modules are served from the same origin as the language
atlas. They are pinned copies of the following packages, bundled by esm.sh:

- `@d3-maps/atlas@1.0.0`
- `topojson-client@3.1.0`
- `d3-geo@3.1.1`
- `d3-selection@3.0.0`
- `d3-zoom@3.0.0`
- `earcut@3.0.2`

The 110m topology and JavaScript helpers load with the map runtime. The larger
10m topology remains a dynamic import and is fetched only after the first map
draw. Package license texts are stored alongside the modules.
