import type { CityLayout } from '../sim/city';
import { simClock } from '../sim/clock';
import type { Hydrology } from '../sim/hydrology';
import type { Storm } from '../sim/storm';
import type { Building, SimState } from '../sim/types';
import { ROOF_SPECS } from '../sim/types';

export interface HudHandlers {
  onMode: (mode: 'scripted' | 'manual') => void;
  onPreset: (id: string) => void;
  onIntensity: (value: number) => void;
  onSpeed: (value: number) => void;
  onPause: () => void;
  onXray: () => void;
  onWash: () => void;
  onIrrigate: () => void;
  onToggleTurbines: () => void;
  onToggleGrid: () => void;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

function fmt(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return value.toFixed(digits);
}

export class Hud {
  private readonly clock = $('clock');
  private readonly dayLabel = $('dayLabel');
  private readonly stormLabel = $('stormLabel');
  private readonly intensityValue = $('intensityValue');
  private readonly intensityBar = $('intensityBar');
  private readonly slider = $<HTMLInputElement>('intensity');
  private readonly sliderValue = $('sliderValue');
  private readonly pauseBtn = $<HTMLButtonElement>('pauseBtn');
  private readonly xrayBtn = $<HTMLButtonElement>('xrayBtn');
  private readonly modeSwitch = $('modeSwitch');
  private readonly speedSwitch = $('speedSwitch');
  private readonly presets = $('presets');
  private readonly log = $('log');
  private readonly inspectorTitle = $('inspectorTitle');
  private readonly inspectorBody = $('inspectorBody');
  private readonly values = {
    rain: $('v-rain'),
    harvest: $('v-harvest'),
    used: $('v-used'),
    sewer: $('v-sewer'),
    stored: $('v-stored'),
    flood: $('v-flood'),
    efficiency: $('v-efficiency'),
    coverage: $('v-coverage'),
    sewerLoad: $('v-sewerload'),
    generation: $('v-gen'),
    load: $('v-load'),
    battery: $('v-batt'),
    solar: $('v-solar'),
    hydro: $('v-hydro'),
    selfSufficiency: $('v-selfsuf'),
    grid: $('v-grid'),
  };
  private readonly bars = {
    harvest: $('b-harvest'),
    stored: $('b-stored'),
    flood: $('b-flood'),
    solar: $('b-solar'),
    hydro: $('b-hydro'),
    load: $('b-load'),
    battery: $('b-batt'),
  };
  private readonly turbineBtn = $<HTMLButtonElement>('turbineBtn');
  private readonly gridBtn = $<HTMLButtonElement>('gridBtn');

  private selected: Building | null = null;
  private lastLogLength = -1;

  constructor(handlers: HudHandlers) {
    this.modeSwitch.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('button');
      if (!target) return;
      const mode = target.dataset.mode as 'scripted' | 'manual';
      this.setModeButtons(mode);
      handlers.onMode(mode);
    });

    this.presets.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('button');
      if (!target?.dataset.preset) return;
      handlers.onPreset(target.dataset.preset);
    });

    this.slider.addEventListener('input', () => {
      const value = Number(this.slider.value);
      this.sliderValue.textContent = `${value.toFixed(0)} mm/h`;
      this.setModeButtons('manual');
      handlers.onIntensity(value);
    });

    this.speedSwitch.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('button');
      if (!target?.dataset.speed) return;
      for (const b of this.speedSwitch.querySelectorAll('button')) b.classList.remove('active');
      target.classList.add('active');
      handlers.onSpeed(Number(target.dataset.speed));
    });

    this.pauseBtn.addEventListener('click', () => handlers.onPause());
    this.xrayBtn.addEventListener('click', () => handlers.onXray());
    $('washBtn').addEventListener('click', () => handlers.onWash());
    $('irrigateBtn').addEventListener('click', () => handlers.onIrrigate());
    this.turbineBtn.addEventListener('click', () => handlers.onToggleTurbines());
    this.gridBtn.addEventListener('click', () => handlers.onToggleGrid());
  }

  /** Reflect the state of the power plant controls. */
  setPowerControls(runTurbines: boolean, islanded: boolean): void {
    this.turbineBtn.classList.toggle('on', runTurbines);
    this.gridBtn.classList.toggle('on', islanded);
    this.gridBtn.textContent = islanded ? 'Reconnect grid' : 'Island grid';
  }

  setModeButtons(mode: string): void {
    for (const b of this.modeSwitch.querySelectorAll('button')) {
      b.classList.toggle('active', b.getAttribute('data-mode') === mode);
    }
  }

  setPaused(paused: boolean): void {
    this.pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    this.pauseBtn.classList.toggle('on', paused);
  }

  setXray(on: boolean): void {
    this.xrayBtn.classList.toggle('on', on);
  }

  setManualIntensity(value: number): void {
    this.slider.value = String(value);
    this.sliderValue.textContent = `${value.toFixed(0)} mm/h`;
  }

  setSelected(building: Building | null): void {
    this.selected = building;
  }

  update(state: SimState, layout: CityLayout, hydro: Hydrology, storm: Storm): void {
    const clock = simClock(state.minutes);
    this.clock.textContent = `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
    this.dayLabel.textContent = `Day ${clock.day}`;
    this.stormLabel.textContent = storm.describe(state.minutes);

    const intensity = state.rain.intensity;
    this.intensityValue.innerHTML = `${intensity.toFixed(1)} <i>mm/h</i>`;
    this.intensityBar.style.width = `${Math.min(100, (intensity / 80) * 100)}%`;

    const harvested =
      state.buildings.reduce((s, b) => s + b.capturedTotal, 0) + state.tank.capturedTotal;
    const used = state.buildings.reduce((s, b) => s + b.usedTotal, 0) + state.tank.usedTotal;
    const toSewer = state.sewer.overflowTotal;
    const stored =
      state.buildings.reduce((s, b) => s + b.cistern, 0) + state.tank.stored;
    const capacity =
      state.buildings.reduce((s, b) => s + b.cisternCap, 0) + state.tank.capacity;

    this.values.rain.textContent = fmt(state.rain.totalVolume);
    this.values.harvest.textContent = fmt(harvested);
    this.values.used.textContent = fmt(used);
    this.values.sewer.textContent = fmt(toSewer);
    this.values.stored.textContent = fmt(stored);
    this.values.flood.textContent = fmt(state.sewer.floodedFraction * 100);

    const eff = state.rain.totalVolume > 0 ? (harvested / state.rain.totalVolume) * 100 : 0;
    this.values.efficiency.textContent = `${eff.toFixed(0)}%`;
    const demand = used + state.buildings.reduce((s, b) => s + b.unmet, 0);
    this.values.coverage.textContent = `${demand > 0 ? (used / demand) * 100 : 100}%`;
    this.values.sewerLoad.textContent = `${((state.sewer.flow / Math.max(1, state.sewer.capacity)) * 100).toFixed(0)}%`;

    this.bars.harvest.style.width = `${Math.min(100, eff)}%`;
    this.bars.stored.style.width = `${Math.min(100, (stored / Math.max(1, capacity)) * 100)}%`;
    this.bars.flood.style.width = `${Math.min(100, state.sewer.floodedFraction * 100)}%`;

    this.renderPower(state);

    this.renderInspector(state, layout, hydro);
    this.renderLog(state);
  }

  /** The district grid panel. */
  private renderPower(state: SimState): void {
    const power = state.power;
    const mix = Math.max(0.001, power.generationKw);

    this.setPowerControls(power.runTurbines, power.islanded);

    this.values.generation.textContent = fmt(power.generationKw, power.generationKw < 10 ? 1 : 0);
    this.values.load.textContent = fmt(power.demandKw, power.demandKw < 10 ? 1 : 0);

    const soc = (power.batteryKwh / Math.max(1, power.batteryCapacityKwh)) * 100;
    this.values.battery.textContent = `${soc.toFixed(0)}%`;

    this.values.solar.textContent = `${power.solarKw.toFixed(1)} kW`;
    this.values.hydro.textContent = `${power.hydroKw.toFixed(1)} kW`;
    this.values.selfSufficiency.textContent = `${(power.selfSufficiency * 100).toFixed(0)}%`;

    if (power.islanded) {
      this.values.grid.textContent = power.unmetKw > 0.05 ? 'islanded, short' : 'islanded';
    } else if (power.gridKw >= 0) {
      this.values.grid.textContent = `exporting ${power.gridKw.toFixed(0)} kW`;
    } else {
      this.values.grid.textContent = `importing ${(-power.gridKw).toFixed(0)} kW`;
    }

    // The generation bar splits into solar and hydro.
    this.bars.solar.style.width = `${(power.solarKw / mix) * 100}%`;
    this.bars.hydro.style.width = `${(power.hydroKw / mix) * 100}%`;
    this.bars.load.style.width = `${Math.min(100, (power.demandKw / Math.max(1, power.demandKw + Math.max(0, power.gridKw))) * 100)}%`;
    this.bars.battery.style.width = `${Math.max(0, Math.min(100, soc))}%`;
  }

  private renderInspector(state: SimState, layout: CityLayout, hydro: Hydrology): void {
    const b = this.selected;
    const pvPeak = state.buildings.reduce((s, x) => s + x.pvCapacityKw, 0);
    if (!b) {
      this.inspectorTitle.textContent = 'District';
      this.inspectorBody.innerHTML = `
        <p class="empty">${layout.buildings.length} buildings · ${(layout.totalRoofArea / 1000).toFixed(1)}k m² of roof.
        Click a building to follow its catchment, cistern and overflow.</p>
        <dl>
          <div><dt>Roof area</dt><dd>${fmt(layout.totalRoofArea)} m²</dd></div>
          <div><dt>Mean runoff coefficient</dt><dd>${state.avgCoefficient.toFixed(2)}</dd></div>
          <div><dt>District reservoir</dt><dd>${fmt(state.tank.capacity)} m³</dd></div>
          <div><dt>Reservoir level</dt><dd>${fmt(state.tank.stored)} m³</dd></div>
          <div><dt>Sewer capacity</dt><dd>${fmt(hydro.sewerCapacity)} m³/h</dd></div>
          <div><dt>Street area</dt><dd>${fmt(state.streetArea)} m²</dd></div>
          <div><dt>Standing water</dt><dd>${state.sewer.depth.toFixed(1)} mm</dd></div>
          <div><dt>PV capacity</dt><dd>${pvPeak.toFixed(0)} kW peak</dd></div>
          <div><dt>Runoff through turbines</dt><dd>${state.power.runoffFlow.toFixed(0)} m³/h</dd></div>
        </dl>`;
      return;
    }

    const roof = ROOF_SPECS[b.roof];
    const fill = b.cisternCap > 0 ? b.cistern / b.cisternCap : 0;
    const chips: string[] = [];
    if (b.greenRoof) chips.push('<span class="chip good">green roof</span>');
    if (b.pvArea > 0) chips.push('<span class="chip good">pv array</span>');
    if (b.overflow > 0.01) chips.push('<span class="chip warn">overflowing</span>');
    if (b.cistern > b.cisternCap * 0.9) chips.push('<span class="chip warn">cistern full</span>');
    if (b.unmet > 0.001) chips.push('<span class="chip warn">demand short</span>');
    if (b.netKw > 0.01) chips.push('<span class="chip good">exporting</span>');
    else if (b.netKw < -0.01) chips.push('<span class="chip warn">on grid</span>');

    this.inspectorTitle.textContent = b.name;
    this.inspectorBody.innerHTML = `
      <dl>
        <div><dt>Roof</dt><dd>${roof.label}</dd></div>
        <div><dt>Catchment</dt><dd>${fmt(b.roofArea)} m²</dd></div>
        <div><dt>Runoff coefficient</dt><dd>${b.coefficient.toFixed(2)}</dd></div>
        <div><dt>Captured now</dt><dd>${b.capture.toFixed(2)} m³/h</dd></div>
        <div><dt>Into cistern</dt><dd>${b.inflow.toFixed(2)} m³/h</dd></div>
        <div><dt>To district main</dt><dd>${b.toDistrict.toFixed(2)} m³/h</dd></div>
        <div><dt>Overflow</dt><dd>${b.overflow.toFixed(2)} m³/h</dd></div>
        <div><dt>Demand</dt><dd>${b.served.toFixed(3)} m³/h</dd></div>
        <div><dt>PV array</dt><dd>${b.pvArea > 0 ? `${Math.round(b.pvArea)} m²` : 'none'}</dd></div>
        <div><dt>Solar now</dt><dd>${b.solarKw.toFixed(2)} kW</dd></div>
        <div><dt>Turbine head</dt><dd>${b.turbineHead.toFixed(1)} m</dd></div>
        <div><dt>Downspout turbine</dt><dd>${b.hydroKw.toFixed(2)} kW</dd></div>
        <div><dt>Net to grid</dt><dd>${b.netKw.toFixed(2)} kW</dd></div>
      </dl>
      <div class="tank">
        <div class="tank-track"><span style="width:${Math.min(100, fill * 100).toFixed(1)}%"></span></div>
        <div class="tank-label"><span>cistern</span><span>${b.cistern.toFixed(1)} / ${b.cisternCap.toFixed(0)} m³</span></div>
      </div>
      <div class="chips">${chips.join('')}</div>`;
  }

  private renderLog(state: SimState): void {
    if (state.log.length === this.lastLogLength) return;
    this.lastLogLength = state.log.length;
    const items = state.log.slice(0, 6);
    this.log.innerHTML = items
      .map((entry) => {
        const t = simClock(entry.t);
        return `<li class="${entry.kind}"><time>${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}</time>${entry.text}</li>`;
      })
      .join('');
  }
}
