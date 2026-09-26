import { VehicleSeries } from './replay.models';

export interface VehicleState {
  x: number; y: number; z: number;
  heading: number;        // radians, direction of travel in the data's x/y plane
  speed: number | null;
  gear: number | null;
  onTrack: boolean;
}

export class VehicleTrack {
  private cursor = 0; // remembers where we were last frame

  constructor(public readonly id: string, public readonly data: VehicleSeries) {}

  /** Append a later chunk of data for this vehicle. */
  append(more: VehicleSeries): void {
    for (const key of Object.keys(this.data) as (keyof VehicleSeries)[]) {
      (this.data[key] as unknown[]).push(...(more[key] as unknown[]));
    }
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
    const lerp = (a: number, b: number) => a + (b - a) * f;
    const d = this.data;

    return {
      x: lerp(d.x[i], d.x[i + 1]),
      y: lerp(d.y[i], d.y[i + 1]),
      z: lerp(d.z[i], d.z[i + 1]),
      heading: Math.atan2(d.y[i + 1] - d.y[i], d.x[i + 1] - d.x[i]),
      speed: d.speed[i],
      gear: d.gear[i],
      onTrack: d.on_track[i],
    };
  }
}