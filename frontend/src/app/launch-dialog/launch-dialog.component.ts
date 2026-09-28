import { Component, DestroyRef, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin } from 'rxjs';
import { ReplayApiService } from '../replay/replay-api.service';
import { MotorSummary, RocketMeta, RocketSummary, SimulationRequest } from '../replay/replay.models';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const MONTE_CARLO_RUNS = 200;

/** Pick a rocket, motor and launch conditions, and fly it on the server. */
@Component({
  selector: 'app-launch-dialog',
  standalone: true,
  templateUrl: './launch-dialog.component.html',
  styleUrl: './launch-dialog.component.scss',
})
export class LaunchDialogComponent implements OnInit {
  private api = inject(ReplayApiService);
  private destroyRef = inject(DestroyRef);

  /** The flight being watched, to start from its setup. */
  from = input<RocketMeta | null>(null);
  launched = output<string>();
  close = output<void>();

  protected rockets = signal<RocketSummary[]>([]);
  protected motors = signal<MotorSummary[]>([]);
  protected monteCarloAllowed = signal(false);
  protected error = signal<string | null>(null);
  protected busy = signal(false);
  protected readonly runs = MONTE_CARLO_RUNS;

  protected form = signal<SimulationRequest>({
    rocket: '', motor: null, ejection_delay: null,
    wind_speed: 0, wind_from: 0, angle: 0, heading: 0, monte_carlo: 0,
  });

  protected rocket = computed(() => this.rockets().find((r) => r.id === this.form().rocket) ?? null);
  /** Motors that fit the rocket's mount (same diameter as its own). */
  protected fitting = computed(() => {
    const r = this.rocket();
    return r ? this.motors().filter((m) => m.diameter === r.motor.diameter) : [];
  });
  protected motor = computed(() => this.fitting().find((m) => m.file === this.form().motor) ?? null);
  /** Ejection delays the chosen motor comes with (0 = booster, fires at burnout). */
  protected delays = computed(() => {
    const m = this.motor();
    return m ? [...new Set(m.delays.length ? m.delays : [0])] : [];
  });

  ngOnInit(): void {
    forkJoin({ rockets: this.api.getRockets(), motors: this.api.getMotors(), config: this.api.getRocketConfig() })
      .subscribe({
        next: ({ rockets, motors, config }) => {
          this.rockets.set(rockets);
          this.motors.set(motors);
          this.monteCarloAllowed.set(config.monte_carlo);
          this.startFrom(rockets);
        },
        error: () => this.error.set('Could not load the rocket designs'),
      });
  }

  /** Prefill from the flight being watched, or the first design. */
  private startFrom(rockets: RocketSummary[]): void {
    const meta = this.from();
    if (meta?.custom) {
      this.form.set({ ...meta.custom, monte_carlo: this.monteCarloAllowed() ? meta.custom.monte_carlo : 0 });
      return;
    }
    // Flights saved before designs had ids only carry the rocket's name
    const rocket = rockets.find((r) => r.id === meta?.rocket.id)
      ?? rockets.find((r) => r.name === meta?.rocket.name)
      ?? rockets[0];
    if (!rocket) return;
    const launch = meta?.launch ?? rocket.launch;
    this.form.set({
      rocket: rocket.id,
      motor: rocket.motor.file,
      ejection_delay: rocket.uses_ejection ? rocket.ejection_delay : null,
      wind_speed: round1(launch.wind_speed),
      wind_from: Math.round(((launch.wind_from % 360) + 360) % 360),
      angle: round1(launch.angle),
      heading: Math.round(((launch.heading % 360) + 360) % 360),
      monte_carlo: meta?.dispersion && this.monteCarloAllowed() ? MONTE_CARLO_RUNS : 0,
    });
  }

  protected set<K extends keyof SimulationRequest>(key: K, value: SimulationRequest[K]): void {
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  protected chooseRocket(id: string): void {
    const rocket = this.rockets().find((r) => r.id === id);
    if (!rocket) return;
    this.form.update((f) => ({
      ...f,
      rocket: id,
      motor: rocket.motor.file,
      ejection_delay: rocket.uses_ejection ? rocket.ejection_delay : null,
    }));
  }

  protected chooseMotor(file: string): void {
    const motor = this.fitting().find((m) => m.file === file);
    const current = this.form().ejection_delay;
    // Keep the delay if the new motor offers it; otherwise take its closest one
    const delays = motor?.delays.length ? motor.delays : [0];
    const delay = current == null ? null : delays.reduce((a, b) => (Math.abs(b - current) < Math.abs(a - current) ? b : a));
    this.form.update((f) => ({ ...f, motor: file, ejection_delay: this.rocket()?.uses_ejection ? delay : null }));
  }

  protected numberFrom(event: Event): number {
    return Number((event.target as HTMLInputElement).value);
  }

  protected valueFrom(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected compass(degrees: number): string {
    return COMPASS[Math.round(degrees / 45) % 8];
  }

  protected motorLabel(m: MotorSummary): string {
    return `${m.manufacturer} ${m.designation} · ${m.total_impulse} N·s, ${m.burn_time} s burn`;
  }

  protected launch(): void {
    this.busy.set(true);
    this.error.set(null);
    // Closing the dialog abandons the flight rather than opening it later
    this.api.simulate(this.form()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ replay_id }) => {
        this.busy.set(false);
        this.launched.emit(replay_id);
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(err.error?.detail ?? 'The simulation failed');
      },
    });
  }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
