# Science Fest — Urban Rainwater Harvesting Simulation

An interactive Three.js simulation of urban rainwater harvesting: rooftop catchment, downspouts,
cisterns, district storage, sewer surcharge and street flooding — plus on-site electricity
generation (solar and micro-hydro) and the power balance of the district grid.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production build
```

## Layout

- `src/sim/` — simulation core: hydrology, storm, city layout, clock, power, logging
- `src/scene/` — Three.js scene: buildings, ground, rain, splashes, sky, network, power
- `src/ui/` — HUD, charts, power chart
- `src/core/rng.ts` — deterministic seeded RNG

Built with Vite + TypeScript + Three.js.
