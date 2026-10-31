# World of DODO

A small multiplayer tank game in the browser. One snowy city, everybody in their own DODO tank,
parcels for ammunition. Built on *Poslední míle* (The Last Mile), the 3D delivery game DODO made for
Christmas 2026, where the delivery van had already turned into a tank.

**Play: https://game-3a26-3000.prg1.zerops.app** (English: add `?lang=en`)

![Two players and a bot in the city](docs/screenshot.png)

- **Join with a name only.** Pick a name and a tank colour, drive out. No account, no password,
  nothing is stored: your score lasts as long as you stay connected.
- **Shoot the others.** Space (or the green button on a phone) fires a parcel. A hit on another
  player is worth **10 points**, a hit on a bot (BOT1, BOT2, …) **1 point**.
- **Three hits destroy a tank.** It blows up, lies on its side for a moment and comes back at a free
  spot somewhere else, blinking and immune for a few seconds.
- **The bots** are driven by the server: they roam the streets, chase the nearest player and shoot back.
- **A construction site** south of the city: containers, a half-built house, sand piles, barriers, machines
  and a tower crane. Everything there is cover: it stops parcels, tanks and the line of sight.
- **A shared city.** The cars, the tram and the pedestrians are the same for everyone. A pedestrian a tank
  or a parcel knocks down lies there for a while, then is gone and walks again somewhere else.
- **Names only in plain sight.** A tank's name glows above it only while nothing stands between you,
  and it shows on the minimap only once you have spotted it. The scoreboard lists everybody.
- **Runs on modest hardware.** The quality drops by itself when the frames do not keep up; F shows
  FPS, ping and the level, Q changes the level by hand.
- Czech by default, English with `?lang=en`. Works on phones (touch controls).

## Play it locally

With Docker:

```sh
docker compose up --build -d
# open http://localhost:3400 in two browser windows
```

Or with Node.js 24:

```sh
npm ci
npm start          # http://localhost:3000
```

## How it works

```
client/index.html   the whole game: three.js city, tank physics, HUD, and the network part
server/server.js    serves the page, relays the players over a WebSocket, keeps the score
server/bots.js      the bots: driving, aiming, and what happens when a parcel hits one
server/world.js     the shared city life: cars, tram, pedestrians, knocked-down trees and lamps
server/city.js      the city's streets and buildings as numbers, for the bots and the city
client/shared/site.js  the construction site's layout, loaded by the page and by the server
docs/PROTOCOL.md    every message between the browser and the server
```

The server does not simulate the players. Each browser drives its own tank and sends where it is,
about 15 times a second; the server sends everyone's tanks back in one snapshot. A fired parcel is
passed on, and every browser flies it. **The player who gets hit decides the hit**, because on that
screen their tank is exactly where it is; the server then awards the points. The bots and the life
of the city (cars, tram, pedestrians) run on the server, so everyone sees the same city, and the
server decides what hits a bot.

The game page is one self-contained HTML file on purpose: no build step, no bundler. three.js r128
and the fonts are served from `client/vendor` and `client/fonts`.

## Configuration

Environment variables of the server:

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and WebSocket port |
| `BOTS` | `3` | number of bots, 0–8; they drive only while at least one person is playing |
| `MAX_PLAYERS` | `24` | people at once; the bots come on top |

## Tests

```sh
npm run check          # every inline script of the game page parses
npm run smoke          # protocol test against a running server (default http://localhost:3400)
npm run test:browser   # two players in headless Chrome; needs Chrome and: npm i --no-save puppeteer-core@25.14.0
```

There is no CI on purpose: it is a game for fun, and a push to `main` goes straight to the server
(see Deploy). Run the checks yourself before you push.

## Deploy (Zerops)

The game runs as a Zerops project of its own: one Node.js service with one container, because every
player has to reach the same process.

```sh
zcli project project-import zerops/import.yaml --org-id <organisation>   # once: the project and the service
zcli service enable-subdomain --project-id <project> --service-id <service "game">   # once, after the first deploy
```

**Every push to `main` deploys**: the service `game` is connected to this repository in the Zerops
GUI (the service's build/CI settings, GitHub, branch `main`, trigger on push), and Zerops builds with
`zerops.yaml` from the repository. By hand, from the repository root:
`zcli push --project-id <project> --service-id <service "game">` (on Windows from a folder outside
OneDrive, e.g. a `git archive HEAD` copy: OneDrive's placeholder files break zcli's archive).

The WebSocket runs over the same HTTPS port (`/ws`), nothing else to open.

## Known limits

- **The clients are trusted.** A modified browser can lie about its own tank or report hits. It is a
  game for fun, not a tournament.
- The city is shared (cars, tram, pedestrians, knocked-down trees and lamps), but the cars cannot be
  pushed: everyone would see them somewhere else. They stop for tanks, and turn back if one stays in the way.
- One server is one world. More players than `MAX_PLAYERS` wait outside.
- The minimap shows the city only; the construction site lies just below its bottom edge.

## Contributing

Pull requests are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

The code is under the [MIT License](LICENSE). Third-party parts (three.js, the fonts) keep their own
licenses, see [THIRD_PARTY.md](THIRD_PARTY.md). The DODO name and logo are trademarks of DODO and are
not covered by the MIT License.
