import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp } from '../core/rng';
import type { CityLayout } from '../sim/city';
import type { SimState } from '../sim/types';

/** Panel size (m). */
const PANEL_W = 1.9;
const PANEL_D = 1.05;

/** Tilt of the arrays toward the equator (rad). */
const PANEL_TILT = 0.35;

/** Height of the grid mast at the power house (m). */
const MAST_HEIGHT = 22;

/** Segments used to draw one catenary of the overhead grid. */
const GRID_SEGMENTS = 3;

/**
 * Everything the district uses to make electricity.
 *
 * Three layers:
 *  - the PV arrays bolted to the roofs, which brighten with the sun,
 *  - a turbine in the downspout of every building, spinning when the roof
 *    is shedding water,
 *  - the power house at the park, where the street runoff is turned into
 *    electricity and the battery sits.
 *
 * A faint catenary of overhead lines ties the buildings to the power house.
 */
export class PowerLayer {
  readonly group = new THREE.Group();

  private readonly panelMaterial: THREE.MeshStandardMaterial;
  private readonly panelMesh: THREE.InstancedMesh;
  private readonly turbineHousing: THREE.InstancedMesh;
  private readonly rotors: THREE.InstancedMesh;
  private readonly rotorAngles: number[] = [];
  private readonly gridLines: THREE.LineSegments;
  private readonly gridColors: THREE.BufferAttribute;
  private readonly houseGlow: THREE.MeshStandardMaterial;
  private readonly batteryGlow: THREE.MeshStandardMaterial;
  private readonly runner: THREE.Mesh;
  private readonly dummy = new THREE.Object3D();
  private readonly mast: THREE.Vector3;
  private readonly spinner = new THREE.Quaternion();
  private readonly baseQuaternion = new THREE.Quaternion();
  private readonly spinAxis = new THREE.Vector3(1, 0, 0);
  private readonly rotorOffset = new THREE.Vector3();
  private readonly exportColor = new THREE.Color('#ffb454');
  private readonly importColor = new THREE.Color('#4fa8e8');
  private readonly tmpColor = new THREE.Color();

  constructor(layout: CityLayout) {
    // ---- panels on the roofs -----------------------------------------
    this.panelMaterial = new THREE.MeshStandardMaterial({
      color: '#0e1c2e',
      roughness: 0.18,
      metalness: 0.62,
      emissive: new THREE.Color('#1d4a78'),
      emissiveIntensity: 0,
    });

    const panelGeo = new THREE.BoxGeometry(PANEL_W, 0.07, PANEL_D);
    const transforms: THREE.Matrix4[] = [];
    for (const b of layout.buildings) {
      for (const panel of b.pvPanels) {
        const m = new THREE.Matrix4();
        m.compose(
          new THREE.Vector3(b.x + panel.x, b.h + 0.16, b.z + panel.z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(-PANEL_TILT, 0, 0)),
          new THREE.Vector3(1, 1, 1),
        );
        transforms.push(m);
      }
    }

    this.panelMesh = new THREE.InstancedMesh(panelGeo, this.panelMaterial, Math.max(1, transforms.length));
    transforms.forEach((m, i) => this.panelMesh.setMatrixAt(i, m));
    this.panelMesh.instanceMatrix.needsUpdate = true;
    this.panelMesh.castShadow = true;
    this.panelMesh.count = transforms.length;
    this.group.add(this.panelMesh);

    // ---- downspout turbines ------------------------------------------
    // A pipe down the corner of the building, turning into a short
    // horizontal run through the turbine.
    const turbineGeo = mergeGeometries(
      [
        new THREE.CylinderGeometry(0.2, 0.2, 5.0, 8).translate(0, 4.0, 0),
        new THREE.CylinderGeometry(0.46, 0.46, 2.8, 12).rotateZ(Math.PI / 2).translate(1.3, 1.5, 0),
        new THREE.BoxGeometry(0.8, 1.2, 1.2).translate(2.5, 1.5, 0),
      ],
      false,
    )!;
    const turbineMat = new THREE.MeshStandardMaterial({
      color: '#4a5260',
      roughness: 0.55,
      metalness: 0.55,
    });
    this.turbineHousing = new THREE.InstancedMesh(turbineGeo, turbineMat, Math.max(1, layout.buildings.length));
    this.turbineHousing.castShadow = true;

    const rotorGeo = buildRotorGeometry(0.8, 3);
    const rotorMat = new THREE.MeshStandardMaterial({
      color: '#c8d2dc',
      roughness: 0.35,
      metalness: 0.7,
    });
    this.rotors = new THREE.InstancedMesh(rotorGeo, rotorMat, Math.max(1, layout.buildings.length));
    this.rotors.castShadow = true;

    layout.buildings.forEach((b, i) => {
      // The turbine sits where the downspout lands, just outside the corner.
      const px = b.x + b.w / 2 + 0.25;
      const pz = b.z + b.d / 2 + 0.25;
      // Turn the corner so the turbine points out at the street.
      const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.PI * 0.25, 0));

      const m = new THREE.Matrix4().compose(new THREE.Vector3(px, 0, pz), rot, new THREE.Vector3(1, 1, 1));
      this.turbineHousing.setMatrixAt(i, m);

      const rm = new THREE.Matrix4().compose(new THREE.Vector3(px, 1.5, pz), rot, new THREE.Vector3(1, 1, 1));
      this.rotors.setMatrixAt(i, rm);
      this.rotorAngles.push(0);
    });
    this.turbineHousing.instanceMatrix.needsUpdate = true;
    this.rotors.instanceMatrix.needsUpdate = true;
    this.turbineHousing.count = layout.buildings.length;
    this.rotors.count = layout.buildings.length;
    this.group.add(this.turbineHousing, this.rotors);

    // ---- power house at the park -------------------------------------
    const res = layout.reservoir;
    this.mast = new THREE.Vector3(res.x - 16, MAST_HEIGHT, res.z + 9);
    const house = this.buildPowerHouse(layout);
    this.group.add(house);
    this.runner = house.userData.runner as THREE.Mesh;
    this.houseGlow = house.userData.glow as THREE.MeshStandardMaterial;
    this.batteryGlow = house.userData.battery as THREE.MeshStandardMaterial;

    // ---- overhead grid -----------------------------------------------
    const positions = new Float32Array(layout.buildings.length * GRID_SEGMENTS * 2 * 3);
    const colors = new Float32Array(layout.buildings.length * GRID_SEGMENTS * 2 * 3);
    layout.buildings.forEach((b, i) => {
      const p0 = new THREE.Vector3(b.x, b.h + 1.4, b.z);
      const p3 = this.mast.clone();
      const dist = p0.distanceTo(p3);
      const sag = Math.min(6, dist * 0.05);
      const pts: THREE.Vector3[] = [];
      for (let s = 0; s <= GRID_SEGMENTS; s++) {
        const t = s / GRID_SEGMENTS;
        const p = p0.clone().lerp(p3, t);
        p.y -= Math.sin(t * Math.PI) * sag;
        pts.push(p);
      }
      let o = i * GRID_SEGMENTS * 6;
      for (let s = 0; s < GRID_SEGMENTS; s++) {
        const a = pts[s];
        const c = pts[s + 1];
        positions[o++] = a.x;
        positions[o++] = a.y;
        positions[o++] = a.z;
        positions[o++] = c.x;
        positions[o++] = c.y;
        positions[o++] = c.z;
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.gridColors = new THREE.BufferAttribute(colors, 3);
    geo.setAttribute('color', this.gridColors);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1000);
    this.gridLines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.gridLines.renderOrder = 12;
    this.group.add(this.gridLines);
  }

  /** The turbine house, battery and substation that sit in the park. */
  private buildPowerHouse(layout: CityLayout): THREE.Group {
    const group = new THREE.Group();
    const res = layout.reservoir;
    const x = res.x - 16;
    const z = res.z + 9;

    const concrete = new THREE.MeshStandardMaterial({ color: '#4c525a', roughness: 0.9, metalness: 0.05 });
    const steel = new THREE.MeshStandardMaterial({ color: '#5b6470', roughness: 0.45, metalness: 0.65 });
    const dark = new THREE.MeshStandardMaterial({ color: '#2c333c', roughness: 0.7, metalness: 0.3 });

    const slab = new THREE.Mesh(new THREE.BoxGeometry(17, 0.5, 13), concrete);
    slab.position.set(x, 0.25, z);
    slab.receiveShadow = true;
    group.add(slab);

    // Turbine hall.
    const hall = new THREE.Mesh(new THREE.BoxGeometry(10, 4.6, 6.5), steel);
    hall.position.set(x - 1, 2.8, z);
    hall.castShadow = true;
    hall.receiveShadow = true;
    group.add(hall);

    // The runner of the runoff turbine, on the face of the hall.
    const runnerPivot = new THREE.Group();
    runnerPivot.position.set(x - 1, 2.6, z + 3.3);
    runnerPivot.rotation.y = Math.PI / 2;
    const runner = new THREE.Mesh(
      buildRotorGeometry(1.5, 6),
      new THREE.MeshStandardMaterial({ color: '#d3dbe4', roughness: 0.3, metalness: 0.75 }),
    );
    runner.castShadow = true;
    runnerPivot.add(runner);
    group.add(runnerPivot);

    const housing = new THREE.Mesh(
      new THREE.CylinderGeometry(1.9, 1.9, 1.6, 20, 1, true),
      new THREE.MeshStandardMaterial({
        color: '#39414b',
        roughness: 0.6,
        metalness: 0.4,
        side: THREE.DoubleSide,
      }),
    );
    housing.rotation.x = Math.PI / 2;
    housing.position.set(x - 1, 2.6, z + 3.3);
    group.add(housing);

    // Turbine glow: brighter while the runoff is turning.
    const glow = new THREE.MeshStandardMaterial({
      color: '#16202b',
      emissive: new THREE.Color('#5ce1e6'),
      emissiveIntensity: 0,
      roughness: 0.4,
      metalness: 0.5,
    });
    const glowRing = new THREE.Mesh(new THREE.TorusGeometry(2.05, 0.12, 8, 28), glow);
    glowRing.position.set(x - 1, 2.6, z + 3.35);
    group.add(glowRing);

    // Battery container.
    const battery = new THREE.MeshStandardMaterial({
      color: '#2a3138',
      emissive: new THREE.Color('#56d9c8'),
      emissiveIntensity: 0.4,
      roughness: 0.5,
      metalness: 0.4,
    });
    const container = new THREE.Mesh(new THREE.BoxGeometry(5.4, 2.8, 2.8), dark);
    container.position.set(x + 7, 1.9, z - 2);
    container.castShadow = true;
    group.add(container);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.32, 0.12), battery);
    strip.position.set(x + 7, 3.4, z - 0.6);
    group.add(strip);

    // Substation and grid mast.
    const transformer = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.3, 3, 12), steel);
    transformer.position.set(x + 6.4, 2.2, z + 3.4);
    transformer.castShadow = true;
    group.add(transformer);

    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.3, MAST_HEIGHT, 8), steel);
    mast.position.set(this.mast.x, MAST_HEIGHT / 2, this.mast.z);
    mast.castShadow = true;
    group.add(mast);

    group.userData.runner = runner;
    group.userData.glow = glow;
    group.userData.battery = battery;
    return group;
  }

  setXray(amount: number): void {
    (this.gridLines.material as THREE.LineBasicMaterial).opacity = 0.24 + amount * 0.42;
  }

  update(state: SimState, dt: number): void {
    const power = state.power;

    // Panels brighten with the sun and go flat under cloud.
    const sun = clamp(power.irradiance / 900, 0, 1);
    this.panelMaterial.emissiveIntensity = sun * 0.85;

    // The downspout runners spin at a rate set by the water going past them.
    this.baseQuaternion.setFromEuler(new THREE.Euler(0, -Math.PI * 0.25, 0));
    // The runner sits in the horizontal run of the pipe, off the corner.
    this.rotorOffset.set(1.4, 1.5, 0).applyQuaternion(this.baseQuaternion);
    for (let i = 0; i < state.buildings.length; i++) {
      const b = state.buildings[i];
      this.rotorAngles[i] += dt * b.hydroKw * 30;
      const angle = this.rotorAngles[i];

      this.spinner.setFromAxisAngle(this.spinAxis, angle);
      this.dummy.position.set(
        b.x + b.w / 2 + 0.25 + this.rotorOffset.x,
        1.5,
        b.z + b.d / 2 + 0.25 + this.rotorOffset.z,
      );
      this.dummy.quaternion.copy(this.baseQuaternion).multiply(this.spinner);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.rotors.setMatrixAt(i, this.dummy.matrix);
    }
    this.rotors.instanceMatrix.needsUpdate = true;

    // The runoff runner at the power house spins about its own axis.
    this.runner.rotation.x += dt * (power.runoffKw > 0.01 ? 3 + power.runoffKw * 5 : 0);

    const load = clamp(power.generationKw / Math.max(1, power.demandKw), 0, 2);
    this.houseGlow.emissiveIntensity = 0.15 + load * 0.9;

    const soc = clamp(power.batteryKwh / Math.max(1, power.batteryCapacityKwh), 0, 1);
    this.batteryGlow.emissiveIntensity = 0.25 + soc * 1.1;
    this.batteryGlow.emissive.setHex(power.batteryPowerKw < -0.5 ? 0xffb454 : 0x56d9c8);

    // Overhead lines: amber where a building pushes power out, blue where it draws.
    const colors = this.gridColors.array as Float32Array;
    for (let i = 0; i < state.buildings.length; i++) {
      const b = state.buildings[i];
      const net = b.netKw;
      const mag = clamp(Math.abs(net) / 3, 0, 1);
      this.tmpColor
        .copy(net >= 0 ? this.exportColor : this.importColor)
        .multiplyScalar(0.15 + mag * 0.95);
      const o = i * GRID_SEGMENTS * 6;
      for (let v = 0; v < GRID_SEGMENTS * 2; v++) {
        colors[o + v * 3] = this.tmpColor.r;
        colors[o + v * 3 + 1] = this.tmpColor.g;
        colors[o + v * 3 + 2] = this.tmpColor.b;
      }
    }
    this.gridColors.needsUpdate = true;
  }
}

/**
 * A rotor: a hub with `blades` swept paddles, spinning about the X axis.
 */
function buildRotorGeometry(radius: number, blades: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const hub = new THREE.CylinderGeometry(radius * 0.3, radius * 0.3, radius * 0.9, 10);
  hub.rotateZ(Math.PI / 2);
  parts.push(hub);
  for (let i = 0; i < blades; i++) {
    const blade = new THREE.BoxGeometry(radius * 0.5, radius * 1.7, radius * 0.26);
    blade.translate(0, radius * 1.05, 0);
    blade.rotateX((i / blades) * Math.PI * 2);
    parts.push(blade);
  }
  return mergeGeometries(parts, false)!;
}
