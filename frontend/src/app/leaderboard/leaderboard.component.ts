import { Component, input, output } from '@angular/core';
import { StandingRow } from '../f1/standings';

@Component({
  selector: 'app-leaderboard',
  standalone: true,
  templateUrl: './leaderboard.component.html',
  styleUrl: './leaderboard.component.scss',
})
export class LeaderboardComponent {
  rows = input.required<StandingRow[]>();
  lap = input.required<string>();
  selected = input<string | null>(null);
  select = output<string>();
}