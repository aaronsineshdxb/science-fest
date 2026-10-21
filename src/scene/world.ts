import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mulberry32, range, clamp, lerp } from '../core/rng';
import { nightFactor, simHour, sunAngles } from '../sim/clock';
import type { CityLayout } from '../sim/city';
import type { SimState } from '../sim/types';
import { BuildingLayer } from './buildings';
import { Ground } from './ground';
import { PowerLayer } from './power';
import { Rain } from './rain';
import { Sky } from './sky';
import { Splashes } from './splashes';
import { WaterNetwork } from './network';

const DAY_LENGTH_MIN = 1440;

interface Palette {
  horizon: THREE.Color;
  zenith: THREE.Color;
  cloud: THREE.Color;
  sun: THREE.Color;
  fog: THREE.Color;
  sunLight: THREE.Color;
  ambient: number;
}

function paletteFor(elevation: number, stormy: number): Palette {
  const day: Palette = {
    horizon: new THREE.Color('#a8bccd'),
    zenith: new THREE.Color('#3f74ad'),
    cloud: new THREE.Color('#c6d1dc'),
    sun: new THREE.Color('#fff4dc'),
    fog: new THREE.Color('#9fb0c2'),
    sunLight: new THREE.Color('#fff3d8'),
    ambient: 0.95,
  };
  const dusk: Palette = {
    horizon: new THREE.Color('#c9793f'),
    zenith: new THREE.Color('#27324e'),
    cloud: new THREE.Color('#6b5f68'),
    sun: new THREE.Color('#ff9b4d'),
    fog: new THREE.Color('#5a5560'),
    sunLight: new THREE.Color('#ffb066'),
    ambient: 0.42,
  };
  const night: Palette = {
    horizon: new THREE.Color('#161d2a'),
    zenith: new THREE.Color('#060a12'),
    cloud: new THREE.Color('#1f2734'),
    sun: new THREE.Color('#2a3a5e'),
    fog: new THREE.Color('#111722'),
    sunLight: new THREE.Color('#8fa8d8'),
    ambient: 0.2,
  };

  const out: Palette = {
    horizon: new THREE.Color(),
    zenith: new THREE.Color(),
    cloud: new THREE.Color(),
    sun: new THREE.Color(),
    fog: new THREE.Color(),
    sunLight: new THREE.Color(),
    ambient: 0,
  };
  // Day above the horizon, night below, dusk in between.
  const dayT = clamp(elevation / 0.3, 0, 1);
  const nightT = clamp(-elevation / 0.22, 0, 1);
  const from = dusk;
  const to = elevation >= 0 ? day : night;
  const t = elevation >= 0 ? dayT : nightT;

  out.horizon.copy(from.horizon).lerp(to.horizon, t);
  out.zenith.copy(from.zenith).lerp(to.zenith, t);
  out.cloud.copy(from.cloud).lerp(to.cloud, t);
  out.sun.copy(from.sun).lerp(to.sun, t);
  out.fog.copy(from.fog).lerp(to.fog, t);
  out.sunLight.copy(from.sunLight).lerp(to.sunLight, t);
  out.ambient = lerp(from.ambient, to.ambient, t);

  // Storm drains the colour out of the sky.
  const grey = new THREE.Color('#59606b');
  out.zenith.lerp(grey, stormy * 0.55);
  out.cloud.lerp(new THREE.Color('#454b55'), stormy * 0.6);
  return out;
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly sky: Sky;
  readonly ground: Ground;
  readonly buildings: BuildingLayer;
  readonly rain: Rain;
  readonly splashes: Splashes;
  readonly network: WaterNetwork;
  readonly power: PowerLayer;

  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly ambient: THREE.AmbientLight;
  private readonly envScene = new THREE.Scene();
  private readonly envSky: Sky;
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envTimer = 0;
  private flash = 0;
  private nextFlash = 6;
  private xray = 0;
  private xrayTarget = 0;
  private focus: THREE.Vector3 | null = null;
  private time = 0;

  constructor(canvas: HTMLCanvasElement, layout: CityLayout) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.6, 3000);
    this.camera.position.set(-228, 148, 176);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.target.set(0, 5, 0);
    this.controls.minDistance = 18;
    this.controls.maxDistance = 520;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minPolarAngle = 0.12;

    this.scene.fog = new THREE.FogExp2(0x141a24, 0.0032);

    this.sky = new Sky();
    this.scene.add(this.sky.mesh);
    this.envSky = new Sky();
    this.envScene.add(this.envSky.mesh);

    this.ground = new Ground(layout);
    this.scene.add(this.ground.group);

    this.buildings = new BuildingLayer(layout);
    this.scene.add(this.buildings.group);

    this.rain = new Rain(layout);
    this.scene.add(this.rain.mesh);

    this.splashes = new Splashes(layout);
    this.scene.add(this.splashes.mesh);

    this.network = new WaterNetwork(layout);
    this.scene.add(this.network.group);

    this.power = new PowerLayer(layout, this.buildings.roofProps);
    this.scene.add(this.power.group);

    this.addPark(layout);
    this.addBackdrop(layout);

    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const s = layout.half * 1.15;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 900;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0x9fb6cf, 0x14161a, 0.5);
    this.scene.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.15);
    this.scene.add(this.ambient);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();
    this.refreshEnvironment();
  }

  private addPark(layout: CityLayout): void {
    const rng = mulberry32(layout.seed ^ 0x7711);
    const trunks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.24, 0.34, 1, 6),
      new THREE.MeshStandardMaterial({ color: '#3a2d24', roughness: 0.95 }),
      layout.trees.length,
    );
    const canopyGeo = new THREE.IcosahedronGeometry(1, 1);
    const canopy = new THREE.InstancedMesh(
      canopyGeo,
      new THREE.MeshStandardMaterial({ color: '#2f5a2c', roughness: 0.95, flatShading: true }),
      layout.trees.length,
    );
    layout.trees.forEach((t, i) => {
      const m = new THREE.Matrix4();
      m.compose(new THREE.Vector3(t.x, t.h * 0.3, t.z), new THREE.Quaternion(), new THREE.Vector3(1, t.h * 0.6, 1));
      trunks.setMatrixAt(i, m);
      const c = new THREE.Matrix4();
      c.compose(
        new THREE.Vector3(t.x, t.h * 0.72, t.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng() * 3, 0)),
        new THREE.Vector3(t.r, t.r * 1.15, t.r),
      );
      canopy.setMatrixAt(i, c);
    });
    trunks.instanceMatrix.needsUpdate = true;
    canopy.instanceMatrix.needsUpdate = true;
    trunks.castShadow = true;
    canopy.castShadow = true;
    this.scene.add(trunks, canopy);
  }

  /** A dark skyline beyond the district so the city does not float in a void. */
  private addBackdrop(layout: CityLayout): void {
    const rng = mulberry32(layout.seed ^ 0x1234);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: '#161a20', roughness: 1, metalness: 0 });
    const count = 70;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rng() * 0.05;
      const r = range(rng, layout.half + 60, layout.half + 230);
      const h = range(rng, 18, 96);
      const w = range(rng, 16, 42);
      const d = range(rng, 16, 42);
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(Math.cos(a) * r, h / 2, Math.sin(a) * r),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, a + range(rng, -0.4, 0.4), 0)),
        new THREE.Vector3(w, h, d),
      );
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
  }

  refreshEnvironment(): void {
    const target = this.pmrem.fromScene(this.envScene, 0, 1, 2000);
    if (this.envTarget) this.envTarget.dispose();
    this.envTarget = target;
    this.scene.environment = target.texture;
    this.scene.environmentIntensity = 0.55;
  }

  setXray(enabled: boolean): void {
    this.xrayTarget = enabled ? 1 : 0;
  }

  get xrayEnabled(): boolean {
    return this.xrayTarget > 0.5;
  }

  focusBuilding(b: { x: number; z: number; h: number } | null): void {
    this.focus = b ? new THREE.Vector3(b.x, b.h * 0.5, b.z) : null;
  }

  update(state: SimState, dt: number): void {
    this.time += dt;

    const hour = simHour(state.minutes);
    const { elevation, azimuth } = sunAngles(hour);
    const sunDir = new THREE.Vector3(azimuth * 0.8, elevation, -0.5).normalize();

    const storminess = clamp(state.rain.intensity / 45, 0, 1);
    const pal = paletteFor(elevation, storminess * 0.8);
    const night = nightFactor(hour);

    this.sky.palette = {
      horizon: `#${pal.horizon.getHexString()}`,
      zenith: `#${pal.zenith.getHexString()}`,
      cloud: `#${pal.cloud.getHexString()}`,
      sun: `#${pal.sun.getHexString()}`,
    };
    this.sky.setSun(sunDir);
    this.envSky.palette = {
      horizon: `#${pal.horizon.getHexString()}`,
      zenith: `#${pal.zenith.getHexString()}`,
      cloud: `#${pal.cloud.getHexString()}`,
      sun: `#${pal.sun.getHexString()}`,
    };
    this.envSky.setSun(sunDir);

    // Lightning.
    this.nextFlash -= dt;
    if (this.nextFlash <= 0) {
      this.nextFlash = 5 + Math.random() * 18 * (1 - storminess * 0.5);
      if (storminess > 0.12 || Math.random() < 0.3) this.flash = 1;
    }
    this.flash = Math.max(0, this.flash - dt * 3.4);
    const flashPulse = this.flash > 0.75 ? 1 : this.flash * 0.55;

    this.sky.update(this.time, flashPulse, storminess);
    this.envSky.update(this.time, flashPulse, storminess);

    this.sun.position.copy(sunDir).multiplyScalar(320).add(new THREE.Vector3(0, 0, 0));
    this.sun.target.position.set(0, 0, 0);
    this.sun.color.copy(pal.sunLight);
    this.sun.intensity = Math.max(0.02, elevation) * 2.4 * (1 - storminess * 0.65) + flashPulse * 1.6;

    this.hemi.color.copy(pal.zenith).lerp(new THREE.Color('#ffffff'), 0.35);
    this.hemi.groundColor.set('#12141a');
    this.hemi.intensity = 0.25 + pal.ambient * 0.55 + flashPulse * 0.5;
    this.ambient.intensity = 0.1 + night * 0.1;

    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.copy(pal.fog).lerp(new THREE.Color('#101620'), storminess * 0.5);
    fog.density = 0.0026 + storminess * 0.0042;

    // The street lamps dim when the district has to shed load.
    this.buildings.setNight(night, state.power.lightingFactor);
    this.buildings.setWet(clamp(state.rain.intensity / 12, 0, 1));
    this.ground.update(dt, state.rain.intensity, state.sewer.floodedFraction, state.parkGreenness);
    this.rain.update(dt, state.rain.intensity);
    this.splashes.update(dt, state.rain.intensity);
    this.rain.setPaused(state.paused);
    this.splashes.setPaused(state.paused);

    // X-ray fade.
    this.xray += (this.xrayTarget - this.xray) * Math.min(1, dt * 5);
    if (Math.abs(this.xray - this.xrayTarget) > 0.001) {
      this.ground.setXray(this.xray);
      this.buildings.setXray(this.xray);
    }
    this.network.setXray(this.xray);
    this.network.update(state, dt);
    this.power.setXray(this.xray);
    this.power.update(state, dt);

    // Camera focus.
    if (this.focus) {
      this.controls.target.lerp(this.focus, Math.min(1, dt * 2.2));
      if (this.controls.target.distanceTo(this.focus) < 0.4) this.focus = null;
    }

    this.envTimer -= dt;
    if (this.envTimer <= 0) {
      this.envTimer = 4;
      this.refreshEnvironment();
    }
  }

  resize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** Day of the simulated session, 0 = the day the session started. */
  get day(): number {
    return 0;
  }

  static get dayLengthMinutes(): number {
    return DAY_LENGTH_MIN;
  }
}
