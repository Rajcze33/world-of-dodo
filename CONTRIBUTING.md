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
- **The city is built from one seed** (`R` in `core/util.ts`): the order of the random calls decides
  where the trees, parked cars and lit windows are, and the server knows the trees and lamps by their
  index. Changing what draws from `R` (or the build order in `main.ts`) changes the city for everyone;
  that is fine, as long as the server and all players run the same version.
- **Some numbers live twice** and must stay in step:
  - the tank colours: `COLORS` in `server/server.js` and `TANK_COLORS` in the client (same order);
  - the city: `server/city.js` mirrors the street grid and the buildings of the client (the construction
    site is one file both load, `client/shared/site.js`: move or change it there);
  - tank size, parcel physics and the hit rules: `server/bots.js` mirrors the client;
  - the traffic, tram and pedestrian code: `server/world.js` is a port of the client's
    (`client/src/world/traffic.ts` and `peds.ts`, which still run it for the intro screen), and the
    client must keep 33 cars and 50 pedestrians in that order; the tram's track is three.js r128's
    curve on the server (`server/vendor`) and its exact port on the client (`client/src/world/catmull.ts`);
    `rejoin` (a pushed car back into the lane) lives in both too, and the parked cars are numbered
    after the cars (`33 + k`) in the client's order.
- **Protocol changes** go into [docs/PROTOCOL.md](docs/PROTOCOL.md) in the same pull request, and
  `tools/smoke.js` should test them.
- **The server only relays.** Keep the players' physics in the browser; the server should stay cheap
  enough to run on one small container.
- **Texts** are in the `T` object at the top of the game script, Czech first, English in the
  `LANG==='en'` blocks. Add both.
- **No secrets and no personal data** in the repository, ever. The game stores nothing about players
  and should keep it that way.

## Be nice

Be kind in issues and reviews. It is a game; have fun with it.
