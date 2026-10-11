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

/** Ground, pad, launch rail, blast deflector and a windsock showing the wind (scene-axes m/s at 10 m). */
export function buildLaunchSite(railDirection: THREE.Vector3, railLength: number, rocketDiameter: number,
                                wind: THREE.Vector3): THREE.Group {
  const site = new THREE.Group();
  site.add(new THREE.HemisphereLight(0xcfe6ff, 0x4f6b35, 0.35));

  // Farmland to the horizon: a patchwork of fields, so height and speed read from far up
  const farms = farmlandTexture();
  farms.wrapS = farms.wrapT = THREE.RepeatWrapping;
  farms.repeat.set(20, 20); // 4 km tiles
  farms.anisotropy = 8;
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(40000, 96),
    new THREE.MeshStandardMaterial({ color: 0xffffff, map: farms, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  site.add(ground);

  // The launch field: grass with some variation in it, so the camera's motion over it reads up close
  const grass = grassTexture();
  grass.wrapS = grass.wrapT = THREE.RepeatWrapping;
  grass.repeat.set(60, 60); // 20 m tiles
  grass.anisotropy = 8;
  const field = new THREE.Mesh(
    new THREE.CircleGeometry(600, 64),
    new THREE.MeshStandardMaterial({ color: 0xffffff, map: grass, roughness: 1, alphaMap: fieldEdge(), transparent: true }),
  );
  field.rotation.x = -Math.PI / 2;
  field.position.y = 0.03;
  field.receiveShadow = true;
  site.add(field);

  // Mown circle around the pad
  const mown = new THREE.Mesh(
    new THREE.CircleGeometry(25, 48),
    new THREE.MeshStandardMaterial({ color: 0x8aa560, roughness: 1, transparent: true, opacity: 0.55 }),
  );
  mown.rotation.x = -Math.PI / 2;
  mown.position.y = 0.05;
  mown.receiveShadow = true;
  site.add(mown);

  site.add(buildHills());
  site.add(buildTrees());

  const concrete = new THREE.MeshStandardMaterial({ color: 0xb8b4aa, roughness: 0.9 });
  const pad = new THREE.Mesh(new THREE.BoxGeometry(3, PAD_HEIGHT, 3), concrete);
  pad.position.y = PAD_HEIGHT / 2;
  pad.castShadow = pad.receiveShadow = true;
  site.add(pad);

  const steel = new THREE.MeshStandardMaterial({ color: 0x8a8d91, metalness: 0.8, roughness: 0.3 });
  const scorched = new THREE.MeshStandardMaterial({ color: 0x2b2826, metalness: 0.6, roughness: 0.6 });
  const deflector = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.02, 0.6), scorched);
  deflector.position.y = PAD_HEIGHT + 0.01;
  deflector.receiveShadow = true;
  site.add(deflector);

  // Rail: a slim rod along the launch direction, beside the rocket, on a small stand
  const offset = rocketDiameter / 2 + 0.01;
  const side = new THREE.Vector3(1, 0, 0).projectOnPlane(railDirection).normalize().multiplyScalar(offset);
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.02, railLength, 0.02), steel);
  rail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), railDirection);
  rail.position.copy(railDirection.clone().multiplyScalar(railLength / 2)).add(side);
  rail.position.y += PAD_HEIGHT;
  rail.castShadow = true;
  site.add(rail);
  for (let k = 0; k < 3; k++) {
    const a = (2 * Math.PI * k) / 3 + 0.4;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.75, 6), steel);
    leg.position.set(side.x + Math.cos(a) * 0.3, PAD_HEIGHT + 0.3, side.z + Math.sin(a) * 0.3);
    leg.lookAt(side.x, PAD_HEIGHT + 0.6, side.z);
    leg.rotateX(Math.PI / 2);
    leg.castShadow = true;
    site.add(leg);
  }

  // Launch controller cable running off to a table at a safe distance
  const table = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.04, 0.6), new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.6 }));
  table.position.set(-12, 0.75, 9);
  table.castShadow = true;
  site.add(table);
  for (const [dx, dz] of [[-0.55, -0.25], [0.55, -0.25], [-0.55, 0.25], [0.55, 0.25]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.75, 6), steel);
    leg.position.set(-12 + dx, 0.375, 9 + dz);
    site.add(leg);
  }
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.1, 0.18), new THREE.MeshStandardMaterial({ color: 0xc8352a, roughness: 0.5 }));
  box.position.set(-12, 0.82, 9);
  site.add(box);
  const cable = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(side.x, PAD_HEIGHT + 0.05, side.z), new THREE.Vector3(-1.4, 0.06, 1.2),
      new THREE.Vector3(-7, 0.06, 6), new THREE.Vector3(-11.9, 0.06, 8.8), new THREE.Vector3(-12, 0.8, 9),
    ]),
    new THREE.LineBasicMaterial({ color: 0x222222 }),
  );
  site.add(cable);

  site.add(buildWindsock(wind, new THREE.Vector3(8, 0, -6)));
  return site;
}

/** A pole with a sock streaming downwind: it fills out and lifts as the wind picks up. */
function buildWindsock(wind: THREE.Vector3, at: THREE.Vector3): THREE.Group {
  const group = new THREE.Group();
  group.position.copy(at);
  const height = 5;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, height, 8),
    new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.7, roughness: 0.35 }));
  pole.position.y = height / 2;
  pole.castShadow = true;
  group.add(pole);

  // Striped sock, a tapered tube along +X before it's turned downwind
  const stripes = document.createElement('canvas');
  stripes.width = 64;
  stripes.height = 8;
  const ctx = stripes.getContext('2d')!;
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i % 2 ? '#f4f4f4' : '#f26a1b';
    ctx.fillRect((i * 64) / 5, 0, 64 / 5 + 1, 8);
  }
  const texture = new THREE.CanvasTexture(stripes);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sockGeo = new THREE.CylinderGeometry(0.18, 0.1, 1.2, 16, 1, true);
  sockGeo.rotateZ(-Math.PI / 2);
  sockGeo.translate(0.6, 0, 0);
  // Map the stripes along the sock's length
  const uv = sockGeo.attributes['uv'] as THREE.BufferAttribute;
  const pos = sockGeo.attributes['position'] as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / 1.2, uv.getX(i));
  const sock = new THREE.Mesh(sockGeo, new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide, roughness: 0.8 }));
  sock.castShadow = true;

  const speed = Math.hypot(wind.x, wind.z);
  const pivot = new THREE.Group();
  pivot.position.y = height - 0.1;
  pivot.rotation.y = speed > 0.01 ? Math.atan2(-wind.z, wind.x) : 0;
  // Hangs limp in still air, straight out from about 7 m/s (15 knots)
  pivot.rotation.z = -THREE.MathUtils.degToRad(80) * (1 - Math.min(speed / 7, 1));
  pivot.add(sock);
  group.add(pivot);
  return group;
}

/** Rolling hills on the horizon, far enough out that the haze softens them. */
function buildHills(): THREE.Mesh {
  const inner = 9000;
  const outer = 30000;
  const segments = 180;
  const geometry = new THREE.RingGeometry(inner, outer, segments, 6);
  const pos = geometry.attributes['position'] as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    const a = Math.atan2(y, x);
    const rise = Math.min((r - inner) / 4000, 1);
    const h = (180 + 160 * Math.sin(a * 5 + 1) + 90 * Math.sin(a * 13 + 2.3) + 45 * Math.sin(a * 31)) * rise;
    pos.setZ(i, Math.max(h, 0));
  }
  geometry.computeVertexNormals();
  const hills = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x4f6a3e, roughness: 1, flatShading: false }));
  hills.rotation.x = -Math.PI / 2;
  return hills;
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
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Fields of crops, pasture and ploughed earth, with hedgerows and a few roads: one 4 km tile. */
function farmlandTexture(): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = seeded(5);
  const colors = ['#6f8a45', '#7d9650', '#5f7a3c', '#9aa45a', '#b4a868', '#8c7a55', '#6b8f4a', '#a39b5b', '#57703a'];
  ctx.fillStyle = '#5c7339';
  ctx.fillRect(0, 0, size, size);
  // Split the tile into fields, recursively, like land divided over generations
  const split = (x: number, y: number, w: number, h: number, depth: number): void => {
    if (depth > 4 || (depth > 2 && rand() < 0.3) || w < 60 || h < 60) {
      ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
      ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
      // Crop rows or plough lines across some fields
      if (rand() < 0.6) {
        ctx.strokeStyle = 'rgba(0,0,0,0.07)';
        ctx.lineWidth = 1;
        const vertical = rand() < 0.5;
        for (let k = 4; k < (vertical ? w : h) - 4; k += 4) {
          ctx.beginPath();
          if (vertical) { ctx.moveTo(x + k, y + 2); ctx.lineTo(x + k, y + h - 2); }
          else { ctx.moveTo(x + 2, y + k); ctx.lineTo(x + w - 2, y + k); }
          ctx.stroke();
        }
      }
      return;
    }
    if (w > h) {
      const cut = w * (0.3 + rand() * 0.4);
      split(x, y, cut, h, depth + 1);
      split(x + cut, y, w - cut, h, depth + 1);
    } else {
      const cut = h * (0.3 + rand() * 0.4);
      split(x, y, w, cut, depth + 1);
      split(x, y + cut, w, h - cut, depth + 1);
    }
  };
  split(0, 0, size, size, 0);
  // Hedgerows show as the darker gaps between fields; add a couple of country roads
  ctx.strokeStyle = '#8f8a7c';
  ctx.lineWidth = 3;
  for (const y of [size * 0.37, size * 0.81]) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(size * 0.3, y + 40, size * 0.6, y - 50, size, y);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Fades the launch field's edge into the farmland around it. */
function fieldEdge(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.3, size / 2, size / 2, size / 2);
  g.addColorStop(0, '#fff');
  g.addColorStop(1, '#000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/** Scattered trees from 80 m to 3 km out, conifers and broadleaves in varied greens: scale and a sense of speed near the ground. */
function buildTrees(): THREE.Group {
  const group = new THREE.Group();
  const conifers = 700;
  const broadleaves = 700;
  const foliage = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  const coneGeo = new THREE.ConeGeometry(1, 1, 10);
  // A lumpy ball reads as a leafy crown rather than a gem
  const blobGeo = new THREE.IcosahedronGeometry(1, 3);
  const bumps = blobGeo.attributes['position'] as THREE.BufferAttribute;
  for (let i = 0; i < bumps.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(bumps, i);
    const k = 1 + 0.12 * Math.sin(v.x * 7.1 + v.y * 3.3) * Math.sin(v.z * 6.7 - v.y * 4.9) + 0.06 * Math.sin(v.y * 13.0 + v.x * 11.0);
    bumps.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  blobGeo.computeVertexNormals();
  const pines = new THREE.InstancedMesh(coneGeo, foliage, conifers * 2);
  const crowns = new THREE.InstancedMesh(blobGeo, foliage, broadleaves);
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.12, 0.18, 1, 5),
    new THREE.MeshStandardMaterial({ color: 0x5b4330, roughness: 1 }),
    conifers + broadleaves,
  );
  for (const mesh of [pines, crowns, trunks]) mesh.castShadow = mesh.receiveShadow = true;

  const rand = seeded(11);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const color = new THREE.Color();
  const spot = () => {
    // More trees close in, thinning out with distance; in loose clumps, like woodland edges
    const distance = 80 + 2900 * rand() ** 1.8;
    const angle = rand() * Math.PI * 2;
    return [Math.cos(angle) * distance, Math.sin(angle) * distance];
  };
  let trunk = 0;
  for (let i = 0; i < conifers; i++) {
    const [x, z] = spot();
    const height = 8 + rand() * 10;
    const width = height * (0.22 + rand() * 0.1);
    color.setHSL(0.3 + rand() * 0.05, 0.35 + rand() * 0.2, 0.17 + rand() * 0.08);
    // Two stacked cones read as a fir rather than a party hat
    m.compose(new THREE.Vector3(x, height * 0.45, z), q, new THREE.Vector3(width, height * 0.6, width));
    pines.setMatrixAt(i * 2, m);
    pines.setColorAt(i * 2, color);
    m.compose(new THREE.Vector3(x, height * 0.75, z), q, new THREE.Vector3(width * 0.7, height * 0.45, width * 0.7));
    pines.setMatrixAt(i * 2 + 1, m);
    pines.setColorAt(i * 2 + 1, color);
    m.compose(new THREE.Vector3(x, height * 0.1, z), q, new THREE.Vector3(1, height * 0.2, 1));
    trunks.setMatrixAt(trunk++, m);
  }
  for (let i = 0; i < broadleaves; i++) {
    const [x, z] = spot();
    const height = 7 + rand() * 8;
    const width = height * (0.35 + rand() * 0.15);
    color.setHSL(0.22 + rand() * 0.08, 0.4 + rand() * 0.2, 0.22 + rand() * 0.1);
    q.setFromEuler(new THREE.Euler(0, rand() * Math.PI, 0));
    m.compose(new THREE.Vector3(x, height * 0.62, z), q, new THREE.Vector3(width, height * 0.42, width * (0.85 + rand() * 0.3)));
    crowns.setMatrixAt(i, m);
    crowns.setColorAt(i, color);
    q.identity();
    m.compose(new THREE.Vector3(x, height * 0.22, z), q, new THREE.Vector3(1.3, height * 0.44, 1.3));
    trunks.setMatrixAt(trunk++, m);
  }
  group.add(pines, crowns, trunks);
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
