# tools/karlin: the generator of the Karlín map

Builds `client/shared/karlin.json` (the real Karlín for World of DODO, issue #16) from OpenStreetMap, IPR Praha's building
floors and ČÚZK's terrain model. What the file contains, its schema, the sources, the licences and the attribution the game
must show are in [client/shared/KARLIN-DATA.md](../../client/shared/KARLIN-DATA.md).

Node 24, no npm dependencies (the geometry and a small TIFF reader are in `lib/`).

```sh
node tools/karlin/gen.mjs              # writes client/shared/karlin.json (a few seconds, from the cache)
node tools/karlin/check.mjs            # checks it: polygons, graph, blocks, tram, lots, terrain (exit 1 on a failure)
node tools/karlin/preview.mjs [dir]    # preview.svg / preview-arena.svg (and PNGs, see below) into dir (default cache/)
```

Options of `gen.mjs`:

- `--refresh`: download everything again instead of reading `cache/` (needed after a change of the query or to take a newer
  OSM snapshot; then look at the preview and run `check.mjs` before committing the new file).
- `--no-notches`: the brief's original block rule, dead-end streets dropped before taking the faces (their blocks pave them
  over). By default a dead-end street cuts a notch into its block.
- `--synthetic-terrain`: do not use the ČÚZK terrain, make one up (flat Karlín, Vítkov as a ridge through the memorial,
  a gentle rise north of the river). It is also what happens when the terrain service cannot be reached.

## Files

- `gen.mjs`: the generator, in order: water (which pieces are the Vltava), terrain (the river bed), IPR, buildings, streets,
  blocks, plazas, tram, railways, parks, trees, landmarks, lots; it prints what it did and writes `cache/report.json` (counts,
  height sources, the edges it narrowed, the buildings the tram loops removed, the tram stops, the river's bed and the bridges
  raised over it, ...).
- `lib/frame.mjs`: the frame (WGS84 → game units and back), the arena and the outer square from the brief.
- `lib/fetch.mjs`: the three downloads, cached.
- `lib/geom.mjs`: the 2D geometry (simplify, validity, clipping polygons with holes, kerb offsets, rasters, the biggest
  empty rectangle).
- `lib/tiff.mjs`: reads the float TIFF the terrain service sends.
- `check.mjs`, `preview.mjs`: see above.
- `cache/` (gitignored): `overpass.json` (+ the query in `overpass.overpassql`), `ipr-meta.json` and `ipr-NNN.json` pages,
  `dmr-export.json` + `dmr.tif`, `report.json`, the previews.

## The downloads

All three are free public services: one request at a time, a User-Agent that names the project, a pause between pages,
retries with a growing wait on 429/5xx.

- **Overpass** (`https://overpass-api.de/api/interpreter`, falling back to `https://overpass.kumi.systems`): one combined
  POST query over the WGS84 bounding box of the outer square (about 15 MB of JSON, a minute). `out body geom` keeps the node
  ids, which the street graph is noded on.
- **IPR Praha** (`mp.iprpraha.cz/.../URK_CUR_URK_SS_PODLAZNOST_P/FeatureServer/0`): query by envelope with `inSR=4326`,
  `outSR=4326`, paged by `resultOffset`/`resultRecordCount` up to the layer's `maxRecordCount` (2000); about 4000
  polygons in three pages. The roof codes are read from the layer's metadata (`fields[].domain.codedValues` of `strecha`).
- **ČÚZK DMR 5G** (`ags.cuzk.cz/arcgis2/rest/services/dmr5g/ImageServer`): `getSamples` is forbidden there, so one
  `exportImage` (format tiff, F32, no compression, about 5 m pixels, 570 × 570) and bilinear sampling.

## PNG previews

`preview.mjs` makes PNGs when it finds `puppeteer-core` (as `tools/browser-test.js` does: `npm i --no-save
puppeteer-core@25.14.0`, or `NODE_PATH` pointing at a folder that has it; `CHROME=path` for another Chrome). `--view
x0,z0,x1,z1,zoom` renders just that window (units, pixels per unit) as `preview-view`.

## Changing it

- The arena and the frame live in `lib/frame.mjs` and at the top of `gen.mjs` (the arena's nudged edges, with the reasons).
  Changing them moves everything: the client, the server and the bots' copy of the rules all read the new file, so all
  of them must run the same version.
- After any change: `node tools/karlin/gen.mjs && node tools/karlin/check.mjs`, look at the preview, then
  `node tools/test-map.ts` (the shared map's own tests) and the game.
- The output is deterministic: the same cache gives the same file byte for byte.
