# Contributing to World of DODO

Thanks for wanting to make it better. New weapons, smarter bots, a better scoreboard, bug fixes:
all welcome.

## How

1. Fork the repository and create a branch.
2. Make the change and try it: `docker compose up --build -d`, then http://localhost:3400 in two
   windows (or `npm start` and port 3000).
3. Run the tests: `npm run check` and `npm run smoke` (against the running server). If you touched
   the game page, `npm run test:browser` is worth it too.
4. Open a pull request that says what changes for the player and why.

A maintainer reviews and merges. There is no CI: what is merged to `main` is built and deployed by
Zerops right away, so run the checks before you ask for a merge.

## Things to know

- **The game is one HTML file** (`client/index.html`), on purpose: no build step. Its code is dense
  (it started as a hand-made prototype); write new code in the same style and explain the *why* in
  comments. Changes made for World of DODO are marked "World of DODO" in comments.
- **Some numbers live twice** and must stay in step:
  - the tank colours: `COLORS` in `server/server.js` and `TANK_COLORS` in the client (same order);
  - the city: `server/city.js` mirrors the street grid and the buildings of the client;
  - tank size, parcel physics and the hit rules: `server/bots.js` mirrors the client.
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
