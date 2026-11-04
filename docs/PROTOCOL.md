# The World of DODO protocol

One WebSocket per player at `/ws`, JSON text messages, each an object with a type in `t`.
The server relays; it does not simulate the players. It does simulate the bots and the city.

Coordinates are the game's world units in the real Karlín (issue #16; `client/shared/map.ts`, its
frame in `client/shared/KARLIN-DATA.md`): 1 unit = 1.5 m, `x` east, `z` south, the map turned by 17° so
that Karlín's streets run along the axes, the origin near Karlínské náměstí. The tanks, the bots and the
cars stay in the **arena**, `x` −346.7…356, `z` −215…208 (`ARENA`); the planes fly within ±650 of the
origin (`AIR_LIM`) and are turned back up to 60 beyond it. A row or a parcel farther than 720 from the
origin on either axis (`WORLD` in `server/server.js`, `AIR_LIM + 70`) is ignored. A heading `h` is in
radians, `0` faces +z, and the direction is `(sin h, cos h)`; a plane's pitch `p` lifts it to
`(sin h cos p, sin p, cos h cos p)`. Heights `y` are absolute: the arena's streets are at 0 (its
pavements 0.3), and outside the arena the terrain rises (Vítkov to about 60). Speeds are units per
second. The Vltava runs through the outer zone north of the arena (issue #20; `client/shared/naval.ts`):
its surface is at `WATER_Y`, −4.5.

A player drives a tank, flies a plane (issue #14) or sails a warship on the river (issue #20), and may
switch between them; the state rows say which (`k`).

**Time.** The server's clock counts milliseconds since the server started. Every snapshot carries it
(`ts`), and so does every row in it: the moment that row shows. The browser draws everything a fixed
delay behind its estimate of that clock (`INTERP`, 150 ms; the pedestrians 200 ms), between the two
rows around that moment, the snapshot interpolation of most network games. A player's own rows get
the moment their browser took them (`ct` in `st`), moved onto the server's clock by the smallest
arrival delay seen from that player, so the pace of their tank survives the network and the tick.

## Client → server

| `t` | Fields | When |
| --- | --- | --- |
| `hello` | `name`, `color`, `key` | First message. `name`: up to 16 characters. `color`: one of the palette (`COLORS` in `server/server.js`, `TANK_COLORS` in the client), anything else gets a free colour. `key`: 16–64 characters `[A-Za-z0-9_-]`, random per page load, lets a reconnect take the player over and keep the score. |
| `st` | `ct`, `x`, `z`, `h`, `v`, `r`, `s`, `c[]`, `k`, `y`, `p`, `a[]` | 20× a second while playing. `ct`: the moment, on the browser's own clock (ms). `v`: speed (a tank up to 40, a plane up to 90, a ship up to 15, negative astern), `r`: roll (a destroyed tank lies on its side, a plane banks, a ship heels and lists), `s`: `1` while immune after a (re)spawn, `2` while destroyed. `c` (a tank, only while there are any): the cars this tank pushes, as `[i, x, z, heading, speed, released]`, at most 8 (they take turns); `i` is a car of the traffic (0 … `N_CARS` − 1, `N_CARS` in `server/world.js`) or `N_CARS + k` for the client's parked car `k`; `released: 1` the last time, when it has come to rest. A plane adds `k: 1`, its height `y` (0–400) and pitch `p`. A ship (issue #20) adds `k: 2`, `y` its heave and, once destroyed, how deep it has sunk (0 afloat, down to −12, relative to `WATER_Y`), its pitch `p` and `a: [fore, aft]`, the yaw of its two turrets against the hull (radians, the aft one 0 or π at rest); its row counts only on the river, at most 2 over a bank (`bankDist` in `client/shared/naval.ts`). |
| `fire` | `sid`, `x`, `y`, `z`, `vx`, `vy`, `vz`, `rt`, `k` | A parcel left the muzzle (or a plane dropped it), with `k: 1` a bullet left a gun, with `k: 2` a ship's shell left a turret (at most 125 fast), with `k: 3` a ship launched a torpedo (on the water: `y` at `WATER_Y`, `vy` 0, at most 25 fast). Only a player whose row is a ship may fire shells and torpedoes. `sid`: the player's own running number of what they fire. `rt` (parcels and shells): the moment of the city the browser showed when firing (server clock); a bot is hit where it was then. |
| `hit` | `by`, `sid`, `kill` | A parcel, shell, torpedo or bullet of player `by` hit **my** tank, plane or ship and the hit took effect (not while destroyed or immune). `kill`: it destroyed the vehicle. |
| `shot` | `v`, `sid` | My bullet `sid` hit player or bot `v` on my screen (only bullets; see below). Counts within 400 units of `v`. |
| `ping` | `c` | Every 2 s, for the ping in the performance readout. `c`: any number, the client's clock. |
| `ped` | `i`, `vx`, `vz` | My tank or my own parcel hit pedestrian `i`, pushing it along `vx`, `vz`. Counts only for a pedestrian within 80 units of my tank. |
| `prop` | `i`, `fx`, `fz` | My tank knocked down prop `i` (a tree or a lamp, by its index in the client's list), falling towards `fx`, `fz`. |

## Server → client

| `t` | Fields | Meaning |
| --- | --- | --- |
| `welcome` | `id`, `name`, `color`, `pts`, `players[]`, `props[]` | You are in. `players`: everyone else, as `{id, name, color, pts, bot}`. `props`: the trees and lamps down right now, as `[i, fx, fz]`. |
| `err` | `code` | `name_invalid`, `name_taken`, `name_reserved` (BOT1, BOT2, … belong to the bots) or `full`. The socket closes after it. |
| `join` | `p` | Someone (a player or a bot) came in, as in `players[]`. |
| `leave` | `id` | Someone left. |
| `snap` | `ts`, `n`, `p[]`, `c[]`, `m`, `k[]`, `q[]` | 20× a second. `ts`: the server's clock, `n`: the tick (the same snapshot has the same `n` for everyone). `p`: every tank as `[id, x, z, h, v, r, s, t]`, `t` the moment of the row; a plane as `[id, x, z, h, v, r, s, t, 1, y, p]`; a ship as `[id, x, z, h, v, r, s, t, 2, y, p, fore, aft]`. `c`: the `N_CARS` cars of the traffic as `x, z, heading, speed` (flat, in the client's car order) at `ts`; `m`: the tram's place along its track. `k`: the cars players push, as `[i, owner, t, x, z, heading, speed]` (`t`: the moment of the owner's report, drawn in step with the owner's tank). `q`: parked cars pushed away from their spot and left there, as `[i, x, z, heading]`; a parked car not in `k` or `q` is on its spot. |
| `fire` | `id`, `sid`, `x`, `y`, `z`, `vx`, `vy`, `vz`, `k` | Someone else's parcel, or with `k: 1` a bullet, `k: 2` a shell, `k: 3` a torpedo: fly it in your world. |
| `hit` | `by`, `v`, `pts`, `gain`, `kill` | `by` scored `gain` points by hitting `v` and now has `pts`. `kill`: the hit destroyed `v`. `gain` can be 0 (a bullet in a bot that did not destroy it). |
| `dmg` | `by`, `sid` | A bullet of `by` hit you on the shooter's screen: apply it and, if it took effect, answer with `hit` as for a parcel. |
| `pong` | `c` | The answer to `ping`, with the same `c`, straight away. |
| `w` | `ts`, `n`, `p[]` | 10× a second, with every other `snap`: the pedestrians (`PED_N` in `server/world.js`) as `x, z, heading, tilt, fall direction` (flat; tilt > 0 while knocked over). |
| `prop` | `i`, `fx`, `fz` or `i`, `up` | Another player knocked prop `i` down; or, with `up: 1`, it stands again (90 s later). |

## Who decides a hit

What a hit is worth is its share of what destroys the vehicle: the hits within 8 s that add up to three
parcels' worth destroy it. A parcel weighs 1 against a tank and 3 against a plane, a bullet 0.25 and 0.5
(`HIT_W`, in `server/server.js` and `client/src/game/tank.ts`). A person scores 10 points per unit of that:
10 a parcel and 3 a bullet in a tank, 30 and 5 in a plane. A bot (always a tank) is worth 1 point a parcel,
and 1 for the bullet that destroys it.

Issue #20: a ship's shell weighs a parcel against a tank (10 points) and a plane (30; the planes are too fast
for the shells, so it is rare). A ship lasts longer: its hits add up over 20 s (a tank's and a plane's over 8),
and a shell weighs 0.35 against it (4 points), a torpedo 1.5 (15), a parcel 0.75 (8), a bullet 0.08 (1); two
ships that collide faster than 5 units a second each take a ram of 0.5, which scores for nobody. A torpedo
hits ships only. A shell in a bot is worth 1 point, as a parcel. A hit scores only while what made it can
still fly: a parcel 15 s after it was fired, a bullet 3 s, a shell 10 s, a torpedo 20 s (it runs 16).

- **A parcel in a player's tank or plane:** the player it hit. That client flies everyone's parcels in its own world, and
  there its own tank is exactly where it is. It sends `hit`; the server checks that `by` really fired
  that `sid` in the last 15 s and that the parcel has not scored yet, then awards 10 points.
- **A shell or a torpedo in a player's ship or tank (issue #20):** the player it hit, as for a parcel (both are slow). Every
  client flies everyone's shells and torpedoes; elsewhere a shell only bursts where it lands (a column of water on the river).
- **A pedestrian:** the server, which moves them; the client whose tank or parcel hit one reports it (`ped`)
  and lets them fall on its own screen at once. Other players' parcels pass by pedestrians without
  knocking them on your screen.
- **A parcel or a shell in a bot:** the server, because the bot lives there. It flies the players' parcels and the ships'
  shells against the buildings and the ground (the same map as the browsers', `client/shared/map.ts` through
  `server/city.js`; a shell bursts on the ground or the river, `client/shared/naval.ts`) and against where each bot was
  at the moment the shooter saw (`rt`; 200 ms ago without it, at most 400 ms), and awards 1 point.
- **A person's bullet:** the shooter. Their browser tests its bullets against the others as drawn there, a
  little in the past; were the victim to decide, as for the slow parcels, a fast plane would be out of reach
  of any gun. The shooter sends `shot`; the server checks that the bullet was fired in the last 3 s and has
  not hit yet, applies it to a bot itself, or passes it to the person as `dmg`, who answers with `hit`.
- **A bot's bullet:** the player it hits, as for a parcel. A bot fires bursts at a plane flying low and
  close to it (within 60 units, below 60), aiming where the server has the plane. A bot fires parcels at a
  tank or a ship within 50 units with a clear line.

## Who moves a car

The server drives the traffic and stops it for every tank. A car a tank (or a pushed car, or the
player's own parcel) runs into becomes that player's, as in the authority schemes of networked physics
games: their browser moves it with the game's body physics and reports it in `st.c`; the server stops
driving it, passes it on in `snap.k` and refuses it to anyone else until the owner lets go
(`released: 1`) or has not reported it for 1.5 s. A claim counts only for a car within 30 units of the
claimer's tank and within 25 of where the server has it (issue #16: a parked car nobody has moved
stands on its spot, `PARK` in `client/shared/traffic.ts`, which the server knows too), and only inside
the arena give or take 20. A released car of the traffic glides back into
the nearest lane; a parked car stays where it was left, and 30 s later, once no tank is within 60
units, it is back on its spot. A player who leaves lets go of everything.

The clients are trusted: a modified client can report anything about its own tank. It is a game.

## Limits

- 1 KB per message, about 90 messages a second per socket (more are dropped).
- Positions (`st`) and parcels or bullets (`fire`) beyond `WORLD` (720 units) from the origin are ignored. A ship's
  position off the river (more than 2 units over a bank) is ignored too.
- `MAX_PLAYERS` people (default 24); the bots come on top.
- A socket that stops answering the server's pings is dropped within 30 s.
