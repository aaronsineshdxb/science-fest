import { clamp } from '../core/rng';
import type { CityLayout } from './city';
import { pushLog } from './log';
import { RUNOFF_DIVERT_CAP, emptyPowerState } from './power';
import type { Storm } from './storm';
import type { LogEntry, PowerState, SimState } from './types';

export { pushLog };
export type { LogEntry };

/**
 * Hydrology of the district.
 *
 *   rain -> roof catchment -> downspout -> building cistern -> district main
 *        -> district reservoir -> demand (potable substitution, irrigation,
 *           street washing) and finally the municipal sewer.
 *
 * Everything is expressed in m³ and m³/h. 1 mm of rain over 1 m² is 0.001 m³.
 */
export class Hydrology {
  /** Capacity of the shared main between building cisterns and the reservoir (m³/h). */
  readonly mainThroughput: number;
  /** Maximum the district reservoir can push back into the network (m³/h). */
  readonly reservoirOutflow: number;
  /** Infiltration of standing water into the ground (mm/h). */
  readonly infiltration: number;
  readonly sewerCapacity: number;
  readonly districtCapacity: number;

  constructor(layout: CityLayout) {
    const coeff = avgCoefficient(layout);
    const captureAt = (mmh: number) => (layout.totalRoofArea * mmh * coeff) / 1000;

    // Sewers are sized for a fairly ordinary wet day; anything heavier surcharges.
    this.sewerCapacity = captureAt(7) * 0.95;
    // The reservoir holds roughly eight hours of a solid 30 mm/h downpour.
    this.districtCapacity = captureAt(30) * 8;
    this.mainThroughput = this.districtCapacity * 0.35;
    this.reservoirOutflow = this.districtCapacity * 0.035;
    this.infiltration = 2.4;
  }

  createState(layout: CityLayout, power: PowerState = emptyPowerState()): SimState {
    const buildings = layout.buildings.map((b) => ({ ...b, _surplus: 0, _shed: 0 }));
    return {
      minutes: 0,
      speed: 12,
      paused: false,
      buildings,
      tank: {
        capacity: this.districtCapacity,
        stored: 0,
        inflow: 0,
        outflow: 0,
        overflow: 0,
        served: 0,
        capturedTotal: 0,
        overflowTotal: 0,
        usedTotal: 0,
      },
      sewer: {
        capacity: this.sewerCapacity,
        flow: 0,
        floodVolume: 0,
        floodedFraction: 0,
        depth: 0,
        overflowTotal: 0,
      },
      rain: {
        intensity: 0,
        totalDepth: 0,
        totalVolume: 0,
        groundVolume: 0,
      },
      power,
      totalRoofArea: layout.totalRoofArea,
      avgCoefficient: avgCoefficient(layout),
      streetArea: layout.streetArea,
      parkGreenness: 0.55,
      log: [],
    };
  }

  step(state: SimState, layout: CityLayout, storm: Storm, dtReal: number): void {
    const dtMin = state.paused ? 0 : dtReal * state.speed;
    if (dtMin <= 0) {
      state.rain.intensity = storm.intensity(state.minutes);
      return;
    }
    state.minutes += dtMin;
    const h = dtMin / 60;

    // ---- rainfall on the district -------------------------------------
    const intensity = storm.intensity(state.minutes);
    state.rain.intensity = intensity;
    const rainOnDistrict = (intensity * layout.extent * layout.extent * h) / 1000;
    state.rain.totalVolume += rainOnDistrict;
    state.rain.totalDepth += intensity * h;
    state.rain.groundVolume += (intensity * state.streetArea * h) / 1000;

    const diurnal = demandFactor(state.minutes / 60);

    // ---- pass 1: catch the rain on the roofs --------------------------
    let surplusTotal = 0;
    let shedTotal = 0;
    for (const b of state.buildings) {
      const potential = (intensity * b.roofArea * b.coefficient * h) / 1000;
      const throughSpout = Math.min(potential, b.downspoutCap * h);
      const space = Math.max(0, b.cisternCap - b.cistern);
      const inflow = Math.min(throughSpout, space);

      b.cistern += inflow;
      b.capturedTotal += inflow;
      b.inflow = inflow / h;
      b.capture = potential / h;
      // What actually went down the pipe, whether or not it fitted in the tank.
      b.spoutFlow = throughSpout / h;

      // Water the building could not keep leaves through the main...
      b._surplus = throughSpout - inflow;
      surplusTotal += b._surplus;
      // ...and water beyond the downspout capacity spills over the gutter.
      b._shed = potential - throughSpout;
      b.overflow = b._shed / h;
      b.overflowTotal += b._shed;
      shedTotal += b._shed;
    }

    // ---- pass 2: the district main and reservoir ------------------------
    const tank = state.tank;
    const room = Math.max(0, tank.capacity - tank.stored);
    const absorb = Math.min(surplusTotal, room, this.mainThroughput * h);
    if (absorb > 0 && surplusTotal > 0) {
      const ratio = absorb / surplusTotal;
      for (const b of state.buildings) {
        const moved = b._surplus * ratio;
        b.toDistrict = moved / h;
        b._surplus -= moved;
      }
    }
    tank.stored += absorb;
    tank.capturedTotal += absorb;
    tank.inflow = absorb / h;

    // Whatever the main could not take goes down the sewer.
    let toSewer = shedTotal;
    for (const b of state.buildings) {
      b.overflow += b._surplus / h;
      b.overflowTotal += b._surplus;
      toSewer += b._surplus;
      b._surplus = 0;
    }
    // A full reservoir is the reason that surplus exists.
    const reservoirFull = room <= 1e-6 && surplusTotal > 0;
    tank.overflow = reservoirFull ? toSewer - shedTotal : 0;
    tank.overflowTotal += tank.overflow;

    // ---- pass 3: demand -------------------------------------------------
    let unmet = 0;
    for (const b of state.buildings) {
      const demand = b.baseDemand * diurnal;
      const fromOwn = Math.min(demand * h, b.cistern);
      b.cistern -= fromOwn;
      b.served = fromOwn / h;
      b.usedTotal += fromOwn;
      const stillNeeded = demand * h - fromOwn;
      unmet += stillNeeded;
      b.unmet = stillNeeded / h;
    }

    // Buildings that are dry draw from the district reservoir.
    const reservoirDraw = Math.min(unmet, tank.stored, this.reservoirOutflow * h);
    tank.stored -= reservoirDraw;
    tank.outflow = reservoirDraw / h;
    tank.served = reservoirDraw / h;
    tank.usedTotal += reservoirDraw;
    const stillUnmet = unmet - reservoirDraw;

    // ---- pass 4: the sewer ---------------------------------------------
    const sewer = state.sewer;
    // The district turbine house takes a slice of the runoff on its way to the
    // sewer and releases it again on the next step, which takes the peak off
    // the storm drainage while the plant is running.
    const power = state.power;
    const returned = power.spillReturn;
    const diverted = power.runTurbines ? Math.min(Math.max(0, toSewer), RUNOFF_DIVERT_CAP * h) : 0;
    power.spillReturn = diverted;
    power.runoffFlow = diverted / h;

    sewer.flow = (toSewer - diverted + returned) / h;
    sewer.overflowTotal += toSewer;

    const excess = Math.max(0, sewer.flow - sewer.capacity);
    sewer.floodVolume += excess * h;

    // Rain gardens and permeable ground soak up part of what ponds.
    const soak = ((this.infiltration * state.streetArea) / 1000) * h;
    sewer.floodVolume = Math.max(0, sewer.floodVolume - soak);

    const pondCapacity = state.streetArea * 0.0022;
    sewer.floodedFraction = clamp(sewer.floodVolume / Math.max(1, pondCapacity), 0, 1);
    sewer.depth = (sewer.floodVolume / Math.max(1, state.streetArea)) * 1000;

    // Green space dries out unless it is irrigated.
    state.parkGreenness = clamp(state.parkGreenness - 0.0025 * h, 0, 1);

    this.checkEvents(state, excess, stillUnmet);
  }

  private lastWarn = -1e9;

  private checkEvents(state: SimState, sewerExcess: number, unmet: number): void {
    const t = state.minutes;
    if (sewerExcess > 0 && t - this.lastWarn > 45) {
      this.lastWarn = t;
      pushLog(state, 'Sewer at capacity — water is ponding on the street', 'warn');
    }
    if (unmet > 0.2 && t - this.lastWarn > 120) {
      pushLog(state, 'Demand exceeds stored water — draw is short', 'warn');
    }
  }

  /** Manual operator actions. */
  washStreets(state: SimState): boolean {
    const tank = state.tank;
    const wanted = 2.5;
    const taken = Math.min(wanted, tank.stored);
    if (taken <= 0.01) {
      pushLog(state, 'No stored water available for street washing', 'warn');
      return false;
    }
    tank.stored -= taken;
    tank.usedTotal += taken;
    state.sewer.floodVolume = Math.max(0, state.sewer.floodVolume - taken);
    pushLog(state, `Street washing used ${taken.toFixed(1)} m³`, 'good');
    return true;
  }

  irrigatePark(state: SimState): boolean {
    const tank = state.tank;
    const wanted = 0.9;
    const taken = Math.min(wanted, tank.stored);
    if (taken <= 0.01) {
      pushLog(state, 'Reservoir empty — park irrigation refused', 'warn');
      return false;
    }
    tank.stored -= taken;
    tank.usedTotal += taken;
    state.parkGreenness = clamp(state.parkGreenness + 0.22, 0, 1);
    pushLog(state, `Park irrigated with ${taken.toFixed(1)} m³`, 'good');
    return true;
  }
}

function avgCoefficient(layout: CityLayout): number {
  const total = layout.buildings.reduce((s, b) => s + b.roofArea * b.coefficient, 0);
  return layout.totalRoofArea > 0 ? total / layout.totalRoofArea : 0.8;
}

/** Two daily demand humps: a morning peak and a bigger evening one. */
function demandFactor(hourOfDay: number): number {
  const h = ((hourOfDay % 24) + 24) % 24;
  const bump = (c: number, w: number) => Math.exp(-((h - c) ** 2) / (2 * w * w));
  return 0.5 + 0.62 * bump(7.5, 2.2) + 0.78 * bump(19, 2.6);
}
