# Working on World of DODO

For AI coding agents, and for people too. Read [README.md](README.md) (what the game is, how it runs)
and [CONTRIBUTING.md](CONTRIBUTING.md) (the rules, the numbers that live twice) before you change
anything.

## The work comes from the issues

- Bugs and ideas are GitHub issues: https://github.com/Rajcze33/world-of-dodo/issues. The board is
  https://github.com/users/Rajcze33/projects/1, with the columns Nápady (reported, not decided)
  → Na řadě (agreed, waiting) → Dělá se (someone is on it) → Hotovo (merged).
- Look before you start: `gh issue list -R Rajcze33/world-of-dodo`, then `gh issue view <n>`. Unless
  you were asked for something else, take an issue from Na řadě, not from Nápady.
- Claim it before you work on it: assign it (`gh issue edit <n> --add-assignee @me`) or comment, and
  move its card to Dělá se. Someone else's issue in Dělá se is not yours.
- One issue, one branch, one pull request. The pull request says `Fixes #<n>`, so the merge closes
  the issue.
- Found a bug or an idea on the way that you are not doing now? Open an issue with the Chyba or
  Nápad form (the issues are written in Czech) rather than leaving a TODO in the code.
- Not sure what the person wants? Ask in the issue.

## Before you push

- `npm run check`, then `docker compose up --build -d` and `npm run smoke` (http://localhost:3400).
  A change to the game page also wants `npm run test:browser` (Chrome + puppeteer-core, see README).
- There is no CI, and `main` is what runs on the server: never push untested work to `main`; use a
  branch and a pull request.
- A protocol change updates docs/PROTOCOL.md and tools/smoke.js in the same pull request.
- Keep in step what lives twice (list in CONTRIBUTING.md): tank colours, the city, the bots' copy of
  the game rules, the server's copy of the traffic and pedestrian code. The construction site is one
  shared file, client/shared/site.js.
- No secrets, tokens or personal data in the repository.

## Style

- The game is one dense HTML file on purpose (no build step). Write like the code around you,
  explain the why in comments, and mark changes against the original game "World of DODO".
- Player-facing texts live in `T` at the top of the game script: Czech first, English in the
  `LANG==='en'` blocks.
