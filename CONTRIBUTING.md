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
   the game page, `npm run test:browser` is worth it too.
4. Open a pull request that says what changes for the player and why, with `Fixes #<issue>` in it:
   the issue then closes by itself when the pull request is merged.

A maintainer reviews and merges. There is no CI: what is merged to `main` is built and deployed by
Zerops right away, so run the checks before you ask for a merge.

## Things to know

- **The game is one HTML file** (`client/index.html`), on purpose: no build step. Its code is dense
  (it started as a hand-made prototype); write new code in the same style and explain the *why* in
  comments. Changes made for World of DODO are marked "World of DODO" in comments.
- **Some numbers live twice** and must stay in step:
  - the tank colours: `COLORS` in `server/server.js` and `TANK_COLORS` in the client (same order);
  - the city: `server/city.js` mirrors the street grid and the buildings of the client (the construction
    site is one file both load, `client/shared/site.js`: move or change it there);
  - tank size, parcel physics and the hit rules: `server/bots.js` mirrors the client;
  - the traffic, tram and pedestrian code: `server/world.js` is a port of the client's (which still
    runs it for the intro screen), and the client must keep 33 cars and 50 pedestrians in that order;
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
