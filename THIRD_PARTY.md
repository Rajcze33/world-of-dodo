# Third-party parts

These files are not covered by the repository's MIT License; each keeps its own license.

| What | Where | License |
| --- | --- | --- |
| Babylon.js 9 (`@babylonjs/core`) | bundled into the built page (`client/dist/app`) | Apache License 2.0, Copyright Babylon.js contributors: [`client/public/licenses/babylonjs.txt`](client/public/licenses/babylonjs.txt) (served at `/licenses/babylonjs.txt`) |
| The map of Karlín (issue #16) | `client/shared/karlin.json` (also bundled into the built page) | Open Database License 1.0, a database derived from © OpenStreetMap contributors; with floor counts from IPR Praha (CC BY 4.0) and terrain from ČÚZK (CC BY 4.0). Sources, attribution and how to rebuild it: [`client/shared/KARLIN-DATA.md`](client/shared/KARLIN-DATA.md) |
| three.js r128 (`CatmullRomCurve3` and `Curve`, ported to TypeScript) | `client/shared/catmull.ts` (the tram's track, on the page and the server) | MIT, Copyright 2010-2021 Three.js Authors |
| Poppins (Light, Regular, SemiBold, Bold) | `client/public/fonts/Poppins-*.ttf` | SIL Open Font License 1.1, Copyright 2020 The Poppins Project Authors: [`client/public/fonts/OFL-Poppins.txt`](client/public/fonts/OFL-Poppins.txt) |
| IBM Plex Mono (Regular, Medium, SemiBold) | `client/public/fonts/IBMPlexMono-*.ttf` | SIL Open Font License 1.1, Copyright 2017 IBM Corp., Reserved Font Name "Plex": [`client/public/fonts/OFL-IBMPlexMono.txt`](client/public/fonts/OFL-IBMPlexMono.txt) |
| The materials' textures (issue #27) | `client/public/assets/mat/` | CC0 1.0 (public domain): made from [Poly Haven](https://polyhaven.com) and [ambientCG](https://ambientcg.com) textures; every file, its source and its use: [`ASSETS.md`](ASSETS.md) |
| The roofs (issue #27) | `client/public/assets/roofs/`, `client/src/world/roofs.json` | CC BY 4.0, cut from the orthophoto of Prague by IPR Praha, "data base © IPR Praha": [`ASSETS.md`](ASSETS.md) |
| DODO logo | `client/public/assets/logo-white.png` | Trademark of DODO; not licensed for use outside this game |

The two license files are the ones the Google Fonts repository ships with these fonts
(github.com/google/fonts, `ofl/poppins` and `ofl/ibmplexmono`). The fonts are used unmodified.
