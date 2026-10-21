import * as THREE from 'three';
import { mulberry32 } from '../core/rng';
import type { CityLayout } from '../sim/city';

const MAX_RIPPLES = 640;
const LIFE = 0.85;

const vertexShader = /* glsl */ `
precision highp float;
attribute vec2 aCenter;
attribute float aStart;

uniform float uTime;
uniform float uLife;
uniform float uSize;

varying vec2 vUv;
varying float vAge;

void main() {
  vUv = uv;
  float age = uTime - aStart;
  vAge = age;
  if (age < 0.0 || age > uLife) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float t = age / uLife;
  float r = uSize * (0.25 + 1.75 * t);
  vec3 p = vec3(aCenter.x + (position.x - 0.5) * 2.0 * r, 0.06, aCenter.y + (position.y - 0.5) * 2.0 * r);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying float vAge;
uniform float uLife;
uniform float uOpacity;

void main() {
  if (vAge < 0.0 || vAge > uLife) discard;
  float t = vAge / uLife;
  float r = length(vUv * 2.0 - 1.0);
  float ring = smoothstep(0.62, 0.86, r) * smoothstep(1.0, 0.88, r);
  float core = smoothstep(0.35, 0.0, r) * (1.0 - t) * 0.5;
  float alpha = (ring + core) * (1.0 - t) * (1.0 - t);
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(vec3(0.62, 0.78, 0.9), alpha * uOpacity);
}
`;

export class Splashes {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly starts: Float32Array;
  private readonly centers: Float32Array;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly rng = mulberry32(0x4d2c);
  private readonly streetPoints: Float32Array;
  private time = 0;
  private cursor = 0;
  private carry = 0;
  private paused = false;

  constructor(layout: CityLayout) {
    const size = layout.heightGridSize;
    const points: number[] = [];
    for (let iz = 0; iz < size; iz++) {
      for (let ix = 0; ix < size; ix++) {
        if (layout.heightGrid[iz * size + ix] > 0.05) continue;
        const x = layout.heightGridMin + (ix + 0.5) * layout.heightGridCell;
        const z = layout.heightGridMin + (iz + 0.5) * layout.heightGridCell;
        points.push(x, z);
      }
    }
    this.streetPoints = new Float32Array(points.length > 0 ? points : [0, 0]);

    this.centers = new Float32Array(MAX_RIPPLES * 2);
    this.starts = new Float32Array(MAX_RIPPLES).fill(-1000);

    const base = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = base.index;
    this.geometry.setAttribute('position', base.attributes.position);
    this.geometry.setAttribute('uv', base.attributes.uv);
    this.geometry.setAttribute('aCenter', new THREE.InstancedBufferAttribute(this.centers, 2));
    this.geometry.setAttribute('aStart', new THREE.InstancedBufferAttribute(this.starts, 1));
    this.geometry.instanceCount = MAX_RIPPLES;

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: LIFE },
        uSize: { value: 1.5 },
        uOpacity: { value: 0.5 },
      },
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  update(dt: number, intensity: number): void {
    if (!this.paused) this.time += dt;
    this.material.uniforms.uTime.value = this.time;

    const rate = Math.pow(Math.max(0, intensity) / 30, 0.75) * 90;
    this.carry += rate * dt;
    const count = Math.floor(this.carry);
    this.carry -= count;

    const pointCount = this.streetPoints.length / 2;
    for (let i = 0; i < count && i < 60; i++) {
      const idx = this.cursor % MAX_RIPPLES;
      const p = Math.floor(this.rng() * pointCount) * 2;
      this.centers[idx * 2] = this.streetPoints[p] + (this.rng() - 0.5) * 1.2;
      this.centers[idx * 2 + 1] = this.streetPoints[p + 1] + (this.rng() - 0.5) * 1.2;
      this.starts[idx] = this.time;
      this.cursor++;
    }
    if (count > 0) {
      (this.geometry.attributes.aCenter as THREE.InstancedBufferAttribute).needsUpdate = true;
      (this.geometry.attributes.aStart as THREE.InstancedBufferAttribute).needsUpdate = true;
    }

    this.material.uniforms.uOpacity.value = 0.22 + 0.5 * Math.min(1, intensity / 35);
  }

  setPaused(v: boolean): void {
    this.paused = v;
  }
}
