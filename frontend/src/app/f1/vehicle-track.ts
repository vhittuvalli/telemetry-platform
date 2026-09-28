import { VehicleSeries } from '../replay/replay.models';

export interface VehicleState {
  x: number; y: number; z: number;
  heading: number;        // radians, direction of travel in the data's x/y plane
  speed: number | null;
  throttle: number | null;
  brake: number | null;
  gear: number | null;
  rpm: number | null;
  drs: number | null;
  onTrack: boolean;
}

/** Centered moving average: each point becomes the mean of its neighbors within `radius`. */
function smooth(values: number[], radius: number): number[] {
  const n = values.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n - 1, i + radius);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += values[j];
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

/** Catmull-Rom curve through p1..p2 (using neighbors p0 and p3), at fraction f. */
function catmull(p0: number, p1: number, p2: number, p3: number, f: number): number {
  const f2 = f * f;
  const f3 = f2 * f;
  return 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
}

/** Rate of change of the Catmull-Rom curve at fraction f (its direction). */
function catmullSlope(p0: number, p1: number, p2: number, p3: number, f: number): number {
  return 0.5 * ((-p0 + p2) + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * f + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * f * f);
}

/** Linear blend that tolerates missing values (uses whichever side exists). */
function lerpNullable(a: number | null, b: number | null, f: number): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return a + (b - a) * f;
}

export class VehicleTrack {
  private cursor = 0;
  private sx: number[] = [];
  private sy: number[] = [];
  private sz: number[] = [];
  private headings: number[] = []; // per sample, carried through stops

  constructor(public readonly id: string, public readonly data: VehicleSeries) {}

  /** Call once before use: drop bad samples, precompute smoothed positions. */
  finalize(radius = 2): void {
    this.dropMissingPositions();
    this.sx = smooth(this.data.x, radius);
    this.sy = smooth(this.data.y, radius);
    this.sz = smooth(this.data.z, radius);
    this.headings = this.computeHeadings();
  }

  /** FastF1 reports (0, 0, 0) while a car has no position fix (e.g. before it leaves the garage). */
  private dropMissingPositions(): void {
    const d = this.data;
    const keep = d.time.map((_, i) => !(d.x[i] === 0 && d.y[i] === 0));
    if (keep.every(Boolean)) return;
    for (const key of Object.keys(d) as (keyof VehicleSeries)[]) {
      (d[key] as unknown[]) = (d[key] as unknown[]).filter((_, i) => keep[i]);
    }
  }

  /** Direction of travel at each sample; a stopped car keeps the heading it arrived with. */
  private computeHeadings(): number[] {
    const n = this.sx.length;
    const out = new Array<number>(n).fill(NaN);
    let last = NaN;
    for (let i = 0; i < n; i++) {
      const a = Math.max(i - 1, 0);
      const b = Math.min(i + 1, n - 1);
      const dx = this.sx[b] - this.sx[a];
      const dy = this.sy[b] - this.sy[a];
      if (dx * dx + dy * dy > 0.01) last = Math.atan2(dy, dx);
      out[i] = last;
    }
    // Before the car first moves, use the first heading it has
    const first = out.find((h) => !Number.isNaN(h)) ?? 0;
    return out.map((h) => (Number.isNaN(h) ? first : h));
  }

  /** Interpolated state at time t, or null if there is no data at t. */
  stateAt(t: number): VehicleState | null {
    const times = this.data.time;
    const n = times.length;
    if (n < 2 || t < times[0] || t > times[n - 1]) return null;

    // Move the cursor so that times[i] <= t < times[i + 1]
    let i = Math.min(this.cursor, n - 2);
    while (i > 0 && times[i] > t) i--;
    while (i < n - 2 && times[i + 1] <= t) i++;
    this.cursor = i;

    const t0 = times[i];
    const t1 = times[i + 1];
    const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;

    // Four neighboring points around the segment (clamped at the ends of the data)
    const i0 = Math.max(i - 1, 0);
    const i3 = Math.min(i + 2, n - 1);
    const at = (a: number[]) => [a[i0], a[i], a[i + 1], a[i3]] as const;

    const [x0, x1, x2, x3] = at(this.sx);
    const [y0, y1, y2, y3] = at(this.sy);
    const [z0, z1, z2, z3] = at(this.sz);

    // Heading from the curve's direction, or the precomputed one if the car is stopped
    const dx = catmullSlope(x0, x1, x2, x3, f);
    const dy = catmullSlope(y0, y1, y2, y3, f);
    const heading = dx * dx + dy * dy > 1e-4 ? Math.atan2(dy, dx) : this.headings[i];

    const d = this.data;
    return {
      x: catmull(x0, x1, x2, x3, f),
      y: catmull(y0, y1, y2, y3, f),
      z: catmull(z0, z1, z2, z3, f),
      heading,
      // Continuous channels: blend between samples for smooth readouts
      speed: lerpNullable(d.speed[i], d.speed[i + 1], f),
      throttle: lerpNullable(d.throttle[i], d.throttle[i + 1], f),
      rpm: lerpNullable(d.rpm[i], d.rpm[i + 1], f),
      // Stepped channels: use the most recent value
      brake: d.brake[i],
      gear: d.gear[i],
      drs: d.drs[i],
      onTrack: d.on_track[i],
    };
  }
}