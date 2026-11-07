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

**Velemlok** (issue #26). Once in a while a giant salamander comes up in the Vltava and both teams fight it for a bonus; the server
decides everything about it (see *Velemlok* below), its numbers, hitbox and attacks are `client/shared/monster.ts`.

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
| `mhit` | `k`, `sid`, `x`, `y`, `z` | Issue #26: my projectile `sid` of kind `k` (`0` a parcel, `1` a bullet, `2` a shell, `3` a torpedo) hit Velemlok at `x`, `y`, `z`: a parcel, a shell or a torpedo where it touched its hitbox (monster.ts `monSphHit`), a bullet where its segment entered it (`monSphSegT`). The projectile stops there (do not send `hit` or `thit` for it). The server accepts it once per projectile, only for one this player fired with that kind and while it can still score, only while Velemlok is out (`obj.g.st` 1 or 2) and the round is on, only from a living player within 120 (a parcel) or 400 (a bullet, a shell, a torpedo) of the point, and only where its hitbox was in the last 0.6 s (give or take 3). Both teams may hit it. Nothing comes back but the next `obj` (`g.dmg`, at once). |
| `ping` | `c` | Every 2 s, for the ping in the performance readout. `c`: any number, the client's clock. |
| `ped` | `i`, `vx`, `vz` | My tank or my own parcel hit pedestrian `i`, pushing it along `vx`, `vz`. Counts only for a pedestrian within 80 units of my tank. |
| `prop` | `i`, `fx`, `fz` | My tank knocked down prop `i` (a tree or a lamp, by its index in the client's list), falling towards `fx`, `fz`. |

## Server → client

| `t` | Fields | Meaning |
| --- | --- | --- |
| `welcome` | `id`, `name`, `color`, `pts`, `team`, `players[]`, `props[]`, `game` | You are in, in team `team` (issue #24). `players`: everyone else, as `{id, name, color, pts, bot, team}`. `props`: the trees and lamps down right now, as `[i, fx, fz]`. `game`: the team game's state now, as in `obj` (without `t`; with Velemlok's `g`). |
| `err` | `code` | `name_invalid`, `name_taken`, `name_reserved` (BOT1, BOT2, … belong to the bots) or `full`. The socket closes after it. |
| `join` | `p` | Someone (a player or a bot) came in, as in `players[]` (with `team`). |
| `team` | `id`, `team` | Issue #24: player `id` is in team `team` from now on (the teams evened out at a new round); also sent to that player. |
| `obj` | `ts`, `sc[]`, `z[]`, `d[]`, `r` | Issue #24: the team game, once a second and at once (within 0.2 s) when something changed: `sc` the team scores `[A, B]`; `z` the zones (rules.ts `ZONES`: the three ground zones, then the river zone) as `[owner, progress]`, owner `-1` nobody, `0` A, `1` B, progress −100 (B) … 100 (A), whole numbers; `d` the supply depots (rules.ts `DEPOTS`: 4 of A, then 4 of B) as `[hp, upAt]`, `hp` 0 … 6 (destroyed at 0), `upAt` the moment it is rebuilt on the server's clock (as `ts`), 0 while it stands; `r` the round: `{st, left, win, to, best?}`, `st` `'play'` or `'end'` (the intermission), `left` its seconds left, `win` `-1` (none yet, or a draw) or the winning team once it has ended, `to` the points that win a round, `best` after a round the best players as `[[id, pts], …]` (up to three, people and bots). Issue #26: `g` Velemlok, always: `{st, hp, max, dmg, next}`, `st` `0` away, `1` surfacing, `2` out, `3` leaving; `hp` its hit points (whole, rounded up) of `max`; `dmg` the damage each team has dealt it in this appearance `[A, B]` (whole); `next` a moment on the server's clock (as `ts`): while away, when it comes next (in the intermission: the next round's start plus `MON_FIRST_S`), while surfacing or out, when it leaves, while leaving, when it is gone. Its state and damage changing send `obj` at once. |
| `pts` | `id`, `pts`, `gain` | Issue #24: player or bot `id` scored `gain` points outside the hits and now has `pts`: `CAP_PTS` (rules.ts) for every vehicle of the team inside a zone when the team takes it (they count for the team too), or `DEPOT_PTS` for destroying a depot (the team already has them through `obj`); issue #26: or its share of a fight with Velemlok, `round(damage / MON_PTS_PER)`, right after `mres` (personal only). |
| `mon` | `a`, `i`, `v`, `x`, `y`, `z`, `r`, `at` (a jet also `t0`, `sx`, `sy`, `sz`, `vx`, `vy`, `vz`) | Issue #26: an attack of Velemlok, announced before it lands. `a`: `'slam'` (its tail on a ship: a ring of water), `'jet'` (a heavy arc of water at a tank or a ship) or `'geyser'` (a column of water under a plane); `i` its number, `v` the vehicle it was aimed at; it lands at `x`, `z` (`y`: the surface there, a geyser's base) with radius `r` at the moment `at` (the server's clock). A slam is announced `MON_SLAM_WARN` before it lands (the tail rises), a geyser `MON_GEY_WARN` (a warning ring on the water); a jet leaves its mouth at `sx`, `sy`, `sz` at `t0` (`MON_JET_WIND` after the announcement: it rears up) with velocity `vx`, `vy`, `vz`, falls at `MON_JET_G` and lands at `at` (monster.ts `monJetAt`). At `at` every browser applies it to its own vehicle when `monAtkHits` (monster.ts) says it is in it, whoever it was aimed at, both teams, as a hit of kind `mon` (`HIT_W`), and answers nothing: it scores for nobody. The server applies it to the bots. |
| `mres` | `killed`, `dmg`, `win`, `pts`, `top`, `end` | Issue #26: Velemlok leaves: `killed` (its hit points ran out: it rolls over and sinks) or it fled (`MON_LIFE_S` after it surfaced: it dives). `dmg` the damage of A and B `[A, B]` (whole), `win` the team that dealt more (`-1` a tie), `pts` the bonus that team got (`MON_KILL_PTS` or `MON_FLEE_PTS`, already in its score; 0 on a tie), `top` the three who dealt the most as `[[id, dmg], …]` (people and bots). `end: 1`: the end of the round sent it away (it dives): no bonus, no personal points (`win` −1, `pts` 0). Then the personal points come as `pts`. |
| `leave` | `id` | Someone left. |
| `snap` | `ts`, `n`, `p[]`, `c[]`, `m`, `k[]`, `q[]`, `g` | 20× a second. `ts`: the server's clock, `n`: the tick (the same snapshot has the same `n` for everyone). `p`: every tank as `[id, x, z, h, v, r, s, t]`, `t` the moment of the row; a plane as `[id, x, z, h, v, r, s, t, 1, y, p]`; a ship as `[id, x, z, h, v, r, s, t, 2, y, p, fore, aft]`. `c`: the `N_CARS` cars of the traffic as `x, z, heading, speed` (flat, in the client's car order) at `ts`; `m`: the tram's place along its track. `k`: the cars players push, as `[i, owner, t, x, z, heading, speed]` (`t`: the moment of the owner's report, drawn in step with the owner's tank). `q`: parked cars pushed away from their spot and left there, as `[i, x, z, heading]`; a parked car not in `k` or `q` is on its spot. Issue #26: `g` Velemlok's pose at `ts` while it is there (`st` 1, 2 or 3; absent while away) as `[x, z, h, y, st, hp, rear]`: `x`, `z` the middle of its body, `h` its heading (the head points that way), `y` how far it is under its swimming height (0 out, down to `MON_DEEP` while surfacing, diving or sinking), `st` as `obj.g.st`, `hp` its hit points (`st` 3 with `hp` 0: it was killed, it rolls over and sinks), `rear` 0…1 how far it rears up (for a jet or a geyser). Its hitbox at that pose is monster.ts `monSpheres`. |
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
- **Velemlok** (issue #26): the server, as for a depot. A player's browser reports where its projectile hit it (`mhit`), the
  server checks it against the poses it sent and counts it; the bots' fire at it is flown on the server, and everything the
  server flies stops on it. **Its attacks:** the victim, as for a parcel: the server announces each (`mon`), every browser
  applies it to its own vehicle when it lands, the server to the bots. They weigh `MON_HIT_W` (kind `mon` of `HIT_W`: a tank
  1.5, a plane 3, a ship 0.9) and score for nobody.

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

## Velemlok (issue #26)

The numbers, its hitbox and what its attacks hit are `client/shared/monster.ts`; its state machine and its mind are
`server/monster.js`.

- **When.** `MON_FIRST_S` (300 s) after a round starts, then `MON_EVERY_S` (360 s) after it has gone; never in the intermission:
  the end of a round sends it away (an `mres` with `end: 1`, nothing for anyone), and it comes `MON_FIRST_S` after the next round
  starts. `obj.g.next` always says the next moment, the same for everyone (the ships' HUD counts down to it). Env `MON_FIRST_S`,
  `MON_EVERY_S`, `MON_LIFE_S` and `MON_HP` override the numbers (for tests).
- **Where.** It surfaces (`MON_SURF_S`, `st` 1) at a random spot of the Vltava's main channel along Karlín (on the water at least
  30 from every bank and pier, at least 150 from every ship) and swims on the water only, at most `MON_V` (6) a second, the banks
  and the bridge piers stopping it (it goes under the bridges). About 60 long, its back some 5 over the water; it rears up to
  about 22 for a jet or a geyser.
- **Its hit points** `MON_HP` (900). A parcel takes 9, a shell 7, a torpedo 30, a bullet 0.6 (`MON_DMG`), whoever fired it; the
  server keeps the damage per team and per player or bot.
- **It defends itself.** It keeps a threat table: every vehicle's damage in the last `MON_THREAT_S` (20 s). Every `MON_ATK_S`
  (3.5 s; `MON_RAGE_ATK_S`, 2.2 s, below half its hit points) it attacks the top threat in reach, else the nearest vehicle in
  reach (people and bots of both teams, not one destroyed or immune); meanwhile it swims towards the top threat, or wanders along
  the river when nobody has hurt it lately. It stands still while it winds an attack up. Reach is measured from its body
  (monster.ts `monDist`): a **tail slam** on a ship within `MON_SLAM_REACH` (30; a ring of radius 14 where the ship will be, 1 s
  later), a **water jet** at a tank or a ship within `MON_JET_REACH` (120; it rears up for 0.7 s, the water flies 0.7 to 2 s and
  splashes 6 round where the vehicle will be), a **geyser** under a plane within `MON_GEY_REACH` (90) horizontally and lower than
  `MON_GEY_BELOW` (70) whose geyser would come up from the river (radius 8, up to `MON_GEY_TOP`, 80, 0.8 s after the warning).
- **It leaves** when its hit points run out (it rolls over and sinks, `MON_SINK_S`) or `MON_LIFE_S` (180 s) after it began to
  surface (it dives, `MON_DIVE_S`): `mres`. The team that dealt more damage gets `MON_KILL_PTS` (150) if it was killed,
  `MON_FLEE_PTS` (60) if it fled (a tie: nobody); every player and bot that hurt it gets `round(damage / MON_PTS_PER)` (6)
  personal points (`pts`; not for the team).
- **The bots fight it** while it is out: the ship bots hunt it within 650 (they sail round it at 70 to 110, in reach of its jets)
  and their turrets take it before anything else within 300, their torpedoes too; the plane bots go for it before the depots and
  the tanks (an enemy plane near still comes first): bombing runs on its back while they have parcels, else dives with their
  guns, keeping above its geysers' top near it otherwise, and noticing a geyser under them half of the time; the tank bots fire
  at it when it comes within a parcel's reach of the embankment (62) and no enemy is in range. A fight of the bots alone takes
  1.5 to 3 minutes, about two on average (the ship bots deal nearly all of the damage; `server/shipbot.js` `MON_TORP_SLOW`).

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
- After `welcome` a page may load for a while (issue #31: textures, shaders; seconds) before its first `st`. Until then the
  player is in (counted, `join` sent, its team's bot gone) but not in `snap.p`: no capture, no hits; snapshots, `obj` and the
  rest come as usual. A page that gives up closes its socket.
