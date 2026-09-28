import { WritableSignal } from '@angular/core';
import { Observable } from 'rxjs';
import { Domain } from '../replay/replay.models';

export interface CameraOption {
  id: string;
  label: string;
  needsTarget?: boolean; // only usable once something is selected to follow
}

/** What the loaded session gives the shared viewer: its time span and where playback opens. */
export interface Timeline {
  start: number;
  end: number;
  openAt: number;
  live?: boolean; // the end keeps moving as data arrives
}

/**
 * One domain's part of the viewer: its scenery, vehicles, cameras and panel state.
 * The viewer owns the engine, clock and playback controls and drives the module each frame.
 */
export interface SceneModule {
  readonly domain: Domain;
  readonly cameraOptions: readonly CameraOption[];
  readonly showLabels: WritableSignal<boolean>;

  /** Load the session's data and build the scene. Live sessions emit again as data arrives. */
  load(): Observable<Timeline>;
  /** Every frame, outside Angular: move vehicles and cameras to time `t`. */
  update(t: number, dt: number): void;
  /** About ten times a second, inside Angular: refresh signals the panels read. */
  syncUi(t: number): void;
  /** Switch camera; returns false if the mode isn't usable right now. */
  setCameraMode(id: string): boolean;
  cameraMode(): string;
  /** Whether cameras marked `needsTarget` have something to follow. */
  hasTarget(): boolean;
  resetView(): void;
  dispose(): void;
}
