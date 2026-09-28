import { computed, signal } from '@angular/core';
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Observable, map, tap } from 'rxjs';
import { DataSource } from '../replay/replay-source';
import { FlightEvent, RocketMeta } from '../replay/replay.models';
import { CameraOption, SceneModule, Timeline } from '../engine/scene-module';
import { ViewerEngine, toScene } from '../engine/viewer-engine';
import { RocketState, RocketTrack } from './rocket-track';
import { RocketModel, buildRocketModel } from './rocket-model';
import { buildAltitudeRuler, buildLaunchSite, padLift } from './launch-site';

type RocketCamera = 'follow' | 'ground' | 'overview';

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
  readonly cameraOptions: readonly CameraOption[] = [
    { id: 'follow', label: 'Follow' },
    { id: 'ground', label: 'Ground' },
    { id: 'overview', label: 'Overview' },
  ];
  readonly showLabels = signal(true);

  // panel state
  readonly time = signal(0);
  readonly state = signal<RocketState | null>(null);
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
  private latest?: RocketState;
  private model?: RocketModel;
  private lift: number;
  private mode = signal<RocketCamera>('follow');
  private followInitialized = false;
  private trail?: THREE.Line;
  private tag?: CSS2DObject;
  private eventMarkers: { event: FlightEvent; label: CSS2DObject }[] = [];
  private rulerLabels: CSS2DObject[] = [];
  private bounds = new THREE.Box3();
  private readonly baseFov: number;
  private readonly groundCamera: THREE.Vector3;

  constructor(private engine: ViewerEngine, private source: DataSource, readonly meta: RocketMeta) {
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
    return this.source.series(this.meta).pipe(
      tap((vehicles) => {
        const series = vehicles.get('rocket') ?? vehicles.values().next().value;
        if (!series) throw new Error('Flight has no rocket data');
        this.track = new RocketTrack(series);
        this.buildFlight();
        this.charts.set({
          altitude: this.chartSeries('z'),
          velocity: this.chartSeries('vertical_velocity'),
          acceleration: this.chartSeries('acceleration'),
        });
        this.setCameraMode(this.mode()); // the engine starts every session with orbit controls on
      }),
      map(() => ({ start: this.meta.time_range.start, end: this.meta.time_range.end, openAt: 0 })),
    );
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
    scene.background = new THREE.Color(0x8ec5ea);
    scene.fog = new THREE.Fog(0x8ec5ea, 3000, 30000);
    this.engine.camera.far = 60000;
    this.engine.camera.updateProjectionMatrix();

    const g = this.meta.rocket;
    this.engine.add(buildLaunchSite(this.railDirection(), this.meta.launch.rail_length, g.diameter));

    this.model = buildRocketModel(g);
    this.engine.add(this.model.root);

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
    this.engine.add(new THREE.Line(path, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 })));
    this.trail = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: 0xffd28a }),
    );
    this.engine.add(this.trail);

    const apogee = this.meta.summary.apogee;
    const ruler = buildAltitudeRuler(apogee, new THREE.Vector3(-Math.max(8, apogee * 0.06), 0, 0));
    this.engine.add(ruler.group);
    this.rulerLabels = ruler.labels;

    for (const e of this.events()) {
      if (e.name === 'liftoff' || e.name === 'rail_exit') continue; // too close to the pad to label
      const marker = new THREE.Group();
      marker.position.copy(this.place(e.x, e.y, e.z));
      const el = document.createElement('div');
      el.className = 'event-label';
      el.textContent = e.name === 'apogee' ? `${e.label} · ${Math.round(e.z).toLocaleString()} m` : e.label;
      const label = new CSS2DObject(el);
      marker.add(label);
      this.engine.add(marker);
      this.eventMarkers.push({ event: e, label });
    }
    this.resetView();
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

    // Flame length follows thrust, with a little flicker
    const thrust = state.thrust / (this.meta.rocket.motor.max_thrust || 1);
    flame.visible = state.thrust > 0.01 && t > 0;
    const length = this.meta.rocket.length * (0.3 + 0.9 * Math.sqrt(thrust)) * (0.92 + 0.16 * Math.random());
    flame.scale.set(1, length, 1);

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
    for (const label of this.rulerLabels) label.visible = show;
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
    return true;
  }

  private updateCamera(dt: number): void {
    const root = this.model!.root;
    const camera = this.engine.camera;
    const mode = this.mode();
    const length = this.meta.rocket.length;
    const altitude = Math.max(root.position.y - this.lift, 0);

    if (mode === 'overview') {
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

    // Follow: alongside the rocket, backing off a little as it climbs so the ground stays in view
    const distance = length * 5 + altitude * 0.06;
    const desired = root.position.clone().add(new THREE.Vector3(distance * 0.7, -distance * 0.15, distance * 0.7));
    desired.y = Math.max(desired.y, 1.5);
    // Jump straight there on the first frame and after a seek; trail smoothly otherwise
    if (!this.followInitialized || camera.position.distanceTo(desired) > distance * 2) {
      camera.position.copy(desired);
      this.followInitialized = true;
    } else {
      camera.position.lerp(desired, 1 - Math.exp(-4 * dt));
    }
    camera.lookAt(root.position);
  }

  dispose(): void {
    const camera = this.engine.camera;
    camera.fov = this.baseFov;
    camera.updateProjectionMatrix();
    this.engine.clear();
  }
}
