/**
 * Headless check of the simulation core: no DOM, no renderer.
 * Run with:  npx esbuild scripts/sim-check.ts --bundle --platform=node --format=esm --outfile=/tmp/simcheck.mjs && node /tmp/simcheck.mjs
 */
import { generateCity } from '../src/sim/city';
import { Hydrology } from '../src/sim/hydrology';
import { PowerGrid } from '../src/sim/power';
import { Storm } from '../src/sim/storm';

const t0 = Date.now();
const layout = generateCity(20260421);
console.log(`city generated in ${Date.now() - t0} ms`);
console.log(`  ${layout.buildings.length} buildings, ${layout.totalRoofArea.toFixed(0)} m² roof`);
console.log(`  extent ${layout.extent} m, streets ${layout.streetArea.toFixed(0)} m²`);

const hydro = new Hydrology(layout);
const power = new PowerGrid(layout);
const storm = new Storm();
const state = hydro.createState(layout, power.createState());
state.speed = 6;

console.log(`  sewer capacity ${hydro.sewerCapacity.toFixed(1)} m³/h, reservoir ${hydro.districtCapacity.toFixed(0)} m³`);
console.log(`  pv ${power.pvCapacityKw.toFixed(0)} kW, downspout turbines ${power.downspoutCapacityKw.toFixed(0)} kW`);

storm.restart(32, 0);

const rows: string[] = [];
for (let step = 0; step < 240; step++) {
  hydro.step(state, layout, storm, 1);
  power.step(state, 1);
  if (step % 20 === 0) {
    const stored =
      state.buildings.reduce((s, b) => s + b.cistern, 0) + state.tank.stored;
    rows.push(
      [
        `t+${state.minutes.toFixed(0)}m`,
        `rain ${state.rain.intensity.toFixed(1)}mm/h`,
        `fell ${state.rain.totalVolume.toFixed(0)}m³`,
        `stored ${stored.toFixed(0)}m³`,
        `sewer ${state.sewer.overflowTotal.toFixed(0)}m³`,
        `flood ${(state.sewer.floodedFraction * 100).toFixed(0)}%`,
        `gen ${state.power.generationKw.toFixed(0)}kW`,
        `load ${state.power.demandKw.toFixed(0)}kW`,
        `grid ${state.power.gridKw.toFixed(0)}kW`,
        state.power.islanded ? 'ISLANDED' : '',
      ]
        .filter(Boolean)
        .join('  '),
    );
  }
}
console.log(rows.join('\n'));

const stored =
  state.buildings.reduce((s, b) => s + b.cistern, 0) + state.tank.stored;
const harvested =
  state.buildings.reduce((s, b) => s + b.capturedTotal, 0) + state.tank.capturedTotal;
const used = state.buildings.reduce((s, b) => s + b.usedTotal, 0) + state.tank.usedTotal;

console.log('\n--- balance ---');
console.log(`rain fell        ${state.rain.totalVolume.toFixed(1)} m³`);
console.log(`harvested        ${harvested.toFixed(1)} m³`);
console.log(`used             ${used.toFixed(1)} m³`);
console.log(`to sewer         ${state.sewer.overflowTotal.toFixed(1)} m³`);
console.log(`stored now       ${stored.toFixed(1)} m³`);
console.log(`solar made       ${state.power.solarKwh.toFixed(1)} kWh`);
console.log(`hydro made       ${state.power.hydroKwh.toFixed(1)} kWh`);
console.log(`demand           ${state.power.demandKwh.toFixed(1)} kWh`);
console.log(`imported         ${state.power.importKwh.toFixed(1)} kWh`);
console.log(`events           ${state.log.length}`);
for (const e of state.log.slice(0, 5)) console.log(`   ${e.kind}: ${e.text}`);
console.log(`\ntotal ${Date.now() - t0} ms`);
