import { signal } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../environments/environment';
import { ReplayApiService } from './replay-api.service';
import { DataSource } from './replay-source';
import { FlightEvent, ReplayMeta, RocketMeta, Series } from './replay.models';

const EMIT_EVERY_MS = 250; // how often the scene rebuilds from what's arrived
const RECONNECT_MS = 2000;

/** The platform's WebSocket address (the page's own host when the API is same-origin). */
function socketBase(): string {
  const api = environment.apiUrl;
  if (api) return api.replace(/^http/, 'ws');
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

/**
 * A live session: a snapshot of everything sent so far, then new samples and events as
 * they arrive over a WebSocket. `series` emits a growing flight several times a second.
 */
export class LiveSource implements DataSource {
  readonly live = true;
  readonly ended = signal(false);
  readonly replayId = signal<string | null>(null);

  private base?: RocketMeta;
  private columns: Record<string, number[]> = {};
  private events: FlightEvent[] = [];

  constructor(private api: ReplayApiService, readonly code: string) {}

  get id(): string {
    return `live:${this.code}`;
  }

  meta(): Observable<ReplayMeta> {
    return this.api.getLiveSession(this.code).pipe(
      map((info) => {
        const m = info.meta as Partial<RocketMeta>;
        this.base = {
          domain: 'rocket',
          session: { year: new Date().getFullYear(), event: m.rocket?.name ?? 'Live flight', location: 'Live',
                     date: null, ...m.session, name: `Live · ${this.code}` },
          time_range: { start: 0, end: 0 },
          rocket: m.rocket!,
          launch: m.launch ?? { rail_length: 1, angle: 0, heading: 0, wind_speed: 0, wind_from: 0, site_name: 'Live', site_altitude: 0 },
          events: [],
          summary: { apogee: 0, apogee_time: null, max_speed: 0, max_mach: 0, max_acceleration: 0, max_q: 0,
                     max_q_time: 0, flight_time: 0, landing: [0, 0], rail_exit_speed: 0 },
        };
        return this.base;
      }),
    );
  }

  /** The metadata as of the latest data: events so far, and the time covered. */
  currentMeta(): RocketMeta {
    const t = this.columns['time'] ?? [];
    return { ...this.base!, events: [...this.events], time_range: { start: t[0] ?? 0, end: t[t.length - 1] ?? 0 } };
  }

  series(): Observable<Map<string, Series>> {
    return new Observable((subscriber) => {
      let socket: WebSocket | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let dirty = false;
      let closed = false;

      const emit = () => {
        timer = null;
        if (!dirty || !(this.columns['time']?.length > 1)) return;
        dirty = false;
        subscriber.next(new Map([['rocket', this.columns as Series]]));
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
            this.columns = m.columns;
            this.events = m.events;
            if (m.ended) this.finish(m.replay_id);
            schedule();
          } else if (m.type === 'data') {
            for (const sample of m.samples) this.add(sample);
            this.events = [...this.events, ...m.events].sort((a, b) => a.time - b.time);
            schedule();
          } else if (m.type === 'end') {
            this.finish(m.replay_id);
            schedule();
          } else if (m.type === 'error') {
            subscriber.error(new Error(m.detail));
          }
        };
        socket.onclose = () => {
          // Dropped connection mid-flight: reconnect and take a fresh snapshot
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

  /** Add a sample in time order (UDP can deliver out of order). */
  private add(sample: Record<string, number>): void {
    const times = this.columns['time'];
    let i = times.length;
    while (i > 0 && times[i - 1] > sample['time']) i--;
    if (i > 0 && times[i - 1] === sample['time']) return;
    for (const [key, values] of Object.entries(this.columns)) {
      if (i === values.length) values.push(sample[key]);
      else values.splice(i, 0, sample[key]);
    }
  }
}
