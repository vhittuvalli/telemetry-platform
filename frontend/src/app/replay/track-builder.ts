import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const VERGE_WIDTH = 14;       // meters of verge/run-off beside the road
const EMBANKMENT_SLOPE = 1.5; // meters outward for every meter of drop to the ground

// ---------------------------------------------------------------------------
// Track layout: positions, directions, corners, and clearance around the track
// ---------------------------------------------------------------------------

export class TrackLayout {
  readonly samples: THREE.Vector3[];
  readonly tangents: THREE.Vector3[] = [];
  readonly sides: THREE.Vector3[] = []; // unit vectors pointing to the driver's right
  readonly turn: number[] = [];         // signed bend per sample: + right-hander, - left-hander
  readonly groundY: number;             // height of the ground plane
  readonly spacing: number;             // meters between samples

  private clearCache = new Map<number, boolean[]>();

  constructor(points: THREE.Vector3[], readonly width = 12, count = 1500) {
    const curve = new THREE.CatmullRomCurve3(points, true);
    this.samples = curve.getSpacedPoints(count);
    this.samples.pop(); // closed curve: last point repeats the first
    const n = this.samples.length;
    this.spacing = curve.getLength() / n;
    this.groundY = Math.min(...this.samples.map((p) => p.y)) - 0.5;

    for (let i = 0; i < n; i++) {
      const prev = this.samples[(i - 1 + n) % n];
      const next = this.samples[(i + 1) % n];
      const t = next.clone().sub(prev).setY(0).normalize();
      this.tangents.push(t);
      this.sides.push(new THREE.Vector3().crossVectors(t, UP).normalize());
    }

    // Compare the direction a few samples behind with a few samples ahead
    const k = 3;
    for (let i = 0; i < n; i++) {
      const a = this.tangents[(i - k + n) % n];
      const b = this.tangents[(i + k) % n];
      const angle = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
      this.turn.push(angle * Math.sign(b.dot(this.sides[i])));
    }
  }

  get length(): number {
    return this.samples.length;
  }

  get half(): number {
    return this.width / 2;
  }

  /** Rotation that points an object's local +X along the track (same convention as the cars). */
  heading(i: number): number {
    const t = this.tangents[i];
    return Math.atan2(-t.z, t.x);
  }

  isCorner(i: number, threshold = 0.12): boolean {
    return Math.abs(this.turn[i]) > threshold;
  }

  /** The outside of the corner at i: +1 right, -1 left. */
  outside(i: number): number {
    return -Math.sign(this.turn[i]) || 1;
  }

  /** A point `offset` meters from the centerline at sample i, on side s (+1 right, -1 left). */
  offsetPoint(i: number, offset: number, s: number): THREE.Vector3 {
    return this.samples[i].clone().addScaledVector(this.sides[i], offset * s);
  }

  /** Distance between two sample indices, going around the loop the short way. */
  private gap(i: number, j: number): number {
    const d = Math.abs(i - j) % this.length;
    return Math.min(d, this.length - d);
  }

  /**
   * True if no other part of the track comes within `radius` of point p.
   * Samples within `skip` of i (the same stretch of track) are ignored.
   */
  isClear(p: THREE.Vector3, i: number, radius: number, skip = 15): boolean {
    const r2 = radius * radius;
    for (let j = 0; j < this.length; j += 2) {
      if (this.gap(i, j) < skip) continue;
      const q = this.samples[j];
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      if (dx * dx + dz * dz < r2) return false;
    }
    return true;
  }

  /** True if the verge band beside sample i on side s stays off every other part of the track. */
  sideClear(i: number, s: number): boolean {
    let cache = this.clearCache.get(s);
    if (!cache) {
      const radius = this.half + 1.2; // keep off other sections' road and kerbs
      cache = this.samples.map((_, k) =>
        [this.half, this.half + VERGE_WIDTH / 2, this.half + VERGE_WIDTH].every((o) =>
          this.isClear(this.offsetPoint(k, o, s), k, radius),
        ),
      );
      this.clearCache.set(s, cache);
    }
    return cache[i];
  }

  /**
   * The main straight: the longest run of nearly straight track that ends at or
   * shortly before the finish line (sample 0). Returns its sample indices in order.
   */
  findMainStraight(threshold = 0.05, window = 200): number[] {
    const n = this.length;
    const straight = (i: number) => Math.abs(this.turn[i]) < threshold;

    const firstBend = this.turn.findIndex((_, i) => !straight(i));
    if (firstBend < 0) return [...Array(n).keys()]; // the whole track is straight

    // Collect runs of straight samples, walking once around the loop
    const runs: number[][] = [];
    let current: number[] = [];
    for (let k = 1; k <= n; k++) {
      const i = (firstBend + k) % n;
      if (straight(i)) {
        current.push(i);
      } else if (current.length) {
        runs.push(current);
        current = [];
      }
    }
    if (current.length) runs.push(current);
    if (!runs.length) return [];

    // Prefer runs that contain or lead up to the finish line
    const nearFinish = runs.filter((r) => r.includes(0) || (n - r[r.length - 1]) % n <= window);
    const pool = nearFinish.length ? nearFinish : runs;
    return pool.reduce((best, r) => (r.length > best.length ? r : best), []);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * A strip alongside the track, from `from` to `to` meters off the centerline.
 * `sideOf(i)` returns +1 (right), -1 (left), or 0 (skip this segment).
 */
function buildStrip(
  layout: TrackLayout,
  from: number,
  to: number,
  sideOf: (i: number) => number,
  colorOf: (i: number) => THREE.Color,
  lift = 0,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const n = layout.length;

  for (let i = 0; i < n; i++) {
    const s = sideOf(i);
    if (s === 0) continue;
    const j = (i + 1) % n;
    const c = colorOf(i);
    const [a, b, c2, d] = [
      layout.offsetPoint(i, from, s),
      layout.offsetPoint(i, to, s),
      layout.offsetPoint(j, from, s),
      layout.offsetPoint(j, to, s),
    ];
    for (const p of [a, b, c2, b, d, c2]) {
      positions.push(p.x, p.y + lift, p.z);
      colors.push(c.r, c.g, c.b);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

const stripMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  side: THREE.DoubleSide,
  roughness: 0.9,
});

/** Small seeded random generator, so scenery lands in the same places every load. */
function seededRandom(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Road
// ---------------------------------------------------------------------------

export function buildRoad(layout: TrackLayout): THREE.Group {
  const road = new THREE.Group();
  const half = layout.half;
  const asphalt = new THREE.Color(0x333333);
  const white = new THREE.Color(0xffffff);

  road.add(new THREE.Mesh(buildStrip(layout, -half, half, () => 1, () => asphalt), stripMaterial));
  for (const s of [1, -1]) {
    road.add(new THREE.Mesh(buildStrip(layout, half - 0.5, half - 0.2, () => s, () => white, 0.02), stripMaterial));
  }
  return road;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export function buildEnvironment(layout: TrackLayout): THREE.Group {
  const env = new THREE.Group();
  env.add(buildVergeAndRunoff(layout));
  env.add(buildEmbankments(layout));
  env.add(buildStartLine(layout));
  env.add(buildGrandstandsAndPits(layout));
  env.add(buildBarriers(layout));
  env.add(buildTrees(layout));
  return env;
}

function buildVergeAndRunoff(layout: TrackLayout): THREE.Group {
  const group = new THREE.Group();
  const half = layout.half;
  const grass = new THREE.Color(0x3b6e40);
  const red = new THREE.Color(0xd62828);
  const white = new THREE.Color(0xf5f5f5);
  const gravel = new THREE.Color(0xc8b48a);

  for (const s of [1, -1]) {
    // Grass verge at track height, wherever it stays clear of other track sections
    group.add(new THREE.Mesh(
      buildStrip(layout, half, half + VERGE_WIDTH, (i) => (layout.sideClear(i, s) ? s : 0), () => grass, 0.005),
      stripMaterial,
    ));

    // Kerbs at corners, alternating red and white
    group.add(new THREE.Mesh(
      buildStrip(
        layout,
        half,
        half + 1.2,
        (i) => (layout.isCorner(i) && layout.sideClear(i, s) ? s : 0),
        (i) => (i % 2 ? white : red),
        0.04,
      ),
      stripMaterial,
    ));
  }

  // Gravel run-off on the outside of corners
  group.add(new THREE.Mesh(
    buildStrip(
      layout,
      half + 1.2,
      half + VERGE_WIDTH,
      (i) => {
        if (!layout.isCorner(i)) return 0;
        const out = layout.outside(i);
        return layout.sideClear(i, out) ? out : 0;
      },
      () => gravel,
      0.01,
    ),
    stripMaterial,
  ));

  return group;
}

/** Slopes from the verge's outer edge down to the ground, so raised track doesn't float. */
function buildEmbankments(layout: TrackLayout): THREE.Mesh {
  const positions: number[] = [];
  const colors: number[] = [];
  const bank = new THREE.Color(0x35663a);
  const n = layout.length;
  const top = layout.half + VERGE_WIDTH;

  const bottomPoint = (k: number, s: number) => {
    const drop = layout.samples[k].y - layout.groundY;
    const p = layout.offsetPoint(k, top + drop * EMBANKMENT_SLOPE, s);
    p.y = layout.groundY;
    return p;
  };

  for (const s of [1, -1]) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (!layout.sideClear(i, s) || !layout.sideClear(j, s)) continue;
      const a = layout.offsetPoint(i, top, s);
      const b = bottomPoint(i, s);
      const c = layout.offsetPoint(j, top, s);
      const d = bottomPoint(j, s);
      for (const p of [a, b, c, b, d, c]) {
        positions.push(p.x, p.y, p.z);
        colors.push(bank.r, bank.g, bank.b);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, stripMaterial);
}

function checkerTexture(cols: number, rows: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = cols * 4;
  canvas.height = rows * 4;
  const ctx = canvas.getContext('2d')!;
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      ctx.fillStyle = (x + y) % 2 ? '#111' : '#fff';
      ctx.fillRect(x * 4, y * 4, 4, 4);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function buildStartLine(layout: TrackLayout): THREE.Group {
  const group = new THREE.Group();
  const w = layout.width;

  // Checkered stripe across the track (local X = along the track, local Z = across it)
  const line = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, w),
    new THREE.MeshStandardMaterial({ map: checkerTexture(2, 16) }),
  );
  line.rotation.x = -Math.PI / 2;
  line.position.y = 0.05;
  group.add(line);

  // Start-light gantry
  const steel = new THREE.MeshStandardMaterial({ color: 0x444444 });
  for (const z of [-(w / 2 + 1.5), w / 2 + 1.5]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 7, 0.4), steel);
    post.position.set(0, 3.5, z);
    group.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, w + 3), steel);
  beam.position.set(0, 7, 0);
  group.add(beam);

  const light = new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xaa0000 });
  for (let k = 0; k < 5; k++) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), light);
    lamp.position.set(-0.35, 6.5, (k - 2) * 1.2);
    group.add(lamp);
  }

  group.position.copy(layout.samples[0]);
  group.rotation.y = layout.heading(0);
  return group;
}

function buildGrandstand(colorIndex: number): THREE.Group {
  const concrete = new THREE.MeshStandardMaterial({ color: 0x9a9a9a });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xdddddd });
  const seatColors = [0x1f4e9c, 0xc0392b, 0xf1c40f, 0x27ae60];
  const stand = new THREE.Group();

  // Six rows, each higher and further back (local +Z = away from the track)
  for (let t = 0; t < 6; t++) {
    const h = 1 + t * 1.2;
    const material = t % 2
      ? concrete
      : new THREE.MeshStandardMaterial({ color: seatColors[(colorIndex + t) % seatColors.length] });
    const row = new THREE.Mesh(new THREE.BoxGeometry(40, h, 3), material);
    row.position.set(0, h / 2, t * 3);
    stand.add(row);
  }

  const roof = new THREE.Mesh(new THREE.BoxGeometry(42, 0.4, 20), roofMat);
  roof.position.set(0, 10, 8);
  stand.add(roof);
  for (const x of [-20, 20]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 10, 0.5), concrete);
    post.position.set(x, 5, 17);
    stand.add(post);
  }
  return stand;
}

function buildGrandstandsAndPits(layout: TrackLayout): THREE.Group {
  const group = new THREE.Group();
  const half = layout.half;
  const straight = layout.findMainStraight();
  if (straight.length < 30) return group; // no usable straight on this track

  // Leave room at each end of the straight
  const usable = straight.slice(10, -10);
  const every = Math.max(1, Math.round(50 / layout.spacing)); // one stand every ~50 m
  const spots = usable.filter((_, k) => k % every === 0).slice(0, 6);

  // A stand fits if its footprint stays clear of every other part of the track
  const standOffset = half + 22;
  const fits = (i: number, s: number) => layout.isClear(layout.offsetPoint(i, standOffset + 9, s), i, 30);
  const fitCount = (s: number) => spots.filter((i) => fits(i, s)).length;
  const standSide = fitCount(1) >= fitCount(-1) ? 1 : -1;

  spots.forEach((i, k) => {
    if (!fits(i, standSide)) return;
    const stand = buildGrandstand(k);
    stand.position.copy(layout.offsetPoint(i, standOffset, standSide));
    // Turn the stand around on the left side so its rows still step away from the track
    stand.rotation.y = layout.heading(i) + (standSide < 0 ? Math.PI : 0);
    group.add(stand);
  });

  // Pit building on the other side, sized to the straight
  const pitSide = -standSide;
  const mid = usable[Math.floor(usable.length / 2)];
  const pitLength = Math.min(180, usable.length * layout.spacing - 10);
  const pitCenter = layout.offsetPoint(mid, half + 30, pitSide);
  if (pitLength > 40 && layout.isClear(pitCenter, mid, 30)) {
    const pits = new THREE.Mesh(
      new THREE.BoxGeometry(pitLength, 8, 14),
      new THREE.MeshStandardMaterial({ color: 0xe8e8e8 }),
    );
    pits.position.copy(pitCenter);
    pits.position.y += 4;
    pits.rotation.y = layout.heading(mid);
    group.add(pits);
  }

  return group;
}

function buildBarriers(layout: TrackLayout): THREE.InstancedMesh {
  const offset = layout.half + VERGE_WIDTH - 1; // at the back of the run-off
  const spots: { i: number; base: THREE.Vector3 }[] = [];

  for (let i = 0; i < layout.length; i += 2) {
    if (!layout.isCorner(i)) continue;
    const base = layout.offsetPoint(i, offset, layout.outside(i));
    if (layout.isClear(base, i, layout.half + 2)) spots.push({ i, base });
  }

  const alongOffsets = [-3.2, -2.4, -1.6, -0.8, 0, 0.8, 1.6, 2.4, 3.2]; // tires side by side
  const stackHeight = 2;
  const tire = new THREE.CylinderGeometry(0.4, 0.4, 0.3, 12);
  const rubber = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.95 });
  const mesh = new THREE.InstancedMesh(tire, rubber, Math.max(1, spots.length * alongOffsets.length * stackHeight));
  mesh.count = spots.length * alongOffsets.length * stackHeight;

  const matrix = new THREE.Matrix4();
  let k = 0;
  for (const { i, base } of spots) {
    for (const a of alongOffsets) {
      const p = base.clone().addScaledVector(layout.tangents[i], a);
      for (let h = 0; h < stackHeight; h++) {
        matrix.makeTranslation(p.x, p.y + 0.15 + h * 0.3, p.z);
        mesh.setMatrixAt(k++, matrix);
      }
    }
  }
  return mesh;
}

function buildTrees(layout: TrackLayout, count = 700): THREE.Group {
  const rand = seededRandom(42);
  const bounds = new THREE.Box3().setFromPoints(layout.samples);
  const margin = 400;

  // Keep trees off the track, verge, and embankments (which widen where the track is higher)
  const nearby = layout.samples
    .filter((_, i) => i % 4 === 0)
    .map((p) => ({
      p,
      r: Math.max(45, layout.half + VERGE_WIDTH + 8 + (p.y - layout.groundY) * EMBANKMENT_SLOPE),
    }));

  const spots: THREE.Vector3[] = [];
  for (let tries = 0; spots.length < count && tries < count * 10; tries++) {
    const x = THREE.MathUtils.lerp(bounds.min.x - margin, bounds.max.x + margin, rand());
    const z = THREE.MathUtils.lerp(bounds.min.z - margin, bounds.max.z + margin, rand());
    const tooClose = nearby.some(({ p, r }) => (p.x - x) ** 2 + (p.z - z) ** 2 < r * r);
    if (!tooClose) spots.push(new THREE.Vector3(x, layout.groundY, z));
  }

  const size = Math.max(1, spots.length);
  const foliage = new THREE.InstancedMesh(
    new THREE.ConeGeometry(3, 9, 8),
    new THREE.MeshStandardMaterial({ color: 0x2e6b30 }),
    size,
  );
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.4, 0.5, 2, 6),
    new THREE.MeshStandardMaterial({ color: 0x5b3a1e }),
    size,
  );
  foliage.count = spots.length;
  trunks.count = spots.length;

  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  spots.forEach((p, k) => {
    const s = 0.7 + rand() * 0.7;
    const scale = new THREE.Vector3(s, s, s);
    matrix.compose(new THREE.Vector3(p.x, p.y + 1 * s, p.z), rotation, scale);
    trunks.setMatrixAt(k, matrix);
    matrix.compose(new THREE.Vector3(p.x, p.y + 6.5 * s, p.z), rotation, scale);
    foliage.setMatrixAt(k, matrix);
  });

  const group = new THREE.Group();
  group.add(trunks, foliage);
  return group;
}