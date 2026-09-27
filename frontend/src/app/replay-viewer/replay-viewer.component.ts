import {
  AfterViewInit, Component, ElementRef, HostListener, NgZone, OnDestroy, ViewChild,
  computed, effect, inject, input, signal, untracked,
} from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Observable, Subscription, forkJoin } from 'rxjs';
import { ReplayApiService } from '../replay/replay-api.service';
import { Driver, ReplayDataWindow, ReplayMeta } from '../replay/replay.models';
import { PlaybackClock } from '../replay/playback-clock';
import { VehicleTrack } from '../replay/vehicle-track';
import { DriverLaps, computeStandings, indexLaps } from '../replay/standings';
import { LeaderboardComponent } from '../leaderboard/leaderboard.component';
import { createCarModel } from '../replay/car-model';
import { TrackLayout, buildEnvironment, buildRoad, setLamps } from '../replay/track-builder';
import { buildPitLane, findPitLane } from '../replay/pit-lane';
import { StartingGrid, buildStartingGrid, findStartingGrid, lightsOn } from '../replay/starting-grid';
import { DashboardComponent } from '../dashboard/dashboard.component';
import { VehicleState } from '../replay/vehicle-track';

@Component({
  selector: 'app-replay-viewer',
  standalone: true,
  imports: [LeaderboardComponent, DashboardComponent],
  templateUrl: './replay-viewer.component.html',
  styleUrl: './replay-viewer.component.scss',
})
export class ReplayViewerComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  // three.js
  private renderer!: THREE.WebGLRenderer;
  private labelRenderer!: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private ground!: THREE.Mesh;
  private trackBounds?: THREE.Box3;
  private frameId = 0;
  private frameTimer = new THREE.Clock();
  private resizeObserver?: ResizeObserver;
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

  private carStates = new Map<string, VehicleState>();
  protected selectedState = signal<VehicleState | null>(null);

  protected selectedRow = computed(() => {
    const code = this.selectedDriver();
    return this.standings().find((r) => r.code === code) ?? null;
  });

  // replay data
  private api = inject(ReplayApiService);
  replayId = input<string | null>(null);
  private viewReady = signal(false);
  private loading = new Subscription();
  private trackObjects: THREE.Object3D[] = []; // road and scenery for the current track
  private layout?: TrackLayout;
  private grid: StartingGrid | null = null;
  private startLamps: THREE.Mesh[] = [];
  private litLamps = -1;
  private clock?: PlaybackClock;
  private tracks = new Map<string, VehicleTrack>();
  private labels = new Map<string, CSS2DObject>();
  private outline: [number, number][] = [];
  private carProgress = new Map<string, number | null>();

  // UI state (read by the template)
  protected currentTime = signal(0);
  protected playing = signal(false);
  protected speed = signal(1);
  protected timeRange = signal<{ start: number; end: number } | null>(null);
  protected showLabels = signal(true);
  protected selectedDriver = signal<string | null>(null);
  protected loadError = signal<string | null>(null);
  protected readonly speeds = [1, 2, 5, 10, 20];
  private lastUiUpdate = 0;

  // leaderboard
  private drivers = signal<Driver[]>([]);
  private lapIndex = signal<Map<string, DriverLaps> | null>(null);
  private totalLaps = signal(0);

  //camera view
  protected cameraMode = signal<'overview' | 'chase' | 'onboard'>('overview');
  private followHeading = 0;
  private followInitialized = false;
  private onTrack = new Set<string>();

  //cars
  private cars = new Map<string, THREE.Object3D>();

  protected standings = computed(() => {
    const index = this.lapIndex();
    if (!index) return [];
    return computeStandings(
      this.currentTime(),
      this.drivers(),
      index,
      (code) => this.carProgress.get(code) ?? null,
    );
  });

  protected lapText = computed(() => {
    const leaderLaps = this.standings()[0]?.lapsDone ?? 0;
    const total = this.totalLaps();
    return `Lap ${Math.min(leaderLaps + 1, total)}/${total}`;
  });

  constructor(private zone: NgZone) {
    // (Re)load whenever the chosen replay changes, once the renderer exists
    effect(() => {
      const id = this.replayId();
      if (!this.viewReady()) return;
      untracked(() => this.loadReplay(id));
    });
  }

  // ---------- setup ----------

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.labelRenderer = new CSS2DRenderer();
    const labelLayer = this.labelRenderer.domElement;
    labelLayer.classList.add('label-layer');
    this.host.nativeElement.appendChild(labelLayer);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 20000);
    this.camera.position.set(0, 500, 800);

    this.scene.background = new THREE.Color(0x87ceeb);
    this.scene.fog = new THREE.Fog(0x87ceeb, 4000, 9000);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(500, 1000, 300);
    this.scene.add(sun);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(10000, 10000),
      new THREE.MeshStandardMaterial({ color: 0x2f5d3a }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.ground);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = false;
    this.controls.zoomToCursor = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;
    this.controls.listenToKeyEvents(canvas);
    this.controls.keyPanSpeed = 30;
    canvas.addEventListener('pointerdown', () => canvas.focus());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();

    this.zone.runOutsideAngular(() => this.animate());
    this.viewReady.set(true);
  }

  // ---------- loading and switching replays ----------

  private loadReplay(id: string | null): void {
    this.clearReplay();
    if (!id) return;
    this.loading = new Subscription();
    this.loading.add(this.api.getMeta(id).subscribe({
      next: (meta) => this.buildTrack(id, meta),
      error: (err) => this.fail('Failed to load replay metadata', err),
    }));
  }

  private fail(message: string, err: unknown): void {
    console.error(message, err);
    this.loadError.set(message);
  }

  /** Remove everything belonging to the current replay and reset the UI. */
  private clearReplay(): void {
    this.loading.unsubscribe(); // drop any in-flight requests for the old replay

    for (const obj of [...this.trackObjects, ...this.cars.values()]) {
      this.scene.remove(obj);
      disposeObject(obj);
    }
    for (const label of this.labels.values()) label.element.remove();
    this.trackObjects = [];
    this.cars.clear();
    this.labels.clear();
    this.tracks.clear();
    this.carStates.clear();
    this.carProgress.clear();
    this.onTrack.clear();
    this.outline = [];
    this.trackBounds = undefined;
    this.layout = undefined;
    this.grid = null;
    this.startLamps = [];
    this.litLamps = -1;
    this.clock = undefined;

    this.currentTime.set(0);
    this.playing.set(false);
    this.speed.set(1);
    this.timeRange.set(null);
    this.selectedDriver.set(null);
    this.selectedState.set(null);
    this.loadError.set(null);
    this.drivers.set([]);
    this.lapIndex.set(null);
    this.totalLaps.set(0);
    this.cameraMode.set('overview');
    this.controls.enabled = true;
    this.followInitialized = false;
  }

  // ---------- playback controls ----------

  protected togglePlay(): void {
    if (!this.clock) return;
    if (!this.clock.playing && this.clock.time >= this.clock.end) {
      this.clock.seek(0);
    }
    this.clock.toggle();
    this.playing.set(this.clock.playing);
  }

  protected onSeek(event: Event): void {
    if (!this.clock) return;
    const value = Number((event.target as HTMLInputElement).value);
    this.clock.seek(value);
    this.currentTime.set(value);
  }

  protected setSpeed(s: number): void {
    if (!this.clock) return;
    this.clock.speed = s;
    this.speed.set(s);
  }

  protected resetView(): void {
    this.fitCameraToTrack();
  }

  protected setCameraMode(mode: 'overview' | 'chase' | 'onboard'): void {
    if (mode !== 'overview' && !this.selectedDriver()) return; // need a driver to follow
    this.cameraMode.set(mode);
    this.followInitialized = false;
    this.controls.enabled = mode === 'overview';
    if (mode === 'overview') this.fitCameraToTrack();
  }

  protected toggleLabels(): void {
    this.showLabels.update((v) => !v);
  }

  //choosing a driver starts following them
  protected selectDriver(code: string): void {
    const next = this.selectedDriver() === code ? null : code;
    this.selectedDriver.set(next);
    for (const [id, label] of this.labels) {
      label.element.classList.toggle('selected', id === next);
    }

    if (next === null) {
      this.setCameraMode('overview');
    } else if (this.cameraMode() === 'overview') {
      this.setCameraMode('chase');
    } else {
      this.followInitialized = false; // switching drivers: snap to the new car
    }
  }

  protected formatTime(t: number): string {
    const sign = t < 0 ? '-' : '';
    const total = Math.floor(Math.abs(t));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${sign}${m}:${s.toString().padStart(2, '0')}`;
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (event.code !== 'Space') return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLButtonElement) return;
    event.preventDefault();
    this.togglePlay();
  }

  // ---------- render loop ----------

  private animate = (): void => {
    this.frameId = requestAnimationFrame(this.animate);
    const dt = Math.min(this.frameTimer.getDelta(), 0.1);

    if (this.clock) {
      this.clock.tick(dt);
      this.updateCars(this.clock.time);
      this.updateStartLights(this.clock.time);
      this.updateFollowCamera(dt);

      const now = performance.now();
      if (now - this.lastUiUpdate > 100) {
        this.lastUiUpdate = now;
        const clock = this.clock;
        this.zone.run(() => {
          this.currentTime.set(clock.time);
          this.playing.set(clock.playing);
          const code = this.selectedDriver();
          this.selectedState.set(code ? this.carStates.get(code) ?? null : null);
        });
      }
    }

    if (this.cameraMode() === 'overview') this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  };

  /** Move the camera to follow the selected car. */
private updateFollowCamera(dt: number): void {
  const mode = this.cameraMode();
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

  if (!this.followInitialized) {
    this.camera.position.copy(desired); // first frame: jump straight there
    this.followInitialized = true;
  } else {
    const k = mode === 'chase' ? 5 : 20; // onboard follows tightly; chase trails a bit
    this.camera.position.lerp(desired, 1 - Math.exp(-k * dt)); //frame rate independent smoothing
  }
  this.camera.lookAt(lookAt);
}

  private resize(): void {
    const canvas = this.canvasRef.nativeElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.labelRenderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  // ---------- track ----------

  /** Convert data coordinates (Z-up) to three.js coordinates (Y-up). */
  private toScene([x, y, z]: [number, number, number]): THREE.Vector3 {
    return new THREE.Vector3(x, z, -y);
  }

  private buildTrack(id: string, meta: ReplayMeta): void {
    this.outline = meta.track_outline.map(([x, y]) => [x, y] as [number, number]);

    const points = meta.track_outline.map((p) => this.toScene(p));

    // Road now; the scenery waits for the telemetry, which shows where the pits and grid are
    const layout = new TrackLayout(points);
    this.layout = layout;
    this.addTrackObject(buildRoad(layout));

    // Frame the camera on the track
    this.trackBounds = new THREE.Box3().setFromPoints(points);
    this.fitCameraToTrack();

    // Ground at the layout's ground height, centered under the track
    const center = this.trackBounds.getCenter(new THREE.Vector3());
    this.ground.position.set(center.x, layout.groundY, center.z);

    this.loadReplayData(id, meta);
  }

  /** Position the camera so the whole track fills the view. */
  private fitCameraToTrack(): void {
    if (!this.trackBounds) return;
    const center = this.trackBounds.getCenter(new THREE.Vector3());
    const size = this.trackBounds.getSize(new THREE.Vector3());

    const radius = 0.5 * Math.hypot(size.x, size.z);
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 0.85;

    const elevation = THREE.MathUtils.degToRad(60);
    const azimuth = size.x >= size.z ? 0 : Math.PI / 2;
    const direction = new THREE.Vector3(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(azimuth) * Math.cos(elevation),
    );

    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.controls.target.copy(center);
    this.controls.update();
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

  // ---------- data and cars ----------

  private loadReplayData(id: string, meta: ReplayMeta): void {
    const { start, end } = meta.time_range;

    // Leaderboard data
    this.drivers.set(meta.drivers);

    // Telemetry, in chunks
    const chunk = 300; // matches the backend's max window
    const requests: Observable<ReplayDataWindow>[] = [];
    for (let s = start; s < end; s += chunk) {
      requests.push(this.api.getData(id, s, Math.min(s + chunk, end + 1)));
    }

    // Laps come with the telemetry: together they show where the pit lane and grid are
    this.loading.add(forkJoin({ laps: this.api.getLaps(id), windows: forkJoin(requests) }).subscribe({
      next: ({ laps, windows }) => {
        const lapIndex = indexLaps(laps);
        this.lapIndex.set(lapIndex);
        this.totalLaps.set(Math.max(0, ...laps.map((l) => l.lap)));

        for (const w of windows) {
          for (const [id, series] of Object.entries(w.vehicles)) {
            const existing = this.tracks.get(id);
            if (existing) existing.append(series);
            else this.tracks.set(id, new VehicleTrack(id, series));
          }
        }
        for (const track of this.tracks.values()) track.finalize();
        this.buildScenery(meta, lapIndex);
        this.createCars(meta);
        this.clock = new PlaybackClock(start, end);
        // Races open on the formed grid a few seconds before the lights; other sessions at the start
        this.clock.seek(this.grid ? Math.max(start, this.grid.raceStart - 10) : 0);
        this.clock.playing = true;
        this.timeRange.set({ start, end });
        this.playing.set(true);
      },
      error: (err) => this.fail('Failed to load replay data', err),
    }));
  }

  private addTrackObject(obj: THREE.Object3D): void {
    this.trackObjects.push(obj);
    this.scene.add(obj);
  }

  /** Pit lane, starting grid, and the rest of the scenery around the track. */
  private buildScenery(meta: ReplayMeta, lapIndex: Map<string, DriverLaps>): void {
    const layout = this.layout!;
    const toScene = (p: [number, number, number]) => this.toScene(p);

    const pitLane = findPitLane(layout, this.tracks, lapIndex, toScene);
    if (pitLane) {
      const teamColors = [...new Set(meta.drivers.map((d) => d.color ?? '#888888'))];
      this.addTrackObject(buildPitLane(layout, pitLane, teamColors));
    }

    // Only races and sprints start from a grid
    const standingStart = meta.session.name === 'Race' || meta.session.name === 'Sprint';
    this.grid = standingStart ? findStartingGrid(layout, this.tracks, lapIndex, toScene) : null;
    if (this.grid) {
      const { group, lamps } = buildStartingGrid(layout, this.grid);
      this.addTrackObject(group);
      this.startLamps = lamps;
    }

    this.addTrackObject(buildEnvironment(layout, { pitSide: pitLane?.side, finishGantry: !this.grid }));
  }

  private updateStartLights(t: number): void {
    if (!this.grid) return;
    const lit = lightsOn(this.grid, t);
    if (lit === this.litLamps) return;
    this.litLamps = lit;
    setLamps(this.startLamps, lit);
  }

  private createCars(meta: ReplayMeta): void {
    for (const driver of meta.drivers) {
      if (!this.tracks.has(driver.code)) continue;
      const color = driver.color ?? '#ffffff';

      const car = createCarModel(color);
      car.visible = false;

      const el = document.createElement('div');
      el.className = 'car-label';
      el.textContent = driver.code;
      el.style.borderLeftColor = color;
      const label = new CSS2DObject(el);
      label.position.set(0, 2.5, 0);; // a few meters above the car
      car.add(label);

      this.scene.add(car);
      this.cars.set(driver.code, car);
      this.labels.set(driver.code, label);
    }
  }

  private updateCars(t: number): void {
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
      const onboardSelf = this.cameraMode() === 'onboard' && id === this.selectedDriver();
      car.visible = !onboardSelf;
      label.visible = this.showLabels() && !onboardSelf;

      // Sit on the road surface: telemetry heights are noisy, and flat in the pit lane
      const position = this.toScene([state.x, state.y, state.z]);
      if (this.layout) position.y = this.layout.samples[this.layout.locate(position).index].y;
      car.position.copy(position);
      car.rotation.y = state.heading; // face the direction of travel
      if (this.cameraMode() === 'overview') {
        const distance = this.camera.position.distanceTo(car.position);
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

  // ---------- cleanup ----------

  ngOnDestroy(): void {
    this.loading.unsubscribe();
    cancelAnimationFrame(this.frameId);
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    this.renderer?.dispose();
    this.labelRenderer?.domElement.remove();
  }
}
/** Free the GPU memory held by an object's meshes. */
function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.geometry.dispose();
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of materials) {
      (m as THREE.MeshStandardMaterial).map?.dispose();
      m.dispose();
    }
  });
}
