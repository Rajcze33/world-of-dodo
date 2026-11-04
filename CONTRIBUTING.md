# Contributing to World of DODO

Thanks for wanting to make it better. New weapons, smarter bots, a better scoreboard, bug fixes:
all welcome.

## Bugs and ideas: the issues

Everything that does not work and everything we want to add lives in the
[issues](https://github.com/Rajcze33/world-of-dodo/issues), one thing per issue: use the
**Chyba** (bug) or **Nápad** (idea) form. The labels say where it belongs (`hra` the game page,
`server`, `boti`, `město` the shared city, `staveniště` the construction site, `výkon` performance)
and what matters (`priorita`; `good first issue` for a first contribution). Before you start on
one, assign it to yourself or say so in a comment, so two people do not build the same thing.

## How

1. Pick an issue (or open one), fork the repository and create a branch.
2. Make the change and try it: `docker compose up --build -d`, then http://localhost:3400 in two
   windows (or `npm start` and port 3000).
3. Run the tests: `npm run check` and `npm run smoke` (against the running server). If you touched
   the game page, `npm run test:browser` is worth it too. `npm run dev` gives live reload while you
   work on the page (with `npm start` running for the WebSocket).
4. Open a pull request that says what changes for the player and why, with `Fixes #<issue>` in it:
   the issue then closes by itself when the pull request is merged.

A maintainer reviews and merges. There is no CI: what is merged to `main` is built and deployed by
Zerops right away, so run the checks before you ask for a merge.

## Things to know

- **The game is TypeScript modules on Babylon.js** (`client/src`, see README), built by Vite. Each
  module builds its meshes in a `build…()` function that `main.ts` calls in order; the top level of a
  module holds only constants and functions. Write like the code around you and explain the *why*
  in comments. Changes made for World of DODO (against the original Christmas game) are marked
  "World of DODO" in comments.
- **The 3D conventions** (`client/src/core/geo.ts`): the scene is right-handed, shapes are built as
  triangle lists that wind counter-clockwise from the front, and the shape helpers follow three.js
  (a cylinder stands on y, a plane faces +z). Use `lambert`/`basic` from `core/mat.ts` for materials,
  `Inst` for many copies of one shape, and the buckets (`BK`, `bake`) to merge static geometry into
  few draw calls.
- **The world is written once, in `client/shared`** (issue #16): the map of Karlín (`map.ts`: the
  solids and collisions, the ground, the street graph and routes, the spawn points, the kerb spots, the
  depot; `geom.ts` its geometry), the construction site (`site.ts`) and the city's life (the traffic,
  the tram and the pedestrians). Vite builds it into the page and the server `require()`s the very same
  files (`server/city.js`, `server/world.js`; Node 24 strips the types). So it may use only erasable
  TypeScript (no enums, no namespaces, no parameter properties), relative imports with the `.ts`
  extension, no browser API, and only `+ - * /` and `Math.sqrt` where a result decides something (the
  page and the server must derive the same city to the last bit; see the top of `geom.ts`).
- **The map data is generated**: `client/shared/karlin.json` comes from `tools/karlin` (OpenStreetMap,
  IPR Praha, ČÚZK). Never edit it by hand; change the generator and run it again
  ([tools/karlin/README.md](tools/karlin/README.md)). Places in Karlín are not numbers in the code:
  the game, the bots and the tests ask the map (`SPAWNS`, `DEPOT`, `SITE`, `DATA.landmarks`, ...).
- **What is random in the city comes from one seed** (`R` in `core/util.ts`): the order of the random
  calls decides which kerb spots get a parked car, which windows are lit and so on, and the server knows
  the trees and lamps by their index, registered in an order that follows from the data alone.
  Changing what draws from `R` (or the build order in `main.ts`) changes the city for everyone; that is
  fine, as long as the server and all players run the same version.
- **Some numbers still live twice** and must stay in step:
  - the tank colours: `COLORS` in `server/server.js` and `TANK_COLORS` in the client (same order);
  - tank size, parcel physics and the hit rules: the server mirrors the client (`TANK_L/W/H`, the parcel's
    gravity, bounce and ground in `server/shots.js`; `SLOW_T`, `DEAD_T`, the bot's wall circles
    `BOT_C`/`BOT_CR` in `server/bots.js` against `TANK_C`/`TANK_CR` in `client/src/game/tank.ts`);
  - what a hit weighs and scores (issue #14): `HIT_W` in `server/game.js` (issue #24: it moved there from
    server.js, the bots use it too) and in `client/src/game/tank.ts`; issue #20 added the ship as a victim
    and the shell and the torpedo as kinds (and the ship's 20 s window, `HIT_WIN` in tank.ts and
    `HIT_WIN_MS` in game.js, which the bots use; the server keeps no window for the players);
  - the ships (issue #20): a shell's gravity, `SHELL_G` in `client/src/game/shells.ts`, `server/shots.js`
    (which flies the shells at the bots) and `server/shipbot.js`; how long a hit can score, `SCORE_TTL_MS` in `server/server.js`,
    longer than a shell flies and a torpedo runs (`TORP_RUN` / `TORP_V` in shells.ts); the speed caps in
    `server/server.js` (`SHIP_V`, `SHELL_V_MAX`, `TORP_V_MAX`) above the ship's top speed (`V_MAX` in
    `client/src/game/ship.ts`), `SHELL_V` and `TORP_V`;
  - how far a plane may go: `WORLD` in `server/server.js` (`AIR_LIM + 70`) must stay above the plane's
    turn-back margin in `client/src/game/plane.ts` (`AIR_LIM + 60`);
  - the bots fly and sail the players' vehicles (issue #24): `server/planebot.js` copies the flight model of
    `client/src/game/plane.ts` (`V_STALL` … `BANK`, the guns' `GUN_RATE` and `GUN_CONV`, the parcels aboard
    `BOMBS`, `BOMB_RELOAD`, `BOMB_CD`, where a plane comes in `SPAWN_R/Y/V`; `AIR_TOP` from world/grid.ts,
    `BUL_V` and `PLANE_R` from game/bullets.ts, `SHOT_G` from game/shots.ts), `server/shipbot.js` the ship of
    `client/src/game/ship.ts` (`V_MAX` … `TURN_SLOW`, `SHIP_C`/`SHIP_CR`, `TURRETS`, `ARC` … `DISP`, the
    torpedoes' and the anti-aircraft guns' numbers; `SHELL_V`, `SHELL_G`, `TORP_V` from game/shells.ts,
    `SINK_T` from game/tank.ts), and `server/shots.js` the hit shapes (`shipBox` with `SHIP_HL/HW/HH` from
    game/shells.ts, `PLANE_R`, `TANK_R`, `SHIP_R` from game/bullets.ts). Change a vehicle, change its bot;
  - the team game's rules and places are written once, in `client/shared/rules.ts` (issue #24), and the
    server's defaults for `TEAM_SIZE`, `ROUND_POINTS` and `ROUND_SEC` come from there; how solid a standing
    supply depot is (a tank's circle `DEPOT_SOLID` · r, a plane crashes within r below its top) is in
    rules.ts too, but the collision code is twice: `client/src/world/objectives.ts` (`depotPush`, `depotBody`)
    for the players, `server/bots.js` (`depotPush`) and `server/planebot.js` (`crashed`) for the bots;
  - the shared city's counts and row sizes (cars, pedestrians) are also at the top of `tools/smoke.js`
    (`CITY`).
- **Protocol changes** go into [docs/PROTOCOL.md](docs/PROTOCOL.md) in the same pull request, and
  `tools/smoke.js` should test them.
- **The server only relays.** Keep the players' physics in the browser; the server should stay cheap
  enough to run on one small container.
- **Texts** are in `client/src/texts.ts`, Czech first (`CS`), English in `EN`. Add both.
- **No secrets and no personal data** in the repository, ever. The game stores nothing about players
  and should keep it that way.

## Be nice

Be kind in issues and reviews. It is a game; have fun with it.
