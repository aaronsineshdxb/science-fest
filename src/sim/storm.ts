import { clamp, lerp, mulberry32, smoothstep } from '../core/rng';

export interface StormPreset {
  id: string;
  label: string;
  /** Peak intensity in mm/h. */
  peak: number;
  note: string;
}

export const STORM_PRESETS: StormPreset[] = [
  { id: 'drizzle', label: 'Drizzle', peak: 2.5, note: 'light, steady' },
  { id: 'steady', label: 'Steady rain', peak: 9, note: 'typical wet day' },
  { id: 'downpour', label: 'Downpour', peak: 32, note: 'tanks overflow' },
  { id: 'burst', label: 'Cloudburst', peak: 78, note: 'sewer surcharges' },
];

/**
 * Storm driver.
 *
 * Two modes:
 *  - `scripted`: a self-running storm front with a rise, a noisy plateau and
 *    a long tail. Used when the simulation is left to play itself.
 *  - `manual`: intensity is whatever the user sets on the slider.
 */
export class Storm {
  mode: 'scripted' | 'manual' = 'scripted';
  manualIntensity = 0;
  /** Peak intensity of the scripted front, mm/h. */
  scriptedPeak = 30;
  /** Sim minute the scripted front started from. */
  private origin = 0;
  private readonly seedRng = mulberry32(0x51f3);
  private readonly offsets: number[] = [];

  constructor() {
    for (let i = 0; i < 64; i++) this.offsets.push(this.seedRng() * 2 - 1);
  }

  /** Start a fresh scripted front at the given sim minute. */
  restart(peak: number, atMinute: number): void {
    this.scriptedPeak = peak;
    this.origin = atMinute;
    this.mode = 'scripted';
  }

  /** Smooth pseudo-random noise in [-1, 1] with a 7 minute correlation time. */
  private noise(minutes: number): number {
    const t = minutes / 7;
    const i = Math.floor(t);
    const f = t - i;
    const a = this.offsets[((i % 64) + 64) % 64];
    const b = this.offsets[(((i + 1) % 64) + 64) % 64];
    const s = f * f * (3 - 2 * f);
    return lerp(a, b, s);
  }

  /** Intensity in mm/h at a given sim minute. */
  intensity(minutes: number): number {
    if (this.mode === 'manual') return this.manualIntensity;
    const t = minutes - this.origin;
    const p = this.scriptedPeak;
    // Envelope: build -> peak -> decay -> drizzle tail.
    const build = smoothstep(0, 34, t);
    const decay = 1 - smoothstep(86, 190, t);
    const tail = 0.06 * (1 - smoothstep(190, 320, t));
    const env = Math.max(tail, build * decay);
    const gust = 1 + 0.34 * this.noise(t);
    const squall = 1 + 0.22 * Math.sin(t * 0.13) * (env > 0.05 ? 1 : 0);
    return clamp(p * env * gust * squall, 0, 120);
  }

  /** Human readable description of what the storm is doing right now. */
  describe(minutes: number): string {
    const i = this.intensity(minutes);
    if (i < 0.2) return 'Clear';
    if (i < 2) return 'Drizzle';
    if (i < 10) return 'Light rain';
    if (i < 25) return 'Moderate rain';
    if (i < 50) return 'Heavy rain';
    return 'Cloudburst';
  }
}
