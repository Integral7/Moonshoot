# Moonshot — Progress Log

This file lets a fresh session pick up the build. Read it first.

## Working agreement (from the user)
- Commit **and push to `main`** after every milestone and after any large chunk of work.
- Keep this file updated at every milestone.
- Run tests and the headless app (`npm run e2e`) and fix errors before finishing a milestone.
- **Pause for the user's go-ahead every 4 milestones** (after M4, M8, M12) with a summary and the exact Windows commands to run the app.
- Low / Medium / High quality setting (done: `src/render/quality.ts`).
- README must have a "How this was built" section.

## Stack
Vite 8 + TypeScript 7 + Three.js 0.186. Vitest 5 for unit tests (`tests/`), Playwright 1.64 headless Chromium
(SwiftShader WebGL) for smoke runs (`e2e/`). Physics lives in `src/physics/` and must stay pure
(no Three.js, no DOM) so it runs under Vitest in Node.

## Commands
| Command | What it does |
|---|---|
| `npm install` | install deps |
| `npx playwright install chromium` | one-time headless browser download |
| `npm run dev` | dev server at http://localhost:5173 |
| `npm test` | unit tests |
| `npm run e2e` | build + preview + headless smoke tests (screenshots in `e2e/screenshots/`) |
| `npm run check` | typecheck + unit + build + e2e |

## Architecture
- `src/app/App.ts` — owns renderer, DOM overlay, settings, active `Screen`. Debug hook `window.__moonshot.state()` used by e2e.
- `src/app/Screen.ts` — screen interface (enter/exit/update/render/resize/onQualityChange/debugState).
- `src/screens/` — one class per screen (menu, vehicle design, flight phases...).
- `src/render/` — procedural visuals + `quality.ts` presets.
- `src/ui/` — DOM helpers (`h()`), panels, CSS.
- `src/util/rng.ts` — seeded PRNG (deterministic replays).

## Milestones
| # | Milestone | Status |
|---|---|---|
| 1 | Scaffold, tooling, quality framework, headless harness | ✅ done |
| 2 | Physics core + unit tests | ✅ done |
| 3 | Game shell, mission control HUD, procedural Earth/Moon/stars | ✅ done |
| 4 | Vehicle design (VAB) | ⏳ next — **pause after this** |
| 5 | Launch | ☐ |
| 6 | Earth orbit + TLI maneuver node | ☐ |
| 7 | Cruise (patched conic, MCC, warp) | ☐ |
| 8 | LOI + landing | ☐ — **pause after this** |
| 9 | Return: ascent, TEI, reentry, splashdown | ☐ |
| 10 | Scoring/failure analysis + replay w/ telemetry graphs | ☐ |
| 11 | Campaign polish, free-play states, perf | ☐ |
| 12 | Docs + final headless pass | ☐ — **pause after this** |

## Log
### M1 — Scaffold (done)
- Project config, App/Screen framework, main menu with procedural starfield, settings modal (quality + callouts), localStorage-guarded settings.
- Unit tests: settings + quality presets. E2E: boot/menu render, quality switching + persistence.
- Notes: renderer is recreated when antialias changes (low ↔ medium/high). Logarithmic depth buffer is on.

### M2 — Physics core (done)
`src/physics/` (pure, SI units, ECI frame with +Z = Earth spin axis):
- `constants.ts` real constants (WGS-84, DE430 lunar GM, US76). `bodies.ts` Earth/Moon, simplified ephemeris
  (Moon circular in XY plane, tidally locked; `Ephemeris` sets initial Moon/Earth angles), lat/lon helpers.
- `kepler.ts` elements↔state (equatorial/circular safe), universal-variable `propagateKepler`, anomaly/timing.
- `integrator.ts` RK4 (preallocated), symplectic Euler, `FixedStepper` accumulator.
- `atmosphere.ts` US76 exact to 86 km + table to 1000 km. `aero.ts` q, Sutton-Graves, Allen-Eggers, Mach drag rise.
- `dynamics.ts` 7-state EOM (r, v, m) with thrust (pressure-dependent Isp), drag vs co-rotating air, banked lift, heat flux, g-load.
- `rocket.ts` Tsiolkovsky etc. `maneuver.ts` local frame (prograde/normal/radial), Hohmann, TLI, phase angle, capture dv.
- `lambert.ts` universal-variable Lambert (bisection). `patched.ts` patched-conic `predictTrajectory` (segments + events:
  soi-enter/exit, periapsis, atmosphere, impact, escape) and `coast()` for exact time-warp coasting.
- Tests (`tests/physics/`): published values (TLI 3.1 km/s, LEO/ISS, escape, GEO, Moon SOI, LOI 0.8–0.9 km/s, LLO period,
  11 km/s entry), Curtis textbook examples 3.7/4.3/5.2, RK4-vs-Kepler, invariants, US76 table, entry g-loads, rocket eqn,
  module purity guard.
- Note: Allen-Eggers is only valid for steep entries; shallow supercircular ballistic entry simulates at ~14 g.

### M3 — Game shell + world (done)
- `src/sim/`: `time.ts` (MET formatting), `callouts.ts` (rule-based flight director callouts, once/re-arm), `telemetry.ts`
  (adaptive-interval recorder + interpolation), `scoring.ts` (weighted metrics, ratings, failure cap), `mission.ts`
  (6-phase state machine, carry state + retry snapshots), `presets.ts` (free-play states; `STANDARD_EPHEMERIS`).
- `src/physics/planner.ts`: `planTli` solves TLI burn time for a target lunar periapsis (signed-periapsis bisection).
- Kepler fix: Laguerre-Conway iteration (Newton diverged on long high-e propagations) + regression test.
- Render: `bake.ts` GPU cube-map baking (seamless) with cache (`userData.shared` textures are never disposed by screens);
  `earth.ts` (continents/biomes/ice, ocean specular, city lights, clouds, atmosphere shell), `moon.ts` (crater layers,
  maria on +X near side, lunar-Lambert shading, height bump), `World.ts` (floating origin; ECI→scene: x,z,-y),
  `MapView.ts` (trajectory lines per SOI, ghost Moon at SOI entry, event markers+labels, focus cycling), `OrbitCamera`,
  `PostFX` (bloom on medium/high), `sun.ts`.
- UI: `Hud.ts` (MET, warp, telemetry rows, Mission Control log, toasts), `ResultsPanel.ts`, `Labels.ts`.
- Screens: `FlightScreen` base (warp w/ auto-limit hook, pause menu, restart, debrief, debugCommand), `CruiseScreen`
  (coast-only for now; ends 1 h before lunar periapsis), `FreePlayScreen`. Phase registry in `src/app/phases.ts`.
- E2E: free-play cruise flown to completion under warp; Earth/Moon render screenshots at medium.
- Notes: Sun fixed along ECI +X. Custom ShaderMaterials must include log-depth chunks (`glsl.ts` helpers);
  `modelMatrix` is vertex-only — pass rotations as uniforms. Labels z-index below HUD.

## Next steps
Start M4: vehicle design screen — parts catalog (capsule, service module, lander descent/ascent, tanks, engines,
decouplers, chutes, heat shield, fairing), stack builder UI, live mass/thrust/TWR/Δv per stage, mission Δv budget
allocation, procedural 3D vehicle preview; campaign entry from main menu. Then PAUSE for user go-ahead.