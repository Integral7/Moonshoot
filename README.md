# Moonshot

An end-to-end lunar mission game in 3D for the web: design a vehicle, launch it, park in Earth orbit,
burn for the Moon, land by hand, and bring the crew home through a reentry corridor to splashdown.
Everything is procedural (no image or model assets), and the physics uses real constants.

> Status: in active development (milestones 1-8 of 12 complete). See [PROGRESS.md](PROGRESS.md) for the milestone log.

## What works so far

- **Vehicle design** (Campaign, or Free Play → Vehicle Design): build a rocket from capsules, heat shields,
  parachutes, an escape tower, tanks, engines, decouplers and landing legs. Mass, thrust-to-weight, per-stage
  delta-v and the full mission delta-v budget update live, with validation and a scored debrief.
- **Launch** (phase 2): countdown, hand-flown or autopilot ascent with gravity turn, max-Q, staging, escape-tower
  jettison, plumes, smoke and sky; linear-tangent upper-stage guidance reaches a 185 km orbit for about 9.1 km/s.
- **Earth orbit and TLI** (phase 3): maneuver nodes (prograde/normal/radial), circularize helpers, and an
  auto-planned trans-lunar injection corrected for finite burn time, with the predicted Moon encounter drawn.
- **Translunar cruise** (phase 4): patched-conic coast with time warp up to 100,000x and a mid-course correction
  planner.
- **Lunar orbit and landing** (phase 5): orbit insertion, a descent orbit timed for low morning sun, then a
  powered descent over procedural cratered terrain with boulders, by hand or with a hazard-avoiding autopilot.
- **Physics core** (`src/physics`): real constants, Kepler and universal-variable propagation, Lambert solver,
  patched conics, US Standard Atmosphere 1976, drag/lift/heating, fixed-step RK4, TLI planner, all unit-tested.

## Controls

| Key / input | Action |
|---|---|
| Drag / wheel | Rotate / zoom camera |
| `,` and `.` | Slower / faster time warp (`/` resets to 1x) |
| `P` | Pause |
| `Tab` | Cycle camera focus (map views) |
| `Esc` | Pause menu |
| Launch: `W`/`S`, `Shift`/`Ctrl`, `Z`/`X`, `Space` | Pitch, throttle, full/cut, stage (`G` autopilot, `T` prograde assist, `C` camera, `M` map) |
| Orbit/cruise: buttons, `Shift`/`Ctrl`, `Z`/`X` | Attitude modes, throttle (maneuver node panel on the right) |
| Landing: `W`/`A`/`S`/`D`, `R`, `V`, `G` | Tilt thrust, retrograde hold, vertical hold, landing autopilot |

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
