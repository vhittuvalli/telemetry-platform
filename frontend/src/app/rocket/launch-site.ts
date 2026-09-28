import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

const PAD_HEIGHT = 0.3; // m, the pad's top surface above the ground

/** A round step for altitude marks: 1, 2 or 5 × 10ⁿ, giving about `count` marks up to `max`. */
export function niceStep(max: number, count = 6): number {
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
}

/** Height the flight's origin (the rocket's CG on the pad) sits above the ground. */
export function padLift(tailBelowCg: number): number {
  return PAD_HEIGHT + tailBelowCg;
}

/** Ground, pad, launch rail and blast deflector. */
export function buildLaunchSite(railDirection: THREE.Vector3, railLength: number, rocketDiameter: number): THREE.Group {
  const site = new THREE.Group();

  site.add(buildSky());
  site.add(new THREE.HemisphereLight(0xcfe6ff, 0x4f6b35, 0.6));

  // Grass with some variation in it, so the camera's motion over the ground reads
  const grass = grassTexture();
  grass.wrapS = grass.wrapT = THREE.RepeatWrapping;
  grass.repeat.set(4000, 4000); // 20 m tiles
  grass.anisotropy = 8;
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(40000, 64),
    new THREE.MeshStandardMaterial({ color: 0xffffff, map: grass, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  site.add(ground);
  site.add(buildTrees());

  // Mown field around the pad, so the ground has some sense of scale
  const field = new THREE.Mesh(
    new THREE.CircleGeometry(60, 48),
    new THREE.MeshStandardMaterial({ color: 0x78964f, roughness: 1 }),
  );
  field.rotation.x = -Math.PI / 2;
  field.position.y = 0.02;
  site.add(field);

  const concrete = new THREE.MeshStandardMaterial({ color: 0xb8b4aa, roughness: 0.9 });
  const pad = new THREE.Mesh(new THREE.BoxGeometry(3, PAD_HEIGHT, 3), concrete);
  pad.position.y = PAD_HEIGHT / 2;
  site.add(pad);

  const steel = new THREE.MeshStandardMaterial({ color: 0x8a8d91, metalness: 0.7, roughness: 0.35 });
  const deflector = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.5), steel);
  deflector.position.y = PAD_HEIGHT + 0.01;
  site.add(deflector);

  // Rail: a slim rod along the launch direction, beside the rocket
  const offset = rocketDiameter / 2 + 0.01;
  const side = new THREE.Vector3(1, 0, 0).projectOnPlane(railDirection).normalize().multiplyScalar(offset);
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.02, railLength, 0.02), steel);
  rail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), railDirection);
  rail.position.copy(railDirection.clone().multiplyScalar(railLength / 2)).add(side);
  rail.position.y += PAD_HEIGHT;
  site.add(rail);

  return site;
}

/** A pole beside the pad marked every `step` meters up to `top`, with labels. */
export function buildAltitudeRuler(top: number, at: THREE.Vector3): { group: THREE.Group; labels: CSS2DObject[] } {
  const group = new THREE.Group();
  const labels: CSS2DObject[] = [];
  const step = niceStep(top);
  const height = Math.ceil(top / step) * step;

  const material = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });
  const points = [at.clone(), at.clone().setY(height)];
  const tick = Math.max(height / 80, 0.5);
  for (let h = step; h <= height + 1e-6; h += step) {
    points.push(at.clone().setY(h), at.clone().setY(h).add(new THREE.Vector3(tick, 0, 0)));
    const el = document.createElement('div');
    el.className = 'altitude-label';
    el.textContent = `${Math.round(h).toLocaleString()} m`;
    const label = new CSS2DObject(el);
    label.position.copy(at).setY(h).add(new THREE.Vector3(tick * 1.5, 0, 0));
    label.center.set(0, 0.5);
    group.add(label);
    labels.push(label);
  }
  // Pairs of points: the pole, then each tick
  const segments = [points[0], points[1], ...points.slice(2)];
  group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segments), material));
  return { group, labels };
}

/** Sky dome: pale near the horizon, deeper blue overhead. */
function buildSky(): THREE.Mesh {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(45000, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { horizon: { value: new THREE.Color(0xd6e9f7) }, zenith: { value: new THREE.Color(0x3d7cc9) } },
      vertexShader: `
        varying float vHeight;
        void main() {
          vHeight = normalize(position).y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 horizon;
        uniform vec3 zenith;
        varying float vHeight;
        void main() {
          gl_FragColor = vec4(mix(horizon, zenith, pow(clamp(vHeight, 0.0, 1.0), 0.6)), 1.0);
        }`,
    }),
  );
  sky.renderOrder = -1;
  return sky;
}

/** A tile of grass: mottled greens with a few darker tufts. */
function grassTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#627f41';
  ctx.fillRect(0, 0, size, size);
  const rand = seeded(7);
  for (let i = 0; i < 2600; i++) {
    const shade = 80 + rand() * 60;
    ctx.fillStyle = `rgba(${shade * 0.75 | 0}, ${shade + 30 | 0}, ${shade * 0.45 | 0}, ${0.25 + rand() * 0.35})`;
    const r = 1 + rand() * 4;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return new THREE.CanvasTexture(canvas);
}

/** Scattered trees from 80 m to 3 km out: scale and a sense of speed near the ground. */
function buildTrees(): THREE.Group {
  const group = new THREE.Group();
  const count = 900;
  const crowns = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1, 1, 7),
    new THREE.MeshStandardMaterial({ color: 0x2f5a2c, roughness: 1, flatShading: true }),
    count,
  );
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.12, 0.16, 1, 5),
    new THREE.MeshStandardMaterial({ color: 0x5b4330, roughness: 1 }),
    count,
  );
  const rand = seeded(11);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    // More trees close in, thinning out with distance
    const distance = 80 + 2900 * rand() ** 1.8;
    const angle = rand() * Math.PI * 2;
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    const height = 6 + rand() * 9;
    const width = height * (0.3 + rand() * 0.15);
    m.compose(new THREE.Vector3(x, height * 0.2 + height * 0.4, z), new THREE.Quaternion(),
              new THREE.Vector3(width, height * 0.8, width));
    crowns.setMatrixAt(i, m);
    m.compose(new THREE.Vector3(x, height * 0.1, z), new THREE.Quaternion(), new THREE.Vector3(1, height * 0.2, 1));
    trunks.setMatrixAt(i, m);
  }
  group.add(crowns, trunks);
  return group;
}

/** A small deterministic random generator, so the scenery is the same every time. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
