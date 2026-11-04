# The Karlín map data (`karlin.json`)

`client/shared/karlin.json` is the real Prague district of Karlín for World of DODO (issue #16): buildings, streets,
blocks, the tram, the railway, water, parks, trees, empty lots, landmarks and the terrain around it, in game units. The
client and the server load the same file (`client/shared/map.ts`).

**It is generated. Never edit it by hand:** change `tools/karlin/gen.mjs` and run it again (see "Re-running" below and
`tools/karlin/README.md`). `node tools/karlin/check.mjs` checks the file against everything described here.

## Sources and licences

| Source | What it gives | Licence | How it is read |
|---|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/copyright) | footprints, building parts, `height`/`building:levels`/`roof:*`, streets and their widths, tram and railway lines, tram stops, trees and tree rows, parks, water, squares, pedestrian areas, the landmarks' names | ODbL 1.0 | one Overpass query over the bounding box of the outer square (overpass-api.de, falling back to overpass.kumi.systems); the snapshot time is `osmDate` |
| [IPR Praha](https://geoportalpraha.cz), *Podlažnost budov* (`URK_CUR_URK_SS_PODLAZNOST_P`) | floors (`podlaz_celk` in total, `pocet_podlazi` up to the cornice), the roof shape (`strecha`), the kind of building (`typ`, used for the storey height) | CC BY 4.0 | ArcGIS FeatureServer query by envelope, `inSR`/`outSR` 4326, paged by `resultOffset` |
| [ČÚZK](https://geoportal.cuzk.cz), *DMR 5G* (digital terrain model, 5th generation) | the terrain height of the outer zone | CC BY 4.0 | the ImageServer `ags.cuzk.cz/arcgis2/rest/services/dmr5g` (`exportImage`, one 32-bit float TIFF of about 5 m pixels) |

No Google, Mapbox, Apple, Esri or Mapy.com content is used (their terms forbid it).

### What the game must show

The three lines in `attribution`, wherever the game credits its sources:

- `© OpenStreetMap contributors (ODbL)`
- `datový podklad © IPR Praha (CC BY 4.0)`
- `výškopis © ČÚZK (CC BY 4.0)`

`karlin.json` is a database derived from OpenStreetMap, so the file itself is under the **ODbL** (its source is this
generator plus the public sources above, so anyone can rebuild it). The game's code stays under the MIT licence.

## The frame

WGS84 → local metres around `lat0 = 50.0925`, `lon0 = 14.4500`:
`x = (lon - lon0) · 111320 · cos(lat0)`, `z = -(lat - lat0) · 110540` (x east, **z south**, the game's convention), then
turned by **17°** so that Karlín's street grid is axis-aligned (Thámova runs along constant x):
`x' = x cos17 - z sin17`, `z' = x sin17 + z cos17`; then the window centre `(cx, cz) = (-120, -30)` rotated metres is
subtracted and the result divided by **1.5** (1 unit = 1.5 m). Heights are real metres × **1.2** / 1.5 (a bit taller than
life). `frame` in the file holds these numbers; `tools/karlin/lib/frame.mjs` has `toU`/`fromU`.

- **arena** (where tanks, bots and cars stay): `[-346.7, -215, 356, 208]` units (x0, z0, x1, z1). The west edge is the
  brief's x' = -640 m (west of the Negrelli viaduct). Three edges were moved from the brief's rectangle
  (x' -640..400, z' -360..300 m = units ±346.7 × ±220):
  - north -220 → **-215**: the Vltava's bank is at z ≈ -237 to -245 in the west; the flat margin (15 u) now ends at the
    water instead of in it. Rohanské nábřeží (the embankment street) is inside.
  - south 220 → **208**: the main railway at the foot of Vítkov runs at z 213..222; it now lies just outside the arena, on
    the flat margin, a natural southern border.
  - east 346.7 → **356**: the brief's edge ran exactly along Šaldova/Breitfeldova (x 344..350), leaving a street half in
    and half out; the edge is now just behind Šaldova's east kerb.
- **outer** (the planes' surroundings, solid and drawn, out of the tanks' reach): the square `[-700, -700, 700, 700]`.

## The schema

All coordinates in units, rounded to 0.1. Polygons are flat arrays `[x0, z0, x1, z1, ...]`, the first point not repeated,
simplified, never crossing themselves, and **positive by the shoelace formula** `sum(x_i·z_(i+1) - x_(i+1)·z_i) > 0`.
(Drawn with x to the right and z downwards, as on a screen, that is a clockwise ring; in a right-handed y-up scene seen
from above it is counter-clockwise. `map.ts` normalises with `polyArea` anyway.)

```ts
interface KarlinData {
  v: 1;
  attribution: string[];       // the three lines above
  osmDate: string;             // Overpass snapshot time (timestamp_osm_base)
  frame: { lat0, lon0, rotDeg, unitM, hScale, cx, cz };
  arena: [x0, z0, x1, z1];
  outer: [x0, z0, x1, z1];
  buildings: Building[];       // arena buildings first (sorted by z, x), then the far ones
  roads: { nodes: number[]; edges: Edge[] };
  blocks: number[][];          // kerb polygons of the street graph's faces inside the arena
  plazas: number[][];          // paved pedestrian areas on the blocks
  tram: { loop: number[]; stops: number[]; tracks: number[][] };
  rail: { pts: number[]; deck: number; bridge: 0 | 1 }[];
  farRoads: { pts: number[]; w: number; y?: number }[];   // the car roads of the outer square outside the arena, drawn only (no graph,
                                                       // no traffic); y: a bridge's deck height (see "rail" for those over the river)
  water: number[][];
  parks: number[][];
  trees: number[];             // [x, z, size, ...]
  lots: number[][];            // [x0, z0, x1, z1], biggest first
  landmarks: Record<string, { x: number; z: number; rot: number; b: number }>;
  terrain: { x0, z0, step, nx, nz, h: number[] };
}
interface Building { p: number[]; h: number; y0?: number; r: 0 | 1 | 2; rh: number; f: number; c: number; k?: string; far?: 1 }
interface Edge { a: number; b: number; pts: number[]; w: number; c: 0 | 1 | 2 | 3 | 4; n?: string; tram?: 1 }
```

### buildings

- `p` the footprint; `h` the **top of the walls (cornice), absolute** (already × 1.2, and including `y0`); `y0` the base
  where it is not 0: far buildings stand on the terrain, `y0` is the lowest terrain under the footprint and `h` the mean
  terrain under it plus the wall height (so a house on the Vítkov slope reaches into the ground on the uphill side, never
  floats). Arena buildings have no `y0` (the terrain is 0 there).
- `r` roof: 0 flat, 1 pitched/hipped, 2 mansard; `rh` the roof's height above `h` (0 when flat); `f` floors (for the
  window rows); `c` the facade colour index 0..7.
- `k` kind, where known: `church`, `synagogue`, `industrial`, `garage`, `shed`, `office`, `retail`, `school`, `station`,
  `hospital`, `hotel`, `civic`, `construction`, `ruins`, and on the landmark buildings the landmark's key (all pieces of
  that OSM building).
- `far: 1` when the footprint lies entirely outside the arena (simplified harder, small ones dropped).
- Heights, in this order: OSM `height` (minus `roof:height`) → OSM `building:levels` × storey height (+ `roof:levels`) →
  the tallest of the building's `building:part`s → IPR `pocet_podlazi` × storey height (extra floors up to
  `podlaz_celk` become the roof) → a default. The storey height is 3.2 m, or IPR's for that house: 3.7 m for *stará
  zástavba, vysoké stropy* (typ 7, Karlín's 19th-century houses) and 4.5 m for *nestandardní výška podlaží* (typ 3).
  OSM `building:levels = 1` is a placeholder on many RÚIAN-imported Karlín houses (IPR has 4, 5, 7 floors for them):
  where IPR knows more than one floor, IPR wins over such a 1. Defaults: by kind (office 6, school 4, industrial 2,
  garage/shed 1, ...), apartments/residential 5, and a plain `building=yes` by its size (under 30 m² 1 floor, under
  80 m² 2, under 200 m² 3, else 5).
- Roof shape: OSM `roof:shape` → IPR `strecha`, read from the layer's coded domain (*šikmá* → 1, *rovná* → 0,
  *atypická (kombinace)* → 2, *kopulovitá* → 1, *neurčeno* → no information) → default (houses up to 6 floors pitched,
  the rest flat). Roof height: `roof:height`, `roof:levels` × 3 m, IPR's extra floors × 3 m, else 35 % of the
  footprint's short side for a pitched roof (at most 7 m), 3.5 m for a mansard; never more than 60 % of the short side.
  Extra floors over a flat roof are set-back storeys: they count as walls.
- Facade colour: OSM `building:colour` (a name or a hex value) mapped to the nearest of the palette, else a stable hash
  of the OSM id. The palette the indices refer to: 0 cream `#efe6cf`, 1 ochre `#e3c78a`, 2 light grey `#c9c9c4`,
  3 white `#f4f4f0`, 4 salmon `#e7b9a5`, 5 sage `#c2d1b0`, 6 grey-blue `#b5c3cf`, 7 brick `#b46a50`.

### roads

- `nodes` flat `[x, z, ...]`; `edges` join two different nodes, `pts` the polyline including both node points exactly.
- Car streets only: motorway/trunk/primary (`c` 0), secondary (1), tertiary (2), residential/unclassified/living_street
  (3), and service roads (4) only where they link streets (dead-end service roads are pruned). Without parking aisles,
  driveways, private/no-access minor roads, tunnels, building passages and covered drives (a house is solid in the game).
- Noded at shared OSM nodes; clipped to the arena: an edge cut by the arena's edge ends in a node **on** the edge (exactly
  `x = x0/x1` or `z = z0/z1`); nodes joined by an edge shorter than 4 u merged; degree-2 nodes folded into the edge
  polylines (except where that would make a loop of one edge); both halves of a dual carriageway between the same two
  junctions merged into one edge; only the largest connected piece kept.
- `w` the carriageway width: OSM `width`, else primary 14 m, secondary 12, tertiary 10, residential 8, service 5 (in
  units: / 1.5). Where that would reach a facade, the edge is narrowed so that a 2 u pavement stays between kerb and
  house (never below 4.5 u).
- `n` the street name; `tram: 1` on the edges the tram runs along.
- Every street counts as two-way in the game (a brief decision), whatever OSM's `oneway` says.

### blocks

The faces of the street graph inside the arena (the arena's edge closes the faces along it), each pulled in from the
centreline by that edge's half carriageway width: the kerb. The outer face is not included. **Dead-end streets cut a
notch** into their block, the street's width wide, ending square at the street's end, so a cul-de-sac is a street and not
a pavement; `--no-notches` gives the brief's original rule (dead ends dropped before taking the faces, so their blocks pave
them over). A face whose kerb pinches shut splits into several blocks.

### plazas

OSM `place=square`, `area:highway=pedestrian|footway`, pedestrian/footway areas, `highway=pedestrian` lines (6 m wide
unless tagged) and footways at least 4 m wide, rasterised at 0.5 u, **kept only where a block is** (a square mapped over its
streets keeps its streets), traced back to polygons. Karlínské náměstí is the big one.

### tram

- `loop`: one closed polyline along **Sokolovská** (the only street of the two with tram tracks; it spans the arena from
  edge to edge), from the arena's west edge to its east edge and back, **right-hand running** (eastbound on the south
  track, 2.2 u from the centreline of the real tracks), with a turning loop at each end just outside the arena: an S-bend
  out to the right, a half circle of radius 12 u to the left, an S-bend back. The polyline is not repeated at its end
  (the last point joins the first). Far buildings the loops would cut were dropped.
- `stops`: arc lengths along `loop` of the real stops (OSM stop positions) Karlínské náměstí and Křižíkova, each direction
  on its own track (4 values, ascending).
- `tracks`: every OSM tram track in the outer zone, for drawing.

### rail

OSM railway lines (rail, light rail; not tunnels, sidings or spurs; disused tracks only where they are on a viaduct) in the
outer zone, joined end to end where their bridge state stays the same. `bridge: 1` on bridges and viaducts; `deck` the
height of the track bed in units: the **Negrelli viaduct** (and any bridge in or near the arena) 6.4 u (8 m), other
bridges the terrain at their ends but at least 4.8 u. `bridge: 0` lines have `deck: 0`: they lie on the terrain
(`terrainH`). The line at the foot of Vítkov is the `bridge: 0` line along z ≈ 215.

**Bridges over the Vltava** (issue #20, warships: a ship's superstructure must pass under them; the water is at -4.5): a rail
deck over the river is at least 3 u (map.ts makes the deck slab `deck - 1` .. `deck`, so its underside is at least 2 u, 6.5 over
the water), a `farRoads` piece with `y` that crosses the river at least 3.5 u (its slab `y - 1` .. `y`). Both are met by the
Negrelli viaduct (6.4) as it was; six pieces of Hlávkův most (0.3 to 2.5 before, their ends' terrain) are raised to 3.5. The
ends' terrain of every bridge is read from the terrain as it was before the river got its deep bed (see "terrain"), so no other
bridge changes. The piers in the river are not data: `client/shared/map.ts` stands them where a bridge crosses the water (on every
small dry gap the data has there, the Negrelli viaduct's piers and the locks' walls, and evenly between them where the open water
runs longer than 30 u).

### water, parks, trees

- `water`: natural=water / riverbank polygons (the Vltava, with Štvanice as land) clipped to the outer square. **The Vltava**
  (issue #20) is the water connected to the biggest piece (15 of the 18 pieces; touching within 0.5 u, as the pieces of one
  polygon share their cut edges): its bank is every piece edge with no river on its other side. The other three are small
  ponds (one of them a 20 × 8 u pool in the arena's north, at x 3..23, z -190..-182). `client/shared/naval.ts` reads the river
  the same way.
- `parks`: parks, gardens, grass, forest, meadows, recreation grounds (not paved ones), cemeteries, woods, scrub.
- Polygons with holes (a courtyard, an island) are cut into simple pieces along vertical lines through the holes.
- `trees`: OSM trees and tree rows (one every 6 u) inside the arena, on a block and outside houses; a street tree that
  falls just onto the carriageway (simplified kerbs) is moved onto the nearest kerb within 3 u, else dropped. `size` from
  OSM `height` (0.7..1.3), else a stable hash.

### lots

The biggest axis-aligned empty rectangles inside the arena, biggest first, at most 8, at least 12 u on each side and at
most 4:1: on a block, 2 u in from the kerb (off the pavement), at least 1 u from any building, plaza, water and 2.5 u from
any railway track, **reachable by a tank** (connected to a street through a gap of at least a tank's width: a courtyard
closed by houses does not count), 3 u apart. The first is kept for the construction site (off for now, `SITE_LOT` in `map.ts`), the DODO depot hall takes
the next that fits.

### landmarks

`church` (sv. Cyril a Metoděj, Karlínské náměstí), `theatre` (Hudební divadlo Karlín: **outside the arena**, a far
building, by Florenc), `forum` (Forum Karlín), `kasarna` (Karlínská kasárna), `synagogue` (Karlínská synagoga), `viaduct`
(Negrelliho viadukt: the bridge outline's middle inside the arena, `b = -1`), `vitkov` (Národní památník na Vítkově, a
far building on the hill). `x, z` the middle of the building's minimum bounding rectangle, `rot` its long axis in radians
(atan2 in x/z), `b` the index into `buildings` (the biggest piece) or -1.

### terrain

A heightmap over the outer zone, row-major (rows of constant z): `x0 = z0 = -700`, `step = 10`, `nx = nz = 141`.
Heights in units relative to Karlín's own level (the median of DMR 5G inside the arena, 186.4 m above sea level), × 1.2.
**Exactly 0 inside the arena and 15 u around it** (the rectangle grown by 15), then blended to the real terrain over 45 u.
Land never goes below -0.6. **Under the Vltava** (issue #20, outside the flat zone) the river bed, -8, under the water's
surface at -4.5 (`naval.ts` `WATER_Y`; Prague's embankments stand 5-7 m over the river). The grid is read bilinearly, so a grid
point just inside the bank at -8 would drag the land beside it far down: the bed rises towards the bank over its last units,
`max(-8, -0.6 - 1.6 d)` with `d` the grid point's distance to the bank (sampled up to 6 u). Near a bank the grid is therefore
neither the land's height nor the bed's for a few units; the game asks `naval.ts` (`inRiver`, `landY`: the grid with its river
points taking their land neighbours' height) and draws the bank as an embankment wall. Under a pond (not the Vltava) -2 as
before, the pond drawn frozen above it. The far buildings' bases and the bridges' ends are taken from the terrain as it was
before the deep bed (-2 under all water), so that a house on the bank keeps its footing: the buildings are byte for byte the
same. Vítkov rises to about 60 u under the memorial (≈ 75 m above Karlín), the
highest point of the zone is 71.8 u.

## What the generator simplifies

- Footprints: Douglas-Peucker 0.25 u (far 0.5 u), rounded to 0.1, checked again after rounding. Arena buildings smaller
  than 6 m² and far ones smaller than 14 u² (31.5 m²) are dropped; building=roof (canopies), underground and indoor
  buildings are skipped; building parts only give heights (a tower on a lower building is not modelled: the building has
  one height, the tallest part's when it has none of its own).
- One wall height per building (no set-backs, no towers), roofs as three shapes only.
- The street graph: see "roads" (two-way, merged junctions, dual carriageways as one edge where they meet the same two
  junctions, else as two edges with a thin median block between).
- Kerbs follow the carriageway widths above, not the real kerb lines; the arena's edge closes the blocks along it.
- The tram is one line on one street with game-made turning loops; the real lines turn off to Florenc and Palmovka.
- Trees from OSM only (IPR's street-tree layer is not used).
- Terrain at 15 m resolution, flattened in and around the arena, the river bed at one depth (and the water's surface at one
  level: no weirs, the lock chambers at the river's level).

## Known data problems

- One house by the Negrelli viaduct (building 197, at x -300..-308, z -46..-28) reaches about 2 u into Prvního pluku's
  carriageway (11 of 9264 carriageway samples inside a house; the narrowing rule looks at the 10th percentile of a whole
  edge).
- 126 arena buildings (most of them small courtyard buildings) have no height in OSM or IPR: they get the defaults above.
- The Vítkov memorial is mapped 5 m high (one storey); the generator gives it 22 m.
- The church's towers and the theatre's fly tower are not in the data (one prism each); the client draws landmarks itself.
- Karlín has no empty plot anywhere near 150 × 50 u: the biggest reachable lot is 58 × 31 u. For comparison (not used):
  without the reachability rule the Kasárna courtyard gives 57 × 39; if single-storey buildings could be demolished,
  70 × 35; if every building up to two storeys could, 89 × 35.
- A few tiny blocks (traffic islands, 6–8 u²) and one 4.8 u edge (an unnamed service link at -241.8, -169.9).
- OSM is edited every day: a re-run with `--refresh` can move things (`osmDate` says which snapshot this is).

## Re-running

```sh
node tools/karlin/gen.mjs            # from the cache in tools/karlin/cache/ (offline, gives the same file)
node tools/karlin/gen.mjs --refresh  # download OSM, IPR and ČÚZK again
node tools/karlin/check.mjs          # check the file
node tools/karlin/preview.mjs        # pictures of it (SVG, and PNG with puppeteer-core)
```

More in `tools/karlin/README.md`.
