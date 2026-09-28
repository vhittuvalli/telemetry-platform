import * as THREE from 'three';
import { TrackLayout, buildGantry } from './track-builder';
import { VehicleTrack } from './vehicle-track';
import { DriverLaps } from './standings';
import { ToScene } from './pit-lane';

const MIN_WAIT = 3;       // seconds a car must sit still to count as parked on the grid
const LIGHTS_STEP = 1;    // seconds between each of the five start lights coming on
const START_LINE_GAP = 6; // meters from the pole car's slot to the start line

export interface GridSlot {
  code: string;
  index: number;          // nearest track sample
  position: THREE.Vector3; // where the car parked, on the road surface
}

export interface StartingGrid {
  slots: GridSlot[];      // front of the grid first
  raceStart: number;      // replay time the lights go out
  startIndex: number;     // track sample of the start line
}

/**
 * Find the standing start: where each car sat still before launching on lap 1.
 * Returns null when there wasn't one (e.g. a start behind the safety car).
 */
export function findStartingGrid(
  layout: TrackLayout,
  tracks: Map<string, VehicleTrack>,
  lapIndex: Map<string, DriverLaps>,
  toScene: ToScene,
): StartingGrid | null {
  const slots: GridSlot[] = [];
  const launches: number[] = [];

  for (const [code, track] of tracks) {
    const firstLapEnd = lapIndex.get(code)?.laps[0]?.lap_end;
    if (firstLapEnd == null) continue;
    const parked = lastStop(track, firstLapEnd - 40);
    if (!parked) continue;

    const position = toScene(parked.position);
    const { index, lateral } = layout.locate(position);
    if (Math.abs(lateral) > layout.half + 1) continue; // starting from the pit lane
    position.y = layout.samples[index].y;
    slots.push({ code, index, position });
    launches.push(parked.launch);
  }
  if (slots.length < Math.max(4, tracks.size / 2)) return null;

  // Order front to back by distance around the track, measured from any one car
  const n = layout.length;
  const ref = slots[0].index;
  const ahead = (i: number) => ((i - ref + n + n / 2) % n) - n / 2;
  slots.sort((a, b) => ahead(b.index) - ahead(a.index));

  launches.sort((a, b) => a - b);
  return {
    slots,
    raceStart: launches[Math.floor(launches.length / 2)] - 0.3, // cars react just after lights out
    startIndex: (slots[0].index + Math.round(START_LINE_GAP / layout.spacing)) % n,
  };
}

/** Grid boxes, the start line, and a start-light gantry over it. */
export function buildStartingGrid(layout: TrackLayout, grid: StartingGrid): { group: THREE.Group; lamps: THREE.Mesh[] } {
  const group = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const bar = (along: number, across: number) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(along, across), paint);
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
  };

  // Each box: a line across the front of the car and short lines down both sides
  // (local X = along the track, local Z = across it; the car's center is the origin)
  for (const slot of grid.slots) {
    const box = new THREE.Group();
    const front = bar(0.25, 2.6);
    front.position.set(3.1, 0.03, 0);
    box.add(front);
    for (const z of [-1.3, 1.3]) {
      const sideLine = bar(2.5, 0.2);
      sideLine.position.set(1.85, 0.03, z);
      box.add(sideLine);
    }
    box.position.copy(slot.position);
    box.rotation.y = layout.heading(slot.index);
    group.add(box);
  }

  // Start line and gantry
  const start = new THREE.Group();
  const line = bar(0.6, layout.width);
  line.position.y = 0.03;
  start.add(line);
  const gantry = buildGantry(layout.width, false);
  start.add(gantry.group);
  start.position.copy(layout.samples[grid.startIndex]);
  start.rotation.y = layout.heading(grid.startIndex);
  group.add(start);

  return { group, lamps: gantry.lamps };
}

/** How many start lights are on at time t: one more each second, then all out at the start. */
export function lightsOn(grid: StartingGrid, t: number): number {
  const sinceFirst = t - (grid.raceStart - 5 * LIGHTS_STEP);
  if (sinceFirst < 0 || t >= grid.raceStart) return 0;
  return Math.min(5, Math.floor(sinceFirst / LIGHTS_STEP) + 1);
}

/**
 * The last time the car sat still for MIN_WAIT seconds before `before`:
 * its average position then, and when it moved off.
 */
function lastStop(track: VehicleTrack, before: number): { position: [number, number, number]; launch: number } | null {
  const d = track.data;
  let result: { position: [number, number, number]; launch: number } | null = null;
  let runStart = -1;

  for (let k = 0; k < d.time.length && d.time[k] < before; k++) {
    const still = d.on_track[k] && d.speed[k] != null && d.speed[k]! <= 1;
    if (still) {
      if (runStart < 0) runStart = k;
      continue;
    }
    if (runStart >= 0 && d.time[k - 1] - d.time[runStart] >= MIN_WAIT) {
      let x = 0, y = 0, z = 0;
      for (let m = runStart; m < k; m++) {
        x += d.x[m];
        y += d.y[m];
        z += d.z[m];
      }
      const count = k - runStart;
      result = { position: [x / count, y / count, z / count], launch: d.time[k] };
    }
    runStart = -1;
  }
  return result;
}
