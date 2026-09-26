import {
  AfterViewInit, Component, ElementRef, HostListener, NgZone, OnDestroy, ViewChild,
  computed, inject, signal,
} from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Observable, forkJoin } from 'rxjs';
import { ReplayApiService } from '../replay/replay-api.service';
import { Driver, ReplayDataWindow, ReplayMeta } from '../replay/replay.models';
import { PlaybackClock } from '../replay/playback-clock';
import { VehicleTrack } from '../replay/vehicle-track';
import { DriverLaps, computeStandings, indexLaps } from '../replay/standings';
import { LeaderboardComponent } from '../leaderboard/leaderboard.component';

@Component({
  selector: 'app-replay-viewer',
  standalone: true,
  imports: [LeaderboardComponent],
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

  // replay data
  private api = inject(ReplayApiService);
  private replayId = 'monza_2024_r';
  private clock?: PlaybackClock;
  private tracks = new Map<string, VehicleTrack>();
  private cars = new Map<string, THREE.Mesh>();
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
  protected readonly speeds = [1, 2, 5, 10, 20];
  private lastUiUpdate = 0;

  // leaderboard
  private drivers = signal<Driver[]>([]);
  private lapIndex = signal<Map<string, DriverLaps> | null>(null);
  private totalLaps = signal(0);

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

  constructor(private zone: NgZone) {}

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

    this.api.getMeta(this.replayId).subscribe({
      next: (meta) => this.buildTrack(meta),
      error: (err) => console.error('Failed to load replay metadata', err),
    });
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

  protected toggleLabels(): void {
    this.showLabels.update((v) => !v);
  }

  protected selectDriver(code: string): void {
    const next = this.selectedDriver() === code ? null : code;
    this.selectedDriver.set(next);
    for (const [id, label] of this.labels) {
      label.element.classList.toggle('selected', id === next);
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

      const now = performance.now();
      if (now - this.lastUiUpdate > 100) {
        this.lastUiUpdate = now;
        const clock = this.clock;
        this.zone.run(() => {
          this.currentTime.set(clock.time);
          this.playing.set(clock.playing);
        });
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  };

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

  private buildTrack(meta: ReplayMeta): void {
    this.outline = meta.track_outline.map(([x, y]) => [x, y] as [number, number]);

    const points = meta.track_outline.map((p) => this.toScene(p));
    points.push(points[0].clone()); // close the loop

    // Center line, drawn just above the road
    const linePoints = points.map((p) => p.clone().setY(p.y + 0.2));
    const geometry = new THREE.BufferGeometry().setFromPoints(linePoints);
    const material = new THREE.LineBasicMaterial({ color: 0xffffff });
    this.scene.add(new THREE.Line(geometry, material));
    this.scene.add(this.buildRoad(points.slice(0, -1)));

    // Frame the camera on the track
    const box = new THREE.Box3().setFromPoints(points);
    this.trackBounds = box;
    this.fitCameraToTrack();

    // Put the ground just below the lowest point of the track
    const center = box.getCenter(new THREE.Vector3());
    this.ground.position.set(center.x, box.min.y - 0.5, center.z);

    this.loadReplayData(meta);
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

  private buildRoad(points: THREE.Vector3[], width = 12): THREE.Mesh {
    const curve = new THREE.CatmullRomCurve3(points, true);
    const samples = curve.getSpacedPoints(1500);
    samples.pop(); // last point duplicates the first on a closed curve

    const up = new THREE.Vector3(0, 1, 0);
    const positions: number[] = [];
    const indices: number[] = [];
    const n = samples.length;

    for (let i = 0; i < n; i++) {
      const prev = samples[(i - 1 + n) % n];
      const next = samples[(i + 1) % n];
      const tangent = next.clone().sub(prev).normalize();
      const side = new THREE.Vector3().crossVectors(tangent, up).normalize().multiplyScalar(width / 2);

      const left = samples[i].clone().add(side);
      const right = samples[i].clone().sub(side);
      positions.push(left.x, left.y, left.z, right.x, right.y, right.z);

      const a = 2 * i;
      const b = 2 * i + 1;
      const c = 2 * ((i + 1) % n);
      const d = 2 * ((i + 1) % n) + 1;
      indices.push(a, b, c, b, d, c);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({ color: 0x333333, side: THREE.DoubleSide });
    return new THREE.Mesh(geometry, material);
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

  private loadReplayData(meta: ReplayMeta): void {
    const { start, end } = meta.time_range;

    // Leaderboard data
    this.drivers.set(meta.drivers);
    this.api.getLaps(this.replayId).subscribe({
      next: (laps) => {
        this.lapIndex.set(indexLaps(laps));
        this.totalLaps.set(Math.max(...laps.map((l) => l.lap)));
      },
      error: (err) => console.error('Failed to load laps', err),
    });

    // Telemetry, in chunks
    const chunk = 300; // matches the backend's max window
    const requests: Observable<ReplayDataWindow>[] = [];
    for (let s = start; s < end; s += chunk) {
      requests.push(this.api.getData(this.replayId, s, Math.min(s + chunk, end + 1)));
    }

    forkJoin(requests).subscribe({
      next: (windows) => {
        for (const w of windows) {
          for (const [id, series] of Object.entries(w.vehicles)) {
            const existing = this.tracks.get(id);
            if (existing) existing.append(series);
            else this.tracks.set(id, new VehicleTrack(id, series));
          }
        }
        this.createCars(meta);
        this.clock = new PlaybackClock(start, end);
        this.clock.seek(0);
        this.clock.playing = true;
        this.timeRange.set({ start, end });
        this.playing.set(true);
      },
      error: (err) => console.error('Failed to load replay data', err),
    });
  }

  private createCars(meta: ReplayMeta): void {
    for (const driver of meta.drivers) {
      if (!this.tracks.has(driver.code)) continue;
      const color = driver.color ?? '#ffffff';

      const car = new THREE.Mesh(
        new THREE.BoxGeometry(12, 3, 5), // enlarged for visibility
        new THREE.MeshStandardMaterial({ color }),
      );
      car.visible = false;

      const el = document.createElement('div');
      el.className = 'car-label';
      el.textContent = driver.code;
      el.style.borderLeftColor = color;
      const label = new CSS2DObject(el);
      label.position.set(0, 8, 0); // a few meters above the car
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
        continue;
      }
      this.carProgress.set(id, this.lapFraction(state.x, state.y));
      car.visible = true;
      label.visible = this.showLabels();
      car.position.copy(this.toScene([state.x, state.y, state.z]));
      car.position.y += 1.5; // half the box height, so it sits on the road
      car.rotation.y = state.heading; // face the direction of travel
    }
  }

  // ---------- cleanup ----------

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frameId);
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    this.renderer?.dispose();
    this.labelRenderer?.domElement.remove();
  }
}