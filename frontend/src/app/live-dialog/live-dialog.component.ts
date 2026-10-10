import { Component, DestroyRef, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable } from 'rxjs';
import { ReplayApiService } from '../replay/replay-api.service';
import { NewLiveSession, ReplaySummary, RocketSummary } from '../replay/replay.models';
import { environment } from '../../environments/environment';

export type LiveDialogMode = 'demo' | 'send';

const REPO = 'https://github.com/vhittuvalli/telemetry-platform';
const SPEEDS = [1, 5, 10, 20];

/** Go live from the site: watch a demo the server streams, or start a session for your own sender. */
@Component({
  selector: 'app-live-dialog',
  standalone: true,
  templateUrl: './live-dialog.component.html',
  styleUrl: './live-dialog.component.scss',
})
export class LiveDialogComponent implements OnInit {
  private api = inject(ReplayApiService);
  private destroyRef = inject(DestroyRef);

  mode = input<LiveDialogMode>('demo');
  /** Built replays; the F1 ones can be streamed as a demo. */
  replays = input<ReplaySummary[]>([]);
  watch = output<string>(); // live:CODE
  close = output<void>();

  protected tab = signal<LiveDialogMode>('demo');
  protected rockets = signal<RocketSummary[]>([]);
  protected error = signal<string | null>(null);
  protected busy = signal(false);
  protected readonly speeds = SPEEDS;
  protected readonly repo = REPO;

  // Demo: a design (rocket:<id>) or an F1 replay (f1:<id>)
  protected source = signal('');
  protected speed = signal(1);
  protected races = computed(() => this.replays().filter((r) => r.domain === 'f1' && !r.id.startsWith('live_')));

  // Your own sender
  protected design = signal('');
  protected name = signal('');
  protected session = signal<NewLiveSession | null>(null);
  protected copied = signal<string | null>(null);

  protected site = (environment.apiUrl || location.origin).replace(/\/$/, '');
  protected host = new URL(this.site).hostname;

  protected packet = computed(() => {
    const s = this.session();
    return s ? `{"v":1,"session":"${s.code}","key":"${s.key}","seq":0,"samples":[{"time":0,"x":0,"y":0,"z":0}]}` : '';
  });
  protected netcat = computed(() => {
    const s = this.session();
    return s?.udp_port ? `echo '${this.packet()}' | nc -u -w1 ${this.host} ${s.udp_port}` : '';
  });
  protected cli = computed(() => {
    const s = this.session();
    return s ? `your_ground_station | telemetry-live send - --session ${s.code} --key ${s.key} --site ${this.site}` : '';
  });
  protected websocketUrl = computed(() => this.site.replace(/^http/, 'ws') + '/live/ingest');

  ngOnInit(): void {
    this.tab.set(this.mode());
    this.api.getRockets().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rockets) => {
        this.rockets.set(rockets);
        if (rockets[0]) {
          this.design.set(rockets[0].id);
          this.source.set(`rocket:${rockets[0].id}`);
        }
      },
      error: () => this.error.set('Could not load the rocket designs'),
    });
  }

  protected setTab(tab: LiveDialogMode): void {
    this.tab.set(tab);
    this.error.set(null);
  }

  protected chooseSource(value: string): void {
    this.source.set(value);
    this.speed.set(value.startsWith('f1:') ? 10 : 1); // a race is long; a flight is two minutes at most
  }

  protected startDemo(): void {
    const [kind, id] = splitOnce(this.source(), ':');
    this.run(this.api.startDemo({ [kind === 'f1' ? 'replay' : 'rocket']: id, speed: this.speed() }),
      ({ code }) => this.watch.emit(`live:${code}`), 'Could not start the demo');
  }

  protected startSession(): void {
    this.run(this.api.createLiveSession(this.design(), this.name().trim()),
      (session) => this.session.set(session), 'Could not start a session');
  }

  private run<T>(call: Observable<T>, done: (result: T) => void, fallback: string): void {
    this.busy.set(true);
    this.error.set(null);
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (result) => {
        this.busy.set(false);
        done(result);
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(err.error?.detail ?? fallback);
      },
    });
  }

  protected copy(what: string, text: string): void {
    navigator.clipboard?.writeText(text).then(
      () => {
        this.copied.set(what);
        setTimeout(() => this.copied() === what && this.copied.set(null), 1500);
      },
      () => {}, // no clipboard access; the text is still there to select
    );
  }

  protected valueFrom(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }
}

function splitOnce(text: string, sep: string): [string, string] {
  const i = text.indexOf(sep);
  return [text.slice(0, i), text.slice(i + 1)];
}
