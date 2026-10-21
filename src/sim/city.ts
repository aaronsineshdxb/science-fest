import { clamp, intRange, mulberry32, range, type Rng } from '../core/rng';
import { PV_YIELD_KW_PER_M2, ROOF_SPECS, type Building, type RoofType } from './types';

export interface Block {
  index: number;
  col: number;
  row: number;
  x: number;
  z: number;
  size: number;
  kind: 'built' | 'park' | 'civic';
}

export interface Tree {
  x: number;
  z: number;
  r: number;
  h: number;
}

export interface Lamp {
  x: number;
  z: number;
}

export interface CityLayout {
  seed: number;
  grid: number;
  blockSize: number;
  street: number;
  pitch: number;
  half: number;
  extent: number;
  blocks: Block[];
  buildings: Building[];
  trees: Tree[];
  lamps: Lamp[];
  /** Position of the shared district reservoir (under the park plaza). */
  reservoir: { x: number; z: number; radius: number };
  /** Park block (rain garden / irrigable green space). */
  park: { x: number; z: number; size: number };
  /** Height lookup grid used for rain collision. */
  heightGrid: Float32Array;
  heightGridSize: number;
  heightGridCell: number;
  heightGridMin: number;
  totalRoofArea: number;
  streetArea: number;
}

const GRID = 5;
const BLOCK_SIZE = 42;
const STREET = 15;
const PITCH = BLOCK_SIZE + STREET;

interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

function subdivide(rng: Rng, rect: Rect, out: Rect[], depth: number): void {
  const min = 15;
  if (depth > 3 || (rect.w < min * 2 && rect.d < min * 2)) {
    out.push(rect);
    return;
  }
  const splitX = rect.w >= rect.d;
  const t = range(rng, 0.38, 0.62);
  if (splitX) {
    const w1 = rect.w * t;
    if (w1 < min || rect.w - w1 < min) {
      out.push(rect);
      return;
    }
    subdivide(rng, { ...rect, w: w1 }, out, depth + 1);
    subdivide(rng, { ...rect, x: rect.x + w1, w: rect.w - w1 }, out, depth + 1);
  } else {
    const d1 = rect.d * t;
    if (d1 < min || rect.d - d1 < min) {
      out.push(rect);
      return;
    }
    subdivide(rng, { ...rect, d: d1 }, out, depth + 1);
    subdivide(rng, { ...rect, z: rect.z + d1, d: rect.d - d1 }, out, depth + 1);
  }
}

const ROOF_WEIGHTS: { type: RoofType; weight: number }[] = [
  { type: 'metal', weight: 34 },
  { type: 'concrete', weight: 30 },
  { type: 'gravel', weight: 18 },
  { type: 'green', weight: 18 },
];

function pickRoof(rng: Rng, height: number): RoofType {
  // Tall towers rarely have green roofs; low buildings often do.
  const table = ROOF_WEIGHTS.map((r) => {
    if (r.type === 'green') return { type: r.type, weight: r.weight * (height < 26 ? 1.9 : 0.25) };
    if (r.type === 'gravel') return { type: r.type, weight: r.weight * (height < 26 ? 1.4 : 0.7) };
    return r;
  });
  const total = table.reduce((s, r) => s + r.weight, 0);
  let roll = rng() * total;
  for (const r of table) {
    roll -= r.weight;
    if (roll <= 0) return r.type;
  }
  return 'concrete';
}

export function generateCity(seed = 20260421): CityLayout {
  const rng = mulberry32(seed);
  const extent = GRID * PITCH - STREET;
  const half = extent / 2;

  const blocks: Block[] = [];
  const parkIndex = intRange(rng, 0, GRID * GRID - 1);
  let civicIndex = intRange(rng, 0, GRID * GRID - 1);
  if (civicIndex === parkIndex) civicIndex = (civicIndex + 1) % (GRID * GRID);

  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const index = row * GRID + col;
      const cx = -half + STREET / 2 + col * PITCH + BLOCK_SIZE / 2;
      const cz = -half + STREET / 2 + row * PITCH + BLOCK_SIZE / 2;
      const kind: Block['kind'] =
        index === parkIndex ? 'park' : index === civicIndex ? 'civic' : 'built';
      blocks.push({ index, col, row, x: cx, z: cz, size: BLOCK_SIZE, kind });
    }
  }

  const buildings: Building[] = [];
  const trees: Tree[] = [];
  const lamps: Lamp[] = [];
  let id = 0;

  for (const block of blocks) {
    const blockLabel = `${String.fromCharCode(65 + block.col)}${block.row + 1}`;

    if (block.kind === 'park') {
      // Rain garden: an open green square that accepts street runoff.
      const count = intRange(rng, 14, 22);
      for (let i = 0; i < count; i++) {
        trees.push({
          x: block.x + range(rng, -block.size / 2 + 3, block.size / 2 - 3),
          z: block.z + range(rng, -block.size / 2 + 3, block.size / 2 - 3),
          r: range(rng, 1.6, 3.4),
          h: range(rng, 4, 8.5),
        });
      }
      continue;
    }

    const isCivic = block.kind === 'civic';
    const lots: Rect[] = [];
    const inset = isCivic ? 6 : 3;
    subdivide(
      rng,
      { x: block.x - block.size / 2 + inset, z: block.z - block.size / 2 + inset, w: block.size - inset * 2, d: block.size - inset * 2 },
      lots,
      0,
    );

    for (const lot of lots) {
      const margin = range(rng, 1.5, 4.5);
      const w = Math.max(8, lot.w - margin * 2);
      const d = Math.max(8, lot.d - margin * 2);
      const x = lot.x + lot.w / 2;
      const z = lot.z + lot.d / 2;

      let h: number;
      if (isCivic) {
        h = range(rng, 16, 26);
      } else {
        const roll = rng();
        // A handful of towers break up the skyline.
        h = roll > 0.93 ? range(rng, 44, 78) : 7 + Math.pow(rng(), 2.1) * 36;
      }

      const roof = isCivic ? 'green' : pickRoof(rng, h);
      const roofArea = w * d;
      const coefficient = ROOF_SPECS[roof].coefficient;
      const cisternCap = clamp(roofArea * 0.055, 5, 42);

      // The solar retrofit: flat, unshaded roofs with a workable area get an
      // array. Green roofs and tight plots are skipped.
      const pvEligible = roof !== 'green' && roofArea >= 140 && rng() > 0.58;
      const pvArea = pvEligible ? roofArea * range(rng, 0.12, 0.22) : 0;

      buildings.push({
        id: id++,
        name: `${blockLabel} · ${String.fromCharCode(65 + (id - 1) % 26)}${Math.floor((id - 1) / 26) + 1}`,
        block: blockLabel,
        x,
        z,
        w,
        d,
        h,
        roof,
        roofArea,
        coefficient,
        cisternCap,
        cistern: 0,
        baseDemand: 0.004 + roofArea * 0.00016,
        downspoutCap: 2.2 + roofArea * 0.004,
        capture: 0,
        spoutFlow: 0,
        inflow: 0,
        overflow: 0,
        toDistrict: 0,
        served: 0,
        unmet: 0,
        turbineHead: Math.max(1.5, h - 3),
        pvArea,
        pvCapacityKw: pvArea * PV_YIELD_KW_PER_M2,
        pvShade: 1,
        baseLoadKw: 0.12 + roofArea * 0.0012,
        solarKw: 0,
        hydroKw: 0,
        loadKw: 0,
        netKw: 0,
        capturedTotal: 0,
        overflowTotal: 0,
        usedTotal: 0,
        greenRoof: roof === 'green',
        hasTank: cisternCap >= 6,
        _surplus: 0,
        _shed: 0,
      });
    }
  }

  // Street lamps along the avenues.
  for (let i = 0; i <= GRID; i++) {
    const p = -half + STREET / 2 + i * PITCH - STREET / 2;
    for (let j = 0; j < GRID * 2; j++) {
      const t = -half + (j + 0.5) * (extent / (GRID * 2));
      lamps.push({ x: p, z: t });
      lamps.push({ x: t, z: p });
    }
  }

  const parkBlock = blocks.find((b) => b.kind === 'park')!;
  const reservoir = { x: parkBlock.x + 7, z: parkBlock.z + 7, radius: 11 };

  const totalRoofArea = buildings.reduce((s, b) => s + b.roofArea, 0);

  computeShading(buildings);

  // Impervious surface: streets + block paving minus the park and roofs.
  const streetArea = Math.max(1, extent * extent - totalRoofArea - parkBlock.size * parkBlock.size);

  const layout: CityLayout = {
    seed,
    grid: GRID,
    blockSize: BLOCK_SIZE,
    street: STREET,
    pitch: PITCH,
    half,
    extent,
    blocks,
    buildings,
    trees,
    lamps,
    reservoir,
    park: { x: parkBlock.x, z: parkBlock.z, size: parkBlock.size },
    heightGrid: new Float32Array(0),
    heightGridSize: 0,
    heightGridCell: 0,
    heightGridMin: 0,
    totalRoofArea,
    streetArea,
  };

  buildHeightGrid(layout);
  return layout;
}

/**
 * Work out how much sky each roof can still see.
 *
 * A tower surrounded by taller towers gets a poor array; a low building on
 * the edge of the district keeps most of its daylight. The result scales the
 * PV output of every building.
 */
function computeShading(buildings: Building[]): void {
  const REACH = 45;
  for (const b of buildings) {
    let blocked = 0;
    for (const o of buildings) {
      if (o === b) continue;
      const taller = o.h - b.h;
      if (taller <= 0) continue;
      const dx = Math.max(0, Math.abs(o.x - b.x) - (o.w + b.w) / 2);
      const dz = Math.max(0, Math.abs(o.z - b.z) - (o.d + b.d) / 2);
      const dist = Math.hypot(dx, dz);
      if (dist >= REACH) continue;
      blocked += (taller / REACH) * (1 - dist / REACH);
    }
    b.pvShade = clamp(1 - blocked * 0.38, 0.3, 1);
  }
}

/**
 * Coarse height field of the city so the rain shader can stop drops on roofs.
 * One texel holds the tallest building footprint covering that cell.
 */
function buildHeightGrid(layout: CityLayout): void {
  const size = 192;
  const cell = layout.extent / size;
  const grid = new Float32Array(size * size);
  const min = -layout.half;

  for (const b of layout.buildings) {
    const x0 = Math.max(0, Math.floor((b.x - b.w / 2 - min) / cell));
    const x1 = Math.min(size - 1, Math.ceil((b.x + b.w / 2 - min) / cell));
    const z0 = Math.max(0, Math.floor((b.z - b.d / 2 - min) / cell));
    const z1 = Math.min(size - 1, Math.ceil((b.z + b.d / 2 - min) / cell));
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const i = iz * size + ix;
        if (b.h > grid[i]) grid[i] = b.h;
      }
    }
  }

  layout.heightGrid = grid;
  layout.heightGridSize = size;
  layout.heightGridCell = cell;
  layout.heightGridMin = min;
}
