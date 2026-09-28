import { signal } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../environments/environment';
import { ReplayApiService } from './replay-api.service';
import { DataSource } from './replay-source';
import { F1Meta, FlightEvent, LapRecord, ReplayMeta, RocketMeta, Series } from './replay.models';

const EMIT_EVERY_MS = 250; // how often the scene rebuilds from what's arrived
const RECONNECT_MS = 2000;

/** The platform's WebSocket address (the page's own host when the API is same-origin). */
function socketBase(): string {
  const api = environment.apiUrl;
  if (api) return api.replace(/^http/, 'ws');
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

type Columns = Record<string, number[]>;

/**
 * A live session: a snapshot of everything sent so far, then new samples, events and
 * laps as they arrive over a WebSocket. `series` emits the growing session several times
 * a second, one series per vehicle (a rocket, or each car in an F1 session).
 */
export class LiveSource implements DataSource {
  readonly live = true;
  readonly ended = signal(false);
  readonly replayId = signal<string | null>(null);

  private base?: ReplayMeta;
  private vehicles: Record<string, Columns> = {};
  private events: FlightEvent[] = [];
  private lapRecords = new Map<string, LapRecord>(); // by driver and lap

  constructor(private api: ReplayApiService, readonly code: string) {}

  get id(): string {
    return `live:${this.code}`;
  }

  meta(): Observable<ReplayMeta> {
    return this.api.getLiveSession(this.code).pipe(
      map((info) => {
        const m = info.meta as Record<string, any>;
        const session = { year: new Date().getFullYear(), location: 'Live', date: null, ...m['session'],
                          name: `Live · ${this.code}` };
        if (info.domain === 'f1') {
          this.base = { domain: 'f1', session: { event: 'Live session', ...session }, time_range: { start: 0, end: 0 },
                        drivers: m['drivers'], track_outline: m['track_outline'] } as F1Meta;
        } else {
          this.base = {
            domain: 'rocket',
            session: { event: m['rocket']?.name ?? 'Live flight', ...session },
            time_range: { start: 0, end: 0 },
            rocket: m['rocket'],
            launch: m['launch'] ?? { rail_length: 1, angle: 0, heading: 0, wind_speed: 0, wind_from: 0, site_name: 'Live', site_altitude: 0 },
            events: [],
            summary: { apogee: 0, apogee_time: null, max_speed: 0, max_mach: 0, max_acceleration: 0, max_q: 0,
                       max_q_time: 0, flight_time: 0, landing: [0, 0], rail_exit_speed: 0 },
          } as RocketMeta;
        }
        return this.base;
      }),
    );
  }

  /** The metadata as of the latest data: events so far, and the time covered. */
  currentMeta<M extends ReplayMeta = ReplayMeta>(): M {
    const starts: number[] = [];
    const ends: number[] = [];
    for (const cols of Object.values(this.vehicles)) {
      const t = cols['time'];
      if (t?.length) {
        starts.push(t[0]);
        ends.push(t[t.length - 1]);
      }
    }
    const time_range = { start: starts.length ? Math.min(...starts) : 0, end: ends.length ? Math.max(...ends) : 0 };
    const meta = { ...this.base!, time_range } as ReplayMeta;
    if (meta.domain === 'rocket') (meta as RocketMeta).events = [...this.events];
    return meta as M;
  }

  /** Laps completed so far (F1). */
  laps(): LapRecord[] {
    return [...this.lapRecords.values()];
  }

  series(): Observable<Map<string, Series>> {
    return new Observable((subscriber) => {
      let socket: WebSocket | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let dirty = false;
      let closed = false;

      const emit = () => {
        timer = null;
        const ready = Object.entries(this.vehicles).filter(([, c]) => c['time']?.length > 1);
        if (!dirty || !ready.length) return;
        dirty = false;
        subscriber.next(new Map(ready.map(([id, cols]) => [id, cols as Series])));
      };
      const schedule = () => {
        dirty = true;
        if (!timer) timer = setTimeout(emit, EMIT_EVERY_MS);
      };

      const connect = () => {
        socket = new WebSocket(`${socketBase()}/live/sessions/${this.code}/watch`);
        socket.onmessage = (msg) => {
          const m = JSON.parse(msg.data);
          if (m.type === 'snapshot') {
            this.vehicles = m.vehicles;
            this.events = m.events;
            this.lapRecords.clear();
            this.addLaps(m.laps ?? []);
            if (m.ended) this.finish(m.replay_id);
            schedule();
          } else if (m.type === 'data') {
            for (const sample of m.samples) this.add(sample);
            this.events = [...this.events, ...m.events].sort((a, b) => a.time - b.time);
            this.addLaps(m.laps ?? []);
            schedule();
          } else if (m.type === 'end') {
            this.finish(m.replay_id);
            schedule();
          } else if (m.type === 'error') {
            subscriber.error(new Error(m.detail));
          }
        };
        socket.onclose = () => {
          // Dropped connection mid-session: reconnect and take a fresh snapshot
          if (!closed && !this.ended()) setTimeout(connect, RECONNECT_MS);
        };
      };
      connect();

      return () => {
        closed = true;
        if (timer) clearTimeout(timer);
        socket?.close();
      };
    });
  }

  private finish(replayId: string | null): void {
    this.ended.set(true);
    this.replayId.set(replayId);
  }

  private addLaps(laps: LapRecord[]): void {
    for (const lap of laps) this.lapRecords.set(`${lap.driver}/${lap.lap}`, lap);
  }

  /** Add a sample to its vehicle, in time order (UDP can deliver out of order). */
  private add(sample: Record<string, number | string>): void {
    const id = String(sample['vehicle_id'] ?? 'rocket');
    let cols = this.vehicles[id];
    if (!cols) {
      cols = this.vehicles[id] = {};
      for (const key of Object.keys(sample)) if (key !== 'vehicle_id') cols[key] = [];
    }
    const times = cols['time'];
    let i = times.length;
    while (i > 0 && times[i - 1] > (sample['time'] as number)) i--;
    if (i > 0 && times[i - 1] === sample['time']) return;
    for (const [key, values] of Object.entries(cols)) {
      const v = sample[key] as number;
      if (i === values.length) values.push(v);
      else values.splice(i, 0, v);
    }
  }
}
