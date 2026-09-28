import {
  AfterViewInit, Component, ElementRef, HostListener, NgZone, OnDestroy, ViewChild,
  computed, effect, inject, input, signal, untracked,
} from '@angular/core';
import * as THREE from 'three';
import { Subscription, switchMap } from 'rxjs';
import { ReplayApiService } from '../replay/replay-api.service';
import { ReplayMeta } from '../replay/replay.models';
import { ReplaySource } from '../replay/replay-source';
import { PlaybackClock } from '../replay/playback-clock';
import { ViewerEngine } from '../engine/viewer-engine';
import { SceneModule } from '../engine/scene-module';
import { F1Scene } from '../f1/f1-scene';
import { RocketScene } from '../rocket/rocket-scene';
import { LeaderboardComponent } from '../leaderboard/leaderboard.component';
import { DashboardComponent } from '../dashboard/dashboard.component';
import { RocketPanelsComponent } from '../rocket-panels/rocket-panels.component';

/**
 * The 3D viewer shell shared by every domain: engine, playback clock and controls.
 * The session's domain picks a scene module, which supplies the scenery, vehicles,
 * cameras and panels.
 */
@Component({
  selector: 'app-replay-viewer',
  standalone: true,
  imports: [LeaderboardComponent, DashboardComponent, RocketPanelsComponent],
  templateUrl: './replay-viewer.component.html',
  styleUrl: './replay-viewer.component.scss',
})
export class ReplayViewerComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  private engine!: ViewerEngine;
  private frameId = 0;
  private frameTimer = new THREE.Clock();
  private resizeObserver?: ResizeObserver;
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

  // session
  private api = inject(ReplayApiService);
  replayId = input<string | null>(null);
  private viewReady = signal(false);
  private loading = new Subscription();
  private clock?: PlaybackClock;
  protected module = signal<SceneModule | null>(null);
  protected f1 = computed(() => {
    const m = this.module();
    return m instanceof F1Scene ? m : null;
  });
  protected rocket = computed(() => {
    const m = this.module();
    return m instanceof RocketScene ? m : null;
  });

  // UI state (read by the template)
  protected currentTime = signal(0);
  protected playing = signal(false);
  protected speed = signal(1);
  protected timeRange = signal<{ start: number; end: number } | null>(null);
  protected loadError = signal<string | null>(null);
  protected readonly speeds = [1, 2, 5, 10, 20];
  private lastUiUpdate = 0;

  constructor(private zone: NgZone) {
    // (Re)load whenever the chosen replay changes, once the renderer exists
    effect(() => {
      const id = this.replayId();
      if (!this.viewReady()) return;
      untracked(() => this.loadReplay(id));
    });
  }

  // ---------- setup ----------

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;
    this.engine = new ViewerEngine(canvas, this.host.nativeElement);

    this.resizeObserver = new ResizeObserver(() => this.engine.resize());
    this.resizeObserver.observe(canvas);
    this.engine.resize();

    this.zone.runOutsideAngular(() => this.animate());
    this.viewReady.set(true);
  }

  // ---------- loading and switching sessions ----------

  private createModule(source: ReplaySource, meta: ReplayMeta): SceneModule {
    if (meta.domain === 'rocket') return new RocketScene(this.engine, source, this.api, meta);
    return new F1Scene(this.engine, source, this.api, meta);
  }

  private loadReplay(id: string | null): void {
    this.clearReplay();
    if (!id) return;
    const source = new ReplaySource(this.api, id);
    this.loading = source.meta().pipe(
      switchMap((meta) => {
        const module = this.createModule(source, meta);
        this.module.set(module);
        return module.load();
      }),
    ).subscribe({
      next: ({ start, end, openAt }) => {
        this.clock = new PlaybackClock(start, end);
        this.clock.seek(openAt);
        this.clock.playing = true;
        this.timeRange.set({ start, end });
        this.playing.set(true);
      },
      error: (err) => this.fail(this.module() ? 'Failed to load replay data' : 'Failed to load replay metadata', err),
    });
  }

  private fail(message: string, err: unknown): void {
    console.error(message, err);
    this.loadError.set(message);
  }

  /** Remove everything belonging to the current session and reset the UI. */
  private clearReplay(): void {
    this.loading.unsubscribe(); // drop any in-flight requests for the old session
    this.module()?.dispose();
    this.module.set(null);
    this.clock = undefined;

    this.currentTime.set(0);
    this.playing.set(false);
    this.speed.set(1);
    this.timeRange.set(null);
    this.loadError.set(null);
  }

  // ---------- playback controls ----------

  protected togglePlay(): void {
    if (!this.clock) return;
    if (!this.clock.playing && this.clock.time >= this.clock.end) {
      this.clock.seek(0);
    }
    this.clock.toggle();
    this.playing.set(this.clock.playing);
  }

  protected onSeek(event: Event): void {
    if (!this.clock) return;
    const value = Number((event.target as HTMLInputElement).value);
    this.clock.seek(value);
    this.currentTime.set(value);
  }

  protected seekTo(t: number): void {
    if (!this.clock) return;
    this.clock.seek(t);
    this.currentTime.set(this.clock.time);
  }

  protected setSpeed(s: number): void {
    if (!this.clock) return;
    this.clock.speed = s;
    this.speed.set(s);
  }

  protected setCameraMode(id: string): void {
    this.module()?.setCameraMode(id);
  }

  protected toggleLabels(): void {
    this.module()?.showLabels.update((v) => !v);
  }

  protected formatTime(t: number): string {
    const sign = t < 0 ? '-' : '';
    const total = Math.floor(Math.abs(t));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${sign}${m}:${s.toString().padStart(2, '0')}`;
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (event.code !== 'Space') return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLButtonElement) return;
    event.preventDefault();
    this.togglePlay();
  }

  // ---------- render loop ----------

  private animate = (): void => {
    this.frameId = requestAnimationFrame(this.animate);
    const dt = Math.min(this.frameTimer.getDelta(), 0.1);
    const module = this.module();

    if (this.clock && module) {
      this.clock.tick(dt);
      module.update(this.clock.time, dt);

      const now = performance.now();
      if (now - this.lastUiUpdate > 100) {
        this.lastUiUpdate = now;
        const clock = this.clock;
        this.zone.run(() => {
          this.currentTime.set(clock.time);
          this.playing.set(clock.playing);
          module.syncUi(clock.time);
        });
      }
    }

    this.engine.render();
  };

  // ---------- cleanup ----------

  ngOnDestroy(): void {
    this.loading.unsubscribe();
    cancelAnimationFrame(this.frameId);
    this.resizeObserver?.disconnect();
    this.module()?.dispose();
    this.engine?.dispose();
  }
}
