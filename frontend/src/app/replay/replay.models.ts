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