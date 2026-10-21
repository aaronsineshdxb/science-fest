import * as THREE from 'three';
import { mulberry32 } from '../core/rng';
import type { CityLayout } from '../sim/city';

const WET_SIZE = 192;
const TEX_SIZE = 2048;
const MARGIN = 44;

const COLORS = {
  asphalt: '#1b1e23',
  asphaltWorn: '#232730',
  surroundings: '#141619',
  pavement: '#31353c',
  kerb: '#454a52',
  lane: '#c8c2a8',
  laneWhite: '#9aa0a6',
  grass: '#3c6b33',
  grassDark: '#2d5228',
  plaza: '#3a3e45',
};

/** Canvas painting of the whole district: streets, pavement, park, markings. */
export function paintCityTexture(layout: CityLayout): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d')!;
  const rng = mulberry32(layout.seed ^ 0x9e37);

  const span = layout.extent + MARGIN * 2;
  const scale = TEX_SIZE / span;
  const toPx = (v: number) => (v + layout.half + MARGIN) * scale;

  ctx.fillStyle = COLORS.surroundings;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  // Asphalt everywhere inside the district.
  ctx.fillStyle = COLORS.asphalt;
  ctx.fillRect(toPx(-layout.half), toPx(-layout.half), layout.extent * scale, layout.extent * scale);

  // Grain on the asphalt.
  ctx.save();
  ctx.beginPath();
  ctx.rect(toPx(-layout.half), toPx(-layout.half), layout.extent * scale, layout.extent * scale);
  ctx.clip();
  for (let i = 0; i < 26000; i++) {
    const x = rng() * TEX_SIZE;
    const y = rng() * TEX_SIZE;
    const a = rng() * 0.055;
    ctx.fillStyle = rng() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 1.4})`;
    ctx.fillRect(x, y, 1 + rng() * 2.5, 1 + rng() * 2.5);
  }
  ctx.restore();

  // Pavement + kerb around every block.
  for (const block of layout.blocks) {
    const half = block.size / 2;
    const x = toPx(block.x - half - 3);
    const y = toPx(block.z - half - 3);
    const s = (block.size + 6) * scale;
    ctx.fillStyle = COLORS.kerb;
    ctx.fillRect(x, y, s, s);
    ctx.fillStyle = block.kind === 'park' ? COLORS.grassDark : COLORS.pavement;
    ctx.fillRect(x + 3 * scale, y + 3 * scale, s - 6 * scale, s - 6 * scale);
  }

  // The park gets a lawn with a path and a plaza over the reservoir.
  const park = layout.park;
  ctx.save();
  ctx.beginPath();
  ctx.rect(toPx(park.x - park.size / 2), toPx(park.z - park.size / 2), park.size * scale, park.size * scale);
  ctx.clip();
  for (let i = 0; i < 9000; i++) {
    const x = toPx(park.x - park.size / 2) + rng() * park.size * scale;
    const y = toPx(park.z - park.size / 2) + rng() * park.size * scale;
    ctx.fillStyle = `rgba(${20 + rng() * 30},${70 + rng() * 50},${25 + rng() * 25},0.5)`;
    ctx.fillRect(x, y, 2, 2);
  }
  ctx.restore();

  const plaza = layout.reservoir;
  ctx.beginPath();
  ctx.arc(toPx(plaza.x), toPx(plaza.z), plaza.radius * scale, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.plaza;
  ctx.fill();
  ctx.strokeStyle = '#585e68';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Lane markings along every avenue.
  ctx.strokeStyle = COLORS.lane;
  ctx.lineWidth = Math.max(1, 0.32 * scale);
  ctx.setLineDash([6 * scale, 7 * scale]);
  for (let i = 0; i <= layout.grid; i++) {
    const p = -layout.half + layout.street / 2 + i * layout.pitch - layout.street / 2;
    ctx.beginPath();
    ctx.moveTo(toPx(p), toPx(-layout.half));
    ctx.lineTo(toPx(p), toPx(layout.half));
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(toPx(-layout.half), toPx(p));
    ctx.lineTo(toPx(layout.half), toPx(p));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Kerb edges.
  ctx.strokeStyle = COLORS.kerb;
  ctx.lineWidth = Math.max(1, 0.45 * scale);
  for (const block of layout.blocks) {
    const half = block.size / 2 + 3;
    ctx.strokeRect(toPx(block.x - half), toPx(block.z - half), half * 2 * scale, half * 2 * scale);
  }

  // Crosswalks at intersections.
  ctx.fillStyle = 'rgba(190,196,205,0.55)';
  for (let i = 0; i <= layout.grid; i++) {
    for (let j = 0; j <= layout.grid; j++) {
      const p = -layout.half + layout.street / 2 + i * layout.pitch - layout.street / 2;
      const q = -layout.half + layout.street / 2 + j * layout.pitch - layout.street / 2;
      if (Math.abs(p) > layout.half + 1 || Math.abs(q) > layout.half + 1) continue;
      for (let s = 0; s < 5; s++) {
        const off = (s - 2) * 2.1 * scale;
        ctx.fillRect(toPx(p) - 3 * scale, toPx(q) + off - 0.5 * scale, 6 * scale, 1 * scale);
        ctx.fillRect(toPx(q) + off - 0.5 * scale, toPx(p) - 3 * scale, 1 * scale, 6 * scale);
      }
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

export class Ground {
  readonly group = new THREE.Group();
  readonly cityMesh: THREE.Mesh;
  readonly outsideMesh: THREE.Mesh;
  readonly wetTexture: THREE.DataTexture;
  private readonly wetData: Uint8Array;
  private readonly streetMask: Float32Array;
  private readonly pattern: Float32Array;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly outsideMaterial: THREE.MeshStandardMaterial;
  private accumulator = 0;

  constructor(layout: CityLayout) {
    const span = layout.extent + MARGIN * 2;
    const citySize = layout.extent + MARGIN * 2;

    this.wetData = new Uint8Array(WET_SIZE * WET_SIZE * 4);
    this.streetMask = new Float32Array(WET_SIZE * WET_SIZE);
    this.pattern = new Float32Array(WET_SIZE * WET_SIZE);

    // Static masks: where water can pond (streets) and a soft patchiness field.
    const rng = mulberry32(layout.seed ^ 0x51ab);
    const noise = new Float32Array(64 * 64);
    for (let i = 0; i < noise.length; i++) noise[i] = rng();
    const sample = (u: number, v: number) => {
      const x = u * 63;
      const y = v * 63;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const g = (a: number, b: number) => noise[((b % 64) + 64) % 64 * 64 + (((a % 64) + 64) % 64)];
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      const top = g(x0, y0) * (1 - sx) + g(x0 + 1, y0) * sx;
      const bot = g(x0, y0 + 1) * (1 - sx) + g(x0 + 1, y0 + 1) * sx;
      return top * (1 - sy) + bot * sy;
    };

    for (let iz = 0; iz < WET_SIZE; iz++) {
      for (let ix = 0; ix < WET_SIZE; ix++) {
        const i = iz * WET_SIZE + ix;
        const wx = -layout.half + ((ix + 0.5) / WET_SIZE) * layout.extent;
        const wz = -layout.half + ((iz + 0.5) / WET_SIZE) * layout.extent;
        // Distance to the nearest block centre decides whether this is street.
        let onStreet = 1;
        for (const block of layout.blocks) {
          const dx = Math.abs(wx - block.x) - block.size / 2;
          const dz = Math.abs(wz - block.z) - block.size / 2;
          const outside = Math.max(dx, dz);
          if (outside < 1.5) onStreet = 0;
        }
        if (Math.abs(wx) > layout.half || Math.abs(wz) > layout.half) onStreet = 0;
        this.streetMask[i] = onStreet;
        const u = ix / WET_SIZE;
        const v = iz / WET_SIZE;
        this.pattern[i] = 0.35 + 0.65 * (0.6 * sample(u * 2, v * 2) + 0.4 * sample(u * 5, v * 5));
        const o = i * 4;
        this.wetData[o] = 0;
        this.wetData[o + 1] = 0;
        this.wetData[o + 2] = Math.round(onStreet * 255);
        this.wetData[o + 3] = 255;
      }
    }

    this.wetTexture = new THREE.DataTexture(this.wetData, WET_SIZE, WET_SIZE, THREE.RGBAFormat);
    this.wetTexture.needsUpdate = true;
    this.wetTexture.minFilter = THREE.LinearFilter;
    this.wetTexture.magFilter = THREE.LinearFilter;
    this.wetTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.wetTexture.wrapT = THREE.ClampToEdgeWrapping;

    const tex = paintCityTexture(layout);
    this.material = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.94,
      metalness: 0.02,
      envMapIntensity: 0.5,
    });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uWet = { value: this.wetTexture };
      shader.uniforms.uWetMin = { value: new THREE.Vector2(-layout.half, -layout.half) };
      shader.uniforms.uWetSize = { value: layout.extent };
      shader.uniforms.uGreen = { value: 0 };
      shader.uniforms.uFlood = { value: 0 };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vWPos;
           uniform sampler2D uWet;
           uniform vec2 uWetMin;
           uniform float uWetSize;
           uniform float uGreen;
           uniform float uFlood;`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           vec2 wetUv = (vWPos.xz - uWetMin) / uWetSize;
           float inCity = step(0.0, wetUv.x) * step(wetUv.x, 1.0) * step(0.0, wetUv.y) * step(wetUv.y, 1.0);
           vec4 wetSample = texture2D(uWet, clamp(wetUv, 0.0, 1.0));
           float wetness = wetSample.r * inCity;
           float puddle = wetSample.g * inCity;
           diffuseColor.rgb *= mix(1.0, 0.46, wetness);
           diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.72 + vec3(0.012, 0.026, 0.038), puddle * 0.85);
           float grass = smoothstep(0.015, 0.075, diffuseColor.g - max(diffuseColor.r, diffuseColor.b));
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.045, 0.115, 0.035), grass * uGreen * 0.8);`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           roughnessFactor = mix(roughnessFactor, 0.07, wetness * 0.85);
           roughnessFactor = mix(roughnessFactor, 0.015, puddle);
           roughnessFactor = clamp(roughnessFactor, 0.01, 1.0);`,
        );
      this.material.userData.shader = shader;
    };
    this.material.customProgramCacheKey = () => 'wet-ground-v1';

    this.outsideMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#101215'),
      roughness: 0.98,
      metalness: 0,
    });

    this.cityMesh = new THREE.Mesh(new THREE.PlaneGeometry(citySize, citySize), this.material);
    this.cityMesh.rotation.x = -Math.PI / 2;
    this.cityMesh.position.y = 0.02;
    this.cityMesh.receiveShadow = true;
    this.group.add(this.cityMesh);

    this.outsideMesh = new THREE.Mesh(new THREE.PlaneGeometry(2600, 2600), this.outsideMaterial);
    this.outsideMesh.rotation.x = -Math.PI / 2;
    this.outsideMesh.position.y = 0;
    this.outsideMesh.receiveShadow = false;
    this.group.add(this.outsideMesh);

    void span;
  }

  /** Rain wets the pavement; ponding water fills the low spots of the street. */
  update(dt: number, rainIntensity: number, floodedFraction: number, greenness: number): void {
    this.accumulator += dt;
    const shader = this.material.userData.shader as { uniforms: Record<string, { value: unknown }> } | undefined;
    if (shader) {
      shader.uniforms.uGreen.value = greenness;
      shader.uniforms.uFlood.value = floodedFraction;
    }
    if (this.accumulator < 0.05) return;
    const step = this.accumulator;
    this.accumulator = 0;

    const wetGain = rainIntensity > 0.2 ? Math.min(0.9, 0.16 + rainIntensity * 0.02) : 0;
    const dry = 0.012;
    const target = floodedFraction;

    for (let i = 0; i < this.streetMask.length; i++) {
      const o = i * 4;
      let wet = this.wetData[o] / 255;
      wet += wetGain * step - dry * step;
      wet = wet < 0 ? 0 : wet > 1 ? 1 : wet;
      this.wetData[o] = Math.round(wet * 255);

      const puddle = target * this.streetMask[i] * this.pattern[i];
      const cur = this.wetData[o + 1] / 255;
      const next = cur + (puddle - cur) * Math.min(1, step * 2.2);
      this.wetData[o + 1] = Math.round(next * 255);
    }
    this.wetTexture.needsUpdate = true;
  }

  setXray(amount: number): void {
    this.material.transparent = amount > 0.001;
    this.material.opacity = 1 - amount * 0.82;
    this.material.depthWrite = amount < 0.05;
    this.outsideMaterial.transparent = amount > 0.001;
    this.outsideMaterial.opacity = 1 - amount * 0.9;
    this.material.needsUpdate = true;
    this.outsideMaterial.needsUpdate = true;
  }
}
