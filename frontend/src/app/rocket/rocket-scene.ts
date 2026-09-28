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
import { Puff, Smoke, buildGlow, flicker } from './effects';

type RocketCamera = 'follow' | 'ground' | 'overview' | 'landing';

/** Where the follow camera sits relative to the rocket: to one side and a little below. */
const FOLLOW_BEARING = new THREE.Vector3(0.7, -0.15, 0.7).normalize();

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

  private buildStatic(): void {
    const scene = this.engine.scene;
    scene.fog = new THREE.Fog(0xd6e9f7, 3000, 30000); // matches the sky dome's horizon
    this.engine.camera.far = 60000;
    this.engine.camera.updateProjectionMatrix();

    const g = this.meta.rocket;
    this.engine.add(buildLaunchSite(this.railDirection(), this.meta.launch.rail_length, g.diameter));

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
    while (t < smokeEnd && puffs.length < 8000) {
      t += step;
      const here = nozzleAt(t);
      const burning = t <= burnout;
      if (last.distanceTo(here) < (burning ? 0.2 : 0.25)) continue;
      last = here;
      const jitter = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(size * 0.3);
      puffs.push(burning
        ? { position: here.clone().add(jitter), born: t, size, growth: 1.3, life: 11 + rand() * 3, rise: 0.15 }
        : { position: here.clone().add(jitter), born: t, size: size * 0.7, growth: 0.9, life: 8 + rand() * 2, rise: 0.1 });
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
    this.nozzleLight!.intensity = burning ? 40 * Math.sqrt(thrust) * wobble : 0;
    this.smoke?.update(t, this.engine.camera, this.engine.renderer.getDrawingBufferSize(new THREE.Vector2()).y);

    // A jump in time is a seek: cameras snap instead of easing
    if (Math.abs(t - this.lastTime) > 0.5) this.followInitialized = false;
    this.lastTime = t;

    const deploys = this.meta.events.filter((e) => e.name.startsWith('deploy:'));
    this.meta.rocket.recovery.forEach((device, i) => {
      const deployed = deploys.find((e) => e.name === `deploy:${device.name}`);
      chutes[i].visible = !!deployed && t >= deployed.time && !(t >= this.meta.time_range.end);
    });

    // Trail up to now
    const flown = this.track.time.findIndex((x) => x > t);
    this.trail!.geometry.setDrawRange(0, flown === -1 ? this.track.time.length : Math.max(flown, 1));

    this.tag?.position.copy(root.position);
    this.updateLabels(t);
    this.updateCamera(dt);
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

  private updateCamera(dt: number): void {
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
      // A tracking telescope: fixed spot, zooming so the rocket keeps a steady size
      camera.position.copy(this.groundCamera);
      const distance = camera.position.distanceTo(root.position);
      const view = Math.max(length * 6, 6);
      camera.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(view / 2 / distance)), 0.5, this.baseFov);
      camera.updateProjectionMatrix();
      camera.lookAt(root.position);
      return;
    }

    // Follow: locked to the rocket at a fixed bearing, so it can't fall behind; only the
    // distance eases, backing off a little as the rocket climbs so the ground stays in view
    const target = length * 4 + altitude * 0.02;
    this.followDistance = this.followInitialized
      ? THREE.MathUtils.lerp(this.followDistance, target, 1 - Math.exp(-2 * dt))
      : target;
    this.followInitialized = true;
    camera.position.copy(root.position).addScaledVector(FOLLOW_BEARING, this.followDistance);
    camera.position.y = Math.max(camera.position.y, 1.5);
    // Aim a little below the rocket: it rides in the upper part of the frame with its smoke trailing beneath
    camera.lookAt(root.position.clone().add(new THREE.Vector3(0, -this.followDistance * 0.3, 0)));
    return;
    camera.lookAt(root.position);
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
