import * as THREE from 'three';
import './style.css';
import { generateCity } from './sim/city';
import { Hydrology } from './sim/hydrology';
import { PowerGrid } from './sim/power';
import { STORM_PRESETS, Storm } from './sim/storm';
import type { HistorySample, SimState } from './sim/types';
import { World } from './scene/world';
import { Chart } from './ui/chart';
import { Hud } from './ui/hud';
import { PowerChart } from './ui/power-chart';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const layout = generateCity(20260421);
const hydro = new Hydrology(layout);
const power = new PowerGrid(layout);
const storm = new Storm();
const state: SimState = hydro.createState(layout, power.createState());
state.speed = 6;

const world = new World(canvas, layout);
const chart = new Chart(document.getElementById('chart') as HTMLCanvasElement);
const powerChart = new PowerChart(document.getElementById('powerChart') as HTMLCanvasElement);
const hudSlider = document.getElementById('intensity') as HTMLInputElement;

if (import.meta.env.DEV) {
  Object.assign(window, {
    __world: world,
    __state: state,
    __storm: storm,
    __hydro: hydro,
    __pick: (x: number, y: number) => {
      pointer.x = (x / window.innerWidth) * 2 - 1;
      pointer.y = -(y / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(pointer, world.camera);
      return raycaster
        .intersectObjects(world.buildings.meshes, false)
        .map((h) => ({ id: h.object.userData.buildingId, distance: +h.distance.toFixed(1) }));
    },
  });
}
const hud = new Hud({
  onMode: (mode) => {
    storm.mode = mode;
    if (mode === 'manual') {
      storm.manualIntensity = Number(hudSlider.value);
      hud.setManualIntensity(storm.manualIntensity);
    }
  },
  onPreset: (id) => {
    const preset = STORM_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    storm.restart(preset.peak, state.minutes);
    hud.setModeButtons('scripted');
  },
  onIntensity: (value) => {
    storm.mode = 'manual';
    storm.manualIntensity = value;
  },
  onSpeed: (value) => {
    state.speed = value;
  },
  onPause: () => {
    state.paused = !state.paused;
    hud.setPaused(state.paused);
  },
  onXray: () => {
    world.setXray(!world.xrayEnabled);
    hud.setXray(world.xrayEnabled);
  },
  onWash: () => hydro.washStreets(state),
  onIrrigate: () => hydro.irrigatePark(state),
  onToggleTurbines: () => power.toggleTurbines(state),
  onToggleGrid: () => power.toggleGrid(state),
});

if (import.meta.env.DEV) {
  Object.assign(window, { __hud: hud });
}

// ---------------------------------------------------------------- selection
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt: { x: number; y: number } | null = null;

canvas.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY };
});

canvas.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 5) return;

  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, world.camera);
  const hits = raycaster.intersectObjects(world.buildings.meshes, false);
  if (hits.length > 0) {
    const id = hits[0].object.userData.buildingId as number;
    const building = state.buildings.find((b) => b.id === id) ?? null;
    hud.setSelected(building);
    world.buildings.setHighlight(id);
    world.focusBuilding(building);
  } else {
    hud.setSelected(null);
    world.buildings.setHighlight(null);
    world.focusBuilding(null);
  }
});

// ------------------------------------------------------------------ keyboard
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Space') {
    e.preventDefault();
    state.paused = !state.paused;
    hud.setPaused(state.paused);
  } else if (e.key === 'x' || e.key === 'X') {
    world.setXray(!world.xrayEnabled);
    hud.setXray(world.xrayEnabled);
  } else if (e.key >= '1' && e.key <= '4') {
    const preset = STORM_PRESETS[Number(e.key) - 1];
    if (preset) {
      storm.restart(preset.peak, state.minutes);
      hud.setModeButtons('scripted');
    }
  }
});

window.addEventListener('resize', () => {
  world.resize();
  chart.resize();
  powerChart.resize();
});

// --------------------------------------------------------------------- loop
const history: HistorySample[] = [];
let lastSample = -1;
let hudTimer = 0;
let chartTimer = 0;
let lastFrame = performance.now();

function totalStored(): number {
  let s = state.tank.stored;
  for (const b of state.buildings) s += b.cistern;
  return s;
}

function totalCapacity(): number {
  let s = state.tank.capacity;
  for (const b of state.buildings) s += b.cisternCap;
  return s;
}

function frame(): void {
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;

  hydro.step(state, layout, storm, dt);
  power.step(state, dt);

  if (state.minutes >= lastSample + 1) {
    lastSample = Math.floor(state.minutes);
    history.push({
      minutes: state.minutes,
      intensity: state.rain.intensity,
      stored: totalStored(),
      storedCapacity: totalCapacity(),
      captured: state.rain.totalVolume,
      overflow: state.sewer.overflowTotal,
      solarKw: state.power.solarKw,
      hydroKw: state.power.hydroKw,
      demandKw: state.power.demandKw,
    });
    if (history.length > 900) history.shift();
  }

  world.update(state, dt);
  world.render();

  hudTimer += dt;
  if (hudTimer > 0.12) {
    hudTimer = 0;
    hud.update(state, layout, hydro, storm);
  }
  chartTimer += dt;
  if (chartTimer > 0.2) {
    chartTimer = 0;
    chart.draw(history);
    powerChart.draw(history);
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(() => {
  chart.resize();
  powerChart.resize();
  hud.update(state, layout, hydro, storm);
  const loading = document.getElementById('loading');
  if (loading) {
    loading.classList.add('done');
    setTimeout(() => loading.remove(), 700);
  }
  frame();
});
