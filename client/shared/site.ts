// World of DODO: the construction site, as data. The game draws it (client/src/world/city.ts) and collides with it, the server's bots
// aim around it; both get it from client/shared/map.ts, which places it on an empty lot of the city.
//
// World of DODO, issue #16: this was client/shared/site.js, a fixed layout on the snow south of the invented city (300 × 70 units
// round x 0, z 209). In the real Karlín it stands on whatever empty lot the map data offers, so the same layout is now made for a
// rectangle. The positions spread or squeeze with the lot; the things keep their size. The two groups (the half-built house, the
// container yard) shrink to fit their share of the lot, down to 0.6, and are left out below that (the container yard first; `dropped`
// says what went); a loose thing (a barrier, a pallet, a pile, a machine) that would run into another one, a gate or the fence is left
// out. The long side of the layout follows the lot's long side (rot 1: along z); the gates face the street the caller names.
//
// Every solid is a box standing on the ground: x0..x1, z0..z1, height h (world units), with a kind and a colour for drawing. A few
// kinds carry more for their looks: a sand pile its radius r and height ph (the box is the pile's solid core), pipes their axis. The
// crane is drawn by the page; only its mast's base is a solid here.

export interface SiteSolid {
  kind: string;
  x0: number; x1: number; z0: number; z1: number;
  h: number;
  color: number;
  r?: number; ph?: number;            // a sand pile
  axis?: 'x' | 'z';                   // pipes
}
export interface Site {
  origin: [number, number];           // the middle of the site
  area: { x0: number; x1: number; z0: number; z1: number };   // the dirt ground inside the fence; no trees grow here
  solids: SiteSolid[];
  crane: { x: number; z: number; h: number; jib: number; back: number; color: number };
  rot: 0 | 1;                         // 0: the layout's long side runs along x (as the original), 1: along z
  out: [number, number];              // the side with the gates (the original's north, towards the city), as an outward unit vector
  gates: { x: number; z: number; w: number }[];   // the gaps in that fence: their middle and width (the page draws tracks from them)
  house: number; yard: number;        // the size of the house and the container yard against the original's (0: left out)
  dropped: string[];                  // 'containers', 'house': left out, the lot was too small
}

// The original layout in its own coordinates: u along the long side (-150..150), v across (-35 the gate side .. 35), as in site.js.
const D0 = 35;
// which groups each try keeps, and the stretch of u it needs
const TRIES: { drop: string[]; u0: number; u1: number }[] = [
  { drop: [], u0: -150, u1: 150 },
  { drop: ['containers'], u0: -150, u1: 72 },
  { drop: ['house'], u0: -80, u1: 150 },
  { drop: ['containers', 'house'], u0: -80, u1: 72 },
];
// the groups: their middle and half size in layout units, and the slot of u they may take (so the middle keeps its room)
const HOUSE = { u: -105, v: -3, hu: 20, hv: 20, s0: -150, s1: -80 }, YARD = { u: 105, v: 1.2, hu: 33, hv: 24.2, s0: 68, s1: 150 };

// the site on the lot x0..x1 × z0..z1; (fx, fz) points from the lot to the street the gates should face
export function makeSite(x0: number, z0: number, x1: number, z1: number, fx = 0, fz = -1): Site {
  const M = 1;                                                    // the fence keeps this far inside the lot (off the kerbs and walls)
  x0 += M; z0 += M; x1 -= M; z1 -= M;
  const rot: 0 | 1 = x1 - x0 >= z1 - z0 ? 0 : 1, L = rot ? z1 - z0 : x1 - x0, S = rot ? x1 - x0 : z1 - z0, hu = L / 2, hv = S / 2;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, kv = S / (2 * D0);
  // the gate side: of the two long sides, the one facing (fx, fz); fv flips the layout across its long axis to put it there
  const fv = rot ? (fx > 0 ? -1 : 1) : (fz > 0 ? -1 : 1);
  const out: [number, number] = rot ? [-fv, 0] : [0, -fv];
  const wx = (u: number, v: number) => rot ? cx + v * fv : cx + u, wz = (u: number, v: number) => rot ? cz + u : cz + v * fv;
  // how big a group may be in a try (1 = as the original): inside the fence, within its slot of u
  let T = TRIES[0], ku = 1, um = 0, gH = 0, gY = 0;
  const U = (u: number) => (u - um) * ku, Vv = (v: number) => v * kv;
  const fit = (g: typeof HOUSE) => Math.min(1, (U(g.u) - Math.max(U(g.s0), -hu + 1.5)) / g.hu, (Math.min(U(g.s1), hu - 1.5) - U(g.u)) / g.hu,
    (Vv(g.v) + hv - 8) / g.hv, (hv - 1.5 - Vv(g.v)) / g.hv);   // the gate side keeps the ways in free
  for (const t of TRIES) {
    T = t; ku = L / (t.u1 - t.u0); um = (t.u0 + t.u1) / 2;
    gH = t.drop.includes('house') ? 0 : fit(HOUSE); gY = t.drop.includes('containers') ? 0 : fit(YARD);
    if ((gH === 0 || gH >= 0.6) && (gY === 0 || gY >= 0.6)) break;
  }
  if (gH < 0.6) gH = 0; if (gY < 0.6) gY = 0;
  const dropped = [...(gY ? [] : ['containers']), ...(gH ? [] : ['house'])];
  const solids: SiteSolid[] = [], taken: number[][] = [];           // taken: boxes in (u, v) that loose things must keep clear of
  // a box by its centre (u, v, world units from the site's middle along/across) and size along/across
  const put = (kind: string, u: number, v: number, wu: number, wv: number, h: number, color: number, more?: Partial<SiteSolid>) => {
    const X = wx(u, v), Z = wz(u, v), ax = rot ? wv : wu, az = rot ? wu : wv;
    solids.push(Object.assign({ kind, x0: X - ax / 2, x1: X + ax / 2, z0: Z - az / 2, z1: Z + az / 2, h, color }, more));
    taken.push([u - wu / 2, v - wv / 2, u + wu / 2, v + wv / 2]);
  };
  // a loose thing of the original at (u, v), w × d (along × across): placed by the lot, its own size; left out where there is no room
  const loose = (kind: string, u: number, v: number, w: number, d: number, h: number, color: number, more?: Partial<SiteSolid>) => {
    const pu = U(u), pv = Vv(v), a = [pu - w / 2 - 0.4, pv - d / 2 - 0.4, pu + w / 2 + 0.4, pv + d / 2 + 0.4];
    if (a[0] < -hu + 0.4 || a[2] > hu - 0.4 || a[1] < -hv + 0.4 || a[3] > hv - 0.4) return;
    for (const b of taken) if (a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]) return;
    put(kind, pu, pv, w, d, h, color, more);
  };
  // a group keeps its shape: its middle is placed by the lot, its parts sized and spaced by g
  const group = (G: typeof HOUSE, g: number) => {
    const GU = U(G.u), GV = Vv(G.v);
    return (kind: string, a: number, b: number, c: number, e: number, h: number, color: number) =>
      put(kind, GU + ((a + c) / 2 - G.u) * g, GV + ((b + e) / 2 - G.v) * g, (c - a) * g, (e - b) * g, h, color);
  };

  // the fence round the lot, with gates in the gate side (three on a long lot, as the original's, else one in the middle); the way in
  // behind each gate stays free
  const FENCE = 0x2e5e3a, FH = 2.2, gw = 14, gu = L >= 140 ? [-hu * 0.69, 0, hu * 0.69] : [0];
  let u = -hu;
  for (const g of gu) { put('fence', (u + g - gw / 2) / 2, -hv + 0.2, g - gw / 2 - u, 0.4, FH, FENCE); u = g + gw / 2; }
  put('fence', (u + hu) / 2, -hv + 0.2, hu - u, 0.4, FH, FENCE);
  put('fence', -hu - 0.2, 0, 0.4, S, FH, FENCE); put('fence', hu + 0.2, 0, 0.4, S, FH, FENCE);
  put('fence', 0, hv + 0.2, L + 0.8, 0.4, FH, FENCE);
  for (const g of gu) taken.push([g - gw / 2, -hv, g + gw / 2, -hv + 8]);
  const gates = gu.map(g => ({ x: wx(g, -hv), z: wz(g, -hv), w: gw }));

  // the half-built house in the west: ground-floor walls with openings, columns up to the second floor
  const CON = 0xa9a9a2, WH = 3.6;
  if (gH) {
    const H = group(HOUSE, gH), col = (cu: number, cv: number) => H('column', cu - 0.4, cv - 0.4, cu + 0.4, cv + 0.4, 8, CON);
    for (const [a, b] of [[-125, -112], [-106, -98], [-92, -85]]) H('wall', a, -23, b, -22.4, WH, CON);       // gate-side wall, two openings
    H('wall', -125, 16.4, -85, 17, WH, CON);                                                                 // back wall
    for (const [a, b] of [[-23, -7], [1, 17]]) H('wall', -125, a, -124.4, b, WH, CON);                         // west wall, one opening
    for (const [a, b] of [[-23, -11], [-3, 17]]) H('wall', -85.6, a, -85, b, WH, CON);                         // east wall, one opening
    H('wall', -110, -3.3, -100, -2.7, WH, CON);                                                              // a piece of an inner wall
    for (const cu of [-115, -105, -95]) for (const cv of [-13, -3, 7]) col(cu, cv);
    for (const [a, b] of [[-125, -117], [-93, -85]]) H('wall', a, 16.4, b, 17, 7.6, CON);                     // the corners already one floor higher
    taken.push([U(HOUSE.u) - HOUSE.hu * gH, Vv(HOUSE.v) - HOUSE.hv * gH, U(HOUSE.u) + HOUSE.hu * gH, Vv(HOUSE.v) + HOUSE.hv * gH]);   // and its inside
  }

  // containers in the east: alleys, some stacked two high (5.2)
  if (gY) {
    const C = { o: 0xd9622b, b: 0x2f6fb5, g: 0x3f8f4f, r: 0xb23a3a, w: 0xe6e6e0, s: 0x8a9290 }, Y = group(YARD, gY);
    for (const [a, b, along, high, col] of [
      [72, -23, 'x', 0, C.o], [78.4, -23, 'x', 1, C.b], [92, -23, 'x', 0, C.g], [104, -23, 'x', 0, C.r],
      [72, -11, 'z', 0, C.w], [86, -9, 'x', 1, C.o], [100, -13, 'z', 0, C.b], [112, -3, 'x', 0, C.g],
      [124, -17, 'x', 1, C.r], [78, 5, 'x', 0, C.s], [96, 9, 'x', 1, C.g], [118, 13, 'x', 0, C.b],
      [132, 1, 'z', 0, C.o], [84, 21, 'x', 0, C.r], [106, 23, 'x', 0, C.w]] as [number, number, string, number, number][]) {
      const [w, d] = along === 'x' ? [6, 2.4] : [2.4, 6];
      Y('container', a, b, a + w, b + d, high ? 5.2 : 2.6, col);
    }
  }

  // the loose things, the most important first (the later ones give way): masts, the crane, the cabins, the machines, the rest
  for (const [su, sv] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) put('mast', su * (hu - 4), sv * (hv - 4), 0.4, 0.4, 9, 0x3d4543);
  let CRANE = { x: wx(U(10), Vv(3)), z: wz(U(10), Vv(3)), h: 44, jib: 46, back: 14, color: 0xf2c400 };
  const nc = solids.length; loose('crane', 10, 3, 4, 4, CRANE.h, 0x8d8d86);
  if (solids.length === nc) { put('crane', 0, 0, 4, 4, CRANE.h, 0x8d8d86); CRANE = { ...CRANE, x: cx, z: cz }; }   // no room: in the middle
  loose('office', 59, -29.8, 6, 2.4, 5.2, 0xf2f2ee);                                                       // the site manager's two cabins
  loose('toilet', 52, -29.5, 1.2, 1.2, 2.3, 0x2f6fb5); loose('toilet', 53.6, -29.5, 1.2, 1.2, 2.3, 0x2f6fb5);
  loose('excavator', -38, 5, 3.2, 4.4, 3.4, 0xf2b705);
  loose('dozer', 60, 11, 3, 4.5, 2.8, 0xf2b705);
  loose('pipes', 32, -17, 8, 4, 2.6, 0x9a9a94, { axis: rot ? 'z' : 'x' });
  const SAND = 0xc9a46a;
  for (const [pu, pv, r, h] of [[-50, 15, 7, 5], [-28, 23, 6, 4], [40, 23, 6.5, 4.5]]) loose('pile', pu, pv, r * 1.1, r * 1.1, h * 0.9, SAND, { r, ph: h });
  const BAR = 0xd7d7d0;
  for (const [bu, bv, along] of [[-40, -13, 'x'], [-34, -8, 'z'], [-20, -17, 'x'], [-8, -9, 'x'], [4, -15, 'x'], [18, -7, 'x'],
    [-60, -3, 'z'], [50, 1, 'z'], [-10, 5, 'x'], [24, 11, 'x'], [-2, 26, 'x'], [-70, 22, 'z']] as [number, number, string][]) {
    const [w, d] = along === 'x' ? [4, 0.8] : [0.8, 4];
    loose('barrier', bu, bv, w, d, 1.4, BAR);
  }
  for (const [pu, pv] of [[-66, -25], [-62, -25], [14, -27], [18, -27], [-4, 27], [60, 29]]) loose('pallet', pu, pv, 1.6, 1.6, 1.2, 0xa0442c);

  return { origin: [cx, cz], area: { x0, x1, z0, z1 }, solids, crane: CRANE, rot, out, gates, house: gH, yard: gY, dropped };
}
