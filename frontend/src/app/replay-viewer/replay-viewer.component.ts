import {
  AfterViewInit, Component, ElementRef, HostListener, NgZone, OnDestroy, ViewChild, inject, signal,
} from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Observable, forkJoin } from 'rxjs';
import { ReplayApiService } from '../replay/replay-api.service';
import { ReplayDataWindow, ReplayMeta } from '../replay/replay.models';
import { PlaybackClock } from '../replay/playback-clock';
import { VehicleTrack } from '../replay/vehicle-track';

@Component({
  selector: 'app-replay-viewer',
  standalone: true,
  templateUrl: './replay-viewer.component.html',
  styleUrl: './replay-viewer.component.scss',
})
export class ReplayViewerComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  // three.js
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private ground!: THREE.Mesh;
  private trackBounds?: THREE.Box3;
  private frameId = 0;
  private frameTimer = new THREE.Clock();
  private resizeObserver?: ResizeObserver;

  // replay data
  private api = inject(ReplayApiService);
  private replayId = 'monza_2024_r';
  private clock?: PlaybackClock;
  private tracks = new Map<string, VehicleTrack>();
  private cars = new Map<string, THREE.Mesh>();

  // UI state (read by the template)
  protected currentTime = signal(0);
  protected playing = signal(false);
  protected speed = signal(1);
  protected timeRange = signal<{ start: number; end: number } | null>(null);
  protected readonly speeds = [1, 2, 5, 10, 20];
  private lastUiUpdate = 0;

  constructor(private zone: NgZone) {}

  // ---------- setup ----------

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);

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
    this.controls.screenSpacePanning = false;          // pan along the ground
    this.controls.zoomToCursor = true;                 // zoom toward the mouse
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;  // stay above the ground
    this.controls.listenToKeyEvents(canvas);           // arrow keys pan, only when the 3D view has focus
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
      this.clock.seek(0); // restart if at the end
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
  };

  private resize(): void {
    const canvas = this.canvasRef.nativeElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  // ---------- track ----------

  /** Convert data coordinates (Z-up) to three.js coordinates (Y-up). */
  private toScene([x, y, z]: [number, number, number]): THREE.Vector3 {
    return new THREE.Vector3(x, z, -y);
  }

  private buildTrack(meta: ReplayMeta): void {
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
    // Smooth the outline and resample it to evenly spaced points
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

  // ---------- cars ----------

  private loadReplayData(meta: ReplayMeta): void {
    const { start, end } = meta.time_range;
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
        new THREE.BoxGeometry(12, 3, 5), // length, height, width in meters (enlarged for visibility)
        new THREE.MeshStandardMaterial({ color }),
      );
      car.visible = false;
      this.scene.add(car);
      this.cars.set(driver.code, car);
    }
  }

  private updateCars(t: number): void {
    for (const [id, car] of this.cars) {
      const state = this.tracks.get(id)!.stateAt(t);
      if (!state || !state.onTrack) {
        car.visible = false;
        continue;
      }
      car.visible = true;
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
  }
}