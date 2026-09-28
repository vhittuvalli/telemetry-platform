import * as THREE from 'three';
import { TrackLayout, stripMaterial } from './track-builder';
import { VehicleTrack } from './vehicle-track';
import { DriverLaps } from './standings';

const LANE_WIDTH = 10;       // meters of pit-lane asphalt
const WINDOW_PAD = 6;        // seconds of data kept either side of a pit stop, to catch entry and exit
const MIN_LANE_LENGTH = 100; // meters; anything shorter is noise, not a pit lane

/** The pit lane, described relative to the track it runs beside. */
export interface PitLane {
  side: number;      // +1 right of the track, -1 left
  indices: number[]; // track samples alongside the lane, in driving order
  offsets: number[]; // distance of the lane's centerline from the track's, per index
}

export type ToScene = (p: [number, number, number]) => THREE.Vector3;

/**
 * Work out where the pit lane is from where cars actually drove during their pit stops.
 * Returns null if there aren't enough pit stops to tell.
 */
export function findPitLane(
  layout: TrackLayout,
  tracks: Map<string, VehicleTrack>,
  lapIndex: Map<string, DriverLaps>,
  toScene: ToScene,
): PitLane | null {
  const n = layout.length;
  const bins: number[][] = Array.from({ length: n }, () => []);
  let stops = 0;

  for (const [code, info] of lapIndex) {
    const d = tracks.get(code)?.data;
    if (!d) continue;
    for (const [enter, exit] of info.pits) {
      stops++;
      for (let k = firstAtOrAfter(d.time, enter - WINDOW_PAD); k < d.time.length && d.time[k] <= exit + WINDOW_PAD; k++) {
        if (!d.on_track[k]) continue; // in the garage
        const { index, lateral } = layout.locate(toScene([d.x[k], d.y[k], d.z[k]]));
        // Off the road but not far away: somewhere in the pit lane
        if (Math.abs(lateral) > layout.half && Math.abs(lateral) < 60) bins[index].push(lateral);
      }
    }
  }
  if (stops < 3) return null;

  // Which side of the track most pit samples are on
  const votes = bins.flat().reduce((sum, v) => sum + Math.sign(v), 0);
  const side = votes >= 0 ? 1 : -1;

  const minCount = Math.max(2, Math.round(stops * 0.1));
  const offsets = bins.map((values) => {
    const mine = values.filter((v) => Math.sign(v) === side).map(Math.abs);
    return mine.length >= minCount ? median(mine) : NaN;
  });

  const run = longestRun(offsets.map((o) => !Number.isNaN(o)), Math.round(25 / layout.spacing));
  if (run.length * layout.spacing < MIN_LANE_LENGTH) return null;

  // Fill small gaps, smooth, then taper both ends into the road edge
  const lane = fillGaps(run.map((i) => offsets[i]));
  const smoothed = smooth(lane, 4);
  const taper = Math.round(30 / layout.spacing);
  const before = Array.from({ length: taper }, (_, k) => (run[0] - taper + k + n) % n);
  const after = Array.from({ length: taper }, (_, k) => (run[run.length - 1] + 1 + k) % n);
  const edge = layout.half;
  const first = smoothed[0];
  const last = smoothed[smoothed.length - 1];

  return {
    side,
    indices: [...before, ...run, ...after],
    offsets: [
      ...before.map((_, k) => THREE.MathUtils.lerp(edge, first, (k + 1) / (taper + 1))),
      ...smoothed,
      ...after.map((_, k) => THREE.MathUtils.lerp(last, edge, (k + 1) / (taper + 1))),
    ],
  };
}

/** Pit-lane asphalt, lines, pit wall, and a row of garages behind the lane. */
export function buildPitLane(layout: TrackLayout, lane: PitLane, teamColors: string[]): THREE.Group {
  const group = new THREE.Group();
  const { side, indices, offsets } = lane;
  const half = layout.half;
  const inner = (k: number) => Math.max(offsets[k] - LANE_WIDTH / 2, half);
  const outer = (k: number) => offsets[k] + LANE_WIDTH / 2;

  group.add(new THREE.Mesh(band(layout, lane, inner, outer, new THREE.Color(0x3a3a3a), 0.012), stripMaterial));
  const white = new THREE.Color(0xffffff);
  group.add(new THREE.Mesh(band(layout, lane, (k) => outer(k) - 0.3, outer, white, 0.02), stripMaterial));
  group.add(new THREE.Mesh(
    band(layout, lane, inner, (k) => inner(k) + 0.3, white, 0.02, (k) => inner(k) > half + 0.5),
    stripMaterial,
  ));

  // Pit wall in the gap between the track and the lane, wherever there's room for one
  const wallSegments: [number, number][] = [];
  for (let k = 0; k < indices.length - 1; k++) {
    const gap = inner(k) - half;
    if (gap >= 1.5) wallSegments.push([k, half + gap / 2]);
  }
  group.add(segmentBoxes(layout, lane, wallSegments, 0.4, (y) => [y, y + 1.1], 0xd0d0d0));

  // Garages along the steady middle part of the lane (entries and exits can swing wide)
  const m = indices.length;
  const typical = median(offsets.slice(Math.floor(m * 0.2), Math.ceil(m * 0.8)));
  const steady = indices
    .map((_, k) => k)
    .filter((k) => k > m * 0.1 && k < m * 0.9 - 1 && Math.abs(offsets[k] - typical) <= 3);
  if (steady.length < 10) return group;

  const depth = 12;
  const garageFront = (k: number) => outer(k) + 1;
  group.add(segmentBoxes(
    layout,
    lane,
    steady.map((k) => [k, garageFront(k) + depth / 2]),
    depth,
    (y) => [layout.groundY, y + 7],
    0xe8e8e8,
  ));

  // Doors facing the lane, two per team, with a strip of team color above each
  const every = Math.max(1, Math.round(14 / layout.spacing));
  const doorMaterial = new THREE.MeshStandardMaterial({ color: 0x1a1a1a });
  const doorGeometry = new THREE.BoxGeometry(5, 4, 0.2);
  const stripGeometry = new THREE.BoxGeometry(5, 0.8, 0.2);
  const colors = teamColors.length ? teamColors : ['#888888'];
  steady.filter((_, j) => j % every === Math.floor(every / 2)).forEach((k, g) => {
    const i = indices[k];
    const base = layout.offsetPoint(i, garageFront(k) - 0.1, side);
    const rotation = layout.heading(i);

    const door = new THREE.Mesh(doorGeometry, doorMaterial);
    door.position.set(base.x, base.y + 2, base.z);
    door.rotation.y = rotation;
    group.add(door);

    const color = colors[Math.floor(g / 2) % colors.length];
    const strip = new THREE.Mesh(stripGeometry, new THREE.MeshStandardMaterial({ color }));
    strip.position.set(base.x, base.y + 4.8, base.z);
    strip.rotation.y = rotation;
    group.add(strip);
  });

  return group;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A flat band beside the track along the lane, between two per-index offsets. */
function band(
  layout: TrackLayout,
  lane: PitLane,
  from: (k: number) => number,
  to: (k: number) => number,
  color: THREE.Color,
  lift: number,
  include: (k: number) => boolean = () => true,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const { side, indices } = lane;

  for (let k = 0; k < indices.length - 1; k++) {
    if (!include(k) || !include(k + 1)) continue;
    const [i, j] = [indices[k], indices[k + 1]];
    const a = layout.offsetPoint(i, from(k), side);
    const b = layout.offsetPoint(i, to(k), side);
    const c = layout.offsetPoint(j, from(k + 1), side);
    const d = layout.offsetPoint(j, to(k + 1), side);
    for (const p of [a, b, c, b, d, c]) {
      positions.push(p.x, p.y + lift, p.z);
      colors.push(color.r, color.g, color.b);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * One box per lane segment [k, offset], `thickness` meters across the track,
 * spanning the heights `heights(trackY)` returns.
 */
function segmentBoxes(
  layout: TrackLayout,
  lane: PitLane,
  segments: [number, number][],
  thickness: number,
  heights: (y: number) => [number, number],
  color: number,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color }),
    Math.max(1, segments.length),
  );
  mesh.count = segments.length;

  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  segments.forEach(([k, offset], m) => {
    const i = lane.indices[k];
    const j = lane.indices[k + 1];
    const a = layout.offsetPoint(i, offset, lane.side);
    const b = layout.offsetPoint(j, offset, lane.side);
    const [bottom, top] = heights(Math.min(a.y, b.y));
    const length = Math.hypot(b.x - a.x, b.z - a.z) + 0.2; // slight overlap hides seams
    rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-(b.z - a.z), b.x - a.x));
    matrix.compose(
      new THREE.Vector3((a.x + b.x) / 2, (bottom + top) / 2, (a.z + b.z) / 2),
      rotation,
      new THREE.Vector3(length, top - bottom, thickness),
    );
    mesh.setMatrixAt(m, matrix);
  });
  return mesh;
}

/** Index of the first time >= t (binary search). */
function firstAtOrAfter(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Indices of the longest run of `present` samples around the loop, allowing gaps of up to
 * `maxGap` missing samples inside it. Returned in order, possibly wrapping past 0.
 */
function longestRun(present: boolean[], maxGap: number): number[] {
  const n = present.length;
  const start = present.findIndex((p) => !p);
  if (start < 0) return [...Array(n).keys()]; // everything present (unlikely)

  let best: number[] = [];
  let current: number[] = [];
  let gap: number[] = [];
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (present[i]) {
      if (current.length) current.push(...gap);
      current.push(i);
      gap = [];
    } else if (current.length) {
      gap.push(i);
      if (gap.length > maxGap) {
        if (current.length > best.length) best = current;
        current = [];
        gap = [];
      }
    }
  }
  return current.length > best.length ? current : best;
}

/** Replace NaNs by interpolating between their neighbors. */
function fillGaps(values: number[]): number[] {
  const out = [...values];
  for (let i = 0; i < out.length; i++) {
    if (!Number.isNaN(out[i])) continue;
    let j = i;
    while (j < out.length && Number.isNaN(out[j])) j++;
    const a = out[i - 1] ?? out[j];
    const b = out[j] ?? a;
    for (let k = i; k < j; k++) out[k] = THREE.MathUtils.lerp(a, b, (k - i + 1) / (j - i + 1));
    i = j;
  }
  return out;
}

function smooth(values: number[], radius: number): number[] {
  return values.map((_, i) => {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(values.length - 1, i + radius);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += values[j];
    return sum / (hi - lo + 1);
  });
}
