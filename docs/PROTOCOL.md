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

**Teams** (issue #24). Every player and every bot is in team A (`team` 0) or B (1). Teammates do not hurt each
other, and the server keeps the team game (the scores, the zones, the supply depots, the rounds; see *The team
game* below), whose rules and places are `client/shared/rules.ts`, the same file in the page and on the server.

**Time.** The server's clock counts milliseconds since the server started. Every snapshot carries it
(`ts`), and so does every row in it: the moment that row shows. The browser draws everything a fixed
delay behind its estimate of that clock (`INTERP`, 150 ms; the pedestrians 200 ms), between the two
rows around that moment, the snapshot interpolation of most network games. A player's own rows get
the moment their browser took them (`ct` in `st`), moved onto the server's clock by the smallest
arrival delay seen from that player, so the pace of their tank survives the network and the tick.

## Client → server

| `t` | Fields | When |
| --- | --- | --- |
| `hello` | `name`, `color`, `key`, `team` | First message. `name`: up to 16 characters. `color`: one of the palette (`COLORS` in `server/server.js`, `TANK_COLORS` in the client), anything else gets a free colour. `key`: 16–64 characters `[A-Za-z0-9_-]`, random per page load, lets a reconnect take the player over and keep the score. `team` (issue #24): `0`, `1` or `'auto'` (also when left out); the server may put the player into the other team (see *The team game*), `welcome` says which. |
| `st` | `ct`, `x`, `z`, `h`, `v`, `r`, `s`, `c[]`, `k`, `y`, `p`, `a[]` | 20× a second while playing. `ct`: the moment, on the browser's own clock (ms). `v`: speed (a tank up to 40, a plane up to 90, a ship up to 15, negative astern), `r`: roll (a destroyed tank lies on its side, a plane banks, a ship heels and lists), `s`: `1` while immune after a (re)spawn, `2` while destroyed. `c` (a tank, only while there are any): the cars this tank pushes, as `[i, x, z, heading, speed, released]`, at most 8 (they take turns); `i` is a car of the traffic (0 … `N_CARS` − 1, `N_CARS` in `server/world.js`) or `N_CARS + k` for the client's parked car `k`; `released: 1` the last time, when it has come to rest. A plane adds `k: 1`, its height `y` (0–400) and pitch `p`. A ship (issue #20) adds `k: 2`, `y` its heave and, once destroyed, how deep it has sunk (0 afloat, down to −12, relative to `WATER_Y`), its pitch `p` and `a: [fore, aft]`, the yaw of its two turrets against the hull (radians, the aft one 0 or π at rest); its row counts only on the river, at most 2 over a bank (`bankDist` in `client/shared/naval.ts`). |
| `fire` | `sid`, `x`, `y`, `z`, `vx`, `vy`, `vz`, `rt`, `k` | A parcel left the muzzle (or a plane dropped it), with `k: 1` a bullet left a gun, with `k: 2` a ship's shell left a turret (at most 125 fast), with `k: 3` a ship launched a torpedo (on the water: `y` at `WATER_Y`, `vy` 0, at most 25 fast). Only a player whose row is a ship may fire shells and torpedoes. `sid`: the player's own running number of what they fire. `rt` (parcels and shells): the moment of the city the browser showed when firing (server clock); a bot is hit where it was then. |
| `hit` | `by`, `sid`, `kill` | A parcel, shell, torpedo or bullet of player `by` hit **my** tank, plane or ship and the hit took effect (not while destroyed or immune). `kill`: it destroyed the vehicle. |
| `shot` | `v`, `sid` | My bullet `sid` hit player or bot `v` on my screen (only bullets; see below). Counts within 400 units of `v`, and only on the other team. |
| `thit` | `i`, `k`, `x`, `y`, `z`, `sid` | Issue #24: my projectile `sid` of kind `k` (`0` a parcel, `1` a bullet, `2` a shell) hit supply depot `i` (an index into `DEPOTS` in `client/shared/rules.ts`) at `x`, `y`, `z`: a parcel or a shell where it came down (burst, or first touched the ground) within `r + DEPOT_NEAR` of the depot's middle and no higher than its top, a bullet where it entered it (rules.ts `depotAt` says so). Send it only for the other team's depots. The server accepts it once per projectile, only for one this player fired with that kind and while it can still score, only from a living player of the other team within 120 (a parcel) or 400 (a bullet, a shell) of the point, and only where the depot is (give or take 1.5), then applies the damage. Nothing comes back but the next `obj`. |
| `ping` | `c` | Every 2 s, for the ping in the performance readout. `c`: any number, the client's clock. |
| `ped` | `i`, `vx`, `vz` | My tank or my own parcel hit pedestrian `i`, pushing it along `vx`, `vz`. Counts only for a pedestrian within 80 units of my tank. |
| `prop` | `i`, `fx`, `fz` | My tank knocked down prop `i` (a tree or a lamp, by its index in the client's list), falling towards `fx`, `fz`. |

## Server → client

| `t` | Fields | Meaning |
| --- | --- | --- |
| `welcome` | `id`, `name`, `color`, `pts`, `team`, `players[]`, `props[]`, `game` | You are in, in team `team` (issue #24). `players`: everyone else, as `{id, name, color, pts, bot, team}`. `props`: the trees and lamps down right now, as `[i, fx, fz]`. `game`: the team game's state now, as in `obj` (without `t`). |
| `err` | `code` | `name_invalid`, `name_taken`, `name_reserved` (BOT1, BOT2, … belong to the bots) or `full`. The socket closes after it. |
| `join` | `p` | Someone (a player or a bot) came in, as in `players[]` (with `team`). |
| `team` | `id`, `team` | Issue #24: player `id` is in team `team` from now on (the teams evened out at a new round); also sent to that player. |
| `obj` | `ts`, `sc[]`, `z[]`, `d[]`, `r` | Issue #24: the team game, once a second and at once (within 0.2 s) when something changed: `sc` the team scores `[A, B]`; `z` the zones (rules.ts `ZONES`: the three ground zones, then the river zone) as `[owner, progress]`, owner `-1` nobody, `0` A, `1` B, progress −100 (B) … 100 (A), whole numbers; `d` the supply depots (rules.ts `DEPOTS`: 4 of A, then 4 of B) as `[hp, upAt]`, `hp` 0 … 6 (destroyed at 0), `upAt` the moment it is rebuilt on the server's clock (as `ts`), 0 while it stands; `r` the round: `{st, left, win, to, best?}`, `st` `'play'` or `'end'` (the intermission), `left` its seconds left, `win` `-1` (none yet, or a draw) or the winning team once it has ended, `to` the points that win a round, `best` after a round the best players as `[[id, pts], …]` (up to three, people and bots). |
| `pts` | `id`, `pts`, `gain` | Issue #24: player or bot `id` scored `gain` points outside the hits and now has `pts`: `CAP_PTS` (rules.ts) for every vehicle of the team inside a zone when the team takes it (they count for the team too), or `DEPOT_PTS` for destroying a depot (the team already has them through `obj`). |
| `leave` | `id` | Someone left. |
| `snap` | `ts`, `n`, `p[]`, `c[]`, `m`, `k[]`, `q[]` | 20× a second. `ts`: the server's clock, `n`: the tick (the same snapshot has the same `n` for everyone). `p`: every tank as `[id, x, z, h, v, r, s, t]`, `t` the moment of the row; a plane as `[id, x, z, h, v, r, s, t, 1, y, p]`; a ship as `[id, x, z, h, v, r, s, t, 2, y, p, fore, aft]`. `c`: the `N_CARS` cars of the traffic as `x, z, heading, speed` (flat, in the client's car order) at `ts`; `m`: the tram's place along its track. `k`: the cars players push, as `[i, owner, t, x, z, heading, speed]` (`t`: the moment of the owner's report, drawn in step with the owner's tank). `q`: parked cars pushed away from their spot and left there, as `[i, x, z, heading]`; a parked car not in `k` or `q` is on its spot. |
| `fire` | `id`, `sid`, `x`, `y`, `z`, `vx`, `vy`, `vz`, `k` | Someone else's parcel, or with `k: 1` a bullet, `k: 2` a shell, `k: 3` a torpedo: fly it in your world. |
| `hit` | `by`, `v`, `pts`, `gain`, `kill` | `by` scored `gain` points by hitting `v` and now has `pts` (their own points; the team's come in `obj`). `kill`: the hit destroyed `v`. |
| `dmg` | `by`, `sid` | A bullet of `by` hit you on the shooter's screen: apply it and, if it took effect, answer with `hit` as for a parcel. |
| `pong` | `c` | The answer to `ping`, with the same `c`, straight away. |
| `w` | `ts`, `n`, `p[]` | 10× a second, with every other `snap`: the pedestrians (`PED_N` in `server/world.js`) as `x, z, heading, tilt, fall direction` (flat; tilt > 0 while knocked over). |
| `prop` | `i`, `fx`, `fz` or `i`, `up` | Another player knocked prop `i` down; or, with `up: 1`, it stands again (90 s later). |

## Who decides a hit

What a hit is worth is its share of what destroys the vehicle: the hits within 8 s that add up to three
parcels' worth destroy it. A parcel weighs 1 against a tank and 3 against a plane, a bullet 0.25 and 0.5
(`HIT_W`, in `server/game.js` and `client/src/game/tank.ts`). A person scores 10 points per unit of that:
10 a parcel and 3 a bullet in a tank, 30 and 5 in a plane. Issue #24: a bot (a tank, a plane or a ship, by its
row) is worth half of that, rounded, at least 1 (5 a parcel in a bot's tank, 2 a bullet). A hit on a teammate
does nothing and scores nothing (the victim's browser ignores it, the server never scores it), and nothing
scores in the intermission between two rounds; every point counts for the scorer's team too.

Issue #20: a ship's shell weighs a parcel against a tank (10 points) and a plane (30; the planes are too fast
for the shells, so it is rare). A ship lasts longer: its hits add up over 20 s (a tank's and a plane's over 8),
and a shell weighs 0.35 against it (4 points), a torpedo 1.5 (15), a parcel 0.75 (8), a bullet 0.08 (1); two
ships that collide faster than 5 units a second each take a ram of 0.5, which scores for nobody. A torpedo
hits ships only. A hit scores only while what made it can still fly: a parcel 15 s after it was fired, a
bullet 3 s, a shell 10 s, a torpedo 20 s (it runs 16).

- **A parcel in a player's tank or plane:** the player it hit. That client flies everyone's parcels in its own world, and
  there its own tank is exactly where it is. It sends `hit`; the server checks that `by` really fired
  that `sid` in the last 15 s and that the parcel has not scored yet, then awards 10 points.
- **A shell or a torpedo in a player's ship or tank (issue #20):** the player it hit, as for a parcel (both are slow). Every
  client flies everyone's shells and torpedoes; elsewhere a shell only bursts where it lands (a column of water on the river).
- **A pedestrian:** the server, which moves them; the client whose tank or parcel hit one reports it (`ped`)
  and lets them fall on its own screen at once. Other players' parcels pass by pedestrians without
  knocking them on your screen.
- **A parcel, a shell or (issue #24) a torpedo in a bot:** the server, because the bot lives there. It flies the players'
  parcels, the ships' shells and torpedoes against the buildings and the ground (the same map as the browsers',
  `client/shared/map.ts` through `server/city.js`; a shell bursts on the ground or the river, a torpedo at a bank or a
  pier, `client/shared/naval.ts`) and against where each bot of the other team was at the moment the shooter saw (`rt`;
  200 ms ago without it, at most 400 ms), with the browsers' hit shapes (a tank's box, a plane's sphere, a ship's box),
  and awards the bot's points.
- **A person's bullet:** the shooter. Their browser tests its bullets against the others as drawn there, a
  little in the past; were the victim to decide, as for the slow parcels, a fast plane would be out of reach
  of any gun. The shooter sends `shot`; the server checks that the bullet was fired in the last 3 s and has
  not hit yet, applies it to a bot itself, or passes it to the person as `dmg`, who answers with `hit`.
- **A bot's parcel, bullet, shell or torpedo:** the player it hits, as for a parcel (they go out as `fire`, like a
  player's). Issue #24: what a bot fires at another bot (of the other team) or at a supply depot is flown and decided by
  the server (`server/shots.js`). A bot never aims at a teammate. A tank bot fires bursts at an enemy plane flying low and
  close to it (within 60 units, below 60), parcels at an enemy tank or ship within 50 units with a clear line, and at an
  enemy depot it passes in range; a plane bot fires bursts of bullets along its nose and drops parcels on depots; a ship
  bot fires salvos of shells, torpedoes and anti-aircraft bursts (`server/planebot.js`, `server/shipbot.js`).
- **A supply depot** (issue #24): the server. A player's browser reports where its parcel, shell or bullet hit one
  (`thit`), the server checks it and applies it; the bots' fire at depots is flown on the server.

## The team game (issue #24)

The rules, the places and the numbers are `client/shared/rules.ts`; the server's state machine is `server/game.js`.

- **Teams.** A joining player goes into the team asked for (`hello.team`), unless it already has 2 or more people
  than the other, then into the other; `'auto'` (and a player coming back with the same key, into their old team if
  it may) the team with fewer people (a tie: the one with fewer points, then A). Team A's home is the west half
  (x < 0), B's the east: each browser brings its player in on its team's side (rules.ts `TEAM_SPAWNS`,
  `TEAM_SHIP_SPAWNS`, `PLANE_SIDE_X`).
- **Bots** fill each team up to `TEAM_SIZE` members (env, default 6), people counted: a joining person replaces a
  bot of their team at once (a tank first), a leaving one gets a bot back. A team's bots fly a plane and sail a ship
  when none of its people does (by their rows), the rest drive tanks; a bot reconsiders its vehicle when it comes
  back. They use the players' row shapes (`k` 1 and 2), so a browser draws them as it draws players.
- **Zones.** Every living tank (the river zone: ship) of a team inside a zone moves its progress `CAP_RATE` (12) a
  second towards that team; at most `CAP_MAX` (3) of a team count, the two sides cancel out. A team owns the zone at
  ±100 and loses it when the progress crosses 0. Every full second an owned zone gives its team `ZONE_PTS` (1).
- **Supply depots.** `DEPOT_HP` (6); a parcel takes 2, a shell 1.5, a bullet 0.25 (`DEPOT_DMG`). Destroyed:
  `DEPOT_PTS` (30) for the team that destroyed it; it is rebuilt `DEPOT_BACK_S` (90 s) later. A team cannot damage its
  own.
- **Rounds.** A round ends when a team reaches `ROUND_PTS` (1000) or after `ROUND_S` (900 s), env `ROUND_POINTS` and
  `ROUND_SEC` override them (for tests): `obj.r.st` turns `'end'`, `win` says the winner (−1 a draw), `best` the best
  players. Then `INTER_S` (15 s) of intermission: the server passes no `fire` on and scores nothing. Then a new round:
  `r.st` turns `'play'` again, the team scores, everyone's points (`pts`, also the bots'), the zones (neutral, 0) and
  the depots (standing) start from nothing; the teams are evened out (while one has 2 or more people more than the
  other, its most recently joined person goes over: a `team` message), and the bots come back on their side. Every
  browser zeroes its scoreboard and brings its own vehicle back in its half when `r.st` turns from `'end'` to
  `'play'` (no other message says so).

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
- `MAX_PLAYERS` people (default 24); the bots come on top (up to `TEAM_SIZE` a team, issue #24).
- A socket that stops answering the server's pings is dropped within 30 s.
