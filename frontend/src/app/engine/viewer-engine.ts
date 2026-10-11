import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/** Convert data coordinates (Z-up) to three.js coordinates (Y-up). */
export function toScene([x, y, z]: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(x, z, -y);
}

/** How a scene wants to be rendered; `clear()` goes back to plain rendering. */
export interface Look {
  exposure?: number;                 // with filmic (ACES) tone mapping
  shadows?: boolean;                 // soft shadow maps
  bloom?: { strength: number; radius: number; threshold: number }; // glow around bright things
}

/**
 * The parts of the 3D view every domain shares: renderer, label layer, camera, orbit
 * controls and lighting. Scene modules add their own objects through `add` so they can
 * be cleared in one go when the session changes.
 */
export class ViewerEngine {
  readonly renderer: THREE.WebGLRenderer;
  readonly labelRenderer = new CSS2DRenderer();
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 20000);
  readonly controls: OrbitControls;
  /** The shared lights, which a scene may dim or move; `clear()` restores them. */
  readonly ambient = new THREE.AmbientLight(0xffffff, 0.6);
  readonly sun = new THREE.DirectionalLight(0xffffff, 1.2);

  private owned: THREE.Object3D[] = [];
  private composer?: EffectComposer;
  private bloom?: UnrealBloomPass;

  constructor(private canvas: HTMLCanvasElement, host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);

    const labelLayer = this.labelRenderer.domElement;
    labelLayer.classList.add('label-layer');
    host.appendChild(labelLayer);

    this.camera.position.set(0, 500, 800);

    this.sun.position.set(500, 1000, 300);
    this.scene.add(this.ambient, this.sun, this.sun.target);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = false;
    this.controls.zoomToCursor = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;
    this.controls.listenToKeyEvents(canvas);
    this.controls.keyPanSpeed = 30;
    canvas.addEventListener('pointerdown', () => canvas.focus());
  }

  /** Add an object that belongs to the current session. */
  add(obj: THREE.Object3D): void {
    this.owned.push(obj);
    this.scene.add(obj);
  }

  /** Remove and free one object added with `add`. */
  remove(obj: THREE.Object3D): void {
    this.scene.remove(obj);
    obj.traverse((child) => {
      if (child instanceof CSS2DObject) child.element.remove();
    });
    disposeObject(obj);
    this.owned = this.owned.filter((o) => o !== obj);
  }

  /** Filmic tone mapping, and optionally shadows and bloom, until the next `clear()`. */
  setLook(look: Look): void {
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = look.exposure ?? 1;
    this.renderer.shadowMap.enabled = !!look.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.composer?.dispose();
    this.composer = this.bloom = undefined;
    if (look.bloom) {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(size, look.bloom.strength, look.bloom.radius, look.bloom.threshold);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass()); // tone mapping and sRGB, after the glow
      this.resize();
    }
  }

  /** Remove and free everything added with `add`, and reset the scene's look. */
  clear(): void {
    for (const obj of this.owned) {
      this.scene.remove(obj);
      obj.traverse((child) => {
        if (child instanceof CSS2DObject) child.element.remove();
      });
      disposeObject(obj);
    }
    this.owned = [];
    this.scene.background = null;
    this.scene.fog = null;
    this.scene.environment?.dispose();
    this.scene.environment = null;
    this.scene.environmentIntensity = 1;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = false;
    this.composer?.dispose();
    this.composer = this.bloom = undefined;
    this.ambient.color.set(0xffffff);
    this.ambient.intensity = 0.6;
    this.sun.color.set(0xffffff);
    this.sun.intensity = 1.2;
    this.sun.position.set(500, 1000, 300);
    this.sun.target.position.set(0, 0, 0);
    this.sun.castShadow = false;
    this.camera.far = 20000;
    this.camera.updateProjectionMatrix();
    this.controls.enabled = true;
    this.controls.minDistance = 0;
    this.controls.maxDistance = Infinity;
  }

  resize(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.labelRenderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(width, height);
  }

  /** Position the orbit camera so a sphere of `radius` around `center` fills the view. */
  frame(center: THREE.Vector3, radius: number, elevationDeg = 60, azimuth = 0): void {
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 0.85;

    const elevation = THREE.MathUtils.degToRad(elevationDeg);
    const direction = new THREE.Vector3(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(azimuth) * Math.cos(elevation),
    );

    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.controls.target.copy(center);
    this.controls.update();
  }

  render(): void {
    if (this.controls.enabled) this.controls.update();
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.clear();
    this.composer?.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.labelRenderer.domElement.remove();
  }
}

/** Free the GPU memory held by an object's meshes. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.Points)) return;
    obj.geometry.dispose();
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of materials) {
      (m as THREE.MeshStandardMaterial).map?.dispose();
      m.dispose();
    }
  });
}
