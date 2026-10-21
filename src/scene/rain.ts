import * as THREE from 'three';
import { mulberry32 } from '../core/rng';
import type { CityLayout } from '../sim/city';

const MAX_DROPS = 9000;
const FALL_HEIGHT = 96;
const HEIGHT_SCALE = 110;

const vertexShader = /* glsl */ `
precision highp float;

attribute vec3 aBase;
attribute float aSpeed;
attribute float aLen;
attribute float aWidth;
attribute float aSeed;

uniform float uTime;
uniform float uFall;
uniform float uWind;
uniform sampler2D uHeight;
uniform vec2 uGridMin;
uniform float uGridSize;
uniform float uHeightScale;

varying vec2 vQuad;
varying float vFade;

void main() {
  float y = mod(aBase.y - uTime * aSpeed, uFall);

  // The streak leans downwind.
  vec3 dir = normalize(vec3(-uWind * 1.6, -1.0, 0.0));
  vec3 p = vec3(aBase.x, y, aBase.z);

  vec2 uv = (p.xz - uGridMin) / uGridSize;
  float roof = texture2D(uHeight, clamp(uv, 0.001, 0.999)).r * uHeightScale;

  // Drops stop when they reach whatever is under them.
  float bottom = y + position.y * aLen;
  float head = y + (position.y + 0.5) * aLen;
  float fade = smoothstep(roof, roof + 1.4, head) * step(roof - 0.2, bottom);

  vec3 toCamera = normalize(cameraPosition - p);
  vec3 side = normalize(cross(dir, toCamera));

  vec3 world = p + side * (position.x * aWidth) + dir * (position.y * aLen);

  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  vFade = fade * smoothstep(1.5, 9.0, -mv.z);
  vQuad = vec2(position.x * 2.0, position.y + 0.5);
  gl_Position = projectionMatrix * mv;
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
varying vec2 vQuad;
varying float vFade;
uniform vec3 uColor;
uniform float uOpacity;

void main() {
  if (vFade <= 0.002) discard;
  // Soft across the streak, fading towards its tail.
  float across = 1.0 - abs(vQuad.x);
  float along = smoothstep(0.0, 0.45, vQuad.y);
  float alpha = across * across * along * vFade * uOpacity;
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(uColor, alpha);
}
`;

export class Rain {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly rng = mulberry32(0x7a11);
  private active = 0;
  private paused = false;
  private time = 0;

  constructor(layout: CityLayout) {
    const base = new Float32Array(MAX_DROPS * 3);
    const speed = new Float32Array(MAX_DROPS);
    const len = new Float32Array(MAX_DROPS);
    const width = new Float32Array(MAX_DROPS);
    const seed = new Float32Array(MAX_DROPS);

    const span = layout.extent + 70;
    for (let i = 0; i < MAX_DROPS; i++) {
      base[i * 3] = (this.rng() - 0.5) * span;
      base[i * 3 + 1] = this.rng() * FALL_HEIGHT;
      base[i * 3 + 2] = (this.rng() - 0.5) * span;
      speed[i] = 32 + this.rng() * 26;
      len[i] = 1.6 + this.rng() * 3.4;
      width[i] = 0.035 + this.rng() * 0.05;
      seed[i] = this.rng();
    }

    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = quad.index;
    this.geometry.setAttribute('position', quad.attributes.position);
    this.geometry.setAttribute('uv', quad.attributes.uv);
    this.geometry.setAttribute('aBase', new THREE.InstancedBufferAttribute(base, 3));
    this.geometry.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(speed, 1));
    this.geometry.setAttribute('aLen', new THREE.InstancedBufferAttribute(len, 1));
    this.geometry.setAttribute('aWidth', new THREE.InstancedBufferAttribute(width, 1));
    this.geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
    this.geometry.instanceCount = 0;

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
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uFall: { value: FALL_HEIGHT },
        uWind: { value: 0.055 },
        uHeight: { value: heightTex },
        uGridMin: { value: new THREE.Vector2(-layout.half, -layout.half) },
        uGridSize: { value: layout.extent },
        uHeightScale: { value: HEIGHT_SCALE },
        uColor: { value: new THREE.Color('#cfe4f5') },
        uOpacity: { value: 0.55 },
      },
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  update(dt: number, intensity: number): void {
    if (!this.paused) this.time += dt;
    this.material.uniforms.uTime.value = this.time;

    const target = Math.min(1, Math.pow(Math.max(intensity, 0.2) / 40, 0.6));
    this.active = Math.floor(MAX_DROPS * target);
    this.geometry.instanceCount = this.active;
    this.material.uniforms.uOpacity.value = 0.34 + 0.5 * Math.min(1, intensity / 40);
    this.material.uniforms.uWind.value = 0.05 + 0.035 * Math.sin(this.time * 0.11);
  }

  setPaused(v: boolean): void {
    this.paused = v;
  }
}
