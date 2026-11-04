# The World of DODO protocol

One WebSocket per player at `/ws`, JSON text messages, each an object with a type in `t`.
The server relays; it does not simulate the players. It does simulate the bots and the city.

Coordinates are the game's world units (1 unit = 5 m): `x` east, `z` south, the city spans
about ±156, the world ends at ±250. A heading `h` is in radians, `0` faces +z, and the direction is
`(sin h, cos h)`. Speeds are units per second.

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
| `st` | `ct`, `x`, `z`, `h`, `v`, `r`, `s`, `c[]` | 20× a second while driving. `ct`: the moment, on the browser's own clock (ms). `v`: speed, `r`: roll (a destroyed tank lies on its side), `s`: `1` while immune after a (re)spawn. `c` (only while there are any): the cars this tank pushes, as `[i, x, z, heading, speed, released]`, at most 8 (they take turns); `i` is a car of the traffic (0–32) or `33 + k` for the client's parked car `k`; `released: 1` the last time, when it has come to rest. |
| `fire` | `sid`, `x`, `y`, `z`, `vx`, `vy`, `vz`, `rt` | A parcel left the muzzle. `sid`: the player's own running number of the parcel. `rt`: the moment of the city the browser showed when firing (server clock); a bot is hit where it was then. |
| `hit` | `by`, `sid`, `kill` | A parcel of player `by` hit **my** tank and the hit took effect (not while destroyed or immune). `kill`: it was the third hit and destroyed the tank. |
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
| `snap` | `ts`, `n`, `p[]`, `c[]`, `m`, `k[]`, `q[]` | 20× a second. `ts`: the server's clock, `n`: the tick (the same snapshot has the same `n` for everyone). `p`: every tank as `[id, x, z, h, v, r, s, t]`, `t` the moment of the row. `c`: the 33 cars as `x, z, heading, speed` (flat, in the client's car order) at `ts`; `m`: the tram's place along its track. `k`: the cars players push, as `[i, owner, t, x, z, heading, speed]` (`t`: the moment of the owner's report, drawn in step with the owner's tank). `q`: parked cars pushed away from their spot and left there, as `[i, x, z, heading]`; a parked car not in `k` or `q` is on its spot. |
| `fire` | `id`, `sid`, `x`, `y`, `z`, `vx`, `vy`, `vz` | Someone else's parcel: fly it in your world. |
| `hit` | `by`, `v`, `pts`, `gain`, `kill` | `by` scored `gain` points by hitting `v` and now has `pts`. `kill`: the hit destroyed `v`. |
| `pong` | `c` | The answer to `ping`, with the same `c`, straight away. |
| `w` | `ts`, `n`, `p[]` | 10× a second, with every other `snap`: the 50 pedestrians as `x, z, heading, tilt, fall direction` (flat; tilt > 0 while knocked over). |
| `prop` | `i`, `fx`, `fz` or `i`, `up` | Another player knocked prop `i` down; or, with `up: 1`, it stands again (90 s later). |

## Who decides a hit

- **A player's tank:** the player it hit. That client flies everyone's parcels in its own world, and
  there its own tank is exactly where it is. It sends `hit`; the server checks that `by` really fired
  that `sid` in the last 15 s and that the parcel has not scored yet, then awards 10 points.
- **A pedestrian:** the server, which moves them; the client whose tank or parcel hit one reports it (`ped`)
  and lets them fall on its own screen at once. Other players' parcels pass by pedestrians without
  knocking them on your screen.
- **A bot:** the server, because the bot lives there. It flies the players' parcels against the
  buildings (`server/city.js`) and against where each bot was at the moment the shooter saw (`rt`; 200 ms
  ago without it, at most 400 ms), and awards 1 point.

## Who moves a car

The server drives the traffic and stops it for every tank. A car a tank (or a pushed car, or the
player's own parcel) runs into becomes that player's, as in the authority schemes of networked physics
games: their browser moves it with the game's body physics and reports it in `st.c`; the server stops
driving it, passes it on in `snap.k` and refuses it to anyone else until the owner lets go
(`released: 1`) or has not reported it for 1.5 s. A claim counts only for a car within 30 units of the
claimer's tank and within 25 of where the server has it. A released car of the traffic glides back into
the nearest lane; a parked car stays where it was left, and 30 s later, once no tank is within 60
units, it is back on its spot. A player who leaves lets go of everything.

The clients are trusted: a modified client can report anything about its own tank. It is a game.

## Limits

- 1 KB per message, about 90 messages a second per socket (more are dropped).
- `MAX_PLAYERS` people (default 24); the bots come on top.
- A socket that stops answering the server's pings is dropped within 30 s.
