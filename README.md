# Moonshot

An end-to-end lunar mission game in 3D for the web. Design a rocket, fly it to orbit, burn for the Moon,
correct course, brake into lunar orbit, land by hand on cratered terrain, lift off again, and bring the
crew home through the reentry corridor to a parachute splashdown.

Everything you see is procedural (no image, model or texture assets), and the physics uses real constants:
two-body motion with patched conics, a fixed-step integrator, the 1976 US Standard Atmosphere, and
Apollo-era vehicle numbers.

## The mission

| # | Phase | What you do |
|---|---|---|
| 1 | **Vehicle design** | Stack capsules, heat shields, parachutes, an escape tower, tanks, engines, decouplers and landing legs. Mass, thrust-to-weight, per-stage Δv and the whole mission's Δv budget update live, with validation. |
| 2 | **Launch & ascent** | Countdown, liftoff, gravity turn, max-Q, staging, escape-tower jettison, orbit insertion. Hand-flown, with a prograde assist, or on the autopilot. |
| 3 | **Earth orbit & TLI** | Circularize, then plan trans-lunar injection with the maneuver node tool (prograde/normal/radial, timing). The predicted trajectory and Moon encounter are drawn live. |
| 4 | **Translunar cruise** | Patched-conic coast under time warp (up to 100,000x) with a mid-course correction. |
| 5 | **Lunar orbit & landing** | Lunar orbit insertion, a descent-orbit burn timed for a low morning sun, then a powered descent over craters and boulders with throttle and attitude control. |
| 6 | **Return & splashdown** | Lunar liftoff, trans-Earth injection targeting a −6.5° entry, reentry with bank-angle lift control inside the heating and g-load limits, drogues, mains, splashdown. |

Every phase ends with a scored debrief and failure analysis (what went wrong and why), a telemetry graph,
and a saved **replay** you can scrub through. **Free Play** starts any phase from a standard state;
**Campaign** carries your vehicle and trajectory through all six and is saved at each phase, so you can
continue later. A mission summary scores the whole flight.

## Running it locally (Windows)

Requires [Node.js](https://nodejs.org/) 20 or newer (built with Node 24). In PowerShell, in this folder:

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

## Controls

| Where | Input | Action |
|---|---|---|
| Everywhere | Drag / wheel | Rotate / zoom the camera |
| | `,` `.` (`/` resets) | Slower / faster time warp |
| | `P`, `Esc` | Pause, pause menu (restart phase, settings, quit) |
| Launch | `W` / `S` | Pitch over / up |
| | `Shift` / `Ctrl`, `Z` / `X` | Throttle up / down, full / cut |
| | `Space`, `T`, `G` | Stage, prograde assist, autopilot |
| | `C`, `M` | Cycle camera (chase / pad / map), map view |
| Orbit, cruise, lunar orbit | Maneuver panel (right) | Auto-planners, node time and Δv, warp to node, execute |
| | Attitude buttons, `Shift`/`Ctrl`/`Z`/`X`, `Space`, `Tab` | Manual burns, stage, camera focus |
| Landing | `W` `A` `S` `D` | Tilt the thrust vector forward / left / back / right |
| | `R`, `V`, `G` | Retrograde hold, vertical hold, landing autopilot |
| Reentry | `A` / `D`, `U` / `J` | Roll the lift vector, lift up / down |
| | `1`, `2`, `G` | Drogues, mains, entry autopilot |

## Graphics quality

Settings → Graphics quality offers **Low**, **Medium** and **High**. It scales planet mesh and texture
resolution, star, particle and trail counts, lunar terrain resolution, bloom, clouds, shadows and pixel
ratio. Low suits integrated GPUs.

## Tests

```powershell
npm test                          # unit tests: physics, guidance, vehicle model, game logic
npx playwright install chromium   # one-time download for the headless browser tests
npm run e2e                       # builds the app and flies it in headless Chromium
```

The unit tests check the physics against published values: trans-lunar injection from a 185 km orbit is
about 3.1 km/s, lunar orbit insertion 0.8 to 0.9 km/s, ISS orbital period 92.7 minutes, Earth escape
velocity 11.19 km/s, the Moon's sphere of influence about 66,100 km, lunar-return entry speed about 11 km/s.
They also cover textbook examples (Curtis 3.7, 4.3 and 5.2), the US76 atmosphere table, entry
deceleration theory, and integrator invariants. The headless tests fly every phase to its debrief,
including a full campaign from vehicle design to splashdown on the autopilots and planners.

## Project layout

```
src/physics/   Pure physics module (no rendering or DOM; enforced by a test)
src/sim/       Game simulation: vehicle model, ascent, orbital flight, descent, reentry, planners,
               scoring, callouts, telemetry, replays, campaign saves
src/render/    Procedural visuals: GPU-baked Earth and Moon, stars, plumes, smoke, terrain, vehicle meshes
src/screens/   One screen per phase plus menus, replays and the mission summary
src/ui/        HUD, maneuver panel, telemetry graph, results panel
tests/         Vitest unit tests        e2e/   Playwright headless tests
```

### Model simplifications

- The Moon moves on a circular orbit in Earth's equatorial plane and is tidally locked; the Sun is fixed along
  one direction (it moves only about 1° a day).
- The launch site is on the equator, so the parking orbit is coplanar with the Moon's orbit.
- Gravity is patched conics: only the body whose sphere of influence you are in attracts you.
- The rocket is a point mass with instant-ish attitude (rate-limited), with no aerodynamic torques.
- The return is direct from the surface, with no lunar-orbit rendezvous. That needs a Nova-class booster
  (about 5,000 t), which is historically why Apollo chose lunar-orbit rendezvous instead.

## How this was built

Moonshot was built in one long pairing session with **Claude Code** (Anthropic's coding agent, running in
the Claude desktop app), working from a one-paragraph brief. Claude proposed a 12-milestone plan, which the
user approved, and built it in stages. The ground rules were set up front:

- **Small, verifiable milestones.** Each milestone ended with unit tests, a production build, and a headless
  browser run that drove the real app, with errors fixed before moving on. Each was then committed and pushed,
  and recorded in [PROGRESS.md](PROGRESS.md) so a fresh session could pick up the work.
- **Check-ins every four milestones.** Work paused for the user's go-ahead after milestones 4, 8 and 12, with
  a summary and the Windows commands to try it.
- **Physics first, as a pure module.** `src/physics` was written and tested against published values before
  any gameplay, and every later system (guidance, planners, entry) builds on it.
- **Look at the output.** Headless Chromium (SwiftShader WebGL) took screenshots at each milestone, and Claude
  checked them for visual bugs. For example: an overexposed Earth, terrain normals pointing into the ground,
  star-shaped streaks from a polar terrain grid, a plasma glow hiding the capsule, and a rocket lit only from
  directly above.

### Problems that taught something

- **Kepler solver divergence.** Universal-variable Newton iteration diverged on multi-day propagations of the
  highly eccentric TLI orbit and produced phantom "escape" events. It was replaced with Laguerre-Conway
  iteration, plus a regression test.
- **Ascent guidance.** A naive climb-rate controller wasted 1.5 km/s fighting gravity with a low-thrust upper
  stage. The fix was linear-tangent steering on the upper stages (the law Saturn V's iterative guidance
  used), solved by Newton's method against a fast multi-stage prediction. The recommended rocket now
  reaches orbit for 9.1 km/s.
- **1 m/s at TLI is about 1,000 km at the Moon.** A finite nine-minute burn misses by 35,000 km if planned
  impulsively. The node planner now matches the impulsive orbital energy, then re-solves the burn time
  against a simulation of the real finite burn. A whole-step cutoff error of 3 m/s also had to go.
- **GLSL float32 semantics.** The JavaScript port of the GPU continent noise (used to decide ocean or land at
  splashdown) produced invalid gradients until one constant was rounded to float32. The shader relies on
  `0.142857142857` rounding up past 1/7.
- **Reentry.** A lift-up entry skipped back out of the atmosphere at a supercircular 10.5 km/s.
  Constant-drag tracking (fly lift-down to capture, then hold about 4 g) fixed it. Parachutes then gave 43 g
  until canopies inflated over several seconds, as reefed parachutes do.
- **Landing.** The first landing autopilot ran out of vertical authority while braking. Vertical-priority
  guidance fixed that, but it then landed on a 13° crater wall and tipped. Apollo-style landing-point
  redesignation (search for a flat, boulder-free spot below 400 m) fixed that, and also drives the
  safe-site marker shown to manual pilots.

### Credits

3D simplex noise is from [webgl-noise](https://github.com/ashima/webgl-noise) by Ian McEwan, Stefan Gustavson
and Ashima Arts (MIT License). 2D simplex noise follows Stefan Gustavson's public-domain reference
implementation. Built with [Three.js](https://threejs.org/), [Vite](https://vitejs.dev/),
[Vitest](https://vitest.dev/) and [Playwright](https://playwright.dev/).
