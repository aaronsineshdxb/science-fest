export type RoofType = 'green' | 'metal' | 'concrete' | 'gravel';

export interface RoofSpec {
  type: RoofType;
  /** Fraction of rainfall that becomes runoff (1 - losses). */
  coefficient: number;
  label: string;
}

export const ROOF_SPECS: Record<RoofType, RoofSpec> = {
  green: { type: 'green', coefficient: 0.28, label: 'Green roof' },
  metal: { type: 'metal', coefficient: 0.95, label: 'Standing-seam metal' },
  concrete: { type: 'concrete', coefficient: 0.83, label: 'Concrete deck' },
  gravel: { type: 'gravel', coefficient: 0.89, label: 'Ballast / gravel' },
};

/**
 * Module efficiency and performance ratio of the district's PV.
 */
export const MODULE_EFFICIENCY = 0.21;
export const PERFORMANCE_RATIO = 0.8;

/**
 * Peak yield of a PV array in kW per m² of panel:
 * 1000 W/m² of irradiance × module efficiency × performance ratio.
 */
export const PV_YIELD_KW_PER_M2 = MODULE_EFFICIENCY * PERFORMANCE_RATIO;

/** A single building with its own roof catchment and cistern. */
export interface Building {
  id: number;
  name: string;
  block: string;
  /** Footprint centre. */
  x: number;
  z: number;
  /** Footprint size (m). */
  w: number;
  d: number;
  /** Height (m). */
  h: number;
  roof: RoofType;
  roofArea: number;
  coefficient: number;
  /** Cistern capacity (m³). */
  cisternCap: number;
  /** Water currently stored (m³). */
  cistern: number;
  /** Base demand (m³/h) before the diurnal pattern. */
  baseDemand: number;
  /** Capacity of the downspout run (m³/h). */
  downspoutCap: number;
  /** Live flow values (m³/h). */
  capture: number;
  /** Flow through the downspout itself (m³/h) - the turbine taps this. */
  spoutFlow: number;
  inflow: number;
  overflow: number;
  toDistrict: number;
  served: number;
  unmet: number;
  /** Net head available to the downspout turbine (m). */
  turbineHead: number;
  /** Area of the PV array on the roof (m²). */
  pvArea: number;
  /** Rated capacity of the PV array (kW at 1000 W/m²). */
  pvCapacityKw: number;
  /** Shading factor from taller neighbours, 0.3 (deep shade) to 1 (open sky). */
  pvShade: number;
  /** Electrical demand at full load (kW). */
  baseLoadKw: number;
  /** Live electrical values (kW). */
  solarKw: number;
  hydroKw: number;
  loadKw: number;
  /** Net contribution to the district grid: positive exports, negative draws. */
  netKw: number;
  /** Cumulative counters (m³). */
  capturedTotal: number;
  overflowTotal: number;
  usedTotal: number;
  greenRoof: boolean;
  hasTank: boolean;
  /** Internal: water leaving the building towards the district main (m³). */
  _surplus: number;
  /** Internal: water that exceeded the downspout capacity (m³). */
  _shed: number;
}

export interface DistrictTank {
  capacity: number;
  stored: number;
  inflow: number;
  outflow: number;
  overflow: number;
  served: number;
  capturedTotal: number;
  overflowTotal: number;
  usedTotal: number;
}

export interface SewerState {
  /** m³/h the pipe network can carry before it surcharges. */
  capacity: number;
  /** Current inflow to the sewer (m³/h). */
  flow: number;
  /** Water standing on the street surface (m³). */
  floodVolume: number;
  /** Fraction of the impervious street area that is under water. */
  floodedFraction: number;
  /** Mean depth of standing water (mm). */
  depth: number;
  overflowTotal: number;
}

export interface RainState {
  /** Instantaneous intensity (mm/h). */
  intensity: number;
  /** Accumulated depth over the session (mm). */
  totalDepth: number;
  /** Total volume that fell on the district (m³). */
  totalVolume: number;
  /** Volume that hit the ground and not a roof (m³). */
  groundVolume: number;
}

/**
 * The district microgrid.
 *
 * Two ways of making electricity out of the weather: rooftop photovoltaics and
 * the water the district catches. Everything else - the battery, the utility
 * connection - is there to make those two worth having.
 */
export interface PowerState {
  /** Instantaneous generation (kW). */
  solarKw: number;
  hydroKw: number;
  /** Live irradiance on the rooftops (W/m²). */
  irradiance: number;
  /** Generation split (kW). */
  runoffKw: number;
  downspoutKw: number;
  /** Total generation (kW). */
  generationKw: number;
  /** District demand before any shedding (kW). */
  demandKw: number;
  /** Street lighting load actually served (kW). */
  lightingKw: number;
  /** Share of the street lighting that is still on, 0 to 1. */
  lightingFactor: number;
  /** Load shed because the district ran short (kW). */
  shedKw: number;
  /** Demand that could not be met at all (kW). */
  unmetKw: number;
  /** Net exchange with the utility: positive exports, negative imports. */
  gridKw: number;
  /** True when the district is cut off from the utility. */
  islanded: boolean;
  /** Battery state of charge and rated capacity (kWh). */
  batteryKwh: number;
  batteryCapacityKwh: number;
  /** Battery power: positive charging, negative discharging (kW). */
  batteryPowerKw: number;
  /** Energy counters (kWh). */
  solarKwh: number;
  hydroKwh: number;
  demandKwh: number;
  importKwh: number;
  exportKwh: number;
  /** Share of the demand met from local generation (0-1). */
  selfSufficiency: number;
  /** Operator switch: route street runoff through the district turbines. */
  runTurbines: boolean;
  /** Operator switch: hold the district off the utility. */
  gridIsolated: boolean;
  /** Live flow through the runoff turbines (m³/h). */
  runoffFlow: number;
  /** Internal: runoff held at the turbine house, released into the sewer next step (m³). */
  spillReturn: number;
  /** Internal: minutes the storm has been over the trip threshold. */
  outageMinutes: number;
  /** Internal: minutes the rain has eased enough to restore the supply. */
  restoreMinutes: number;
}

export interface SimState {
  /** Simulated minutes since session start. */
  minutes: number;
  /** Simulated minutes per real second. */
  speed: number;
  paused: boolean;
  buildings: Building[];
  tank: DistrictTank;
  sewer: SewerState;
  rain: RainState;
  power: PowerState;
  /** Sum of all roof catchment areas (m²). */
  totalRoofArea: number;
  /** Weighted average runoff coefficient. */
  avgCoefficient: number;
  /** Area of the impervious surface network (m²). */
  streetArea: number;
  /** Non-negative per-building demand not yet met (m³/h). */
  parkGreenness: number;
  log: LogEntry[];
}

export interface LogEntry {
  t: number;
  text: string;
  kind: 'info' | 'warn' | 'good';
}

/** One sample of the storm timeline, used by the chart. */
export interface HistorySample {
  minutes: number;
  intensity: number;
  stored: number;
  storedCapacity: number;
  captured: number;
  overflow: number;
  solarKw: number;
  hydroKw: number;
  demandKw: number;
}
