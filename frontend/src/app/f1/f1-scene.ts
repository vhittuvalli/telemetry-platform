import { computed, signal } from '@angular/core';
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Observable, forkJoin, map, tap } from 'rxjs';
import { ReplayApiService } from '../replay/replay-api.service';
import { DataSource } from '../replay/replay-source';
import { LiveSource } from '../replay/live-source';
import { Driver, F1Meta, LapRecord, Series, VehicleSeries } from '../replay/replay.models';
import { CameraOption, SceneModule, Timeline } from '../engine/scene-module';
import { ViewerEngine, toScene } from '../engine/viewer-engine';
import { VehicleState, VehicleTrack } from './vehicle-track';
import { DriverLaps, computeStandings, indexLaps } from './standings';
import { createCarModel } from './car-model';
import { TrackLayout, buildEnvironment, buildRoad, setLamps } from './track-builder';
import { buildPitLane, findPitLane } from './pit-lane';
import { StartingGrid, buildStartingGrid, findStartingGrid, lightsOn } from './starting-grid';

type F1Camera = 'overview' | 'chase' | 'onboard';

/** An F1 session: the track and its scenery, every car, and the leaderboard and driver dashboard. */
export class F1Scene implements SceneModule {
  readonly domain = 'f1';
  readonly cameraOptions: readonly CameraOption[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'chase', label: 'Chase', needsTarget: true },
    { id: 'onboard', label: 'Onboard', needsTarget: true },
  ];

  // panel state (read by the viewer's template)
  readonly showLabels = signal(true);
  readonly selectedDriver = signal<string | null>(null);
  readonly selectedState = signal<VehicleState | null>(null);
  private time = signal(0);
  private drivers = signal<Driver[]>([]);
  private lapIndex = signal<Map<string, DriverLaps> | null>(null);
  private totalLaps = signal(0);

  readonly standings = computed(() => {
    const index = this.lapIndex();
    if (!index) return [];
    return computeStandings(this.time(), this.drivers(), index, (code) => this.carProgress.get(code) ?? null);
  });
  readonly selectedRow = computed(() => {
    const code = this.selectedDriver();
    return this.standings().find((r) => r.code === code) ?? null;
  });
  readonly lapText = computed(() => {
    const leaderLaps = this.standings()[0]?.lapsDone ?? 0;
    // Live, the race's length isn't known yet
    if (this.source.live) return `Lap ${leaderLaps + 1}`;
    const total = this.totalLaps();
    return `Lap ${Math.min(leaderLaps + 1, total)}/${total}`;
  });

  // scene
  private ground!: THREE.Mesh;
  private trackBounds?: THREE.Box3;
  private layout?: TrackLayout;
  private grid: StartingGrid | null = null;
  private startLamps: THREE.Mesh[] = [];
  private litLamps = -1;
  private outline: [number, number][] = [];

  // cars
  private tracks = new Map<string, VehicleTrack>();
  private cars = new Map<string, THREE.Object3D>();
  private labels = new Map<string, CSS2DObject>();
  private carStates = new Map<string, VehicleState>();
  private carProgress = new Map<string, number | null>();
  private onTrack = new Set<string>();

  // camera
  private mode = signal<F1Camera>('overview');
  private followHeading = 0;
  private followInitialized = false;

  constructor(
    private engine: ViewerEngine,
    private source: DataSource,
    private api: ReplayApiService,
    private meta: F1Meta,
  ) {}

  cameraMode(): string {
    return this.mode();
  }

  hasTarget(): boolean {
    return this.selectedDriver() !== null;
  }

  // ---------- loading ----------

  load(): Observable<Timeline> {
    if (this.source instanceof LiveSource) return this.loadLive(this.source);
    this.buildTrack();
    const { start, end } = this.meta.time_range;
    this.drivers.set(this.meta.drivers);

    // Laps come with the telemetry: together they show where the pit lane and grid are
    return forkJoin({
      laps: this.api.getLaps(this.source.id),
      vehicles: this.source.series(this.meta),
    }).pipe(
      tap(({ laps, vehicles }) => {
        const lapIndex = indexLaps(laps);
        this.lapIndex.set(lapIndex);
        this.totalLaps.set(Math.max(0, ...laps.map((l) => l.lap)));

        for (const [id, series] of vehicles) {
          const track = new VehicleTrack(id, series as unknown as VehicleSeries);
          track.finalize();
          this.tracks.set(id, track);
        }
        this.buildScenery(lapIndex);
        this.createCars();
      }),
      // Races open on the formed grid a few seconds before the lights; other sessions at the start
      map(() => ({ start, end, openAt: this.grid ? Math.max(start, this.grid.raceStart - 10) : 0 })),
    );
  }

  /**
   * A live session: the track now, then cars and standings rebuilt from everything
   * received each time more arrives. Pit lane and grid detection need the whole
   * session, so a live view shows the track without them.
   */
  private loadLive(source: LiveSource): Observable<Timeline> {
    this.buildTrack();
    this.drivers.set(this.meta.drivers);
    let first = true;
    return source.series().pipe(
      map((vehicles) => {
        this.applyLive(vehicles, source.laps());
        if (first) {
          this.engine.add(buildEnvironment(this.layout!, { finishGantry: true }));
          first = false;
        }
        const { start, end } = source.currentMeta().time_range;
        return { start, end, openAt: end, live: true };
      }),
    );
  }

  private applyLive(vehicles: Map<string, Series>, laps: LapRecord[]): void {
    const lapIndex = indexLaps(laps);
    this.lapIndex.set(lapIndex);
    this.totalLaps.set(laps.reduce((most, l) => Math.max(most, l.lap), 0));
    for (const [id, series] of vehicles) {
      // Finalizing cleans and smooths the data in place, so work on a copy: more keeps arriving
      const copy = Object.fromEntries(Object.entries(series).map(([k, v]) => [k, v.slice()])) as unknown as VehicleSeries;
      const track = new VehicleTrack(id, copy);
      track.finalize();
      this.tracks.set(id, track);
    }
    this.createCars(); // cars that have just appeared
  }

  private buildTrack(): void {
    const scene = this.engine.scene;
    scene.background = new THREE.Color(0x87ceeb);
    scene.fog = new THREE.Fog(0x87ceeb, 4000, 9000);

    this.outline = this.meta.track_outline.map(([x, y]) => [x, y] as [number, number]);
    const points = this.meta.track_outline.map(toScene);

    // Road now; the scenery waits for the telemetry, which shows where the pits and grid are
    const layout = new TrackLayout(points);
    this.layout = layout;
    this.engine.add(buildRoad(layout));

    // Frame the camera on the track
    this.trackBounds = new THREE.Box3().setFromPoints(points);
    this.resetView();

    // Ground at the layout's ground height, centered under the track
    const center = this.trackBounds.getCenter(new THREE.Vector3());
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(10000, 10000),
      new THREE.MeshStandardMaterial({ color: 0x2f5d3a }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.set(center.x, layout.groundY, center.z);
    this.engine.add(this.ground);
  }

  /** Pit lane, starting grid, and the rest of the scenery around the track. */
  private buildScenery(lapIndex: Map<string, DriverLaps>): void {
    const layout = this.layout!;

    const pitLane = findPitLane(layout, this.tracks, lapIndex, toScene);
    if (pitLane) {
      const teamColors = [...new Set(this.meta.drivers.map((d) => d.color ?? '#888888'))];
      this.engine.add(buildPitLane(layout, pitLane, teamColors));
    }

    // Only races and sprints start from a grid
    const standingStart = this.meta.session.name === 'Race' || this.meta.session.name === 'Sprint';
    this.grid = standingStart ? findStartingGrid(layout, this.tracks, lapIndex, toScene) : null;
    if (this.grid) {
      const { group, lamps } = buildStartingGrid(layout, this.grid);
      this.engine.add(group);
      this.startLamps = lamps;
    }

    this.engine.add(buildEnvironment(layout, { pitSide: pitLane?.side, finishGantry: !this.grid }));
  }

  private createCars(): void {
    for (const driver of this.meta.drivers) {
      if (!this.tracks.has(driver.code) || this.cars.has(driver.code)) continue;
      const color = driver.color ?? '#ffffff';

      const car = createCarModel(color);
      car.visible = false;

      const el = document.createElement('div');
      el.className = 'car-label';
      el.textContent = driver.code;
      el.style.borderLeftColor = color;
      const label = new CSS2DObject(el);
      label.position.set(0, 2.5, 0); // a few meters above the car
      car.add(label);

      this.engine.add(car);
      this.cars.set(driver.code, car);
      this.labels.set(driver.code, label);
    }
  }

  // ---------- per frame ----------

  update(t: number, dt: number): void {
    this.updateCars(t);
    this.updateStartLights(t);
    this.updateFollowCamera(dt);
  }

  syncUi(t: number): void {
    this.time.set(t);
    const code = this.selectedDriver();
    this.selectedState.set(code ? this.carStates.get(code) ?? null : null);
  }

  private updateStartLights(t: number): void {
    if (!this.grid) return;
    const lit = lightsOn(this.grid, t);
    if (lit === this.litLamps) return;
    this.litLamps = lit;
    setLamps(this.startLamps, lit);
  }

  private updateCars(t: number): void {
    const camera = this.engine.camera;
    for (const [id, car] of this.cars) {
      const state = this.tracks.get(id)!.stateAt(t);
      const label = this.labels.get(id)!;
      if (!state || !state.onTrack) {
        car.visible = false;
        label.visible = false;
        this.carProgress.set(id, null);
        this.onTrack.delete(id);
        this.carStates.delete(id);
        continue;
      }
      this.carProgress.set(id, this.lapFraction(state.x, state.y));
      this.onTrack.add(id);
      this.carStates.set(id, state);

      // Hide the followed car (and its label) in onboard view, since the camera sits inside it
      const onboardSelf = this.mode() === 'onboard' && id === this.selectedDriver();
      car.visible = !onboardSelf;
      label.visible = this.showLabels() && !onboardSelf;

      // Sit on the road surface: telemetry heights are noisy, and flat in the pit lane
      const position = toScene([state.x, state.y, state.z]);
      if (this.layout) position.y = this.layout.samples[this.layout.locate(position).index].y;
      car.position.copy(position);
      car.rotation.y = state.heading; // face the direction of travel
      if (this.mode() === 'overview') {
        const distance = camera.position.distanceTo(car.position);
        car.scale.setScalar(THREE.MathUtils.clamp(distance / 250, 1, 6));
      } else {
        car.scale.setScalar(1);
      }
    }
    this.separateCars();
  }

  /** Nudge overlapping cars apart sideways. Visual only; race order is unaffected. */
  private separateCars(): void {
    const CAR_LENGTH = 5.6;
    const CAR_WIDTH = 2.1;
    const active: THREE.Object3D[] = [];
    for (const [id, car] of this.cars) {
      if (this.onTrack.has(id)) active.push(car);
    }

    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < active.length; a++) {
        for (let b = a + 1; b < active.length; b++) {
          const A = active[a];
          const B = active[b];
          const dx = B.position.x - A.position.x;
          const dz = B.position.z - A.position.z;
          if (dx * dx + dz * dz > 36) continue; // more than 6 m apart: can't overlap

          // Measure the offset in A's frame: along its length and across its width
          const h = A.rotation.y;
          const fx = Math.cos(h), fz = -Math.sin(h);   // forward
          const sx = Math.sin(h), sz = Math.cos(h);    // sideways
          const along = dx * fx + dz * fz;
          const across = dx * sx + dz * sz;
          if (Math.abs(along) >= CAR_LENGTH || Math.abs(across) >= CAR_WIDTH) continue;

          // Push each car half the overlap, in opposite sideways directions
          const push = (CAR_WIDTH - Math.abs(across)) / 2;
          const dir = across >= 0 ? 1 : -1;
          A.position.x -= sx * push * dir;
          A.position.z -= sz * push * dir;
          B.position.x += sx * push * dir;
          B.position.z += sz * push * dir;
        }
      }
    }
  }

  /** Fraction of the lap (0–1) for a position, from the closest outline point. */
  private lapFraction(x: number, y: number): number {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this.outline.length; i++) {
      const dx = this.outline[i][0] - x;
      const dy = this.outline[i][1] - y;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best / this.outline.length;
  }

  // ---------- cameras and selection ----------

  resetView(): void {
    if (!this.trackBounds) return;
    const center = this.trackBounds.getCenter(new THREE.Vector3());
    const size = this.trackBounds.getSize(new THREE.Vector3());
    this.engine.frame(center, 0.5 * Math.hypot(size.x, size.z), 60, size.x >= size.z ? 0 : Math.PI / 2);
  }

  setCameraMode(id: string): boolean {
    const mode = id as F1Camera;
    if (mode !== 'overview' && !this.selectedDriver()) return false; // need a driver to follow
    this.mode.set(mode);
    this.followInitialized = false;
    this.engine.controls.enabled = mode === 'overview';
    if (mode === 'overview') this.resetView();
    return true;
  }

  /** Choosing a driver starts following them; choosing them again stops. */
  selectDriver(code: string): void {
    const next = this.selectedDriver() === code ? null : code;
    this.selectedDriver.set(next);
    for (const [id, label] of this.labels) {
      label.element.classList.toggle('selected', id === next);
    }

    if (next === null) {
      this.setCameraMode('overview');
    } else if (this.mode() === 'overview') {
      this.setCameraMode('chase');
    } else {
      this.followInitialized = false; // switching drivers: snap to the new car
    }
  }

  /** Move the camera to follow the selected car. */
  private updateFollowCamera(dt: number): void {
    const mode = this.mode();
    const code = this.selectedDriver();
    if (mode === 'overview' || !code) return;

    const car = this.cars.get(code);
    if (!car || !this.onTrack.has(code)) return;

    // Smooth the heading, always turning the short way around
    const target = car.rotation.y;
    if (!this.followInitialized) {
      this.followHeading = target;
    } else {
      let diff = target - this.followHeading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // wrap to [-π, π]
      this.followHeading += diff * (1 - Math.exp(-6 * dt));
    }

    const forward = new THREE.Vector3(Math.cos(this.followHeading), 0, -Math.sin(this.followHeading));
    const carPos = car.position;

    let desired: THREE.Vector3;
    let lookAt: THREE.Vector3;
    if (mode === 'chase') {
      desired = carPos.clone().addScaledVector(forward, -12).add(new THREE.Vector3(0, 4, 0));
      lookAt = carPos.clone().addScaledVector(forward, 10).add(new THREE.Vector3(0, 1, 0));
    } else {
      // onboard: at the driver's head, looking down the track
      desired = carPos.clone().addScaledVector(forward, 0.3).add(new THREE.Vector3(0, 1.1, 0));
      lookAt = carPos.clone().addScaledVector(forward, 60).add(new THREE.Vector3(0, 0.8, 0));
    }

    const camera = this.engine.camera;
    if (!this.followInitialized) {
      camera.position.copy(desired); // first frame: jump straight there
      this.followInitialized = true;
    } else {
      const k = mode === 'chase' ? 5 : 20; // onboard follows tightly; chase trails a bit
      camera.position.lerp(desired, 1 - Math.exp(-k * dt)); //frame rate independent smoothing
    }
    camera.lookAt(lookAt);
  }

  dispose(): void {
    this.engine.clear();
  }
}
