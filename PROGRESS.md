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
| 2 | Physics core + unit tests | ⏳ next |
| 3 | Game shell, mission control HUD, procedural Earth/Moon/stars | ☐ |
| 4 | Vehicle design (VAB) | ☐ — **pause after this** |
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

## Next steps
Start M2: `src/physics/` — constants, vec3 math, two-body accel, RK4 fixed step, Kepler elements ↔ state,
universal-variable propagation, SOI patching, atmosphere/drag, rocket equation, heating, maneuvers (Hohmann/TLI).
