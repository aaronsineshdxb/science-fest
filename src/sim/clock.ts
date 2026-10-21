/** The session starts late in the afternoon, with the lights still coming on. */
export const START_HOUR = 16.4;

export interface ClockParts {
  day: number;
  hour: number;
  minute: number;
}

/** Wall-clock time of the simulated session. */
export function simClock(minutes: number): ClockParts {
  const total = minutes + START_HOUR * 60;
  const day = Math.floor(total / 1440) + 1;
  const within = ((total % 1440) + 1440) % 1440;
  return { day, hour: Math.floor(within / 60), minute: Math.floor(within % 60) };
}

/** Sun elevation and azimuth for a given hour of day. */
export function sunAngles(hour: number): { elevation: number; azimuth: number } {
  const a = ((hour - 6) / 12) * Math.PI;
  return { elevation: Math.sin(a), azimuth: Math.cos(a) };
}

/** Fractional hour of the day for a given number of simulated minutes. */
export function simHour(minutes: number): number {
  return ((minutes / 60 + START_HOUR) % 24 + 24) % 24;
}

/** How dark it is: 0 in full sun, 1 in deep night. */
export function nightFactor(hour: number): number {
  const { elevation } = sunAngles(hour);
  const t = (0.06 - elevation) / 0.26;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

const SOLAR_CONSTANT = 1367;

/**
 * Clear-sky global horizontal irradiance in W/m².
 *
 * Kasten-Young relative air mass with an ASHRAE-style beam attenuation plus
 * a diffuse share. Cloud cover is applied by the caller.
 */
export function clearSkyIrradiance(hour: number): number {
  const { elevation } = sunAngles(hour);
  if (elevation <= 0.005) return 0;
  const airMass = 1 / (elevation + 0.50572 * Math.pow(elevation + 0.0001, -1.6364));
  const beam = SOLAR_CONSTANT * Math.pow(0.7, Math.pow(airMass, 0.678));
  return (beam * elevation + 0.12 * beam) * 0.92;
}
