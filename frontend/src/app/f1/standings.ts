import { Driver, LapRecord } from '../replay/replay.models';

export interface DriverLaps {
  laps: LapRecord[];          // completed laps with a known end time, in order
  pits: [number, number][];   // [pit entry, pit exit] windows
}

export interface StandingRow {
  code: string;
  color: string;
  position: number;
  lapsDone: number;
  gap: string;
  compound: string | null;
  status: 'RUN' | 'PIT' | 'OUT';
}

/** Returns a car's position around the lap (0 to 1), or null if unknown. */
export type ProgressFn = (code: string) => number | null;

/** Group laps by driver and pair each pit entry with the following lap's pit exit. */
export function indexLaps(records: LapRecord[]): Map<string, DriverLaps> {
  const byDriver = new Map<string, LapRecord[]>();
  for (const r of records) {
    if (!byDriver.has(r.driver)) byDriver.set(r.driver, []);
    byDriver.get(r.driver)!.push(r);
  }

  const result = new Map<string, DriverLaps>();
  for (const [driver, laps] of byDriver) {
    laps.sort((a, b) => a.lap - b.lap);
    const pits: [number, number][] = [];
    laps.forEach((lap, i) => {
      const exit = laps[i + 1]?.pit_out;
      if (lap.pit_in != null && exit != null) pits.push([lap.pit_in, exit]);
    });
    result.set(driver, { laps: laps.filter((l) => l.lap_end != null), pits });
  }
  return result;
}

/** Number of laps completed by time t (binary search on lap_end). */
function lapsCompletedBy(laps: LapRecord[], t: number): number {
  let lo = 0;
  let hi = laps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (laps[mid].lap_end! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function computeStandings(
  t: number,
  drivers: Driver[],
  lapIndex: Map<string, DriverLaps>,
  progressOf: ProgressFn,
): StandingRow[] {
  const rows = drivers.map((d) => {
    const info = lapIndex.get(d.code) ?? { laps: [], pits: [] };
    const done = lapsCompletedBy(info.laps, t);
    const last = done > 0 ? info.laps[done - 1] : null;
    const next = info.laps[done];
    const finalLap = info.laps[info.laps.length - 1];
    const finished = d.status === 'Finished' || (d.status ?? '').startsWith('+');
    // Out once two of their usual laps pass without completing one (safety car laps and
    // pit stops stay inside that). Live, the final lap is just the latest one so far.
    const lapTime = finalLap?.lap_time ?? 90;
    const retired = !finished && finalLap != null && t > finalLap.lap_end! + Math.max(60, 2 * lapTime);
    const inPit = info.pits.some(([enter, exit]) => enter <= t && t < exit);

    // Continuous progress: completed laps + fraction of the current lap
    let progress = done;
    const fraction = progressOf(d.code);
    if (fraction != null && !retired) {
      let f = fraction;
      const sinceLine = last ? t - last.lap_end! : Infinity;
      const untilLine = next ? next.lap_end! - t : Infinity;
      if (f > 0.5 && sinceLine < 20) f -= 1; // timing says crossed, position not yet
      if (f < 0.5 && untilLine < 20) f += 1; // position says crossed, timing not yet
      progress += f;
    }

    return {
      driver: d,
      done,
      progress,
      lastLapTime: last?.lap_time ?? null,
      compound: (last ?? info.laps[0])?.compound ?? null,
      status: (retired ? 'OUT' : inPit ? 'PIT' : 'RUN') as StandingRow['status'],
    };
  });

  const raceStarted = rows.some((r) => r.done > 0);

  rows.sort((a, b) =>
    Number(a.status === 'OUT') - Number(b.status === 'OUT') ||
    (raceStarted
      ? b.progress - a.progress
      : (a.driver.grid_position ?? 99) - (b.driver.grid_position ?? 99)),
  );

  const leader = rows[0];
  const lapTime = leader?.lastLapTime ?? 85; // seconds; a rough default before lap 1

  return rows.map((r, i) => ({
    code: r.driver.code,
    color: r.driver.color ?? '#ffffff',
    position: i + 1,
    lapsDone: r.done,
    gap: i === 0 ? 'Leader' : raceStarted ? formatGap(leader.progress - r.progress, lapTime) : '',
    compound: r.compound,
    status: r.status,
  }));
}

function formatGap(lapsBehind: number, lapTime: number): string {
  if (lapsBehind >= 1) {
    const n = Math.floor(lapsBehind);
    return `+${n} LAP${n > 1 ? 'S' : ''}`;
  }
  return `+${(lapsBehind * lapTime).toFixed(1)}s`;
}