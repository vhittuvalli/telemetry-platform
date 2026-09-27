import { Component, OnDestroy, OnInit, inject, input, output, signal } from '@angular/core';
import { Subscription, switchMap, takeWhile, timer } from 'rxjs';
import { ReplayApiService } from '../replay/replay-api.service';
import {
  BuildJob, CatalogEvent, CatalogSession, ReplaySummary,
} from '../replay/replay.models';

type SessionView = CatalogSession['status'] | 'failed';

@Component({
  selector: 'app-race-picker',
  standalone: true,
  templateUrl: './race-picker.component.html',
  styleUrl: './race-picker.component.scss',
})
export class RacePickerComponent implements OnInit, OnDestroy {
  private api = inject(ReplayApiService);

  replays = input.required<ReplaySummary[]>();
  current = input<string | null>(null);
  closable = input(true);
  select = output<string>();
  close = output<void>();
  built = output<void>(); // a new replay finished building

  protected seasons = signal<number[]>([]);
  protected year = signal<number | null>(null);
  protected events = signal<CatalogEvent[] | null>(null);
  protected error = signal<string | null>(null);
  protected jobs = signal(new Map<string, BuildJob>()); // by replay id

  private subs = new Subscription();
  private seasonSub?: Subscription;
  private watching = new Set<string>(); // build ids being polled

  ngOnInit(): void {
    this.subs.add(this.api.getSeasons().subscribe({
      next: (years) => {
        this.seasons.set(years);
        this.loadSeason(years[0]);
      },
      error: () => this.error.set('Could not reach the backend. Is it running on port 8000?'),
    }));
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.seasonSub?.unsubscribe();
  }

  protected onYearChange(event: Event): void {
    this.loadSeason(Number((event.target as HTMLSelectElement).value));
  }

  protected loadSeason(year: number, quiet = false): void {
    this.year.set(year);
    if (!quiet) this.events.set(null);
    this.error.set(null);
    this.seasonSub?.unsubscribe();
    this.seasonSub = this.api.getSeason(year).subscribe({
      next: (events) => {
        if (this.year() !== year) return;
        this.events.set(events);
        // Pick up builds that were started earlier (e.g. before a page reload)
        for (const e of events) {
          for (const s of e.sessions) {
            if (s.status === 'building' && s.build_id) this.watchBuild(s.build_id);
          }
        }
      },
      error: (err) => this.error.set(err.error?.detail ?? `Could not load the ${year} season`),
    });
  }

  protected title(r: ReplaySummary): string {
    return `${r.year} ${r.event} · ${r.session}`;
  }

  protected sessionView(s: CatalogSession): SessionView {
    const job = this.jobs().get(s.replay_id);
    if (job?.status === 'queued' || job?.status === 'running') return 'building';
    if (job?.status === 'failed' && s.status !== 'built') return 'failed';
    return s.status;
  }

  protected jobMessage(s: CatalogSession): string {
    return this.jobs().get(s.replay_id)?.message ?? 'Building…';
  }

  protected hasPastSessions(e: CatalogEvent): boolean {
    return e.sessions.some((s) => s.status !== 'upcoming');
  }

  protected failures(e: CatalogEvent): BuildJob[] {
    return e.sessions
      .filter((s) => this.sessionView(s) === 'failed')
      .map((s) => this.jobs().get(s.replay_id)!);
  }

  protected onSession(e: CatalogEvent, s: CatalogSession): void {
    const view = this.sessionView(s);
    if (view === 'built') {
      this.select.emit(s.replay_id);
    } else if (view === 'available' || view === 'failed') {
      this.subs.add(this.api.startBuild(this.year()!, e.round, s.code).subscribe({
        next: (job) => this.watchBuild(job.id, job),
        error: (err) => this.error.set(err.error?.detail ?? 'Could not start the build'),
      }));
    }
  }

  /** Poll a build until it finishes, then refresh the lists. */
  private watchBuild(buildId: string, initial?: BuildJob): void {
    if (this.watching.has(buildId)) return;
    this.watching.add(buildId);
    if (initial) this.setJob(initial);

    this.subs.add(timer(0, 2000).pipe(
      switchMap(() => this.api.getBuild(buildId)),
      takeWhile((job) => job.status === 'queued' || job.status === 'running', true),
    ).subscribe({
      next: (job) => {
        this.setJob(job);
        if (job.status === 'done') {
          this.built.emit();
          const year = this.year();
          if (year === job.year) this.loadSeason(year, true);
        }
      },
      error: () => {
        this.watching.delete(buildId);
        if (initial) {
          this.setJob({ ...initial, status: 'failed', message: 'Lost track of the build (did the backend restart?)' });
        }
      },
      complete: () => this.watching.delete(buildId),
    }));
  }

  private setJob(job: BuildJob): void {
    this.jobs.update((jobs) => new Map(jobs).set(job.replay_id, job));
  }
}
