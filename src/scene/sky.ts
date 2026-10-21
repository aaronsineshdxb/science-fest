import * as THREE from 'three';

const vertexShader = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
varying vec3 vDir;

uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uCloud;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uTime;
uniform float uFlash;
uniform float uStorm;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    v += amp * noise(p);
    p = p * 2.03 + vec2(11.7, 3.1);
    amp *= 0.5;
  }
  return v;
}

void main() {
  vec3 dir = normalize(vDir);
  float h = clamp(dir.y, -1.0, 1.0);

  // Base gradient.
  float t = smoothstep(-0.12, 0.75, h);
  vec3 col = mix(uHorizon, uZenith, t);

  // Warm scatter around the sun, strongest near the horizon.
  float sun = max(dot(dir, normalize(uSunDir)), 0.0);
  col += uSunColor * pow(sun, 6.0) * 0.45;
  col += uSunColor * pow(sun, 1.6) * 0.08 * (1.0 - t);

  // Cloud deck projected onto a dome.
  float above = max(h, 0.035);
  vec2 cp = dir.xz / above;
  cp = cp * 0.55 + vec2(uTime * 0.011, uTime * 0.006);
  float density = fbm(cp * 1.35);
  density = smoothstep(0.42 - uStorm * 0.22, 0.92, density);
  density *= smoothstep(0.0, 0.22, h);
  vec3 cloudCol = mix(uCloud * 1.12, uCloud * 0.62, density);
  col = mix(col, cloudCol, density * (0.55 + 0.4 * uStorm));

  // Lightning wash.
  col += vec3(0.62, 0.70, 0.95) * uFlash * (0.35 + 0.9 * density);

  gl_FragColor = vec4(col, 1.0);
}
`;

export class Sky {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(radius = 1400) {
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uHorizon: { value: new THREE.Color('#4a5566') },
        uZenith: { value: new THREE.Color('#141b26') },
        uCloud: { value: new THREE.Color('#5b6474') },
        uSunDir: { value: new THREE.Vector3(0.3, 0.2, -1) },
        uSunColor: { value: new THREE.Color('#ffb066') },
        uTime: { value: 0 },
        uFlash: { value: 0 },
        uStorm: { value: 0.5 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
  }

  update(time: number, flash: number, storminess: number): void {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uFlash.value = flash;
    this.material.uniforms.uStorm.value = storminess;
  }

  set palette(p: { horizon: string; zenith: string; cloud: string; sun: string }) {
    (this.material.uniforms.uHorizon.value as THREE.Color).set(p.horizon);
    (this.material.uniforms.uZenith.value as THREE.Color).set(p.zenith);
    (this.material.uniforms.uCloud.value as THREE.Color).set(p.cloud);
    (this.material.uniforms.uSunColor.value as THREE.Color).set(p.sun);
  }

  setSun(dir: THREE.Vector3): void {
    (this.material.uniforms.uSunDir.value as THREE.Vector3).copy(dir);
  }
}
