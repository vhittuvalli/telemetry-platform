import { Observable, from, map, mergeMap, toArray } from 'rxjs';
import { ReplayApiService } from './replay-api.service';
import { ReplayMeta, Series } from './replay.models';

/** Where a session's data comes from. Replay files today; a live stream can implement the same shape later. */
export interface DataSource {
  readonly id: string;
  meta(): Observable<ReplayMeta>;
  /** Every vehicle's full series for the session, keyed by vehicle id. */
  series(meta: ReplayMeta): Observable<Map<string, Series>>;
}

const WINDOW_S = 300; // matches the backend's max window
const PARALLEL_WINDOWS = 3; // a whole session at once overwhelms small hosts

/** A built replay served by the backend's /replays endpoints. */
export class ReplaySource implements DataSource {
  constructor(private api: ReplayApiService, readonly id: string) {}

  meta(): Observable<ReplayMeta> {
    return this.api.getMeta(this.id);
  }

  series(meta: ReplayMeta): Observable<Map<string, Series>> {
    const { start, end } = meta.time_range;
    const windows: [number, number][] = [];
    for (let s = start; s < end; s += WINDOW_S) windows.push([s, Math.min(s + WINDOW_S, end + 1)]);

    return from(windows).pipe(
      mergeMap(([s, e]) => this.api.getData(this.id, s, e), PARALLEL_WINDOWS),
      toArray(),
      map((chunks) => {
        // Windows can arrive in any order; stitch them back together in time order
        chunks.sort((a, b) => a.start - b.start);
        const vehicles = new Map<string, Series>();
        for (const chunk of chunks) {
          for (const [id, series] of Object.entries(chunk.vehicles)) {
            const existing = vehicles.get(id);
            if (!existing) {
              vehicles.set(id, series);
              continue;
            }
            for (const key of Object.keys(series)) existing[key].push(...(series[key] as never[]));
          }
        }
        return vehicles;
      }),
    );
  }
}
