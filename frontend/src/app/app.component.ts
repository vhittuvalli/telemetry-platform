import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ReplayViewerComponent } from './replay-viewer/replay-viewer.component';
import { RacePickerComponent } from './race-picker/race-picker.component';
import { ReplayApiService } from './replay/replay-api.service';
import { ReplaySummary } from './replay/replay.models';

const LAST_REPLAY_KEY = 'telemetry.lastReplay';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [ReplayViewerComponent, RacePickerComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit {
  private api = inject(ReplayApiService);

  protected replays = signal<ReplaySummary[]>([]);
  protected replayId = signal<string | null>(null);
  protected pickerOpen = signal(false);

  protected current = computed(() => this.replays().find((r) => r.id === this.replayId()) ?? null);

  ngOnInit(): void {
    this.api.listReplays().subscribe({
      next: (replays) => {
        this.replays.set(replays);
        // Reopen the last watched replay, else the newest one, else let the user pick
        const last = readLastReplay();
        const start = replays.find((r) => r.id === last) ?? replays[0];
        if (start) this.replayId.set(start.id);
        else this.pickerOpen.set(true);
      },
      error: () => this.pickerOpen.set(true), // the picker shows the connection error
    });
  }

  protected choose(id: string): void {
    this.replayId.set(id);
    this.pickerOpen.set(false);
    try {
      localStorage.setItem(LAST_REPLAY_KEY, id);
    } catch {
      // storage unavailable (private mode); not remembering is fine
    }
  }

  protected openPicker(): void {
    this.refreshReplays(); // builds may have finished while the picker was closed
    this.pickerOpen.set(true);
  }

  protected refreshReplays(): void {
    this.api.listReplays().subscribe((replays) => this.replays.set(replays));
  }
}

function readLastReplay(): string | null {
  try {
    return localStorage.getItem(LAST_REPLAY_KEY);
  } catch {
    return null;
  }
}
