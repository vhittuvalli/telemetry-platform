import {
  AfterViewInit, Component, ElementRef, NgZone, OnDestroy, ViewChild,
} from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { inject } from '@angular/core';
import { ReplayApiService } from '../replay/replay-api.service';
import { ReplayMeta } from '../replay/replay.models';

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

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(10000, 10000),
      new THREE.MeshStandardMaterial({ color: 0x3a7d44 }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

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

private buildTrack(meta: ReplayMeta): void {
  const points = meta.track_outline.map((p) => this.toScene(p));
  points.push(points[0].clone()); // close the loop

  //draw points and line thru points
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color: 0xffffff });
  this.scene.add(new THREE.Line(geometry, material));

  // Center the view on the track
  const box = new THREE.Box3().setFromPoints(points);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  this.controls.target.copy(center);
  this.camera.position.set(center.x, center.y + size.x * 0.8, center.z + size.z * 0.8);
  this.controls.update();

  // Put the ground just below the lowest point of the track
  const ground = this.scene.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh;
  ground.position.set(center.x, box.min.y - 0.5, center.z);
}

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frameId);
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    this.renderer?.dispose();
  }
}