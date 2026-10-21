import * as THREE from 'three';
import { mulberry32, range, clamp } from '../core/rng';
import type { CityLayout } from '../sim/city';
import type { Building } from '../sim/types';

const FACADE_COLORS = ['#4a4f57', '#5b5751', '#454b54', '#605a52', '#3f454d', '#6b6257', '#4e5259'];
const ROOF_COLORS: Record<string, string> = {
  green: '#33502c',
  metal: '#59636e',
  concrete: '#6d7178',
  gravel: '#4d4b47',
};

export interface BuildingVisual {
  id: number;
  mesh: THREE.Mesh;
  /** Emissive window material instance (shared) - kept for reference. */
  base: THREE.Color;
}

export class BuildingLayer {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  readonly meshes: THREE.Mesh[] = [];
  private readonly specs = new Map<number, Building>();
  private readonly greenRoofMaterial: THREE.MeshStandardMaterial;
  private readonly shrubMesh: THREE.InstancedMesh;
  private readonly acMesh: THREE.InstancedMesh;
  private readonly tankMesh: THREE.InstancedMesh;
  private readonly lampGlow: THREE.InstancedMesh;
  private readonly highlight: THREE.LineSegments;

  constructor(layout: CityLayout) {
    const rng = mulberry32(layout.seed ^ 0x2f11);

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.82,
      metalness: 0.06,
      envMapIntensity: 0.35,
    });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = { value: 0 };
      shader.uniforms.uWet = { value: 0 };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute float aSeed;
           attribute float aHeight;
           varying float vSeed;
           varying float vHeight;
           varying vec3 vLocal;
           varying vec3 vWNormal;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vSeed = aSeed;
           vHeight = aHeight;
           vLocal = position;
           vWNormal = normalize(mat3(modelMatrix) * normal);`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying float vSeed;
           varying float vHeight;
           varying vec3 vLocal;
           varying vec3 vWNormal;
           uniform float uNight;
           uniform float uWet;

           float hash21(vec2 p) {
             p = fract(p * vec2(123.34, 456.21));
             p += dot(p, p + 45.32);
             return fract(p.x * p.y);
           }`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           vec3 wn = normalize(vWNormal);
           float isWall = 1.0 - smoothstep(0.55, 0.8, abs(wn.y));
           vec2 wall = abs(wn.x) > abs(wn.z) ? vec2(vLocal.z, vLocal.y) : vec2(vLocal.x, vLocal.y);
           vec2 gridUv = vec2((wall.x + 256.0) / 3.7, (wall.y - 0.75) / 3.5);
           vec2 cell = floor(gridUv);
           vec2 f = fract(gridUv);
           float winX = step(0.22, f.x) * step(f.x, 0.78);
           float winY = step(0.18, f.y) * step(f.y, 0.80);
           float winMask = winX * winY * isWall * step(1.1, wall.y) * step(wall.y, vHeight - 0.35);
           diffuseColor.rgb *= mix(1.0, 0.30, winMask);
           diffuseColor.rgb *= 1.0 - 0.06 * step(0.93, f.y) * isWall;
           diffuseColor.rgb *= mix(1.0, 0.72, uWet);`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           float wr = hash21(cell + vec2(vSeed * 91.7, vSeed * 13.3));
           float lit = step(0.58, wr) * winMask * uNight;
           vec3 warm = vec3(1.0, 0.68, 0.36);
           vec3 cool = vec3(0.66, 0.82, 1.0);
           vec3 wc = mix(warm, cool, step(0.86, wr));
           totalEmissiveRadiance += wc * lit * (0.75 + 0.5 * hash21(cell + 5.1)) * 1.5;`,
        );
      this.material.userData.shader = shader;
    };
    this.material.customProgramCacheKey = () => 'facade-v1';

    this.greenRoofMaterial = new THREE.MeshStandardMaterial({
      color: '#3d6a30',
      roughness: 0.97,
    });

    this.highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: '#5ce1e6', transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.highlight.renderOrder = 10;
    this.highlight.visible = false;
    this.group.add(this.highlight);

    const shrubPositions: { p: THREE.Vector3; s: number }[] = [];
    const acPositions: { p: THREE.Vector3; ry: number }[] = [];
    const tankPositions: { p: THREE.Vector3 }[] = [];

    for (const b of layout.buildings) {
      const mesh = this.createBuilding(b, rng, shrubPositions, acPositions, tankPositions);
      this.meshes.push(mesh);
      this.specs.set(b.id, b);
      this.group.add(mesh);
    }
    // Green roof planting.
    const shrubGeo = new THREE.IcosahedronGeometry(1, 0);
    const shrubMat = new THREE.MeshStandardMaterial({ color: '#3f6a33', roughness: 0.95, flatShading: true });
    this.shrubMesh = new THREE.InstancedMesh(shrubGeo, shrubMat, Math.max(1, shrubPositions.length));
    shrubPositions.forEach((s, i) => {
      const m = new THREE.Matrix4();
      m.compose(s.p, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, s.p.x * 3, 0)), new THREE.Vector3(s.s, s.s * 0.75, s.s));
      this.shrubMesh.setMatrixAt(i, m);
    });
    this.shrubMesh.instanceMatrix.needsUpdate = true;
    this.shrubMesh.castShadow = true;
    this.shrubMesh.count = shrubPositions.length;
    this.group.add(this.shrubMesh);

    // Rooftop plant.
    const acGeo = new THREE.BoxGeometry(1.7, 1.0, 1.4);
    const acMat = new THREE.MeshStandardMaterial({ color: '#6a7079', roughness: 0.6, metalness: 0.45 });
    this.acMesh = new THREE.InstancedMesh(acGeo, acMat, Math.max(1, acPositions.length));
    acPositions.forEach((s, i) => {
      const m = new THREE.Matrix4();
      m.compose(s.p, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, s.ry, 0)), new THREE.Vector3(1, 1, 1));
      this.acMesh.setMatrixAt(i, m);
    });
    this.acMesh.instanceMatrix.needsUpdate = true;
    this.acMesh.castShadow = true;
    this.acMesh.count = acPositions.length;
    this.group.add(this.acMesh);

    // Gravity tanks on the roofs.
    const tankGeo = new THREE.CylinderGeometry(1.05, 1.05, 2.1, 14);
    const tankMat = new THREE.MeshStandardMaterial({ color: '#8d9298', roughness: 0.55, metalness: 0.3 });
    this.tankMesh = new THREE.InstancedMesh(tankGeo, tankMat, Math.max(1, tankPositions.length));
    tankPositions.forEach((s, i) => {
      const m = new THREE.Matrix4();
      m.compose(s.p, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
      this.tankMesh.setMatrixAt(i, m);
    });
    this.tankMesh.instanceMatrix.needsUpdate = true;
    this.tankMesh.castShadow = true;
    this.tankMesh.count = tankPositions.length;
    this.group.add(this.tankMesh);

    // Street lamp heads.
    const lampGeo = new THREE.SphereGeometry(0.42, 8, 6);
    const lampMat = new THREE.MeshStandardMaterial({
      color: '#2b2f35',
      emissive: new THREE.Color('#ffcf87'),
      emissiveIntensity: 0,
      roughness: 0.4,
    });
    this.lampGlow = new THREE.InstancedMesh(lampGeo, lampMat, layout.lamps.length);
    layout.lamps.forEach((l, i) => {
      const m = new THREE.Matrix4();
      m.compose(new THREE.Vector3(l.x, 6.4, l.z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
      this.lampGlow.setMatrixAt(i, m);
    });
    this.lampGlow.instanceMatrix.needsUpdate = true;
    this.group.add(this.lampGlow);

    // Lamp posts.
    const postGeo = new THREE.CylinderGeometry(0.12, 0.16, 6.4, 6);
    const postMat = new THREE.MeshStandardMaterial({ color: '#2f3339', roughness: 0.7, metalness: 0.3 });
    const posts = new THREE.InstancedMesh(postGeo, postMat, layout.lamps.length);
    layout.lamps.forEach((l, i) => {
      const m = new THREE.Matrix4();
      m.compose(new THREE.Vector3(l.x, 3.2, l.z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
      posts.setMatrixAt(i, m);
    });
    posts.instanceMatrix.needsUpdate = true;
    posts.castShadow = true;
    this.group.add(posts);
  }

  private createBuilding(
    b: Building,
    rng: () => number,
    shrubs: { p: THREE.Vector3; s: number }[],
    acs: { p: THREE.Vector3; ry: number }[],
    tanks: { p: THREE.Vector3 }[],
  ): THREE.Mesh {
    const geo = new THREE.BoxGeometry(b.w, b.h, b.d);
    geo.translate(0, b.h / 2, 0);

    const facade = new THREE.Color(FACADE_COLORS[Math.floor(rng() * FACADE_COLORS.length)]);
    const roof = new THREE.Color(ROOF_COLORS[b.roof] ?? '#5a5f66');
    const colors = new Float32Array(geo.attributes.position.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < geo.attributes.position.count; i++) {
      const face = Math.floor(i / 4);
      if (face === 2) {
        c.copy(roof);
      } else if (face === 3) {
        c.copy(roof).multiplyScalar(0.35);
      } else {
        c.copy(facade);
        // Slight per-face tint so corners read.
        const shade = [0.94, 0.86, 1.0, 0.9, 0.98, 0.92][face] ?? 1;
        c.multiplyScalar(shade);
      }
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const seed = new Float32Array(geo.attributes.position.count).fill(rng() * 100);
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const height = new Float32Array(geo.attributes.position.count).fill(b.h);
    geo.setAttribute('aHeight', new THREE.BufferAttribute(height, 1));

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(b.x, 0, b.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.buildingId = b.id;

    if (b.roof === 'green') {
      const patch = new THREE.Mesh(
        new THREE.BoxGeometry(b.w * 0.9, 0.55, b.d * 0.9),
        this.greenRoofMaterial,
      );
      patch.position.set(b.x, b.h + 0.24, b.z);
      patch.castShadow = true;
      patch.receiveShadow = true;
      this.group.add(patch);

      const count = Math.max(2, Math.round((b.w * b.d) / 42));
      for (let i = 0; i < count; i++) {
        shrubs.push({
          p: new THREE.Vector3(
            b.x + range(rng, -b.w * 0.42, b.w * 0.42),
            b.h + 0.7,
            b.z + range(rng, -b.d * 0.42, b.d * 0.42),
          ),
          s: range(rng, 0.6, 1.5),
        });
      }
    } else {
      // Rooftop plant and the gravity tank, both laid out by the city
      // generator so the PV arrays can dodge them.
      for (const u of b.acUnits) {
        acs.push({
          p: new THREE.Vector3(b.x + u.x, b.h + 0.5, b.z + u.z),
          ry: u.ry,
        });
      }
      if (b.roofTank) {
        tanks.push({ p: new THREE.Vector3(b.x + b.roofTank.x, b.h + 1.3, b.z + b.roofTank.z) });
      }
    }
    return mesh;
  }

  /**
   * Fade the windows and street lamps in with the night.
   * `powerFactor` dims them when the district has to shed load.
   */
  setNight(amount: number, powerFactor = 1): void {
    const shader = this.material.userData.shader as { uniforms: Record<string, { value: number }> } | undefined;
    if (shader) shader.uniforms.uNight.value = amount;
    (this.lampGlow.material as THREE.MeshStandardMaterial).emissiveIntensity =
      amount * 2.4 * clamp(powerFactor, 0, 1);
  }

  setWet(amount: number): void {
    const shader = this.material.userData.shader as { uniforms: Record<string, { value: number }> } | undefined;
    if (shader) shader.uniforms.uWet.value = amount;
  }

  setXray(amount: number): void {
    this.material.transparent = amount > 0.001;
    this.material.opacity = 1 - amount * 0.72;
    this.material.depthWrite = amount < 0.05;
    this.material.needsUpdate = true;
  }

  /** Outline the selected building. */
  setHighlight(id: number | null): void {
    if (id === null) {
      this.highlight.visible = false;
      return;
    }
    const b = this.specs.get(id);
    if (!b) {
      this.highlight.visible = false;
      return;
    }
    this.highlight.visible = true;
    this.highlight.position.set(b.x, b.h / 2, b.z);
    this.highlight.scale.set(b.w + 0.6, b.h + 0.6, b.d + 0.6);
  }
}
