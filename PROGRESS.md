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
| 4 | Vehicle design (VAB) | ✅ done (user approved M5–M8) |
| 5 | Launch | ✅ done |
| 6 | Earth orbit + TLI maneuver node | ✅ done |
| 7 | Cruise (patched conic, MCC, warp) | ✅ done |
| 8 | LOI + landing | ✅ done (user approved M9–M12) |
| 9 | Return: ascent, TEI, reentry, splashdown | ✅ done |
| 10 | Scoring/failure analysis + replay w/ telemetry graphs | ⏳ next |
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

### M4 — Vehicle design (done)
- `src/sim/parts.ts`: catalog (capsules, heat shields, chutes, LES, S/M/L tanks, F-1/J-2/RL10/SPS/DPS/methalox engines,
  decouplers, legs) with Saturn/Apollo-class numbers.
- `src/sim/vehicle.ts`: `analyzeDesign` (stages split at decouplers; decoupler goes with the stage below; LES counted
  only during stage 1; engine clusters combined by mass flow; per-stage Δv vac/ascent, TWR Earth/Moon, burn time;
  validation errors/warnings), `allocateBudget` (walks `MISSION_LEGS` consuming stage Δv in firing order; landing
  stage must have legs, is left on the Moon), `TEMPLATES` (Nova-class recommended: direct return needs ~5,000 t —
  historically why Apollo chose LOR; Methalox light 2-crew), runtime `VehicleState` (plain JSON) + `Vehicle` helper
  (mass, staging, LES jettison, throttle limits, Δv remaining, Cd·A, L/D, chutes, heat shield, legs).
- `src/render/vehicleMesh.ts`: procedural model per stage (panel/roll-pattern canvas textures, bell nozzles via
  lathe, `clusterLayout` ring packing, interstages, LES, legs, hidden parachute canopies); nozzle positions for plumes.
- `src/screens/DesignScreen.ts`: palette, run-grouped stack editor (+/−/▲/▼/✕), stage headers with roles, live
  stats + budget table + issues, 3D preview with selection box, templates, localStorage WIP; approve → scored debrief
  → carry.design. `src/app/flow.ts` shared continue/retry/menu actions (continue disabled for unbuilt phases).
- Campaign button now starts at Vehicle Design.

### M5 — Launch (done)
- `src/sim/ascent.ts`: `AscentSim` (pad hold co-rotating, ignition T-3, liftoff when thrust > weight, RK4 at 0.02 s,
  rate-limited pitch, staging + LES jettison, events, max-Q, q·α breakup at 200 kPa·deg, 9 g crew limit, crash);
  `ascentAutopilot`: vertical rise → kick (`kickForTwr`) → zero-AoA gravity turn through stage 1 → linear-tangent
  closed loop on upper stages (Newton on (A,B) against a planar multi-stage prediction; AoA guard). Nova uses
  9.14 km/s, Methalox 9.69 km/s (budget leg raised to 9.4 km/s). `Vehicle.burnTimeFor`.
- Render: `plume.ts` (additive cone, shock diamonds at sea level, widens in vacuum, color by propellant),
  `smoke.ts` (double-precision particles re-based each frame), `launchSite.ts` (curved ground cap built relative to
  the pad, coastline texture, pad, lattice tower, swing arms), starfield brightness, earth `setAtmosphereIntensity`.
- MapView: `setVesselModel`, `cameraOverride`, `showPrediction`, `markerHideDistance`.
- `LaunchScreen`: hold at T-10 → countdown, manual (W/S pitch, Shift/Ctrl/Z/X throttle, Space stage, T prograde
  assist) or autopilot (G), cameras chase/pad/map (C, M), debris for spent stages + LES, trail in Earth-fixed frame,
  sky color + skylight by altitude, callouts, scored debrief (Δv, apoapsis, circularization, max-Q, g, piloting).
  Carries `vehicle` + `flight.orbit`. Warp ≤10x (debug `fast` → 100x for e2e).

### M6 — Earth orbit + TLI (done)
- `src/sim/orbital.ts`: `OrbitalFlight` (exact patched coast, finite RK4 burns, node execution steered in the local
  orbital frame and centered on the node, exact final-step cutoff, auto-staging, halt at atmosphere/impact),
  `simulateNode`, `refineNodeFinite` (energy match for gravity loss, then bisection + fine secant on node time
  against an objective), `lunarApproach` (signed periapsis radius for root finding), `circularizeNode`.
  Lesson: 1 m/s at TLI ≈ 1000 km at the Moon, so burn cutoff quantization matters.
- MapView now has `current` + `planned` layers (each with its own ghost Moon) and a node marker.
- `ManeuverPanel` (time shift, prograde/normal/radial with +/- and typed values, planners, warp-to-node, execute).
- `OrbitalScreen` base (map, vessel model + plume, attitude buttons, manual throttle, warp limits around
  node/events/phase end, finite-burn planned preview, burn callouts). `OrbitScreen`: circularize helpers,
  auto TLI (planTli → refineNodeFinite), completes 60 s after a burn that yields a lunar encounter; scored on
  lunar periapsis, Δv vs impulsive ideal, flight time. Free-play preset = autopilot ascent (`orbitPreset`).

### M7 — Cruise + MCC (done)
- `CruiseScreen` rebuilt on `OrbitalScreen`: maneuver tool, `planLunarCorrection` (scan prograde → radial → normal
  components, log-spaced, smallest bracket, bisection; impulsive), phase ends 1 h before lunar periapsis
  (`phaseEndTime` drives warp limiting), fails on impact/miss. Scored on periapsis accuracy + correction Δv.
- Presets: `vehicleAfterDv`, `cruiseVehicle` (orbit preset minus TLI Δv).
- E2E: free-play cruise plans a 1.8 m/s MCC and arrives at 110.0 km.

### M8 — Lunar orbit + landing (done)
- `src/util/noise.ts` (2D simplex, hash). `src/sim/terrain.ts` `LunarTerrain`: azimuthal-equidistant map around the
  PDI sub-point (Moon-fixed), mare fBm + 4 crater layers (bowl/rim/ejecta) + roughness, `bouldersNear`, slope.
- `src/sim/descent.ts` `DescentSim` (Moon-centered RK4, 20°/s slew, radar altitude, surface velocity incl. rotation,
  fuel time, Apollo-style callout events) + `evaluateTouchdown` (legs: 3 m/s vertical, 1.5 horizontal, 12° tilt;
  boulders; outcomes landed/hard/tipped/crashed) + `descentAutopilot` (vertical-priority guidance, descent rate paced
  by braking time) + `findSafeSite` (landing-point redesignation below 400 m).
- `planDoi` (periapsis 15 km where the Sun is 20° up on the morning side), `landingPreset` (cruise + MCC, Pe−1 h).
- `render/terrainMesh.ts` `TerrainTile`: radially stretched square grid (p = q|q|) relative to tile center, in the
  Moon spin group; vertex-color albedo; instanced boulders < 1.5 km; LPD ring. Moon `setSurfaceVisible` hides only the
  sphere (the tile is a child of the Moon group!).
- `LandingScreen` (OrbitalScreen with modes orbit → descent → surface): LOI (finite-refined circularize at Pe) + DOI
  planners, Begin powered descent (< 25 km; jettisons stages below the legs), manual tilt/throttle/holds or
  autopilot (G), dust, safe-site marker, scored debrief, carries `vehicle` + `surface {r (Moon-fixed), t, eph}`.
- E2E: free-play LOI → DOI → PDI → autopilot touchdown (landed, 1.2 m/s).
- Known: planning happens at frame-dependent sim times, so e2e outcomes vary slightly run to run.
- Campaign chain design→launch→orbit→cruise→landing uses carry everywhere but has no single e2e run yet (M11).

### M9 — Return (done)
- `src/util/noise3.ts`: exact JS port of the GLSL 3D simplex (needs `Math.fround(0.142857142857)`: GLSL relies on
  float32 rounding past 1/7). `src/sim/earthSurface.ts` `isLand` = same continent function as the GPU bake.
- `src/sim/reentry.ts` `EntrySim`: capsule separation, banked lift, Sutton-Graves vs shield maxFlux/maxLoad, 12 g
  limit, skip-out/miss detection, reefed drogue/main fill (3 s / 8 s) with q limits (10 / 4 kPa), splashdown
  (speed, lat/lon, ocean). `entryAutopilot`: constant-drag tracking (lift-down capture, 4 g, hdot damping).
- `DescentSim` `onSurface` start (grounded until thrust > weight; touchdown armed above 3 m), `lunarAscentAutopilot`.
- `planTei` (entry-angle targeting via `perigeeForEntryAngle`, finite-burn refined), `planEarthCorrection`,
  `earthApproach`, `entryAngleOf`. `returnPreset`.
- Render: `SurfaceScene` (shared by landing and return), `entryFx.ts` (plasma glow, local ocean/land patch).
- `ReturnScreen` modes surface → ascent → orbit (TEI/correction planners) → entry → done; scored debrief.
- Fix: warp limits must be values on `WARP_LEVELS`; `setWarpLevel` now snaps down to the nearest level.
- E2E: free-play return lifts off, TEI, coasts, enters at −6.50°, splashes down at 8.7 m/s in the ocean.

## Next steps
M10: telemetry graph component in the debrief (channels, marks), replay recording (vehicle ECI track + attitude +
throttle + body) per phase, replay viewer screen (scrubber, synced graph cursor) + main-menu Replays list (localStorage,
decimated). M11: campaign save/resume, mission summary after return, full-chain campaign e2e. M12: README
"How this was built", final headless pass, PAUSE.