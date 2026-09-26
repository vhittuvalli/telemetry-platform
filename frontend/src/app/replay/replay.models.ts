//interfaces mirror meta.json
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
  on_track: boolean[];
}

export interface ReplayDataWindow {
  replay_id: string;
  start: number;
  end: number;
  vehicles: Record<string, VehicleSeries>;
}