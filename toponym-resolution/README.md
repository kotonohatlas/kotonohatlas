# Toponym resolution

This directory contains the build-time place-name policy and its isolated
reference runtime. It is not published as a JavaScript dependency of the live
map.

- `runtime.js` is the isolated reference implementation retained with the
  resolution work; the live map does not import or emit it.
- `policy.json` is build-time input for preparing the map's label packs and
  fallback metadata.
Admin-1 name curation is an optional external data source. The map continues to
own its geometry and can attach a compatible name catalog when one is present.
