import { VehicleSeries } from './replay.models';

export interface VehicleState {
  x: number; y: number; z: number;
  heading: number;        // radians, direction of travel in the data's x/y plane
  speed: number | null;
  gear: number | null;
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

export class VehicleTrack {
  private cursor = 0;
  private sx: number[] = [];
  private sy: number[] = [];
  private sz: number[] = [];
  private lastHeading = 0;

  constructor(public readonly id: string, public readonly data: VehicleSeries) {}

  /** Append a later chunk of data for this vehicle. */
  append(more: VehicleSeries): void {
    for (const key of Object.keys(this.data) as (keyof VehicleSeries)[]) {
      (this.data[key] as unknown[]).push(...(more[key] as unknown[]));
    }
  }

  /** Call once after all chunks are loaded: precompute smoothed positions. */
  finalize(radius = 2): void {
    this.sx = smooth(this.data.x, radius);
    this.sy = smooth(this.data.y, radius);
    this.sz = smooth(this.data.z, radius);
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

    // Heading from the curve's direction; keep the last heading if the car is stopped
    const dx = catmullSlope(x0, x1, x2, x3, f);
    const dy = catmullSlope(y0, y1, y2, y3, f);
    if (dx * dx + dy * dy > 1e-4) this.lastHeading = Math.atan2(dy, dx);

    const d = this.data;
    return {
      x: catmull(x0, x1, x2, x3, f),
      y: catmull(y0, y1, y2, y3, f),
      z: catmull(z0, z1, z2, z3, f),
      heading: this.lastHeading,
      speed: d.speed[i],
      gear: d.gear[i],
      onTrack: d.on_track[i],
    };
  }
}