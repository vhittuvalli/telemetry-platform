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