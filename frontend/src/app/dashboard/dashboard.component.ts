import { Component, computed, input } from '@angular/core';
import { VehicleState } from '../replay/vehicle-track';
import { StandingRow } from '../replay/standings';

const MAX_RPM = 12500;

@Component({
  selector: 'app-dashboard',
  standalone: true,
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent {
  state = input.required<VehicleState>();
  row = input<StandingRow | null>(null);

  protected speed = computed(() => Math.round(this.state().speed ?? 0));
  protected gear = computed(() => {
    const g = this.state().gear;
    return g == null ? '-' : g === 0 ? 'N' : String(g);
  });
  protected rpmPct = computed(() => Math.min(100, ((this.state().rpm ?? 0) / MAX_RPM) * 100));
  protected throttlePct = computed(() => Math.max(0, Math.min(100, this.state().throttle ?? 0)));
  protected braking = computed(() => (this.state().brake ?? 0) > 0);
  // FastF1 DRS codes: 10, 12, and 14 mean the flap is open
  protected drsOpen = computed(() => (this.state().drs ?? 0) >= 10);
}