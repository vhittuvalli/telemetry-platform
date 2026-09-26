import {
  AfterViewInit, Component, ElementRef, NgZone, OnDestroy, ViewChild,
} from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { inject } from '@angular/core';
import { ReplayApiService } from '../replay/replay-api.service';
import { ReplayMeta } from '../replay/replay.models';
import { forkJoin } from 'rxjs';
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

  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private frameId = 0;
  private resizeObserver?: ResizeObserver;
  private api = inject(ReplayApiService);
  private replayId = 'monza_2024_r';
  private ground!: THREE.Mesh;
  private clock?: PlaybackClock;
  private tracks = new Map<string, VehicleTrack>();
  private cars = new Map<string, THREE.Mesh>();
  private frameTimer = new THREE.Clock();

  constructor(private zone: NgZone) {}

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 20000);
    this.camera.position.set(0, 500, 800);

    this.scene.background = new THREE.Color(0x87ceeb);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(500, 1000, 300);
    this.scene.add(sun);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(10000, 10000),
      new THREE.MeshStandardMaterial({ color: 0x3a7d44 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.ground);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();

    this.zone.runOutsideAngular(() => this.animate());
    this.api.getMeta(this.replayId).subscribe({
    next: (meta) => this.buildTrack(meta),
    error: (err) => console.error('Failed to load replay metadata', err),
});
  }

  private animate = (): void => {
  this.frameId = requestAnimationFrame(this.animate);
  const dt = Math.min(this.frameTimer.getDelta(), 0.1);
  if (this.clock) {
    this.clock.tick(dt);
    this.updateCars(this.clock.time);
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
  /** Convert data coordinates (Z-up) to three.js coordinates (Y-up). */
private toScene([x, y, z]: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(x, z, -y);
}
private loadReplayData(meta: ReplayMeta): void {
  const { start, end } = meta.time_range;
  const chunk = 300; // matches the backend's max window
  const requests = [];
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
    },
    error: (err) => console.error('Failed to load replay data', err),
  });
}

private createCars(meta: ReplayMeta): void {
  for (const driver of meta.drivers) {
    if (!this.tracks.has(driver.code)) continue;
    const color = driver.color ?? '#ffffff';
    const car = new THREE.Mesh(
      new THREE.BoxGeometry(12, 3, 5), // length, height, width in meters
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
    car.position.y += 0.5; // sit on top of the road
    car.rotation.y = state.heading; // turn to face the direction of travel
  }
}

private buildTrack(meta: ReplayMeta): void {
  const points = meta.track_outline.map((p) => this.toScene(p));
  points.push(points[0].clone()); // close the loop

  //draw points and line thru points
  const linePoints = points.map((p) => p.clone().setY(p.y + 0.2));
  const geometry = new THREE.BufferGeometry().setFromPoints(linePoints);
  const material = new THREE.LineBasicMaterial({ color: 0xffffff });
  this.scene.add(new THREE.Line(geometry, material));
  this.scene.add(this.buildRoad(points.slice(0, -1)));

  // Center the view on the track
  const box = new THREE.Box3().setFromPoints(points);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  this.controls.target.copy(center);
  this.camera.position.set(center.x, center.y + size.x * 0.8, center.z + size.z * 0.8);
  this.controls.update();

  // Put the ground just below the lowest point of the track
  this.ground.position.set(center.x, box.min.y - 0.5, center.z);
  this.loadReplayData(meta);
}
private buildRoad(points: THREE.Vector3[], width = 12): THREE.Mesh {
  // Smooth the outline and resample it to evenly spaced points
  const curve = new THREE.CatmullRomCurve3(points, true); // true = closed loop
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

    // Two triangles connecting this pair to the next pair (wrapping at the end)
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

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frameId);
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    this.renderer?.dispose();
  }
}