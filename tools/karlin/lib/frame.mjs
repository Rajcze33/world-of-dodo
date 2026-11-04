// World of DODO, issue #16: the frame of the Karlín map. WGS84 -> local metres around (lat0, lon0), x east, z SOUTH (the
// game's convention), then turned by ROT so that Karlín's street grid is axis-aligned (Thámova has a constant x), then
// moved to the window centre (CX, CZ, rotated metres) and scaled to game units (1 unit = UNIT_M metres).
export const LAT0 = 50.0925, LON0 = 14.4500, ROT_DEG = 17, UNIT_M = 1.5, H_SCALE = 1.2;
// the window centre in rotated metres: the middle of the arena x' -640..400, z' -360..300 (see ARENA_M)
export const CX = -120, CZ = -30;
// the arena (where tanks drive) in rotated metres, before any nudge; the generator may move the north/south edges
export const ARENA_M = { x0: -640, z0: -360, x1: 400, z1: 300 };
export const OUTER_U = 700;                    // the outer zone: the square ±700 units around the centre
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KZ = 110540;
const C = Math.cos(ROT_DEG * Math.PI / 180), S = Math.sin(ROT_DEG * Math.PI / 180);

export function toU(lon, lat) {
  const x = (lon - LON0) * KX, z = -(lat - LAT0) * KZ;
  return [(x * C - z * S - CX) / UNIT_M, (x * S + z * C - CZ) / UNIT_M];
}
export function fromU(u, v) {
  const xr = u * UNIT_M + CX, zr = v * UNIT_M + CZ;
  const x = xr * C + zr * S, z = -xr * S + zr * C;
  return [LON0 + x / KX, LAT0 - z / KZ];
}
// metres of real height -> game units (heights are 1.2 × real, a bit taller than life)
export const hU = m => m * H_SCALE / UNIT_M;
// the WGS84 bounding box of the outer square (+ margin units), for the downloads
export function outerBBox(margin = 40) {
  const R = OUTER_U + margin, ll = [[-R, -R], [R, -R], [R, R], [-R, R]].map(([u, v]) => fromU(u, v));
  const lons = ll.map(p => p[0]), lats = ll.map(p => p[1]);
  return { w: Math.min(...lons), e: Math.max(...lons), s: Math.min(...lats), n: Math.max(...lats) };
}
