import { clamp } from '../core/rng';
import { clearSkyIrradiance, nightFactor, simHour } from './clock';
import type { CityLayout } from './city';
import { pushLog } from './log';
import { PV_YIELD_KW_PER_M2, type PowerState, type SimState } from './types';

/** Water density (kg/m³) and gravity (m/s²). */
const RHO = 1000;
const G = 9.81;

/** Turbine efficiencies: a roof downspout is a rough place for a turbine. */
const DOWNSPOUT_EFFICIENCY = 0.62;
const RUNOFF_EFFICIENCY = 0.55;

/**
 * Net head of the runoff turbines: the district sits on a slope and the trunk
 * sewer drops to the outfall (m).
 */
const RUNOFF_HEAD = 12;

/** How much runoff the district turbine house can swallow (m³/h). */
export const RUNOFF_DIVERT_CAP = 1400;

/** District battery. */
const BATTERY_CAPACITY_KWH = 180;
const BATTERY_MAX_KW = 60;
const BATTERY_EFFICIENCY = 0.92;

/** Street lighting load at full night (kW). */
const LIGHTING_KW = 6;

/** Rain that puts the utility supply at risk (mm/h) and how long it must last. */
const TRIP_INTENSITY = 55;
const TRIP_MINUTES = 5;
const RESTORE_INTENSITY = 18;
const RESTORE_MINUTES = 10;

/** Fraction of the building load that can be shed before the district blacks out. */
const SHEDDABLE_SHARE = 0.45;

/**
 * The district microgrid.
 *
 * Two ways of making electricity out of the weather:
 *
 *   1. Rooftop photovoltaics, which follow the sun and die when the cloud
 *      comes in.
 *   2. The water the district catches. Every roof drains through a turbine
 *      in its downspout, and the runoff the streets cannot hold is diverted
 *      into a turbine house at the low point.
 *
 * A battery and the utility connection sit between them and the district
 * load, so the interesting moments are the storms: the panels go dark, the
 * supply trips, and whatever the water can make has to carry the district.
 */
export class PowerGrid {
  /** Total rated PV capacity of the district (kW). */
  readonly pvCapacityKw: number;
  /** Total rated output of the downspout turbines at full flow (kW). */
  readonly downspoutCapacityKw: number;
  /** Rated output of the runoff turbine house (kW). */
  readonly runoffCapacityKw: number;

  private lastWarn = -1e9;

  constructor(layout: CityLayout) {
    const buildings = layout.buildings;
    this.pvCapacityKw = buildings.reduce((s, b) => s + b.pvCapacityKw, 0);
    this.downspoutCapacityKw = buildings.reduce(
      (s, b) => s + turbinePower(b.downspoutCap, b.turbineHead, DOWNSPOUT_EFFICIENCY),
      0,
    );
    this.runoffCapacityKw = turbinePower(RUNOFF_DIVERT_CAP, RUNOFF_HEAD, RUNOFF_EFFICIENCY);
  }

  createState(): PowerState {
    return {
      solarKw: 0,
      hydroKw: 0,
      irradiance: 0,
      runoffKw: 0,
      downspoutKw: 0,
      generationKw: 0,
      demandKw: 0,
      lightingKw: 0,
      lightingFactor: 1,
      shedKw: 0,
      unmetKw: 0,
      gridKw: 0,
      islanded: false,
      batteryKwh: BATTERY_CAPACITY_KWH * 0.5,
      batteryCapacityKwh: BATTERY_CAPACITY_KWH,
      batteryPowerKw: 0,
      solarKwh: 0,
      hydroKwh: 0,
      demandKwh: 0,
      importKwh: 0,
      exportKwh: 0,
      selfSufficiency: 1,
      runTurbines: true,
      gridIsolated: false,
      runoffFlow: 0,
      spillReturn: 0,
      outageMinutes: 0,
      restoreMinutes: 0,
    };
  }

  /** Advance the grid by one frame. */
  step(state: SimState, dtReal: number): void {
    const power = state.power;
    const dtMin = state.paused ? 0 : dtReal * state.speed;
    const hour = simHour(state.minutes);

    // ---- photovoltaics ------------------------------------------------
    const ghi = clearSkyIrradiance(hour);
    const cloud = clamp(state.rain.intensity / 45, 0, 1);
    const irradiance = ghi * (1 - 0.72 * cloud);
    // Cell temperature rises with the irradiance and costs a little output.
    const cellTemp = 25 + 0.028 * irradiance;
    const derate = 1 - 0.0035 * Math.max(0, cellTemp - 25);
    const sunFactor = (irradiance / 1000) * derate;

    let solarKw = 0;
    for (const b of state.buildings) {
      const p = b.pvArea * PV_YIELD_KW_PER_M2 * sunFactor * b.pvShade;
      b.solarKw = p;
      solarKw += p;
    }

    // ---- hydro: the downspout turbines --------------------------------
    let downspoutKw = 0;
    for (const b of state.buildings) {
      const p = turbinePower(b.spoutFlow, b.turbineHead, DOWNSPOUT_EFFICIENCY);
      b.hydroKw = p;
      downspoutKw += p;
    }

    // ---- hydro: the runoff turbine house ------------------------------
    const runoffKw = power.runTurbines
      ? turbinePower(power.runoffFlow, RUNOFF_HEAD, RUNOFF_EFFICIENCY)
      : 0;
    const hydroKw = downspoutKw + runoffKw;

    // ---- demand -------------------------------------------------------
    const factor = loadFactor(hour);
    let buildingLoadKw = 0;
    for (const b of state.buildings) {
      b.loadKw = b.baseLoadKw * factor;
      buildingLoadKw += b.loadKw;
    }
    const lightingKw = LIGHTING_KW * nightFactor(hour);
    const demandKw = buildingLoadKw + lightingKw;
    power.lightingKw = lightingKw;
    power.lightingFactor = 1;

    // ---- utility connection -------------------------------------------
    this.updateConnection(state, dtMin);

    // ---- balance ------------------------------------------------------
    const generationKw = solarKw + hydroKw;
    const net = generationKw - demandKw;
    let shedKw = 0;
    let unmetKw = 0;
    let gridKw = 0;
    let batteryPowerKw = 0;

    if (net >= 0) {
      // Spare power fills the battery first, then goes out to the utility.
      const room = Math.max(0, power.batteryCapacityKwh - power.batteryKwh);
      const charge = Math.min(net, BATTERY_MAX_KW, room / Math.max(1e-6, hours(dtMin)));
      power.batteryKwh += charge * hours(dtMin);
      batteryPowerKw = charge;
      const surplus = net - charge;
      if (power.islanded) {
        gridKw = 0;
      } else {
        gridKw = surplus;
        power.exportKwh += surplus * hours(dtMin);
      }
    } else {
      const deficit = -net;
      const h = Math.max(1e-6, hours(dtMin));
      const drawn = Math.min(deficit, BATTERY_MAX_KW, (power.batteryKwh * BATTERY_EFFICIENCY) / h);
      power.batteryKwh = Math.max(0, power.batteryKwh - (drawn * h) / BATTERY_EFFICIENCY);
      batteryPowerKw = -drawn;
      const shortfall = deficit - drawn;

      if (power.islanded) {
        gridKw = 0;
        // Lights go out first, then the non-essential part of the building load.
        const shedLight = Math.min(shortfall, lightingKw);
        const shedBuild = Math.min(shortfall - shedLight, buildingLoadKw * SHEDDABLE_SHARE);
        shedKw = shedLight + shedBuild;
        unmetKw = shortfall - shedKw;
        if (shedBuild > 0 && buildingLoadKw > 0) {
          const keep = 1 - shedBuild / buildingLoadKw;
          for (const b of state.buildings) b.loadKw *= keep;
        }
        power.lightingKw = lightingKw - shedLight;
        power.lightingFactor = lightingKw > 0.001 ? (lightingKw - shedLight) / lightingKw : 1;
      } else {
        gridKw = -shortfall;
        power.importKwh += shortfall * hours(dtMin);
        power.lightingKw = lightingKw;
      }
    }

    for (const b of state.buildings) b.netKw = b.solarKw + b.hydroKw - b.loadKw;

    // ---- record -------------------------------------------------------
    power.solarKw = solarKw;
    power.hydroKw = hydroKw;
    power.irradiance = irradiance;
    power.downspoutKw = downspoutKw;
    power.runoffKw = runoffKw;
    power.generationKw = generationKw;
    power.demandKw = demandKw;
    power.shedKw = shedKw;
    power.unmetKw = unmetKw;
    power.gridKw = gridKw;
    power.batteryPowerKw = batteryPowerKw;
    power.selfSufficiency = demandKw > 0 ? clamp(generationKw / demandKw, 0, 1) : 1;
    power.solarKwh += solarKw * hours(dtMin);
    power.hydroKwh += hydroKw * hours(dtMin);
    power.demandKwh += demandKw * hours(dtMin);

    this.checkEvents(state);
  }

  /**
   * The utility supply goes down when the rain is heavy enough to flood a
   * substation, and comes back once the weather eases.
   */
  private updateConnection(state: SimState, dtMin: number): void {
    const power = state.power;
    if (power.gridIsolated) {
      power.islanded = true;
      power.outageMinutes = 0;
      power.restoreMinutes = 0;
      return;
    }

    if (power.islanded) {
      if (state.rain.intensity < RESTORE_INTENSITY) {
        power.restoreMinutes += dtMin;
        if (power.restoreMinutes >= RESTORE_MINUTES) {
          power.islanded = false;
          power.restoreMinutes = 0;
          pushLog(state, 'Utility supply restored — district is back on the grid', 'good');
        }
      } else {
        power.restoreMinutes = 0;
      }
      return;
    }

    if (state.rain.intensity > TRIP_INTENSITY) {
      power.outageMinutes += dtMin;
      if (power.outageMinutes >= TRIP_MINUTES) {
        power.islanded = true;
        power.outageMinutes = 0;
        pushLog(state, 'Substation flooded — utility supply lost, district is islanded', 'warn');
      }
    } else {
      power.outageMinutes = 0;
    }
  }

  private checkEvents(state: SimState): void {
    const power = state.power;
    if (power.unmetKw > 0.5 && state.minutes - this.lastWarn > 45) {
      this.lastWarn = state.minutes;
      pushLog(state, `District is short of power — ${power.unmetKw.toFixed(0)} kW of load shed`, 'warn');
    }
  }

  // ---- operator actions -----------------------------------------------

  /** Cut the district off from the utility, or put it back on. */
  toggleGrid(state: SimState): void {
    const power = state.power;
    power.gridIsolated = !power.gridIsolated;
    power.islanded = power.gridIsolated;
    power.restoreMinutes = 0;
    pushLog(
      state,
      power.gridIsolated
        ? 'District disconnected from the utility grid'
        : 'District reconnected to the utility grid',
      power.gridIsolated ? 'warn' : 'good',
    );
  }

  /** Send the street runoff through the district turbines, or bypass them. */
  toggleTurbines(state: SimState): void {
    const power = state.power;
    power.runTurbines = !power.runTurbines;
    pushLog(
      state,
      power.runTurbines
        ? 'Street runoff routed through the district turbines'
        : 'Runoff bypasses the turbines and goes straight to the sewer',
      power.runTurbines ? 'good' : 'info',
    );
  }
}

/** Power in kW from a flow in m³/h falling through a head in metres. */
function turbinePower(flowM3h: number, head: number, efficiency: number): number {
  if (flowM3h <= 0 || head <= 0) return 0;
  const q = flowM3h / 3600;
  return (RHO * G * q * head * efficiency) / 1000;
}

/** Simulated hours in a step. */
function hours(dtMin: number): number {
  return dtMin / 60;
}

/**
 * District electricity demand through the day: a quiet night, a morning
 * ramp, a working afternoon and a bigger evening peak.
 */
function loadFactor(hour: number): number {
  const bump = (c: number, w: number) => Math.exp(-((hour - c) ** 2) / (2 * w * w));
  return 0.34 + 0.62 * bump(7.6, 2.1) + 0.4 * bump(13, 3.4) + 0.78 * bump(19.4, 2.5);
}

/** A power state with no district behind it, used before the grid is built. */
export function emptyPowerState(): PowerState {
  return {
    solarKw: 0,
    hydroKw: 0,
    irradiance: 0,
    runoffKw: 0,
    downspoutKw: 0,
    generationKw: 0,
    demandKw: 0,
    shedKw: 0,
    unmetKw: 0,
    gridKw: 0,
    islanded: false,
    batteryKwh: BATTERY_CAPACITY_KWH * 0.5,
    batteryCapacityKwh: BATTERY_CAPACITY_KWH,
    batteryPowerKw: 0,
    solarKwh: 0,
    hydroKwh: 0,
    demandKwh: 0,
    importKwh: 0,
    exportKwh: 0,
    selfSufficiency: 1,
    runTurbines: true,
    gridIsolated: false,
    runoffFlow: 0,
    spillReturn: 0,
    outageMinutes: 0,
    restoreMinutes: 0,
    lightingKw: 0,
    lightingFactor: 1,
  };
}
