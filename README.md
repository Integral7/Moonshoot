# Moonshot

An end-to-end lunar mission game in 3D for the web: design a vehicle, launch it, park in Earth orbit,
burn for the Moon, land by hand, and bring the crew home through a reentry corridor to splashdown.
Everything is procedural (no image or model assets), and the physics uses real constants.

> Status: in active development. See [PROGRESS.md](PROGRESS.md) for the milestone log.

## Running it locally (Windows)

Requires [Node.js](https://nodejs.org/) 20 or newer (built with Node 24).

```powershell
npm install
npm run dev
```

Then open http://localhost:5173.

Production build:

```powershell
npm run build
npm run preview
```

Then open http://localhost:4173.

## Tests

```powershell
npm test                          # unit tests (physics, game logic)
npx playwright install chromium   # one-time, for headless runs
npm run e2e                       # builds the app and drives it in headless Chromium
```

## Graphics quality

Settings → Graphics quality offers **Low**, **Medium**, and **High**. The setting controls planet mesh and
texture resolution, star and particle counts, bloom, clouds, shadows, terrain resolution, and pixel ratio.

## How this was built

_To be completed at the end of the build._
