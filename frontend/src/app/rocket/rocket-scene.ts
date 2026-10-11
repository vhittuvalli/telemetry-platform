import { WritableSignal, computed, signal } from '@angular/core';
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Observable, catchError, combineLatest, map, of } from 'rxjs';
import { DataSource } from '../replay/replay-source';
import { Dispersion, FlightEvent, FlightSummary, RocketMeta, Series } from '../replay/replay.models';
import { LiveSource } from '../replay/live-source';
import { ReplayApiService } from '../replay/replay-api.service';
import { CameraOption, SceneModule, Timeline } from '../engine/scene-module';
import { ViewerEngine, toScene } from '../engine/viewer-engine';
import { RocketState, RocketTrack } from './rocket-track';
import { RocketModel, buildRocketModel } from './rocket-model';
import { buildAltitudeRuler, buildLaunchSite, padLift } from './launch-site';
import { buildLandingZone } from './landing-zone';
import { AirMotes, Puff, Smoke, buildGlow, flicker } from './effects';
import { Clouds, HAZE, buildSky, sunDirection } from './sky';

type RocketCamera = 'follow' | 'ground' | 'overview' | 'landing';

/** Where the follow camera sits relative to the rocket: to one side and a little below. */
const FOLLOW_BEARING = new THREE.Vector3(0.7, -0.15, 0.7).normalize();
/** How stiffly the chase camera holds its place: it trails by acceleration / ω², about 8 m at 5 g. */
const CHASE_OMEGA = 2.5; // rad/s
const CHASE_MAX_LAG = 25; // m
/** Wind grows with height as (z / 10 m)^this, as in the simulator, for flights that don't say. */
const DEFAULT_WIND_GRADIENT = 1 / 7;

/** A small deterministic random generator, so smoke looks the same on every replay. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A point on a chart: the flight's time and one channel's value. */
export interface ChartSeries {
  time: number[];
  values: number[];
}

const EVENT_LABELS: Record<string, string> = {
  liftoff: 'Liftoff', rail_exit: 'Rail exit', burnout: 'Burnout', apogee: 'Apogee',
  ejection: 'Ejection', landing: 'Landing',
};

/** A readable name for a flight event; parachutes are "Drogue"/"Main" when there are two. */
export function eventLabel(e: FlightEvent, meta: RocketMeta): string {
  if (e.name.startsWith('deploy:')) {
    const deploys = meta.events.filter((x) => x.name.startsWith('deploy:'));
    if (deploys.length === 2) return deploys[0] === e ? 'Drogue' : 'Main';
    return 'Parachute';
  }
  return EVENT_LABELS[e.name] ?? e.name;
}

/** A rocket flight: launch site, the rocket and its trajectory, flight dashboard and charts. */
export class RocketScene implements SceneModule {
  readonly domain = 'rocket';
  readonly cameraOptions: readonly CameraOption[];
  readonly showLabels = signal(true);
  /** The flight's metadata; for live flights, events and summary update as data arrives. */
  readonly info: WritableSignal<RocketMeta>;
  get meta(): RocketMeta {
    return this.info();
  }

  // panel state
  readonly time = signal(0);
  readonly state = signal<RocketState | null>(null);
  readonly dispersion = signal<Dispersion | null>(null);
  readonly charts = signal<{ altitude: ChartSeries; velocity: ChartSeries; acceleration: ChartSeries } | null>(null);
  readonly events = computed(() =>
    this.meta.events
      .filter((e) => e.name !== 'ignition')
      .map((e) => ({ ...e, label: eventLabel(e, this.meta) })),
  );
  /** What the rocket is doing now, from the events it has passed. */
  readonly phase = computed(() => {
    const t = this.time();
    const passed = (name: string) => this.meta.events.some((e) => e.name === name && e.time <= t);
    const deployed = this.meta.events.filter((e) => e.name.startsWith('deploy:') && e.time <= t);
    if (passed('landing')) return 'Landed';
    if (deployed.length) return `Under ${eventLabel(deployed[deployed.length - 1], this.meta).toLowerCase()}`;
    if (passed('burnout') && passed('apogee')) return 'Falling';
    if (passed('burnout')) return 'Coasting';
    if (passed('rail_exit')) return 'Powered flight';
    if (passed('liftoff')) return 'On the rail';
    return 'Ignition';
  });

  private track?: RocketTrack;
  private flightObjects: THREE.Object3D[] = [];
  private smokeBuilt = 0;
  private smoke?: Smoke;
  private glow?: THREE.Sprite;
  private nozzleLight?: THREE.PointLight;
  private clouds?: Clouds;
  private motes?: AirMotes;
  private readonly sunDir = sunDirection();
  private followDistance = 0;
  private lastTime = 0;
  private latest?: RocketState;
  private model?: RocketModel;
  private lift: number;
  private mode = signal<RocketCamera>('follow');
  private followInitialized = false;
  private trail?: THREE.Line;
  private tag?: CSS2DObject;
  private eventMarkers: { event: FlightEvent; label: CSS2DObject }[] = [];
  private rulerLabels: CSS2DObject[] = [];
  private zoneLabels: CSS2DObject[] = [];
  private zoneBounds?: THREE.Box3;
  private bounds = new THREE.Box3();
  private readonly baseFov: number;
  private readonly groundCamera: THREE.Vector3;

  constructor(
    private engine: ViewerEngine,
    private source: DataSource,
    private api: ReplayApiService,
    meta: RocketMeta,
  ) {
    this.info = signal(meta);
    this.cameraOptions = [
      { id: 'follow', label: 'Follow' },
      { id: 'ground', label: 'Ground' },
      { id: 'overview', label: 'Overview' },
      ...(meta.dispersion ? [{ id: 'landing', label: 'Landing' }] : []),
    ];
    const g = meta.rocket;
    this.lift = padLift(g.motor.aft_position - g.cg);
    this.baseFov = engine.camera.fov;
    // A spectator 40 m from the pad, off to the side of the rail's lean
    const lean = this.railDirection().setY(0);
    const side = lean.lengthSq() > 1e-6 ? lean.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2) : new THREE.Vector3(0, 0, 1);
    this.groundCamera = side.multiplyScalar(40).setY(1.7);
  }

  cameraMode(): string {
    return this.mode();
  }

  hasTarget(): boolean {
    return true;
  }

  // ---------- loading ----------

  load(): Observable<Timeline> {
    this.buildStatic();
    const live = !!this.source.live;
    return combineLatest([
      this.source.series(this.meta),
      // Optional: without it the flight still plays, just without a landing zone
      this.meta.dispersion
        ? this.api.getDispersion(this.source.id).pipe(catchError(() => of(null)))
        : of(null),
    ]).pipe(
      map(([vehicles, dispersion]) => {
        const series = vehicles.get('rocket') ?? vehicles.values().next().value;
        if (!series) throw new Error('Flight has no rocket data');
        this.apply(series, dispersion);
        return { start: this.track!.start, end: this.track!.end, openAt: live ? this.track!.end : 0, live };
      }),
    );
  }

  /** Build (or, for a live flight, rebuild) everything that depends on the flight's data. */
  private apply(series: Series, dispersion: Dispersion | null): void {
    const first = !this.track;
    this.track = new RocketTrack(series);
    if (this.source instanceof LiveSource) {
      const meta = this.source.currentMeta<RocketMeta>();
      this.info.set({ ...meta, summary: summarize(this.track, meta.events) });
    }

    for (const obj of this.flightObjects) this.engine.remove(obj);
    this.flightObjects = [];
    this.buildFlight();
    // Smoke is the costliest to rebuild; once a second is plenty while live
    const now = performance.now();
    if (first || !this.source.live || now - this.smokeBuilt > 1000) {
      if (this.smoke) this.engine.remove(this.smoke.points);
      this.buildSmoke();
      this.smokeBuilt = now;
    }
    this.charts.set({
      altitude: this.chartSeries('z'),
      velocity: this.chartSeries('vertical_velocity'),
      acceleration: this.chartSeries('acceleration'),
    });

    if (!first) return;
    if (dispersion) {
      const zone = buildLandingZone(dispersion);
      this.engine.add(zone.group);
      this.zoneLabels = zone.labels;
      this.zoneBounds = zone.bounds.expandByPoint(new THREE.Vector3(0, 0, 0)); // keep the pad in view
      this.dispersion.set(dispersion);
    }
    this.resetView();
    this.setCameraMode(this.mode()); // the engine starts every session with orbit controls on
  }

  /** Add an object that belongs to the current data, to be replaced when more arrives. */
  private addFlight(obj: THREE.Object3D): void {
    this.flightObjects.push(obj);
    this.engine.add(obj);
  }

  private railDirection(): THREE.Vector3 {
    const { angle, heading } = this.meta.launch;
    const e = THREE.MathUtils.degToRad(90 - angle);
    const h = THREE.MathUtils.degToRad(heading);
    return toScene([Math.cos(e) * Math.sin(h), Math.cos(e) * Math.cos(h), Math.sin(e)]).normalize();
  }

  /** The flight's position in the scene, with the pad's height added. */
  private place(x: number, y: number, z: number): THREE.Vector3 {
    const p = toScene([x, y, z]);
    p.y += this.lift;
    return p;
  }

  /** The wind (scene axes, m/s) at height `z`, without gusts. */
  private windAt(z: number): THREE.Vector3 {
    const { wind_speed, wind_from } = this.meta.launch;
    const gradient = (this.meta.launch as { wind_gradient?: number }).wind_gradient ?? DEFAULT_WIND_GRADIENT;
    const speed = wind_speed * (gradient ? (Math.max(z, 0.5) / 10) ** gradient : 1);
    const h = THREE.MathUtils.degToRad(wind_from);
    return toScene([-speed * Math.sin(h), -speed * Math.cos(h), 0]);
  }

  private buildStatic(): void {
    const engine = this.engine;
    const scene = engine.scene;
    // Filmic tone mapping for the sky's range of brightness, soft sun shadows, and a glow around the flame
    // The sky is HDR (up to about 1.5, the sun far more); only the flame and the sun bloom
    engine.setLook({ exposure: 0.5, shadows: true, bloom: { strength: 0.6, radius: 0.45, threshold: 6 } });
    scene.fog = new THREE.Fog(HAZE, 2500, 32000); // the horizon's haze
    engine.camera.far = 60000;
    engine.camera.near = 0.05;
    engine.camera.updateProjectionMatrix();
    engine.add(buildSky(engine.renderer, scene));
    scene.environmentIntensity = 0.3; // the sky's light fills shadows; the sun does the lighting

    // Sunlight, with shadows in a box that follows the rocket (see updateSun)
    engine.ambient.intensity = 0.15;
    engine.sun.color.set(0xfff1de);
    engine.sun.intensity = 3.2;
    engine.sun.castShadow = true;
    engine.sun.shadow.mapSize.set(2048, 2048);
    engine.sun.shadow.bias = -0.0004;
    engine.sun.shadow.normalBias = 0.02;
    this.updateSun(new THREE.Vector3(0, 0, 0), 12);

    this.clouds = new Clouds(this.windAt(1000));
    engine.add(this.clouds.group);
    this.motes = new AirMotes();
    engine.add(this.motes.points);

    const g = this.meta.rocket;
    engine.add(buildLaunchSite(this.railDirection(), this.meta.launch.rail_length, g.diameter, this.windAt(10)));

    this.model = buildRocketModel(g);
    this.engine.add(this.model.root);

    // Glow and light at the nozzle while the motor burns
    const nozzleY = g.cg - g.motor.aft_position;
    this.glow = buildGlow();
    this.glow.position.y = nozzleY;
    this.nozzleLight = new THREE.PointLight(0xffa050, 0, 40, 2);
    this.nozzleLight.position.y = nozzleY - g.motor.diameter;
    this.model.root.add(this.glow, this.nozzleLight);

    // A tag above the rocket, so it can be found when it's a few pixels tall
    const el = document.createElement('div');
    el.className = 'car-label rocket-label';
    el.textContent = g.motor.designation;
    this.tag = new CSS2DObject(el);
    this.tag.center.set(0.5, 1.6);
    this.engine.add(this.tag);
    this.model.root.position.set(0, this.lift, 0);
    this.model.root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.railDirection());
  }

  private buildFlight(): void {
    const track = this.track!;
    const xs = track.values('x');
    const ys = track.values('y');
    const zs = track.values('z');
    const points = xs.map((x, i) => this.place(x, ys[i], zs[i]));
    this.bounds.setFromPoints(points);

    // Whole path faint; the part already flown drawn over it
    const path = new THREE.BufferGeometry().setFromPoints(points);
    this.addFlight(new THREE.Line(path, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 })));
    this.trail = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: 0xffd28a }),
    );
    this.addFlight(this.trail);

    const apogee = Math.max(this.meta.summary.apogee, 10); // a live flight may not have climbed yet
    const ruler = buildAltitudeRuler(apogee, new THREE.Vector3(-Math.max(8, apogee * 0.06), 0, 0));
    this.addFlight(ruler.group);
    this.rulerLabels = ruler.labels;

    this.eventMarkers = [];
    for (const e of this.events()) {
      if (e.name === 'liftoff' || e.name === 'rail_exit') continue; // too close to the pad to label
      const marker = new THREE.Group();
      marker.position.copy(this.place(e.x, e.y, e.z));
      const el = document.createElement('div');
      el.className = 'event-label';
      el.textContent = e.name === 'apogee' ? `${e.label} · ${Math.round(e.z).toLocaleString()} m` : e.label;
      const label = new CSS2DObject(el);
      marker.add(label);
      this.addFlight(marker);
      this.eventMarkers.push({ event: e, label });
    }
  }

  /** Smoke puffs along the flight: a thick trail while the motor burns, a thin one from the delay grain after. */
  private buildSmoke(): void {
    const track = this.track!;
    const g = this.meta.rocket;
    const event = (name: string) => this.meta.events.find((e) => e.name === name)?.time;
    const liftoff = event('liftoff') ?? 0;
    const burnout = event('burnout') ?? g.motor.burn_time;
    const smokeEnd = event('ejection') ?? burnout + 1;
    const tail = g.motor.aft_position - g.cg; // CG to nozzle, along the axis
    const rand = mulberry(3);
    const puffs: Puff[] = [];

    // A cloud rolling out across the pad at ignition
    for (let i = 0; i < 70; i++) {
      const a = rand() * Math.PI * 2;
      const r = rand() * 2.5;
      puffs.push({
        position: new THREE.Vector3(Math.cos(a) * r, 0.4 + rand() * 0.8, Math.sin(a) * r),
        born: liftoff + rand() * Math.min(burnout, 0.6),
        size: 1.2 + rand(), growth: 2.2, life: 14 + rand() * 4, rise: 0.25,
      });
    }

    // Walk the path from liftoff to the end of the smoke, dropping puffs at even spacing
    // (interpolating between samples: at 100+ m/s they're over a meter apart)
    const size = Math.max(g.motor.diameter * 8, 0.3);
    const nozzleAt = (t: number) => {
      const state = track.stateAt(t);
      const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(state.orientation);
      return this.place(state.x, state.y, state.z).addScaledVector(axis, -tail);
    };
    let t = liftoff;
    let last = nozzleAt(t);
    const step = 0.002; // s, fine enough to place puffs within a few cm of their spacing
    while (t < smokeEnd && puffs.length < 14000) {
      t += step;
      const here = nozzleAt(t);
      const burning = t <= burnout;
      if (last.distanceTo(here) < (burning ? 0.2 : 0.25)) continue;
      last = here;
      const jitter = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(size * 0.3);
      // A motor's trail hangs in the sky for a good while, spreading and thinning as it goes
      puffs.push(burning
        ? { position: here.clone().add(jitter), born: t, size, growth: 1.6, life: 22 + rand() * 6, rise: 0.15 }
        : { position: here.clone().add(jitter), born: t, size: size * 0.7, growth: 1.0, life: 12 + rand() * 4, rise: 0.1 });
    }

    const { wind_speed, wind_from } = this.meta.launch;
    const h = THREE.MathUtils.degToRad(wind_from);
    const wind = toScene([-wind_speed * Math.sin(h), -wind_speed * Math.cos(h), 0]);
    this.smoke = new Smoke(puffs, wind);
    this.engine.add(this.smoke.points);
  }

  private chartSeries(channel: 'z' | 'vertical_velocity' | 'acceleration'): ChartSeries {
    // Every sample is more than a chart needs; keep about 600 points, always including peaks
    const track = this.track!;
    const values = track.values(channel);
    const time = track.time;
    const bucket = Math.max(1, Math.floor(time.length / 300));
    const out: ChartSeries = { time: [], values: [] };
    for (let i = 0; i < time.length; i += bucket) {
      let lo = i;
      let hi = i;
      for (let j = i; j < Math.min(i + bucket, time.length); j++) {
        if (values[j] < values[lo]) lo = j;
        if (values[j] > values[hi]) hi = j;
      }
      for (const k of lo <= hi ? [lo, hi] : [hi, lo]) {
        if (out.time[out.time.length - 1] === time[k]) continue;
        out.time.push(time[k]);
        out.values.push(values[k]);
      }
    }
    return out;
  }

  // ---------- per frame ----------

  update(t: number, dt: number): void {
    if (!this.track || !this.model) return;
    const state = this.track.stateAt(t);
    const { root, flame, chutes } = this.model;
    root.position.copy(this.place(state.x, state.y, state.z));
    root.quaternion.copy(state.orientation);

    // Flame, glow and light follow thrust, with a smooth flicker
    const thrust = state.thrust / (this.meta.rocket.motor.max_thrust || 1);
    const burning = state.thrust > 0.01 && t > 0;
    const wobble = flicker(performance.now() / 1000);
    flame.visible = burning;
    flame.scale.set(1, this.meta.rocket.length * (0.3 + 0.9 * Math.sqrt(thrust)) * wobble, 1);
    const d = this.meta.rocket.motor.diameter;
    this.glow!.visible = burning;
    this.glow!.scale.setScalar(d * (4 + 6 * Math.sqrt(thrust)) * wobble);
    this.nozzleLight!.intensity = burning ? 60 * Math.sqrt(thrust) * wobble : 0;
    this.model.animate(performance.now() / 1000);
    this.clouds?.update(t);
    this.smoke?.update(t, this.engine.camera, this.engine.renderer.getDrawingBufferSize(new THREE.Vector2()).y);

    // A jump in time is a seek: cameras snap instead of easing
    if (Math.abs(t - this.lastTime) > 0.5) this.followInitialized = false;
    this.lastTime = t;

    const deploys = this.meta.events.filter((e) => e.name.startsWith('deploy:'));
    this.meta.rocket.recovery.forEach((device, i) => {
      const deployed = deploys.find((e) => e.name === `deploy:${device.name}`);
      chutes[i].visible = !!deployed && t >= deployed.time && !(t >= this.meta.time_range.end);
      // It streams out of the tube and fills over about half a second, as the simulation has it
      if (deployed) chutes[i].scale.setScalar(Math.max(0.05, THREE.MathUtils.smoothstep(t - deployed.time, 0, 0.6)));
    });

    // Trail up to now
    const flown = this.track.time.findIndex((x) => x > t);
    this.trail!.geometry.setDrawRange(0, flown === -1 ? this.track.time.length : Math.max(flown, 1));

    this.tag?.position.copy(root.position);
    this.updateLabels(t);
    this.updateCamera(dt, t, state);
    const viewport = this.engine.renderer.getDrawingBufferSize(new THREE.Vector2()).y;
    this.motes?.update(this.engine.camera, this.mode() === 'follow' ? state.speed / 3.6 : 0, viewport);
    // Shadows sharp around the rocket near the pad, covering more as the camera backs off
    this.updateSun(root.position, Math.max(this.meta.rocket.length * 6, 12));
    this.latest = state; // published to the panels by syncUi
  }

  syncUi(t: number): void {
    this.time.set(t);
    if (this.latest) this.state.set(this.latest);
  }

  private updateLabels(t: number): void {
    const show = this.showLabels();
    for (const { event, label } of this.eventMarkers) {
      label.visible = show;
      label.element.classList.toggle('upcoming', event.time > t);
    }
    for (const label of [...this.rulerLabels, ...this.zoneLabels]) label.visible = show;
    if (this.tag) this.tag.visible = show && this.mode() !== 'follow';
  }

  // ---------- cameras ----------

  resetView(): void {
    if (this.bounds.isEmpty()) return;
    const sphere = this.bounds.getBoundingSphere(new THREE.Sphere());
    this.engine.frame(sphere.center, Math.max(sphere.radius, 10) * 1.2, 15, Math.PI / 4);
  }

  setCameraMode(id: string): boolean {
    const mode = id as RocketCamera;
    this.mode.set(mode);
    this.followInitialized = false;
    this.engine.controls.enabled = mode === 'overview';
    const camera = this.engine.camera;
    camera.fov = this.baseFov;
    camera.updateProjectionMatrix();
    if (mode === 'overview') this.resetView();
    if (mode === 'landing') this.frameLandingZone();
    return true;
  }

  /** Look straight down on the landing zone and the pad. */
  private frameLandingZone(): void {
    if (!this.zoneBounds) return;
    const center = this.zoneBounds.getCenter(new THREE.Vector3());
    const size = this.zoneBounds.getSize(new THREE.Vector3());
    this.engine.frame(center, Math.max(0.5 * Math.hypot(size.x, size.z), 20), 80);
  }

  /** Keep the sun's shadow box centered on `at`, `half` meters each way. */
  private updateSun(at: THREE.Vector3, half: number): void {
    const sun = this.engine.sun;
    sun.target.position.copy(at);
    sun.position.copy(at).addScaledVector(this.sunDir, 300);
    const cam = sun.shadow.camera;
    if (cam.right !== half) {
      cam.left = cam.bottom = -half;
      cam.right = cam.top = half;
      cam.near = 1;
      cam.far = 700;
      cam.updateProjectionMatrix();
    }
  }

  /** The rocket's acceleration (scene axes, m/s²) around time `t`, averaged over the last few tenths of a second. */
  private accelerationAt(t: number): THREE.Vector3 {
    const track = this.track!;
    const h = 0.05;
    const p = (u: number) => {
      const s = track.stateAt(Math.min(Math.max(u, track.start), track.end));
      return toScene([s.x, s.y, s.z]);
    };
    const sum = new THREE.Vector3();
    let weight = 0;
    for (let k = 0; k < 5; k++) {
      const u = t - k * 0.08;
      const w = Math.exp(-k * 0.5);
      const a = p(u + h).add(p(u - h)).addScaledVector(p(u), -2).divideScalar(h * h);
      sum.addScaledVector(a, w);
      weight += w;
    }
    track.stateAt(t); // leave the track's cursor where the frame is
    return sum.divideScalar(weight);
  }

  private updateCamera(dt: number, t: number, state: RocketState): void {
    const root = this.model!.root;
    const camera = this.engine.camera;
    const mode = this.mode();
    const length = this.meta.rocket.length;
    const altitude = Math.max(root.position.y - this.lift, 0);

    if (mode === 'overview' || mode === 'landing') {
      // The rocket is tiny against its trajectory: enlarge it with distance so it stays visible
      const distance = camera.position.distanceTo(root.position);
      root.scale.setScalar(THREE.MathUtils.clamp(distance / (length * 60), 1, 200));
      return;
    }
    root.scale.setScalar(1);

    if (mode === 'ground') {
      // A tracking telescope: fixed spot, zooming so the rocket keeps a steady size, but not so
      // far that the frame is only sky: its smoke and the clouds around it show it moving
      camera.position.copy(this.groundCamera);
      const distance = camera.position.distanceTo(root.position);
      const view = Math.max(length * 14, 12);
      camera.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(view / 2 / distance)), 2.5, this.baseFov);
      camera.updateProjectionMatrix();
      camera.lookAt(root.position);
      return;
    }

    // Chase: held at a bearing from the rocket by a stiff spring, so when the motor kicks the
    // rocket pulls away and the camera catches up (and drifts ahead as drag slows it after
    // burnout). The lag comes from the flight's own acceleration, so it's right at any speed or seek.
    // Under a parachute, frame the canopy and the rocket hanging from it, not just the rocket,
    // easing over to it as each canopy opens so the view doesn't jump
    const deploys = this.meta.events.filter((e) => e.name.startsWith('deploy:') && e.time <= t);
    let rig = 0;      // m from the rocket's CG up to the top of the largest open canopy
    let opened = 0;   // 0 before the first canopy, easing to 1 as it opens
    for (const e of deploys) {
      const diameter = this.meta.rocket.recovery.find((r) => `deploy:${r.name}` === e.name)?.diameter ?? 0;
      const w = THREE.MathUtils.smoothstep(t - e.time, 0, 1.2);
      rig = Math.max(rig, (diameter * 1.4 + this.meta.rocket.cg) * w); // lines, canopy, rocket above its CG
      opened = Math.max(opened, w);
    }
    const target = Math.max(length * 4, rig * 2.6) + altitude * 0.02;
    this.followDistance = this.followInitialized
      ? THREE.MathUtils.lerp(this.followDistance, target, 1 - Math.exp(-2 * dt))
      : target;
    this.followInitialized = true;
    const lag = this.accelerationAt(t).add(new THREE.Vector3(0, 9.81, 0)).divideScalar(CHASE_OMEGA ** 2);
    // Only while flying free: on the pad there's nothing to lag, and under a canopy the opening
    // shock would yank the camera (near apogee the lag is about zero anyway, so this doesn't jump)
    if (t <= (this.meta.events.find((e) => e.name === 'liftoff')?.time ?? 0) || deploys.length) lag.set(0, 0, 0);
    lag.clampLength(0, Math.min(CHASE_MAX_LAG, this.followDistance * 1.2)); // pulls away, but not out of sight
    camera.position.copy(root.position).addScaledVector(FOLLOW_BEARING, this.followDistance).sub(lag);
    camera.position.y = Math.max(camera.position.y, 1.5);

    // Shake: the motor's rumble and buffeting at high dynamic pressure
    const thrust = state.thrust / (this.meta.rocket.motor.max_thrust || 1);
    const q = state.dynamic_pressure / Math.max(this.meta.summary.max_q, 1);
    const s = performance.now() / 1000;
    const amp = this.followDistance * (0.004 * Math.sqrt(Math.max(thrust, 0)) + 0.003 * q);
    const shake = new THREE.Vector3(
      Math.sin(s * 47) + 0.5 * Math.sin(s * 89 + 1), Math.sin(s * 53 + 2) + 0.5 * Math.sin(s * 97), Math.sin(s * 41 + 4),
    ).multiplyScalar(amp);

    // A wider view at speed, like a camera struggling to keep up
    const speed = state.speed / 3.6;
    camera.fov = this.baseFov + 10 * Math.min(speed / 150, 1);
    camera.updateProjectionMatrix();
    // Aim a little below the rocket: it rides in the upper part of the frame with its smoke trailing
    // beneath. Under a canopy, aim between the two so both are in view.
    const below = -this.followDistance * 0.3 * Math.min(altitude / 20, 1); // on the pad, the rocket itself
    const aim = root.position.clone().add(new THREE.Vector3(0, THREE.MathUtils.lerp(below, rig * 0.35, opened), 0));
    camera.lookAt(aim.add(shake));
  }

  dispose(): void {
    const camera = this.engine.camera;
    camera.fov = this.baseFov;
    camera.updateProjectionMatrix();
    this.engine.clear();
  }
}

/** The flight summary a finished replay carries, from the samples received so far (live flights). */
function summarize(track: RocketTrack, events: FlightEvent[]): FlightSummary {
  const t = track.time;
  const n = t.length;
  const argmax = (v: number[]) => v.reduce((best, x, i) => (x > v[best] ? i : best), 0);
  const z = track.values('z');
  const q = track.values('dynamic_pressure');
  const speed = track.values('speed');
  const at = (name: string) => events.find((e) => e.name === name)?.time;
  const iApo = argmax(z);
  const iQ = argmax(q);
  const railExit = at('rail_exit');
  const iRail = railExit == null ? -1 : t.findIndex((x) => x >= railExit);
  return {
    apogee: z[iApo],
    apogee_time: at('apogee') ?? null,
    max_speed: speed[argmax(speed)] / 3.6,
    max_mach: track.values('mach')[argmax(track.values('mach'))],
    max_acceleration: track.values('acceleration')[argmax(track.values('acceleration'))],
    max_q: q[iQ],
    max_q_time: t[iQ],
    flight_time: t[n - 1],
    landing: [track.values('x')[n - 1], track.values('y')[n - 1]],
    rail_exit_speed: iRail >= 0 ? speed[iRail] / 3.6 : 0,
  };
}
