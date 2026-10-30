# The World of DODO protocol

One WebSocket per player at `/ws`, JSON text messages, each an object with a type in `t`.
The server relays; it does not simulate the players. It does simulate the bots.

Coordinates are the game's world units (1 unit = 5 m): `x` east, `z` south, the city spans
about ±156, the world ends at ±250. A heading `h` is in radians, `0` faces +z, and the direction is
`(sin h, cos h)`. Speeds are units per second.

## Client → server

| `t` | Fields | When |
| --- | --- | --- |
| `hello` | `name`, `color`, `key` | First message. `name`: up to 16 characters. `color`: one of the palette (`COLORS` in `server/server.js`, `TANK_COLORS` in the client), anything else gets a free colour. `key`: 16–64 characters `[A-Za-z0-9_-]`, random per page load, lets a reconnect take the player over and keep the score. |
| `st` | `x`, `z`, `h`, `v`, `r`, `s` | About 15× a second while driving. `v`: speed, `r`: roll (a destroyed tank lies on its side), `s`: `1` while immune after a (re)spawn. |
| `fire` | `sid`, `x`, `y`, `z`, `vx`, `vy`, `vz` | A parcel left the muzzle. `sid`: the player's own running number of the parcel. |
| `hit` | `by`, `sid`, `kill` | A parcel of player `by` hit **my** tank and the hit took effect (not while destroyed or immune). `kill`: it was the third hit and destroyed the tank. |

## Server → client

| `t` | Fields | Meaning |
| --- | --- | --- |
| `welcome` | `id`, `name`, `color`, `pts`, `players[]` | You are in. `players`: everyone else, as `{id, name, color, pts, bot}`. |
| `err` | `code` | `name_invalid`, `name_taken`, `name_reserved` (BOT1, BOT2, … belong to the bots) or `full`. The socket closes after it. |
| `join` | `p` | Someone (a player or a bot) came in, as in `players[]`. |
| `leave` | `id` | Someone left. |
| `snap` | `p[]` | About 15× a second: every tank in the city as `[id, x, z, h, v, r, s]`. |
| `fire` | `id`, `sid`, `x`, `y`, `z`, `vx`, `vy`, `vz` | Someone else's parcel: fly it in your world. |
| `hit` | `by`, `v`, `pts`, `gain`, `kill` | `by` scored `gain` points by hitting `v` and now has `pts`. `kill`: the hit destroyed `v`. |

## Who decides a hit

- **A player's tank:** the player it hit. That client flies everyone's parcels in its own world, and
  there its own tank is exactly where it is. It sends `hit`; the server checks that `by` really fired
  that `sid` in the last 15 s and that the parcel has not scored yet, then awards 10 points.
- **A bot:** the server, because the bot lives there. It flies the players' parcels against the
  buildings (`server/city.js`) and against where each bot was 200 ms earlier (the shooter saw it late),
  and awards 1 point.

The clients are trusted: a modified client can report anything about its own tank. It is a game.

## Limits

- 1 KB per message, about 60 messages a second per socket (more are dropped).
- `MAX_PLAYERS` people (default 24); the bots come on top.
- A socket that stops answering the server's pings is dropped within 30 s.
