import * as THREE from 'three';
import type { CityLayout } from '../sim/city';
import type { SimState } from '../sim/types';

const PARTICLES_PER_BUILDING = 9;

interface PipeRun {
  curve: THREE.CatmullRomCurve3;
  points: THREE.Vector3[];
  buildingId: number;
}

export class WaterNetwork {
  readonly group = new THREE.Group();
  private readonly shellMat: THREE.MeshStandardMaterial;
  private readonly waterMat: THREE.MeshStandardMaterial;
  private readonly pipeMat: THREE.MeshStandardMaterial;
  private readonly cisterns = new Map<number, THREE.Mesh>();
  private readonly waters = new Map<number, THREE.Mesh>();
  private readonly runs: PipeRun[] = [];
  private readonly particles: THREE.Points;
  private readonly particlePositions: Float32Array;
  private readonly particleAlpha: Float32Array;
  private readonly particleBuilding: number[];
  private readonly particleProgress: number[];
  private readonly reservoirWater: THREE.Mesh;
  private readonly reservoirShell: THREE.Mesh;
  private readonly flowMaterial: THREE.ShaderMaterial;
  private xray = 0;

  constructor(layout: CityLayout) {
    this.group.visible = false;

    this.shellMat = new THREE.MeshStandardMaterial({
      color: '#333a44',
      roughness: 0.7,
      metalness: 0.1,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.waterMat = new THREE.MeshStandardMaterial({
      color: '#1d6f8c',
      emissive: new THREE.Color('#0d4358'),
      roughness: 0.12,
      metalness: 0.1,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    });
    this.pipeMat = new THREE.MeshStandardMaterial({
      color: '#4c5765',
      roughness: 0.45,
      metalness: 0.6,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });

    const unitBox = new THREE.BoxGeometry(1, 1, 1);

    for (const b of layout.buildings) {
      const cw = Math.min(b.w * 0.62, 13);
      const cd = Math.min(b.d * 0.62, 13);
      const depth = 3.4;

      const shell = new THREE.Mesh(unitBox, this.shellMat);
      shell.scale.set(cw, depth, cd);
      shell.position.set(b.x, -depth / 2 - 0.4, b.z);
      this.group.add(shell);
      this.cisterns.set(b.id, shell);

      const water = new THREE.Mesh(unitBox, this.waterMat);
      water.scale.set(cw * 0.94, 0.001, cd * 0.94);
      water.position.set(b.x, -depth - 0.4 + 0.001, b.z);
      this.group.add(water);
      this.waters.set(b.id, water);

      // Downspout at a corner, then the run to the district main.
      const cornerX = b.x + b.w / 2 - 0.4;
      const cornerZ = b.z + b.d / 2 - 0.4;
      const sx = nearestStreet(layout, b.x);
      const sz = nearestStreet(layout, b.z);
      const res = layout.reservoir;

      const points = [
        new THREE.Vector3(cornerX, b.h + 0.4, cornerZ),
        new THREE.Vector3(cornerX, b.h * 0.5, cornerZ),
        new THREE.Vector3(cornerX, 0.6, cornerZ),
        new THREE.Vector3(b.x, -1.2, b.z),
        new THREE.Vector3(b.x, -3.6, b.z),
        new THREE.Vector3(sx, -3.6, b.z),
        new THREE.Vector3(sx, -3.6, sz),
        new THREE.Vector3(res.x, -3.6, sz),
        new THREE.Vector3(res.x, -3.6, res.z),
        new THREE.Vector3(res.x, -1.5, res.z),
      ];
      const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.4);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.26, 6, false), this.pipeMat);
      this.group.add(tube);
      this.runs.push({ curve, points: curve.getPoints(48), buildingId: b.id });
    }

    // District reservoir under the park plaza.
    const res = layout.reservoir;
    const resGeo = new THREE.CylinderGeometry(res.radius, res.radius, 7, 40, 1, true);
    this.reservoirShell = new THREE.Mesh(resGeo, this.shellMat);
    this.reservoirShell.position.set(res.x, -3.6, res.z);
    this.group.add(this.reservoirShell);

    const resBottom = new THREE.Mesh(new THREE.CircleGeometry(res.radius, 40), this.shellMat);
    resBottom.rotation.x = -Math.PI / 2;
    resBottom.position.set(res.x, -7.1, res.z);
    this.group.add(resBottom);

    this.reservoirWater = new THREE.Mesh(new THREE.CylinderGeometry(res.radius * 0.97, res.radius * 0.97, 1, 40), this.waterMat);
    this.reservoirWater.position.set(res.x, -6.9, res.z);
    this.group.add(this.reservoirWater);

    // Flow particles.
    const total = layout.buildings.length * PARTICLES_PER_BUILDING;
    this.particlePositions = new Float32Array(total * 3);
    this.particleAlpha = new Float32Array(total);
    this.particleBuilding = [];
    this.particleProgress = [];
    let i = 0;
    for (const b of layout.buildings) {
      for (let p = 0; p < PARTICLES_PER_BUILDING; p++) {
        this.particleBuilding.push(b.id);
        this.particleProgress.push(p / PARTICLES_PER_BUILDING);
        i++;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.particlePositions, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.particleAlpha, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1000);

    this.flowMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color('#6fe6ff') }, uScale: { value: 420 } },
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        uniform float uScale;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = uScale / max(1.0, -mv.z) * 0.01;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d);
          if (r > 0.25) discard;
          float a = smoothstep(0.25, 0.0, r) * vAlpha;
          gl_FragColor = vec4(uColor, a);
        }
      `,
    });

    this.particles = new THREE.Points(geo, this.flowMaterial);
    this.particles.frustumCulled = false;
    this.particles.renderOrder = 20;
    this.group.add(this.particles);
  }

  setXray(amount: number): void {
    this.xray = amount;
    this.group.visible = amount > 0.01;
    const depthTest = amount < 0.5;
    this.shellMat.depthTest = depthTest;
    this.waterMat.depthTest = depthTest;
    this.pipeMat.depthTest = depthTest;
    this.shellMat.opacity = 0.2 + 0.35 * amount;
    this.waterMat.opacity = 0.45 + 0.45 * amount;
    this.pipeMat.opacity = 0.4 + 0.45 * amount;
  }

  update(state: SimState, dt: number): void {
    if (this.xray <= 0.01) return;

    for (const b of state.buildings) {
      const water = this.waters.get(b.id);
      const shell = this.cisterns.get(b.id);
      if (!water || !shell) continue;
      const fill = b.cisternCap > 0 ? Math.min(1, b.cistern / b.cisternCap) : 0;
      const depth = 3.4;
      const h = Math.max(0.001, fill * depth);
      water.scale.set(shell.scale.x * 0.94, h, shell.scale.z * 0.94);
      water.position.set(b.x, -depth - 0.4 + h / 2, b.z);
    }

    const tankFill = Math.min(1, state.tank.stored / Math.max(1, state.tank.capacity));
    const tankH = Math.max(0.01, tankFill * 6.6);
    this.reservoirWater.scale.set(1, tankH, 1);
    this.reservoirWater.position.y = -7.0 + tankH / 2;

    // Move the flow particles.
    const byId = new Map(state.buildings.map((b) => [b.id, b]));
    for (let i = 0; i < this.particleBuilding.length; i++) {
      const id = this.particleBuilding[i];
      const run = this.runs.find((r) => r.buildingId === id);
      const b = byId.get(id);
      if (!run || !b) continue;
      const flow = b.inflow + b.toDistrict;
      const speed = 0.06 + Math.min(1.2, flow * 0.5);
      let t = (this.particleProgress[i] + dt * speed) % 1;
      this.particleProgress[i] = t;
      const p = samplePolyline(run.points, t);
      this.particlePositions[i * 3] = p.x;
      this.particlePositions[i * 3 + 1] = p.y;
      this.particlePositions[i * 3 + 2] = p.z;
      this.particleAlpha[i] = Math.min(1, flow * 2.2);
    }
    (this.particles.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.particles.geometry.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }
}

function nearestStreet(layout: CityLayout, value: number): number {
  const col = Math.round((value + layout.half) / layout.pitch);
  const clamped = Math.max(0, Math.min(layout.grid, col));
  return -layout.half + clamped * layout.pitch;
}

function samplePolyline(points: THREE.Vector3[], t: number): THREE.Vector3 {
  const f = Math.min(0.9999, Math.max(0, t)) * (points.length - 1);
  const i = Math.floor(f);
  const frac = f - i;
  const a = points[i];
  const b = points[Math.min(points.length - 1, i + 1)];
  return new THREE.Vector3(a.x + (b.x - a.x) * frac, a.y + (b.y - a.y) * frac, a.z + (b.z - a.z) * frac);
}
