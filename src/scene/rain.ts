import * as THREE from 'three';
import { mulberry32 } from '../core/rng';
import type { CityLayout } from '../sim/city';

const MAX_DROPS = 12000;
const FALL_HEIGHT = 96;
const HEIGHT_SCALE = 110;

const vertexShader = /* glsl */ `
precision highp float;
attribute float aEnd;
attribute float aSpeed;
attribute float aLen;
attribute float aSeed;

uniform float uTime;
uniform float uFall;
uniform float uWind;
uniform sampler2D uHeight;
uniform vec2 uGridMin;
uniform float uGridSize;
uniform float uHeightScale;

varying float vFade;

void main() {
  float y = mod(position.y - uTime * aSpeed, uFall);
  vec3 p = vec3(position.x, y, position.z);
  p.x += (uFall - y) * uWind * (0.4 + 0.6 * aSeed);

  vec2 uv = (p.xz - uGridMin) / uGridSize;
  float roof = texture2D(uHeight, clamp(uv, 0.001, 0.999)).r * uHeightScale;

  float top = y + aEnd * aLen;
  float fade = smoothstep(roof, roof + 1.2, top);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vFade = fade * smoothstep(2.0, 12.0, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
varying float vFade;
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  if (vFade <= 0.001) discard;
  gl_FragColor = vec4(uColor, vFade * uOpacity);
}
`;

export class Rain {
  readonly mesh: THREE.LineSegments;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private readonly rng = mulberry32(0x7a11);
  private active = 0;
  private paused = false;
  private time = 0;

  constructor(layout: CityLayout) {
    const positions = new Float32Array(MAX_DROPS * 2 * 3);
    const aEnd = new Float32Array(MAX_DROPS * 2);
    const aSpeed = new Float32Array(MAX_DROPS * 2);
    const aLen = new Float32Array(MAX_DROPS * 2);
    const aSeed = new Float32Array(MAX_DROPS * 2);

    const span = layout.extent + 60;
    for (let i = 0; i < MAX_DROPS; i++) {
      const x = (this.rng() - 0.5) * span;
      const z = (this.rng() - 0.5) * span;
      const phase = this.rng() * FALL_HEIGHT;
      const speed = 34 + this.rng() * 26;
      const len = 0.9 + this.rng() * 2.4;
      const seed = this.rng();
      for (let v = 0; v < 2; v++) {
        const idx = i * 2 + v;
        positions[idx * 3] = x;
        positions[idx * 3 + 1] = phase;
        positions[idx * 3 + 2] = z;
        aEnd[idx] = v;
        aSpeed[idx] = speed;
        aLen[idx] = len;
        aSeed[idx] = seed;
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('aEnd', new THREE.BufferAttribute(aEnd, 1));
    this.geometry.setAttribute('aSpeed', new THREE.BufferAttribute(aSpeed, 1));
    this.geometry.setAttribute('aLen', new THREE.BufferAttribute(aLen, 1));
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
    this.geometry.setDrawRange(0, 0);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1000);

    // Height field so drops stop on roofs.
    const size = layout.heightGridSize;
    const heightData = new Uint8Array(size * size);
    for (let i = 0; i < size * size; i++) {
      heightData[i] = Math.min(255, Math.round((layout.heightGrid[i] / HEIGHT_SCALE) * 255));
    }
    const heightTex = new THREE.DataTexture(heightData, size, size, THREE.RedFormat);
    heightTex.minFilter = THREE.LinearFilter;
    heightTex.magFilter = THREE.LinearFilter;
    heightTex.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uFall: { value: FALL_HEIGHT },
        uWind: { value: 0.055 },
        uHeight: { value: heightTex },
        uGridMin: { value: new THREE.Vector2(-layout.half, -layout.half) },
        uGridSize: { value: layout.extent },
        uHeightScale: { value: HEIGHT_SCALE },
        uColor: { value: new THREE.Color('#9fc4dd') },
        uOpacity: { value: 0.5 },
      },
    });

    this.mesh = new THREE.LineSegments(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  update(dt: number, intensity: number): void {
    if (!this.paused) this.time += dt;
    this.material.uniforms.uTime.value = this.time;

    const target = Math.min(1, Math.pow(intensity / 45, 0.62));
    this.active = Math.floor(MAX_DROPS * target);
    this.geometry.setDrawRange(0, this.active * 2);
    this.material.uniforms.uOpacity.value = 0.2 + 0.42 * Math.min(1, intensity / 40);
    this.material.uniforms.uWind.value = 0.045 + 0.03 * Math.sin(this.time * 0.11);
  }

  setPaused(v: boolean): void {
    this.paused = v;
  }
}
