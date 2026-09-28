import * as THREE from 'three';
import { Series } from '../replay/replay.models';

/** Channels every rocket sample carries (see docs/data-format.md, rocket flights). */
export const ROCKET_CHANNELS = [
  'x', 'y', 'z', 'speed', 'vertical_velocity', 'acceleration', 'mach',
  'dynamic_pressure', 'angle_of_attack', 'stability_margin', 'thrust', 'mass',
] as const;
export type RocketChannel = (typeof ROCKET_CHANNELS)[number];

export type RocketState = Record<RocketChannel, number> & {
  /** Orientation in three.js axes, rotating the model (built along +Y) to point where the rocket points. */
  orientation: THREE.Quaternion;
};

/** A flight's samples, interpolated to any time. */
export class RocketTrack {
  readonly time: number[];
  private channels: Record<RocketChannel, number[]>;
  private quats: THREE.Quaternion[];
  private cursor = 0;

  constructor(series: Series) {
    this.time = series.time;
    this.channels = Object.fromEntries(
      ROCKET_CHANNELS.map((c) => [c, (series[c] ?? []).map((v) => Number(v ?? 0))]),
    ) as Record<RocketChannel, number[]>;
    // Data frame is Z-up (x east, y north); three.js is Y-up with scene (x, z, -y).
    // That change of axes is a proper rotation, so it maps a quaternion's vector part the same way.
    const [w, x, y, z] = ['qw', 'qx', 'qy', 'qz'].map((k) => series[k] as number[]);
    this.quats = w.map((_, i) => new THREE.Quaternion(x[i], z[i], -y[i], w[i]));
  }

  get start(): number {
    return this.time[0];
  }

  get end(): number {
    return this.time[this.time.length - 1];
  }

  values(channel: RocketChannel): number[] {
    return this.channels[channel];
  }

  stateAt(t: number): RocketState {
    const times = this.time;
    const n = times.length;
    const tc = Math.min(Math.max(t, times[0]), times[n - 1]);

    let i = Math.min(this.cursor, n - 2);
    while (i > 0 && times[i] > tc) i--;
    while (i < n - 2 && times[i + 1] <= tc) i++;
    this.cursor = i;

    const t0 = times[i];
    const t1 = times[i + 1];
    const f = t1 > t0 ? (tc - t0) / (t1 - t0) : 0;

    const state = { orientation: this.quats[i].clone().slerp(this.quats[i + 1], f) } as RocketState;
    for (const c of ROCKET_CHANNELS) {
      const v = this.channels[c];
      state[c] = v[i] + (v[i + 1] - v[i]) * f;
    }
    return state;
  }
}
