export interface SessionInfo {
  year: number;
  event: string;
  location: string;
  name: string;
  date: string | null;
}

export interface Driver {
  code: string;
  number: string;
  name: string;
  team: string;
  color: string | null;
  final_position: number | null;
  grid_position: number | null;
  status: string | null;
}

export interface ReplayMeta {
  session: SessionInfo;
  time_range: { start: number; end: number };
  drivers: Driver[];
  track_outline: [number, number, number][];
}

export interface VehicleSeries {
  time: number[];
  x: number[];
  y: number[];
  z: number[];
  speed: (number | null)[];
  throttle: (number | null)[];
  brake: (number | null)[];
  gear: (number | null)[];
  rpm: (number | null)[];
  drs: (number | null)[];
  on_track: boolean[];
}

export interface ReplayDataWindow {
  replay_id: string;
  start: number;
  end: number;
  vehicles: Record<string, VehicleSeries>;
}

export interface LapRecord {
  driver: string;
  lap: number;
  lap_time: number | null;
  lap_end: number | null;
  position: number | null;
  compound: string | null;
  tyre_life: number | null;
  stint: number | null;
  pit_in: number | null;
  pit_out: number | null;
}
export interface ReplaySummary {
  id: string;
  year: number;
  event: string;
  location: string;
  session: string;
  date: string | null;
}

export type SessionStatus = 'built' | 'building' | 'available' | 'upcoming';

export interface CatalogSession {
  code: string;
  name: string;
  date_utc: string | null;
  status: SessionStatus;
  replay_id: string;
  build_id: string | null;
}

export interface CatalogEvent {
  round: number;
  name: string;
  location: string;
  country: string;
  date: string;
  sessions: CatalogSession[];
}

export interface BuildJob {
  id: string;
  replay_id: string;
  year: number;
  round: number;
  session: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  message: string;
}
