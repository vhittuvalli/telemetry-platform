/** Which kind of session a replay holds; picks the scene and panels that show it. */
export type Domain = 'f1' | 'rocket';

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

export interface F1Meta {
  domain?: 'f1'; // replays built before domains existed have none
  session: SessionInfo;
  time_range: { start: number; end: number };
  drivers: Driver[];
  track_outline: [number, number, number][];
}

export interface RocketGeometry {
  id: string | null; // the design in rockets/ it was flown from
  name: string;
  length: number;   // m
  diameter: number; // m
  cg: number;       // m from the nose tip, at launch
  nose: { shape: string; length: number; diameter: number; shape_parameter: number; position: number };
  body_tubes: { length: number; diameter: number; position: number }[];
  fins: {
    count: number; root_chord: number; tip_chord: number; span: number;
    sweep: number; thickness: number; position: number;
  }[];
  motor: {
    designation: string; manufacturer: string; diameter: number; length: number;
    total_impulse: number; burn_time: number; max_thrust: number; aft_position: number;
  };
  recovery: { name: string; diameter: number; cd: number; deploy: string }[];
}

export interface FlightEvent {
  name: string; // ignition, liftoff, rail_exit, burnout, apogee, ejection, deploy:<device>, landing
  time: number;
  x: number;
  y: number;
  z: number;
}

export interface FlightSummary {
  apogee: number;
  apogee_time: number | null;
  max_speed: number;
  max_mach: number;
  max_acceleration: number;
  max_q: number;
  max_q_time: number;
  flight_time: number;
  landing: [number, number];
  rail_exit_speed: number;
}

export interface RocketMeta {
  domain: 'rocket';
  session: SessionInfo;
  time_range: { start: number; end: number };
  rocket: RocketGeometry;
  launch: {
    rail_length: number; angle: number; heading: number; wind_speed: number; wind_from: number;
    site_name: string; site_altitude: number;
  };
  events: FlightEvent[];
  summary: FlightSummary;
  dispersion?: DispersionSummary; // present when Monte Carlo runs were made for this flight
  custom?: SimulationRequest;     // present for flights simulated on request
}

export interface LandingZone {
  probability: number;      // share of landings the ellipse is expected to hold
  observed: number;         // share of the runs that actually landed inside it
  center: [number, number]; // m, x east / y north of the pad
  semi_major: number;       // m
  semi_minor: number;       // m
  angle: number;            // degrees, major axis counterclockwise from east
}

export interface DispersionSummary {
  runs: number;
  succeeded: number;
  seed: number;
  variation: Record<string, number>;
  apogee: { mean: number; sd: number; p5: number; p95: number };
  landing: { zones: LandingZone[]; max_distance: number; p95_distance: number };
}

export interface Dispersion extends DispersionSummary {
  landings: [number, number][];
  apogees: number[];
}

export type ReplayMeta = F1Meta | RocketMeta;

/** One vehicle's columns, as the backend sends them: `time` plus any domain's channels. */
export type Series = { time: number[] } & Record<string, (number | boolean | null)[]>;

/** F1 car channels (see docs/data-format.md). */
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
  vehicles: Record<string, Series>;
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
  domain: Domain;
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

export interface MotorSummary {
  file: string;
  designation: string;
  manufacturer: string;
  diameter: number; // mm
  total_impulse: number; // N·s
  burn_time: number; // s
  max_thrust: number; // N
  delays: number[]; // s
}

export interface RocketSummary {
  id: string;
  name: string;
  length: number;
  diameter: number;
  motor: MotorSummary;
  ejection_delay: number | null;
  uses_ejection: boolean;
  launch: { wind_speed: number; wind_from: number; angle: number; heading: number };
}

export interface SimulationRequest {
  rocket: string;
  motor: string | null;
  ejection_delay: number | null;
  wind_speed: number;
  wind_from: number;
  angle: number;
  heading: number;
  monte_carlo: number;
}

export interface LiveSessionInfo {
  code: string;
  domain: string;
  name: string | null;
  samples: number;
  packets: number;
  lost: number;
  latest: number | null;
  ended: boolean;
  replay_id: string | null;
  age: number; // s since it started
  meta?: Record<string, unknown>;
}
