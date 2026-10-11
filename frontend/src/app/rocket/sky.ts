import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

/** Where the sun is: high in the south-west, so shadows fall away from the default cameras. */
export const SUN_ELEVATION = 40; // degrees: far enough from overhead that looking up isn't into its glare
export const SUN_AZIMUTH = 215;  // compass degrees

/** Unit vector toward the sun, in scene axes (x east, y up, -z north). */
export function sunDirection(): THREE.Vector3 {
  const e = THREE.MathUtils.degToRad(SUN_ELEVATION);
  const a = THREE.MathUtils.degToRad(SUN_AZIMUTH);
  return new THREE.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a));
}

/** The horizon's haze, for fog that blends the ground into the sky. */
export const HAZE = 0xc9dbea;

/**
 * Atmospheric sky (Rayleigh and Mie scattering) and the light it casts: an environment map
 * baked from the same sky, so the rocket's paint reflects it, and fog matching its horizon.
 */
export function buildSky(renderer: THREE.WebGLRenderer, scene: THREE.Scene): Sky {
  const sky = new Sky();
  sky.scale.setScalar(45000);
  const u = sky.material.uniforms;
  // A clear day: deep blue overhead, a little haze low down
  u['turbidity'].value = 2.5;
  u['rayleigh'].value = 1.6;
  u['mieCoefficient'].value = 0.0025;
  u['mieDirectionalG'].value = 0.75;
  u['sunPosition'].value.copy(sunDirection());
  // The shader's own cloud deck is a flat layer at infinity: keep it to a few high wisps, since
  // the cumulus below (which a rocket climbs past) carry the parallax, and the telescope camera
  // zoomed into a 40% deck sees nothing but white
  u['cloudCoverage'].value = 0.12;
  u['cloudDensity'].value = 0.25;

  // Bake the sky into an environment map for image-based lighting
  const pmrem = new THREE.PMREMGenerator(renderer);
  const bake = new THREE.Scene();
  const copy = new Sky();
  copy.scale.setScalar(1000);
  copy.material.uniforms = THREE.UniformsUtils.clone(sky.material.uniforms);
  bake.add(copy);
  scene.environment?.dispose();
  scene.environment = pmrem.fromScene(bake, 0, 0.1, 2000).texture;
  copy.geometry.dispose();
  copy.material.dispose();
  pmrem.dispose();
  return sky;
}

/** A small deterministic random generator, so the clouds are the same every time. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A soft, lumpy cloud puff: bright on top where the sun hits, greyer underneath. */
function cloudTexture(seed: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = seeded(seed);
  // Many overlapping soft blobs, denser toward the middle and flatter at the base
  for (let i = 0; i < 46; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * size * 0.28;
    const x = size / 2 + Math.cos(a) * r * 1.25;
    const y = size * 0.56 + Math.sin(a) * r * 0.62;
    const radius = size * (0.09 + rand() * 0.13);
    const shade = Math.round(255 - Math.max(0, (y - size * 0.45) / (size * 0.4)) * 38); // a little greyer low down
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, `rgba(${shade},${shade},${Math.min(255, shade + 6)},0.55)`);
    g.addColorStop(0.6, `rgba(${shade},${shade},${Math.min(255, shade + 6)},0.25)`);
    g.addColorStop(1, `rgba(${shade},${shade},${shade},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Fair-weather cumulus scattered over the sky, drifting with the wind. They sit at the height of
 * a typical cloud base and above, so a climbing rocket has something to climb past, and their
 * drift is a function of flight time, so they're in the right place wherever you seek.
 */
export class Clouds {
  readonly group = new THREE.Group();
  private drift: THREE.Vector3;

  constructor(windAloft: THREE.Vector3, opts: { count?: number; base?: number; radius?: number } = {}) {
    const count = opts.count ?? 160;
    const base = opts.base ?? 700;
    const radius = opts.radius ?? 14000;
    this.drift = windAloft;
    const rand = seeded(23);
    const textures = [cloudTexture(1), cloudTexture(2), cloudTexture(3), cloudTexture(4)];
    const materials = textures.map((map) => new THREE.SpriteMaterial({
      // Already shaded in the texture; tone mapping would grey their whites
      map, transparent: true, depthWrite: false, fog: true, color: 0xffffff, toneMapped: false,
    }));
    for (let i = 0; i < count; i++) {
      // Clusters of puffs make one cloud; fewer right overhead, so the sky above the pad is open
      const r = 600 + Math.sqrt(rand()) * radius;
      const a = rand() * Math.PI * 2;
      const height = base + rand() * 900;
      const width = 260 + rand() * 520;
      const cloud = new THREE.Group();
      cloud.position.set(Math.cos(a) * r, height, Math.sin(a) * r);
      const puffs = 3 + Math.floor(rand() * 4);
      for (let k = 0; k < puffs; k++) {
        const puff = new THREE.Sprite(materials[Math.floor(rand() * materials.length)]);
        const w = width * (0.55 + rand() * 0.5);
        puff.scale.set(w, w * 0.62, 1);
        puff.position.set((rand() - 0.5) * width * 0.9, (rand() - 0.3) * width * 0.18, (rand() - 0.5) * width * 0.5);
        cloud.add(puff);
      }
      this.group.add(cloud);
    }
  }

  /** Move the clouds to where the wind has carried them by flight time `t`. */
  update(t: number): void {
    this.group.position.copy(this.drift).multiplyScalar(t);
  }
}
