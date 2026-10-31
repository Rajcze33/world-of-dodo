// World of DODO: the construction site on the snow south of the city, as data. The page loads this file (it draws the site)
// and so does the server (server/city.js: the bots aim around it and its parcels hit it), so both know the same obstacles.
//
// Every solid is a box standing on the ground: x0..x1, z0..z1, height h (the same shape as the city's buildings in the game's
// SOLIDS), with a kind and a colour for drawing. A few kinds carry more for their looks: a sand pile its radius r (the box is the
// pile's solid core), pipes their axis. The crane is drawn by the page; only its mast's base is a solid here.
//
// To move the whole site, change ORIGIN: every coordinate below is relative to it (x east, z south, in world units).
(function (root) {
  'use strict';
  const ORIGIN = [0, 209];                 // the middle of the site: the city's outer ring road runs at z 156
  const W = 150, D = 35;                   // half width and half depth: x -150..150, z 174..244
  const solids = [], [ox, oz] = ORIGIN;
  // a box by its centre (x, z), size w × d and height h
  const box = (kind, x, z, w, d, h, color, more) => solids.push(Object.assign({ kind, x0: ox + x - w / 2, x1: ox + x + w / 2, z0: oz + z - d / 2, z1: oz + z + d / 2, h, color }, more));
  // a box by its corners
  const span = (kind, x0, z0, x1, z1, h, color) => solids.push({ kind, x0: ox + x0, x1: ox + x1, z0: oz + z0, z1: oz + z1, h, color });

  // the fence, with three gates in line with the city's north-south streets (x -104, 0, 104)
  const FENCE = 0x2e5e3a, FH = 2.2, gates = [[-111, -97], [-7, 7], [97, 111]];
  let x = -W;
  for (const [g0, g1] of gates) { span('fence', x, -D, g0, -D + 0.4, FH, FENCE); x = g1; }
  span('fence', x, -D, W, -D + 0.4, FH, FENCE);
  span('fence', -W - 0.4, -D, -W, D, FH, FENCE);
  span('fence', W, -D, W + 0.4, D, FH, FENCE);
  span('fence', -W, D, W, D + 0.4, FH, FENCE);

  // the half-built house in the west: ground-floor walls with openings, columns up to the second floor
  const CON = 0xa9a9a2, WH = 3.6;
  for (const [a, b] of [[-125, -112], [-106, -98], [-92, -85]]) span('wall', a, -23, b, -22.4, WH, CON);   // north wall, two openings
  span('wall', -125, 16.4, -85, 17, WH, CON);                                                         // south wall
  for (const [a, b] of [[-23, -7], [1, 17]]) span('wall', -125, a, -124.4, b, WH, CON);                 // west wall, one opening
  for (const [a, b] of [[-23, -11], [-3, 17]]) span('wall', -85.6, a, -85, b, WH, CON);                 // east wall, one opening
  span('wall', -110, -3.3, -100, -2.7, WH, CON);                                                      // a piece of an inner wall
  for (const cx of [-115, -105, -95]) for (const cz of [-13, -3, 7]) box('column', cx, cz, 0.8, 0.8, 8, CON);
  for (const [a, b] of [[-125, -117], [-93, -85]]) span('wall', a, 16.4, b, 17, 7.6, CON);              // the corners already one floor higher

  // containers in the east: alleys, some stacked two high (5.2)
  const C = { o: 0xd9622b, b: 0x2f6fb5, g: 0x3f8f4f, r: 0xb23a3a, w: 0xe6e6e0, s: 0x8a9290 };
  for (const [x0, z0, along, high, col] of [
    [72, -23, 'x', 0, C.o], [78.4, -23, 'x', 1, C.b], [92, -23, 'x', 0, C.g], [104, -23, 'x', 0, C.r],
    [72, -11, 'z', 0, C.w], [86, -9, 'x', 1, C.o], [100, -13, 'z', 0, C.b], [112, -3, 'x', 0, C.g],
    [124, -17, 'x', 1, C.r], [78, 5, 'x', 0, C.s], [96, 9, 'x', 1, C.g], [118, 13, 'x', 0, C.b],
    [132, 1, 'z', 0, C.o], [84, 21, 'x', 0, C.r], [106, 23, 'x', 0, C.w]]) {
    const [w, d] = along === 'x' ? [6, 2.4] : [2.4, 6];
    span('container', x0, z0, x0 + w, z0 + d, high ? 5.2 : 2.6, col);
  }
  span('office', 56, -31, 62, -28.6, 5.2, 0xf2f2ee);                                                  // the site manager's two cabins
  box('toilet', 52, -29.5, 1.2, 1.2, 2.3, 0x2f6fb5); box('toilet', 53.6, -29.5, 1.2, 1.2, 2.3, 0x2f6fb5);

  // the middle: sand piles, concrete pipes, jersey barriers, pallets, the machines, the crane's base
  const SAND = 0xc9a46a;
  for (const [cx, cz, r, h] of [[-50, 15, 7, 5], [-28, 23, 6, 4], [40, 23, 6.5, 4.5]]) box('pile', cx, cz, r * 1.1, r * 1.1, h * 0.9, SAND, { r, ph: h });
  span('pipes', 28, -19, 36, -15, 2.6, 0x9a9a94); solids[solids.length - 1].axis = 'x';
  const BAR = 0xd7d7d0;
  for (const [cx, cz, along] of [[-40, -13, 'x'], [-34, -8, 'z'], [-20, -17, 'x'], [-8, -9, 'x'], [4, -15, 'x'], [18, -7, 'x'],
    [-60, -3, 'z'], [50, 1, 'z'], [-10, 5, 'x'], [24, 11, 'x'], [-2, 26, 'x'], [-70, 22, 'z']]) {
    const [w, d] = along === 'x' ? [4, 0.8] : [0.8, 4];
    box('barrier', cx, cz, w, d, 1.4, BAR);
  }
  for (const [cx, cz] of [[-66, -25], [-62, -25], [14, -27], [18, -27], [-4, 27], [60, 29]]) box('pallet', cx, cz, 1.6, 1.6, 1.2, 0xa0442c);
  box('excavator', -38, 5, 3.2, 4.4, 3.4, 0xf2b705);
  box('dozer', 60, 11, 3, 4.5, 2.8, 0xf2b705);
  const CRANE = { x: ox + 10, z: oz + 3, h: 44, jib: 46, back: 14, color: 0xf2c400 };
  box('crane', 10, 3, 4, 4, CRANE.h, 0x8d8d86);
  // floodlight masts in the corners
  for (const [cx, cz] of [[-146, -31], [146, -31], [-146, 31], [146, 31]]) box('mast', cx, cz, 0.4, 0.4, 9, 0x3d4543);

  const SITE = {
    origin: ORIGIN,
    area: { x0: ox - W, x1: ox + W, z0: oz - D, z1: oz + D },   // the dirt ground; no trees grow here
    solids,
    crane: CRANE,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = SITE;
  else root.WOD_SITE = SITE;
})(this);
